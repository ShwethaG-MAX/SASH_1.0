'use strict';
/* Account deletion core. Every step is idempotent, so if anything fails the Auth user is NOT deleted and the student can simply press Delete again.
   Order: data first, Auth user LAST (once the Auth user is gone nobody could retry). */
class CoreError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const E = (c, m) => new CoreError(c, m);

const FRESH_MS = 5 * 60 * 1000;
const CHAT_ROOMS = ['linklearn', 'year1', 'year2'];

// Collections whose docs carry a `uid` field equal to the student's uid.
const BY_UID = ['quizAttempts', 'quizXpLedger', 'dailyQuizResults', 'weeklyQuizResults', 'testAttempts', 'testResults',
  'syllabusQuizAttempts', 'userSyllabusProgress', 'syllabusXpLedger', 'classPollVotes', 'dailyPollVotes', 'chatWarnings'];
// Collections whose docs carry `anonymousId` equal to the student's uid (everything the student posted).
const BY_ANON = ['communityLinks', 'studyMaterials', 'examQuestions', 'communityChat'];
// Docs whose id IS the uid.
const DOC_IS_UID = ['publicProfiles', 'userProfiles', 'deviceTokens', 'testStats', 'xpTotals', 'userXp', 'quizProfiles', 'chatRestrictions', 'crAccounts'];
// Per-user subcollection trees: removed recursively.
const TREE_IS_UID = ['userData', 'userInbox', 'teamNotifs', 'connNotifs', 'discoverUsers'];

async function delQuery(db, q) {
  let n = 0;
  for (;;) {
    const s = await q.limit(400).get();
    if (s.empty) return n;
    const b = db.batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); n += s.size;
    if (s.size < 400) return n;
  }
}
const rdel = (db, ref) => (db.recursiveDelete ? db.recursiveDelete(ref) : ref.delete());

async function eachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

/* ---- Teams: leaders hand over to a remaining member (or the team is removed if nobody else is in it); members are removed. ---- */
async function teams(ctx, uid) {
  const { db, FV } = ctx;
  const led = await db.collection('teams').where('leaderUid', '==', uid).get();
  for (const doc of led.docs) {
    const t = doc.data(), others = (t.memberUids || []).filter((m) => m !== uid);
    if (!others.length) { await rdel(db, doc.ref); await delQuery(db, db.collection('teamRequests').where('teamId', '==', doc.id)); continue; }
    const next = others[0];
    const nm = await doc.ref.collection('members').doc(next).get();
    const b = db.batch();
    b.update(doc.ref, { leaderUid: next, leaderName: (nm.exists && nm.data().name) || '', memberUids: others, memberCount: others.length, updatedAt: FV.serverTimestamp() });
    b.delete(doc.ref.collection('members').doc(uid));
    b.set(doc.ref.collection('members').doc(next), { role: 'leader' }, { merge: true });
    b.create(db.collection('teamNotifs').doc(next).collection('items').doc(), { type: 'transferred', teamId: doc.id, teamName: t.name || '', fromName: t.leaderName || '', read: false, createdAt: FV.serverTimestamp() });
    await b.commit();
    const pend = await db.collection('teamRequests').where('teamId', '==', doc.id).where('status', '==', 'pending').get();
    if (pend.size) { const pb = db.batch(); pend.docs.forEach((d) => pb.update(d.ref, { to: next })); await pb.commit(); }
  }
  const mem = await db.collection('teams').where('memberUids', 'array-contains', uid).get();
  for (const doc of mem.docs) {
    const t = doc.data(), rest = (t.memberUids || []).filter((m) => m !== uid);
    const b = db.batch();
    b.update(doc.ref, { memberUids: rest, memberCount: rest.length, updatedAt: FV.serverTimestamp() });
    b.delete(doc.ref.collection('members').doc(uid));
    await b.commit();
  }
  await delQuery(db, db.collection('teamRequests').where('from', '==', uid));
  await delQuery(db, db.collection('teamRequests').where('to', '==', uid));
}

async function connections(ctx, uid) {
  const { db } = ctx;
  await delQuery(db, db.collection('connectionRequests').where('from', '==', uid));
  await delQuery(db, db.collection('connectionRequests').where('to', '==', uid));
  await delQuery(db, db.collection('connections').where('users', 'array-contains', uid));
}

async function chat(ctx, uid) {
  const { db } = ctx;
  for (const r of CHAT_ROOMS) {
    await delQuery(db, db.collection(`chatRooms/${r}/messages`).where('anonymousId', '==', uid));
    await delQuery(db, db.collection(`chatRooms/${r}/reactions`).where('uid', '==', uid));
    await delQuery(db, db.collection(`chatRooms/${r}/views`).where('uid', '==', uid));
  }
  await delQuery(db, db.collection('chatReactions').where('uid', '==', uid));
  await delQuery(db, db.collection('chatViews').where('uid', '==', uid));
}

/* Exam Chat: the student's questions (with their answers / reactions), plus answers and "+" reactions they left on other people's questions.
   Done per question (no collection-group index needed). */
async function examChat(ctx, uid) {
  const { db } = ctx;
  const mine = await db.collection('examQuestions').where('anonymousId', '==', uid).get();
  for (const d of mine.docs) await rdel(db, d.ref);
  const refs = await db.collection('examQuestions').listDocuments();
  await eachLimit(refs, 20, async (q) => {
    await delQuery(db, q.collection('answers').where('anonymousId', '==', uid));
    await q.collection('reactions').doc(uid).delete();
  });
}

async function discover(ctx, uid) {
  const { db } = ctx;
  const au = await db.collection('discoverCommentAuthors').where('uid', '==', uid).get();
  for (const d of au.docs) {
    const a = d.data();
    if (a.articleId) await db.doc(`discoverArticles/${a.articleId}/comments/${d.id}`).delete();
    await d.ref.delete();
  }
}

async function quizBoards(ctx, uid) {
  const { db } = ctx;
  const boards = await db.collection('quizBoards').listDocuments();
  await eachLimit(boards, 20, (b) => b.collection('entries').doc(uid).delete());
}

async function byField(ctx, cols, field, uid) {
  const { db } = ctx;
  for (const c of cols) {
    if (c === 'examQuestions') continue;
    await delQuery(db, db.collection(c).where(field, '==', uid));
  }
}

async function deleteAccount(ctx, uid, token, data) {
  const { nowMs } = ctx; data = data || {};
  if (!uid) throw E('unauthenticated', 'Please sign in again.');
  if (data.confirm !== 'DELETE') throw E('invalid-argument', 'Type DELETE to confirm.');
  if (token && token.owner === true) throw E('permission-denied', 'The admin account cannot be deleted here.');
  const at = token && token.auth_time ? token.auth_time * 1000 : 0;
  if (!at || nowMs - at > FRESH_MS) throw E('unauthenticated', 'For your security please sign in again, then retry.');   // client shows "re-login required"
  const steps = [
    ['teams', teams], ['connections', connections], ['chat', chat], ['examChat', examChat], ['discover', discover], ['quizBoards', quizBoards],
    ['uid-docs', (c, u) => byField(c, BY_UID, 'uid', u)], ['posted', (c, u) => byField(c, BY_ANON, 'anonymousId', u)],
    ['trees', async (c, u) => { for (const t of TREE_IS_UID) await rdel(c.db, c.db.collection(t).doc(u)); }],
    ['storage', (c, u) => (async () => { await c.deleteFiles(`chatMedia/${u}/`); await c.deleteFiles(`profileImages/${u}/`); })()],
    ['profile-docs', async (c, u) => { for (const t of DOC_IS_UID) await c.db.collection(t).doc(u).delete(); }],   // profile last among data: it carries the section / year the other steps never need
  ];
  const failed = [];
  for (const [name, fn] of steps) { try { await fn(ctx, uid); } catch (e) { console.error('accountDelete step failed:', name, e); failed.push(name); } }
  if (failed.length) throw E('internal', 'Could not finish deleting your account (' + failed.join(', ') + '). Nothing was lost: please try again.');
  await ctx.deleteAuthUser(uid);
  return { ok: true };
}

module.exports = { CoreError, deleteAccount, FRESH_MS, BY_UID, BY_ANON, DOC_IS_UID, TREE_IS_UID };

'use strict';
/**
 * Anonymous article comments.
 *   Public (readable by every signed-in student):  discoverArticles/{aid}/comments/{cid} = { text, createdAt, parentId|null }   <- NO author fields, ever.
 *   Server-only author link:                       discoverCommentAuthors/{cid} = { uid, articleId }                          <- rules: no client access
 *   Author's own list (for the "You" tag/delete):  discoverUsers/{uid}/myComments/{cid}                                       <- readable by that user only
 * Clients cannot write any of these: every write goes through the callables below (validation, rate limits, spam checks, counters).
 */
const admin = require('firebase-admin');
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue, TS = admin.firestore.Timestamp;

const ID_RE = /^a_[0-9a-f]{20}$/, CID_RE = /^[A-Za-z0-9]{20}$/;
const MAX_LEN = 800, MIN_LEN = 2, MAX_LINES = 14, REPORT_HIDE_AT = 3;
const REASONS = ['spam', 'abusive', 'offtopic', 'other'];

const articleRef = (aid) => db.doc('discoverArticles/' + aid);
const commentRef = (aid, cid) => articleRef(aid).collection('comments').doc(cid);

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Please wait for your account to connect, then try again.');
  return request.auth.uid;
}
const isOwner = (request) => !!(request.auth && request.auth.token && request.auth.token.owner === true);
function checkIds(aid, cid) {
  if (typeof aid !== 'string' || !ID_RE.test(aid)) throw new HttpsError('invalid-argument', 'Unknown article.');
  if (cid !== undefined && (typeof cid !== 'string' || !CID_RE.test(cid))) throw new HttpsError('invalid-argument', 'Unknown comment.');
}

/** Fixed-window counter per user + action. Doc ids are uid-based but the collection is server-only. */
async function rateLimit(uid, action, max, windowSec) {
  const win = Math.floor(Date.now() / (windowSec * 1000));
  const ref = db.doc('discoverRate/' + uid + '_' + action + '_' + win);
  const n = await db.runTransaction(async (t) => {
    const s = await t.get(ref), c = (s.exists ? s.data().n : 0) + 1;
    t.set(ref, { n: c, uid, expireAt: TS.fromMillis((win + 2) * windowSec * 1000) });
    return c;
  });
  if (n > max) throw new HttpsError('resource-exhausted', 'You are doing that too quickly. Please wait a moment and try again.');
}

/** Control + invisible/bidi-override characters out, newlines normalised, blank-line runs collapsed. */
function cleanComment(raw) {
  let t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}
/** Returns an error message (string) if the text looks like spam / abuse of the form, else ''. Pure, unit-tested. */
function spamReason(text) {
  if (text.length < MIN_LEN) return 'Your comment is too short.';
  if (text.length > MAX_LEN) return 'Comments can be at most ' + MAX_LEN + ' characters.';
  if (text.split('\n').length > MAX_LINES) return 'Please keep comments to ' + MAX_LINES + ' lines or fewer.';
  if (!/[\p{L}\p{N}]{2}/u.test(text)) return 'Please write a few words.';
  if ((text.match(/https?:\/\/|www\./gi) || []).length > 2) return 'Please include at most two links.';
  if (/(.)\1{11,}/u.test(text)) return 'That looks like spam (repeated characters).';
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size / words.length < 0.3) return 'That looks like spam (repeated words).';
  return '';
}
const textHash = (t) => crypto.createHash('sha1').update(t.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);

/** Same user posting the same text again within 10 minutes is refused (copy-paste flooding). */
async function dupCheck(uid, h) {
  const ref = db.doc('discoverRate/' + uid + '_dup'), now = Date.now();
  await db.runTransaction(async (t) => {
    const s = await t.get(ref), list = ((s.exists && s.data().list) || []).filter((x) => now - x.t < 600000);
    if (list.some((x) => x.h === h)) throw new HttpsError('already-exists', 'You already posted that comment.');
    list.push({ h, t: now });
    t.set(ref, { list: list.slice(-10), uid, expireAt: TS.fromMillis(now + 3600000) });
  });
}

async function postComment(request) {
  const uid = requireAuth(request), d = request.data || {};
  checkIds(d.articleId, d.parentId == null ? undefined : d.parentId);
  const text = cleanComment(d.text), bad = spamReason(text);
  if (bad) throw new HttpsError('invalid-argument', bad);
  await rateLimit(uid, 'post_m', 5, 60); await rateLimit(uid, 'post_h', 40, 3600);
  await dupCheck(uid, textHash(text));
  const aRef = articleRef(d.articleId), cRef = aRef.collection('comments').doc();
  const parentId = d.parentId || null;
  await db.runTransaction(async (t) => {
    const reads = [aRef].concat(parentId ? [commentRef(d.articleId, parentId)] : []);
    const snaps = await t.getAll(...reads);
    if (!snaps[0].exists) throw new HttpsError('not-found', 'This article is no longer available.');
    if (parentId && (!snaps[1].exists || snaps[1].data().parentId)) throw new HttpsError('failed-precondition', 'You can only reply to a top-level comment that still exists.');
    t.create(cRef, { text, createdAt: FV.serverTimestamp(), parentId });
    t.create(db.doc('discoverCommentAuthors/' + cRef.id), { uid, articleId: d.articleId, createdAt: FV.serverTimestamp() });
    t.create(db.doc('discoverUsers/' + uid + '/myComments/' + cRef.id), { articleId: d.articleId, createdAt: FV.serverTimestamp() });
    t.update(aRef, { commentCount: FV.increment(1), lastCommentAt: FV.serverTimestamp() });
  });
  return { id: cRef.id, parentId };
}

/**
 * Remove comments from the public collection (and keep the counter honest). archive=true keeps a server-only copy
 * (used by auto-hide so the owner can restore). Returns how many existed.
 */
async function removeComments(aid, cids, archive, reason) {
  const aRef = articleRef(aid), cRefs = cids.map((c) => commentRef(aid, c)), auRefs = cids.map((c) => db.doc('discoverCommentAuthors/' + c));
  return db.runTransaction(async (t) => {
    const snaps = await t.getAll(aRef, ...cRefs, ...auRefs);
    const art = snaps[0], cs = snaps.slice(1, 1 + cids.length), aus = snaps.slice(1 + cids.length);
    let n = 0;
    cs.forEach((c, i) => {
      if (!c.exists) return;
      n++;
      if (archive) t.set(db.doc('discoverHidden/' + cids[i]), Object.assign({}, c.data(), { articleId: aid, hiddenAt: FV.serverTimestamp(), hiddenBy: reason || 'reports' }));
      t.delete(cRefs[i]);
      const uid = aus[i].exists && aus[i].data().uid;
      if (uid) t.delete(db.doc('discoverUsers/' + uid + '/myComments/' + cids[i]));
      if (aus[i].exists) t.update(auRefs[i], { removedAt: FV.serverTimestamp() });
    });
    if (n && art.exists) {
      const left = Math.max(0, (art.data().commentCount || 0) - n);
      t.update(aRef, left > 0 ? { commentCount: left } : { commentCount: 0, lastCommentAt: FV.delete() });
    }
    return n;
  });
}

async function deleteComment(request) {
  const uid = requireAuth(request), d = request.data || {};
  checkIds(d.articleId, d.commentId);
  await rateLimit(uid, 'del', 20, 3600);
  const au = await db.doc('discoverCommentAuthors/' + d.commentId).get();
  if (!au.exists || au.data().articleId !== d.articleId) throw new HttpsError('not-found', 'Comment not found.');
  if (au.data().uid !== uid && !isOwner(request)) throw new HttpsError('permission-denied', 'You can only delete your own comments.');
  const replies = await articleRef(d.articleId).collection('comments').where('parentId', '==', d.commentId).get();
  const n = await removeComments(d.articleId, [d.commentId].concat(replies.docs.map((x) => x.id)), false);
  return { removed: n };
}

async function reportComment(request) {
  const uid = requireAuth(request), d = request.data || {};
  checkIds(d.articleId, d.commentId);
  const reason = REASONS.includes(d.reason) ? d.reason : 'other';
  await rateLimit(uid, 'report', 15, 3600);
  const [c, au] = await Promise.all([commentRef(d.articleId, d.commentId).get(), db.doc('discoverCommentAuthors/' + d.commentId).get()]);
  if (!c.exists) throw new HttpsError('not-found', 'That comment is no longer there.');
  if (au.exists && au.data().uid === uid) throw new HttpsError('failed-precondition', 'You cannot report your own comment.');
  const rid = d.commentId + '_' + uid;
  try { await db.doc('discoverReports/' + rid).create({ commentId: d.commentId, articleId: d.articleId, reporter: uid, reason, status: 'open', createdAt: FV.serverTimestamp() }); }
  catch (e) { if (e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message)))) return { ok: true, already: true, hidden: false }; throw e; }
  const open = await db.collection('discoverReports').where('commentId', '==', d.commentId).where('status', '==', 'open').get();
  let hidden = false;
  if (open.size >= REPORT_HIDE_AT) { hidden = (await removeComments(d.articleId, [d.commentId], true, 'reports')) > 0; }
  return { ok: true, hidden };
}

/* ---------------- owner moderation (Firebase Auth custom claim owner:true — same system as the rest of the app) ---------------- */
function requireOwner(request) {
  requireAuth(request);
  if (!isOwner(request)) throw new HttpsError('permission-denied', 'Moderators only.');
}

async function modList(request) {
  requireOwner(request);
  const snap = await db.collection('discoverReports').where('status', '==', 'open').limit(300).get();
  const groups = new Map();
  snap.docs.forEach((r) => { const x = r.data(), g = groups.get(x.commentId) || { commentId: x.commentId, articleId: x.articleId, count: 0, reasons: {} }; g.count++; g.reasons[x.reason] = (g.reasons[x.reason] || 0) + 1; groups.set(x.commentId, g); });
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  const items = await Promise.all(top.map(async (g) => {
    const [pub, hid, art] = await Promise.all([commentRef(g.articleId, g.commentId).get(), db.doc('discoverHidden/' + g.commentId).get(), articleRef(g.articleId).get()]);
    const c = pub.exists ? pub.data() : hid.exists ? hid.data() : null;
    return { commentId: g.commentId, articleId: g.articleId, count: g.count, reasons: g.reasons, hidden: !pub.exists && hid.exists, gone: !c, text: c ? c.text : '', articleTitle: art.exists ? art.data().title : '' };
  }));
  return { items };
}

async function modAct(request) {
  requireOwner(request);
  const d = request.data || {};
  checkIds(d.articleId, d.commentId);
  if (d.action !== 'remove' && d.action !== 'keep') throw new HttpsError('invalid-argument', 'Unknown action.');
  const reps = await db.collection('discoverReports').where('commentId', '==', d.commentId).where('status', '==', 'open').get();
  const mark = async (status) => { for (let i = 0; i < reps.docs.length; i += 400) { const b = db.batch(); reps.docs.slice(i, i + 400).forEach((r) => b.update(r.ref, { status, resolvedAt: FV.serverTimestamp() })); await b.commit(); } };
  const hidRef = db.doc('discoverHidden/' + d.commentId);
  if (d.action === 'remove') {
    const replies = await articleRef(d.articleId).collection('comments').where('parentId', '==', d.commentId).get();
    await removeComments(d.articleId, [d.commentId].concat(replies.docs.map((x) => x.id)), false);
    await hidRef.delete().catch(() => {}); await mark('actioned'); return { ok: true };
  }
  const hid = await hidRef.get();                                           // keep = dismiss the reports; restore if it had been auto-hidden
  if (hid.exists) {
    const h = hid.data(), aRef = articleRef(d.articleId), cRef = commentRef(d.articleId, d.commentId);
    await db.runTransaction(async (t) => {
      const a = await t.get(aRef); if (!a.exists) return;
      t.create(cRef, { text: h.text, createdAt: h.createdAt, parentId: h.parentId || null });
      t.update(aRef, { commentCount: FV.increment(1), lastCommentAt: FV.serverTimestamp() });
      t.delete(hidRef);
    });
    const au = await db.doc('discoverCommentAuthors/' + d.commentId).get();
    if (au.exists) { await au.ref.update({ removedAt: FV.delete() }); await db.doc('discoverUsers/' + au.data().uid + '/myComments/' + d.commentId).set({ articleId: d.articleId, createdAt: h.createdAt }); }
  }
  await mark('dismissed'); return { ok: true };
}

module.exports = { postComment, deleteComment, reportComment, modList, modAct, requireAuth, rateLimit, cleanComment, spamReason, textHash, ID_RE, REASONS };

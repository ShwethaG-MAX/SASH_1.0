'use strict';
/* Connection logic. Pure functions over an injected Firestore (db), so they run in tests with no network.
   Data model (all written ONLY here, via Admin SDK):
     connectionRequests/{from}_{to} : {from,to,fromName,toName,status:'pending'|'accepted'|'rejected',createdAt,updatedAt}
     connections/{uidA}_{uidB}      : {users:[a,b] (sorted), names:{uid:name}, createdAt}   (ids sorted so a pair has ONE doc)
     connNotifs/{uid}/items/{id}    : {type:'request'|'accepted'|'rejected',fromUid,fromName,read:false,createdAt}
     userConns/{uid}                : {ids:[uid,...]}  server-only mirror used for mutuals/suggestions (never client readable) */
class CoreError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const UID = /^[A-Za-z0-9_-]{6,128}$/;
const pairId = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
const reqId = (from, to) => from + '_' + to;
function needUid(v, what) { if (typeof v !== 'string' || !UID.test(v)) throw new CoreError('invalid-argument', 'Invalid ' + what + '.'); return v; }

async function profile(ctx, uid) {
  const s = await ctx.db.collection('publicProfiles').doc(uid).get();
  if (!s.exists) return null;
  const d = s.data() || {}; return { uid, name: String(d.name || '').slice(0, 40), year: d.year || '', branch: d.branch || '' };
}
async function notify(ctx, toUid, type, fromUid, fromName) {
  await ctx.db.collection('connNotifs').doc(toUid).collection('items').add({ type, fromUid, fromName, read: false, createdAt: ctx.FV.serverTimestamp() });
}
function realUser(ctx, auth) { // guests (anonymous) can never connect
  if (!auth || !auth.uid) throw new CoreError('unauthenticated', 'Please sign in.');
  if (auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider === 'anonymous') throw new CoreError('permission-denied', 'Sign in with your student account to connect.');
  return auth.uid;
}

async function sendRequest(ctx, auth, data) {
  const me = realUser(ctx, auth), to = needUid(data && data.to, 'student');
  if (to === me) throw new CoreError('invalid-argument', 'You cannot connect with yourself.');
  const [mine, theirs] = await Promise.all([profile(ctx, me), profile(ctx, to)]);
  if (!mine) throw new CoreError('failed-precondition', 'Your profile is not published yet. Reopen Find people and try again.');
  if (!theirs) throw new CoreError('not-found', 'That student could not be found.');
  const out = ctx.db.collection('connectionRequests').doc(reqId(me, to)), back = ctx.db.collection('connectionRequests').doc(reqId(to, me));
  const conn = ctx.db.collection('connections').doc(pairId(me, to));
  return ctx.db.runTransaction(async (tx) => {
    const [co, o, b] = await Promise.all([tx.get(conn), tx.get(out), tx.get(back)]);
    if (co.exists) throw new CoreError('already-exists', 'You are already connected.');
    if (o.exists && o.data().status === 'pending') throw new CoreError('already-exists', 'Request already sent.');
    if (b.exists && b.data().status === 'pending') throw new CoreError('already-exists', theirs.name + ' already sent you a request. Accept it in Received.');
    const now = ctx.FV.serverTimestamp();
    tx.set(out, { from: me, to, fromName: mine.name, toName: theirs.name, status: 'pending', createdAt: now, updatedAt: now });
    return { status: 'pending' };
  }).then(async (r) => { await notify(ctx, to, 'request', me, mine.name); return r; });
}

async function respond(ctx, auth, data) { // receiver accepts or rejects
  const me = realUser(ctx, auth), from = needUid(data && data.from, 'student'), accept = !!(data && data.accept);
  const rq = ctx.db.collection('connectionRequests').doc(reqId(from, me)), conn = ctx.db.collection('connections').doc(pairId(from, me));
  const res = await ctx.db.runTransaction(async (tx) => {
    const s = await tx.get(rq);
    if (!s.exists || s.data().to !== me) throw new CoreError('not-found', 'Request not found.');
    if (s.data().status !== 'pending') throw new CoreError('failed-precondition', 'This request was already handled.');
    const d = s.data(), now = ctx.FV.serverTimestamp();
    tx.update(rq, { status: accept ? 'accepted' : 'rejected', updatedAt: now });
    if (accept) {
      tx.set(conn, { users: [from, me].sort(), names: { [from]: d.fromName, [me]: d.toName }, createdAt: now });
      tx.set(ctx.db.collection('userConns').doc(me), { ids: ctx.FV.arrayUnion(from) }, { merge: true });   // same transaction: a listener can never see the connection without its mirror
      tx.set(ctx.db.collection('userConns').doc(from), { ids: ctx.FV.arrayUnion(me) }, { merge: true });
    }
    return { status: accept ? 'accepted' : 'rejected', name: d.fromName, myName: d.toName };
  });
  await notify(ctx, from, accept ? 'accepted' : 'rejected', me, res.myName);
  return { status: res.status };
}

async function cancelRequest(ctx, auth, data) { // sender withdraws a pending request
  const me = realUser(ctx, auth), to = needUid(data && data.to, 'student');
  const rq = ctx.db.collection('connectionRequests').doc(reqId(me, to));
  return ctx.db.runTransaction(async (tx) => {
    const s = await tx.get(rq);
    if (!s.exists || s.data().status !== 'pending') throw new CoreError('not-found', 'No pending request to cancel.');
    tx.delete(rq); return { status: 'cancelled' };
  });
}

async function removeConnection(ctx, auth, data) {
  const me = realUser(ctx, auth), other = needUid(data && data.uid, 'student');
  const conn = ctx.db.collection('connections').doc(pairId(me, other));
  await ctx.db.runTransaction(async (tx) => {
    const s = await tx.get(conn); if (!s.exists) throw new CoreError('not-found', 'You are not connected.');
    tx.set(ctx.db.collection('userConns').doc(me), { ids: ctx.FV.arrayRemove(other) }, { merge: true });
    tx.set(ctx.db.collection('userConns').doc(other), { ids: ctx.FV.arrayRemove(me) }, { merge: true });
    tx.delete(conn);
    tx.delete(ctx.db.collection('connectionRequests').doc(reqId(me, other))); tx.delete(ctx.db.collection('connectionRequests').doc(reqId(other, me)));
  });
  return { status: 'removed' };
}

async function myIds(ctx, uid) { const s = await ctx.db.collection('userConns').doc(uid).get(); return s.exists && Array.isArray(s.data().ids) ? s.data().ids : []; }

/* Mutual connections between me and each uid in `uids` (max 50): returns {uid:[{uid,name}]}. Only MY connections that are also theirs are revealed. */
async function mutuals(ctx, auth, data) {
  const me = realUser(ctx, auth), uids = (data && Array.isArray(data.uids) ? data.uids : []).slice(0, 50).map((u) => needUid(u, 'student'));
  const mine = new Set(await myIds(ctx, me)), out = {};
  await Promise.all(uids.map(async (u) => {
    const common = (await myIds(ctx, u)).filter((x) => mine.has(x) && x !== me && x !== u);
    out[u] = (await Promise.all(common.slice(0, 10).map((x) => profile(ctx, x)))).filter(Boolean).map((p) => ({ uid: p.uid, name: p.name }));
  }));
  return { mutuals: out };
}

/* Suggestions: friends-of-friends ranked by mutual count, then same year/branch as me. Excludes me, my connections and anyone with a pending request either way. */
async function suggestions(ctx, auth, data) {
  const me = realUser(ctx, auth), limit = Math.min(20, Math.max(1, +(data && data.limit) || 10));
  const mine = await myIds(ctx, me), skip = new Set(mine.concat([me]));
  const [a, b] = await Promise.all([ctx.db.collection('connectionRequests').where('from', '==', me).get(), ctx.db.collection('connectionRequests').where('to', '==', me).get()]);
  a.docs.concat(b.docs).forEach((d) => { const x = d.data(); if (x.status === 'pending') { skip.add(x.from); skip.add(x.to); } });
  const score = new Map();
  await Promise.all(mine.slice(0, 40).map(async (f) => { (await myIds(ctx, f)).forEach((u) => { if (!skip.has(u)) score.set(u, (score.get(u) || 0) + 1); }); }));
  const mineP = await profile(ctx, me);
  if (score.size < limit && mineP) { // top up with same-year/branch students (real publicProfiles only)
    const snap = await ctx.db.collection('publicProfiles').limit(300).get();
    snap.docs.forEach((d) => { const x = d.data() || {}; if (skip.has(d.id) || score.has(d.id) || !x.name) return;
      const sim = (mineP.branch && x.branch === mineP.branch ? 1 : 0) + (mineP.year && x.year === mineP.year ? 1 : 0); if (sim) score.set(d.id, sim / 10); });
  }
  const top = [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit);
  const rows = (await Promise.all(top.map(async ([u, n]) => { const p = await profile(ctx, u); return p ? { uid: u, name: p.name, year: p.year, branch: p.branch, mutual: Math.floor(n) } : null; }))).filter(Boolean);
  return { suggestions: rows };
}

module.exports = { CoreError, pairId, reqId, sendRequest, respond, cancelRequest, removeConnection, mutuals, suggestions };

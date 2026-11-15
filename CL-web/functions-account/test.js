'use strict';
const assert = require('assert');
const core = require('./lib/core');
/* tiny in-memory Firestore: paths -> data */
function fake(seed) {
  const store = new Map(Object.entries(seed));
  const FV = { serverTimestamp: () => 'TS' };
  const idOf = (p) => p.split('/').pop();
  const kids = (col) => [...store.keys()].filter((k) => k.startsWith(col + '/') && k.split('/').length === col.split('/').length + 1);
  const docRef = (p) => ({ path: p, id: idOf(p), delete: async () => { store.delete(p); }, collection: (c) => colRef(p + '/' + c),
    get: async () => ({ exists: store.has(p), data: () => store.get(p), id: idOf(p), ref: docRef(p) }), set: async (d) => { store.set(p, d); }, update: async (d) => { store.set(p, Object.assign({}, store.get(p), d)); } });
  const colRef = (c, filters = [], lim) => ({ where: (f, op, v) => colRef(c, filters.concat([[f, op, v]]), lim), limit: (n) => colRef(c, filters, n), doc: (i) => docRef(c + '/' + (i || 'auto' + Math.random())),
    get: async () => { let ks = kids(c).filter((k) => filters.every(([f, op, v]) => op === '==' ? store.get(k)[f] === v : (store.get(k)[f] || []).includes(v))); if (lim) ks = ks.slice(0, lim);
      return { empty: !ks.length, size: ks.length, docs: ks.map((k) => ({ id: idOf(k), ref: docRef(k), data: () => store.get(k) })) }; },
    listDocuments: async () => [...new Set([...store.keys()].filter((k) => k.startsWith(c + '/')).map((k) => c + '/' + k.slice(c.length + 1).split('/')[0]))].map(docRef) });
  return { store, FV, db: { collection: colRef, doc: docRef, batch: () => { const ops = []; return { delete: (r) => ops.push(() => store.delete(r.path)), update: (r, d) => ops.push(() => store.set(r.path, Object.assign({}, store.get(r.path), d))),
    set: (r, d, o) => ops.push(() => store.set(r.path, o && o.merge ? Object.assign({}, store.get(r.path), d) : d)), create: (r, d) => ops.push(() => store.set(r.path, d)), commit: async () => ops.forEach((f) => f()) }; },
    recursiveDelete: async (r) => { [...store.keys()].filter((k) => k === r.path || k.startsWith(r.path + '/')).forEach((k) => store.delete(k)); } } };
}
(async () => {
  const f = fake({
    'userProfiles/u1': { year: '1' }, 'publicProfiles/u1': { name: 'A' }, 'userProfiles/u2': {},
    'userData/u1/items/csec_x': { v: '1' }, 'quizAttempts/a1': { uid: 'u1' }, 'quizAttempts/a2': { uid: 'u2' },
    'chatRooms/year1/messages/m1': { anonymousId: 'u1' }, 'chatRooms/year1/messages/m2': { anonymousId: 'u2' },
    'examQuestions/q1': { anonymousId: 'u2' }, 'examQuestions/q1/answers/a': { anonymousId: 'u1' }, 'examQuestions/q1/answers/b': { anonymousId: 'u2' }, 'examQuestions/q1/reactions/u1': { anonymousId: 'u1' },
    'quizBoards/k_FY_ALL/entries/u1': { uid: 'u1' }, 'quizBoards/k_FY_ALL/entries/u2': { uid: 'u2' },
    'teams/t1': { leaderUid: 'u1', leaderName: 'A', memberUids: ['u1', 'u2'], memberCount: 2, name: 'T' }, 'teams/t1/members/u1': { role: 'leader' }, 'teams/t1/members/u2': { role: 'member', name: 'B' },
    'teams/t2': { leaderUid: 'u2', memberUids: ['u2', 'u1'], memberCount: 2 }, 'teams/t2/members/u1': {}, 'teams/t2/members/u2': {},
    'teams/t3': { leaderUid: 'u1', memberUids: ['u1'], memberCount: 1 }, 'teams/t3/members/u1': {},
    'teamRequests/r1': { from: 'u1', to: 'u2', teamId: 't2' }, 'connections/c1': { users: ['u1', 'u2'] }, 'communityLinks/l1': { anonymousId: 'u1' },
  });
  let authDeleted = null, files = null;
  const ctx = Object.assign({ nowMs: 1e12, deleteFiles: async (p) => { files = p; }, deleteAuthUser: async (u) => { authDeleted = u; } }, { db: f.db, FV: f.FV });
  const fresh = { auth_time: 1e12 / 1000 - 10 };
  await assert.rejects(core.deleteAccount(ctx, 'u1', fresh, {}), /DELETE/);
  await assert.rejects(core.deleteAccount(ctx, 'u1', { owner: true, auth_time: fresh.auth_time }, { confirm: 'DELETE' }), /admin/);
  await assert.rejects(core.deleteAccount(ctx, 'u1', { auth_time: 1e12 / 1000 - 3600 }, { confirm: 'DELETE' }), /sign in again/);
  assert.strictEqual(authDeleted, null);
  await core.deleteAccount(ctx, 'u1', fresh, { confirm: 'DELETE' });
  const s = f.store, has = (k) => s.has(k);
  assert.strictEqual(authDeleted, 'u1'); assert.strictEqual(files, 'chatMedia/u1/');
  ['userProfiles/u1', 'publicProfiles/u1', 'userData/u1/items/csec_x', 'quizAttempts/a1', 'chatRooms/year1/messages/m1', 'examQuestions/q1/answers/a', 'examQuestions/q1/reactions/u1',
    'quizBoards/k_FY_ALL/entries/u1', 'teams/t3', 'teams/t3/members/u1', 'teams/t2/members/u1', 'teams/t1/members/u1', 'teamRequests/r1', 'connections/c1', 'communityLinks/l1'].forEach((k) => assert(!has(k), 'should be gone: ' + k));
  ['userProfiles/u2', 'quizAttempts/a2', 'chatRooms/year1/messages/m2', 'examQuestions/q1', 'examQuestions/q1/answers/b', 'quizBoards/k_FY_ALL/entries/u2', 'teams/t1', 'teams/t2'].forEach((k) => assert(has(k), 'should remain: ' + k));
  assert.strictEqual(s.get('teams/t1').leaderUid, 'u2'); assert.deepStrictEqual(s.get('teams/t1').memberUids, ['u2']); assert.deepStrictEqual(s.get('teams/t2').memberUids, ['u2']);
  assert.strictEqual(s.get('teams/t1/members/u2').role, 'leader');
  // a failing step must keep the Auth user (retry possible)
  authDeleted = null; const bad = Object.assign({}, ctx, { deleteFiles: async () => { throw new Error('x'); } });
  await assert.rejects(core.deleteAccount(bad, 'u2', fresh, { confirm: 'DELETE' }), /storage/); assert.strictEqual(authDeleted, null);
  console.log('all account-delete tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

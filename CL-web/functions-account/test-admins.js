'use strict';
/* Offline tests for lib/admins.js (fake Auth + Firestore). Run: node test-admins.js */
const assert = require('assert');
const A = require('./lib/admins');

function mk() {
  const users = {}, byEmail = {}, store = {}, tokens = [];
  const addUser = (u) => { users[u.uid] = Object.assign({ customClaims: null, disabled: false, emailVerified: true, displayName: '' }, u); byEmail[u.email.toLowerCase()] = u.uid; };
  const nf = () => { const e = new Error('nf'); e.code = 'auth/user-not-found'; return e; };
  const auth = {
    getUser: async (uid) => { if (!users[uid]) throw nf(); return users[uid]; },
    getUserByEmail: async (em) => { const id = byEmail[em]; if (!id) throw nf(); return users[id]; },
    setCustomUserClaims: async (uid, c) => { users[uid].customClaims = c; },
    revokeRefreshTokens: async (uid) => { tokens.push(uid); },
  };
  const ts = { toMillis: () => 1000 };
  const FV = { serverTimestamp: () => ts };
  const col = (name) => ({
    doc: (id) => ({
      get: async () => ({ exists: !!(store[name] && store[name][id]), data: () => (store[name] || {})[id] }),
      set: async (v) => { (store[name] = store[name] || {})[id] = v; },
      delete: async () => { if (store[name]) delete store[name][id]; },
    }),
    orderBy: () => ({ limit: () => ({ get: async () => ({ docs: Object.keys(store[name] || {}).map((id) => ({ id, data: () => store[name][id] })) }) }) }),
  });
  return { ctx: { auth, db: { collection: col }, FV }, addUser, users, store, tokens };
}
const fails = async (p, code) => { try { await p; } catch (e) { assert.strictEqual(e.code, code, 'expected ' + code + ' got ' + e.code + ' ' + e.message); return; } assert.fail('expected ' + code); };

(async () => {
  const m = mk();
  m.addUser({ uid: 'root', email: 'root@x.com', customClaims: { owner: true } });
  m.addUser({ uid: 'stu', email: 'Stu@x.com', displayName: 'Stu' });
  m.addUser({ uid: 'unv', email: 'unv@x.com', emailVerified: false });
  m.addUser({ uid: 'cr', email: 'sec_a@cr.cse-hub.app' });
  m.addUser({ uid: 'crAcc', email: 'cracc@x.com' }); m.store.crAccounts = { crAcc: { section: 'A' } };
  m.addUser({ uid: 'off', email: 'off@x.com', disabled: true });
  m.addUser({ uid: 'plain', email: 'plain@x.com' });

  await fails(A.grantAdmin(m.ctx, 'stu', { email: 'plain@x.com' }), 'permission-denied');                 // not an admin
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'nope' }), 'invalid-argument');
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'sec_a@cr.cse-hub.app' }), 'failed-precondition');
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'ghost@x.com' }), 'not-found');
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'unv@x.com' }), 'failed-precondition');                // unverified email
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'off@x.com' }), 'failed-precondition');
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'cracc@x.com' }), 'failed-precondition');              // CR
  await fails(A.grantAdmin(m.ctx, 'root', { email: 'root@x.com' }), 'failed-precondition');               // self

  const g = await A.grantAdmin(m.ctx, 'root', { email: '  STU@x.com ' });
  assert.strictEqual(g.status, 'granted'); assert.strictEqual(m.users.stu.customClaims.owner, true);
  assert.ok(m.store.adminGrants.stu && m.store.adminGrants.stu.grantedBy === 'root');
  assert.strictEqual((await A.grantAdmin(m.ctx, 'root', { email: 'stu@x.com' })).status, 'already');

  // a delegated admin can see the list but cannot manage admins
  await fails(A.grantAdmin(m.ctx, 'stu', { email: 'plain@x.com' }), 'permission-denied');
  await fails(A.revokeAdmin(m.ctx, 'stu', { uid: 'root' }), 'permission-denied');
  const l1 = await A.listAdmins(m.ctx, 'stu'); assert.strictEqual(l1.canManage, false); assert.strictEqual(l1.admins.length, 1);
  const l2 = await A.listAdmins(m.ctx, 'root'); assert.strictEqual(l2.canManage, true); assert.strictEqual(l2.admins[0].email, 'Stu@x.com');

  // the main admin cannot be removed; self removal refused; other claims survive a removal
  await fails(A.revokeAdmin(m.ctx, 'root', { uid: 'root' }), 'failed-precondition');
  await fails(A.revokeAdmin(m.ctx, 'root', { uid: 'plain' }), 'failed-precondition');
  await fails(A.revokeAdmin(m.ctx, 'root', { uid: '../x' }), 'invalid-argument');
  m.users.stu.customClaims = { owner: true, other: 1 };
  assert.deepStrictEqual(await A.revokeAdmin(m.ctx, 'root', { uid: 'stu' }), { status: 'removed', uid: 'stu' });
  assert.deepStrictEqual(m.users.stu.customClaims, { other: 1 }); assert.deepStrictEqual(m.tokens, ['stu']); assert.ok(!m.store.adminGrants.stu);

  // a removed admin is refused immediately, even with an old token (checked against Auth, not the token)
  await fails(A.listAdmins(m.ctx, 'stu'), 'permission-denied');
  console.log('admin tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
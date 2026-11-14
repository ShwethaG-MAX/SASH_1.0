'use strict';
const assert = require('assert');
const { makeDb, FieldValue: FV } = require('./test/fakeFirestore');
const core = require('./lib/core');
const tests = []; const t = (n, f) => tests.push([n, f]);
const rejects = async (p, code) => { try { await p; } catch (e) { assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return; } assert.fail('expected ' + code); };

async function world() {
  const db = makeDb(); const put = (p, d) => db.doc(p).set(d);
  for (const [u, n, b, y] of [['alice', 'Alice', 'CSE', '1'], ['bob', 'Bob', 'ISE', '2'], ['carol', 'Carol', 'ECE', '1'], ['dave', 'Dave', 'CSE', '2']]) await put('publicProfiles/' + u, { name: n, branch: b, year: y });
  return { db, ctx: (now) => ({ db, FV, nowMs: now || 1e12 }) };
}
const mk = (ctx, uid, o) => core.createTeam(ctx, uid, Object.assign({ name: 'Hack Squad', project: 'SIH', desc: 'Build a thing', skills: ['React', 'react', 'Python'], maxMembers: 3, eligibility: 'Any branch', rules: 'Be kind' }, o));
const team = async (db, id) => (await db.doc('teams/' + id).get()).data();
const notifs = async (db, u) => (await db.collection('teamNotifs').doc(u).collection('items').get()).docs.map((d) => d.data());

t('create: validates, dedups skills, leader is member', async () => {
  const { db, ctx } = await world(); const c = ctx();
  await rejects(core.createTeam(c, 'alice', { name: 'ab', desc: 'x', maxMembers: 3 }), 'invalid-argument');
  await rejects(core.createTeam(c, 'alice', { name: 'Good name', desc: '', maxMembers: 3 }), 'invalid-argument');
  await rejects(core.createTeam(c, 'alice', { name: 'Good name', desc: 'x', maxMembers: 1 }), 'invalid-argument');
  await rejects(core.createTeam(c, 'ghost', { name: 'Good name', desc: 'x', maxMembers: 3 }), 'failed-precondition');
  const { teamId } = await mk(c, 'alice'); const tm = await team(db, teamId);
  assert.deepStrictEqual(tm.skills, ['React', 'Python']); assert.deepStrictEqual(tm.memberUids, ['alice']); assert.strictEqual(tm.memberCount, 1); assert.strictEqual(tm.leaderName, 'Alice'); assert.strictEqual(tm.open, true);
  assert.strictEqual((await db.doc(`teams/${teamId}/members/alice`).get()).data().role, 'leader');
});
t('create: leader limit', async () => {
  const { ctx } = await world(); const c = ctx();
  for (let i = 0; i < core.LIM.LEAD_MAX; i++) await mk(c, 'alice', { name: 'Team ' + i });
  await rejects(mk(c, 'alice', { name: 'One more' }), 'resource-exhausted');
});
t('request: send, duplicate, notify leader, leader cannot request own team', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice');
  await core.sendRequest(c, 'bob', { teamId, message: 'I know React' });
  const r = (await db.doc(`teamRequests/${teamId}_bob`).get()).data();
  assert.strictEqual(r.status, 'pending'); assert.strictEqual(r.to, 'alice'); assert.strictEqual(r.fromName, 'Bob'); assert.strictEqual(r.message, 'I know React');
  await rejects(core.sendRequest(c, 'bob', { teamId }), 'already-exists');
  await rejects(core.sendRequest(c, 'alice', { teamId }), 'already-exists');
  const n = await notifs(db, 'alice'); assert.strictEqual(n.length, 1); assert.strictEqual(n[0].type, 'request'); assert.strictEqual(n[0].read, false);
  await rejects(core.sendRequest(c, 'bob', { teamId: 'nope' }), 'not-found');
});
t('request: cancel by sender only while pending', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice');
  await rejects(core.cancelRequest(c, 'bob', { teamId }), 'not-found');
  await core.sendRequest(c, 'bob', { teamId }); await core.cancelRequest(c, 'bob', { teamId });
  assert.strictEqual((await db.doc(`teamRequests/${teamId}_bob`).get()).data().status, 'cancelled');
  await rejects(core.cancelRequest(c, 'bob', { teamId }), 'failed-precondition');
  await core.sendRequest(c, 'bob', { teamId });   // can ask again after cancelling
  await rejects(core.decideRequest(c, 'carol', { teamId, from: 'bob', accept: true }), 'permission-denied');
});
t('accept: adds member, count, notifies; capacity enforced', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice', { maxMembers: 2 });
  await core.sendRequest(c, 'bob', { teamId }); await core.sendRequest(c, 'carol', { teamId });
  await core.decideRequest(c, 'alice', { teamId, from: 'bob', accept: true });
  let tm = await team(db, teamId); assert.deepStrictEqual(tm.memberUids, ['alice', 'bob']); assert.strictEqual(tm.memberCount, 2);
  const m = (await db.doc(`teams/${teamId}/members/bob`).get()).data(); assert.strictEqual(m.role, 'member'); assert.strictEqual(m.branch, 'ISE');
  assert.strictEqual((await notifs(db, 'bob'))[0].type, 'accepted');
  await rejects(core.decideRequest(c, 'alice', { teamId, from: 'carol', accept: true }), 'failed-precondition');   // full
  await rejects(core.sendRequest(c, 'dave', { teamId }), 'failed-precondition');
  await rejects(core.decideRequest(c, 'alice', { teamId, from: 'bob', accept: true }), 'failed-precondition');       // already answered
  assert.strictEqual((await db.doc(`teamRequests/${teamId}_carol`).get()).data().status, 'pending');
});
t('reject: status, notify, cooldown then retry', async () => {
  const { db, ctx } = await world(); const { teamId } = await mk(ctx(), 'alice');
  await core.sendRequest(ctx(1e12), 'bob', { teamId }); await core.decideRequest(ctx(), 'alice', { teamId, from: 'bob', accept: false });
  assert.strictEqual((await db.doc(`teamRequests/${teamId}_bob`).get()).data().status, 'rejected'); assert.strictEqual((await notifs(db, 'bob'))[0].type, 'rejected');
  await rejects(core.sendRequest(ctx(Date.now() + 60000), 'bob', { teamId }), 'failed-precondition');
  await core.sendRequest(ctx(Date.now() + 2 * 3600e3), 'bob', { teamId });
  assert.strictEqual((await db.doc(`teamRequests/${teamId}_bob`).get()).data().status, 'pending');
});
t('closed team rejects requests', async () => {
  const { ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice');
  await core.updateTeam(c, 'alice', { teamId, open: false });
  await rejects(core.sendRequest(c, 'bob', { teamId }), 'failed-precondition');
  await core.updateTeam(c, 'alice', { teamId, open: true }); await core.sendRequest(c, 'bob', { teamId });
});
t('update: leader only; cannot shrink below members', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice', { maxMembers: 4 });
  await core.sendRequest(c, 'bob', { teamId }); await core.decideRequest(c, 'alice', { teamId, from: 'bob', accept: true });
  await rejects(core.updateTeam(c, 'bob', { teamId, name: 'Hijack' }), 'permission-denied');
  await rejects(core.updateTeam(c, 'alice', { teamId, maxMembers: 1 }), 'invalid-argument');
  await core.updateTeam(c, 'alice', { teamId, maxMembers: 2, skills: ['Go'], desc: 'New' });
  const tm = await team(db, teamId); assert.strictEqual(tm.maxMembers, 2); assert.deepStrictEqual(tm.skills, ['Go']); assert.strictEqual(tm.name, 'Hack Squad');
  await rejects(core.updateTeam(c, 'alice', { teamId }), 'invalid-argument');
});
t('remove member / leave team', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice', { maxMembers: 4 });
  for (const u of ['bob', 'carol']) { await core.sendRequest(c, u, { teamId }); await core.decideRequest(c, 'alice', { teamId, from: u, accept: true }); }
  await rejects(core.removeMember(c, 'bob', { teamId, member: 'carol' }), 'permission-denied');
  await rejects(core.removeMember(c, 'alice', { teamId, member: 'alice' }), 'invalid-argument');
  await core.removeMember(c, 'alice', { teamId, member: 'bob' });
  let tm = await team(db, teamId); assert.deepStrictEqual(tm.memberUids, ['alice', 'carol']); assert.strictEqual(tm.memberCount, 2);
  assert.strictEqual((await db.doc(`teams/${teamId}/members/bob`).get()).exists, false); assert.strictEqual((await notifs(db, 'bob')).pop().type, 'removed');
  await core.sendRequest(c, 'bob', { teamId });   // removed member may re-apply
  await core.leaveTeam(c, 'carol', { teamId });
  tm = await team(db, teamId); assert.deepStrictEqual(tm.memberUids, ['alice']); assert.strictEqual((await notifs(db, 'alice')).filter((n) => n.type === 'left').length, 1);
  await rejects(core.leaveTeam(c, 'carol', { teamId }), 'failed-precondition');
  await rejects(core.leaveTeam(c, 'alice', { teamId }), 'failed-precondition');
});
t('transfer leadership moves pending requests', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice', { maxMembers: 4 });
  await core.sendRequest(c, 'bob', { teamId }); await core.decideRequest(c, 'alice', { teamId, from: 'bob', accept: true });
  await core.sendRequest(c, 'carol', { teamId });
  await rejects(core.transferLeader(c, 'bob', { teamId, member: 'bob' }), 'permission-denied');
  await rejects(core.transferLeader(c, 'alice', { teamId, member: 'dave' }), 'invalid-argument');
  await core.transferLeader(c, 'alice', { teamId, member: 'bob' });
  const tm = await team(db, teamId); assert.strictEqual(tm.leaderUid, 'bob'); assert.strictEqual(tm.leaderName, 'Bob');
  assert.strictEqual((await db.doc(`teams/${teamId}/members/alice`).get()).data().role, 'member');
  assert.strictEqual((await db.doc(`teamRequests/${teamId}_carol`).get()).data().to, 'bob');
  await core.decideRequest(c, 'bob', { teamId, from: 'carol', accept: true });
  await core.leaveTeam(c, 'alice', { teamId });
});
t('delete team: members, requests and notifications cleaned up', async () => {
  const { db, ctx } = await world(); const c = ctx(); const { teamId } = await mk(c, 'alice', { maxMembers: 4 });
  await core.sendRequest(c, 'bob', { teamId }); await core.decideRequest(c, 'alice', { teamId, from: 'bob', accept: true }); await core.sendRequest(c, 'carol', { teamId });
  await rejects(core.deleteTeam(c, 'bob', { teamId }), 'permission-denied');
  await core.deleteTeam(c, 'alice', { teamId });
  assert.strictEqual((await db.doc('teams/' + teamId).get()).exists, false); assert.strictEqual((await db.doc(`teams/${teamId}/members/bob`).get()).exists, false);
  assert.strictEqual((await db.doc(`teamRequests/${teamId}_carol`).get()).data().status, 'cancelled');
  assert.strictEqual((await notifs(db, 'bob')).pop().type, 'disbanded'); assert.strictEqual((await notifs(db, 'carol')).pop().type, 'disbanded');
});
t('join limit and outgoing pending limit', async () => {
  const { db, ctx } = await world(); const c = ctx(); const ids = [];
  for (let i = 0; i < 11; i++) { await db.doc('publicProfiles/L' + i).set({ name: 'L' + i }); ids.push((await mk(c, 'L' + i, { name: 'Squad ' + i })).teamId); }
  for (let i = 0; i < 10; i++) await core.sendRequest(c, 'dave', { teamId: ids[i] });
  await rejects(core.sendRequest(c, 'dave', { teamId: ids[10] }), 'resource-exhausted');
});

(async () => { let ok = 0; for (const [n, f] of tests) { try { await f(); ok++; console.log('ok  ' + n); } catch (e) { console.error('FAIL ' + n + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } } console.log(`${ok}/${tests.length} passed`); })();

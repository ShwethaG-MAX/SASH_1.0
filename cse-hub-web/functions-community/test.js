'use strict';
const assert = require('assert');
const { makeDb, FieldValue: FV, Timestamp } = require('./test/fakeFirestore');
const core = require('./lib/core');

let passed = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const rejects = async (p, code) => { try { await p; } catch (e) { assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return; } assert.fail('expected rejection ' + code); };

const NOW = 1_800_000_000_000;
function seed() {
  const db = makeDb();
  const put = (path, d) => db.doc(path).set(d);
  return { db, put };
}
async function world() {
  const { db, put } = seed();
  await put('userProfiles/alice', { name: 'Alice', year: '1', branch: 'CSE' });
  await put('userProfiles/bob', { name: 'Bob', year: '2', branch: 'ISE' });
  for (let i = 0; i < 8; i++) await put(`chatRooms/linklearn/messages/m${i}`, { room: 'linklearn', anonymousId: i === 7 ? 'bob' : 'carol', message: 'hello ' + i, createdAt: Timestamp.fromMillis(NOW - (10 - i) * 1000) });
  await put('chatRooms/year1/messages/s1', { room: 'year1', anonymousId: 'bob', message: 'study msg', createdAt: Timestamp.fromMillis(NOW - 500) });
  await put('chatRooms/year1/reactions/m7_x', { msgId: 'm7', uid: 'x', emoji: '👍' });
  await put('chatRooms/linklearn/reactions/m7_x', { msgId: 'm7', uid: 'x', emoji: '👍' });
  return db;
}
const ctx = (db) => ({ db, FV, Timestamp, nowMs: NOW });

t('report stores server snapshot, names, context (same room only)', async () => {
  const db = await world();
  const r = await core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'm7', reason: 'spam', details: '  buy now  ' });
  assert.strictEqual(r.reportId, 'linklearn_m7_alice');
  const d = (await db.doc('chatReports/linklearn_m7_alice').get()).data();
  assert.strictEqual(d.reportedUid, 'bob'); assert.strictEqual(d.reportedName, 'Bob'); assert.strictEqual(d.reporterName, 'Alice');
  assert.strictEqual(d.messageText, 'hello 7'); assert.strictEqual(d.details, 'buy now'); assert.strictEqual(d.status, 'pending');
  assert.strictEqual(d.context.length, 5); assert.deepStrictEqual(d.context.map((c) => c.id), ['m2', 'm3', 'm4', 'm5', 'm6']);
  assert.ok(!d.context.some((c) => c.id === 's1'));
});
t('duplicate report rejected', async () => {
  const db = await world();
  await core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'm7', reason: 'spam' });
  await rejects(core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'm7', reason: 'abusive' }), 'already-exists');
});
t('self report rejected', async () => {
  const db = await world();
  await rejects(core.createReport(ctx(db), 'bob', { room: 'linklearn', messageId: 'm7', reason: 'spam' }), 'failed-precondition');
});
t('unknown room / reason / bad id rejected', async () => {
  const db = await world();
  await rejects(core.createReport(ctx(db), 'alice', { room: 'general', messageId: 'm7', reason: 'spam' }), 'invalid-argument');
  await rejects(core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'm7', reason: 'nope' }), 'invalid-argument');
  await rejects(core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'a/b', reason: 'spam' }), 'invalid-argument');
});
t('cross-room messageId is not found', async () => {
  const db = await world();
  await rejects(core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 's1', reason: 'spam' }), 'not-found');
  await rejects(core.createReport(ctx(db), 'alice', { room: 'year1', messageId: 'm7', reason: 'spam' }), 'not-found');
});
t('rate limit: 11th report within an hour refused, old ones do not count', async () => {
  const db = await world();
  for (let i = 0; i < 12; i++) await db.doc(`chatRooms/linklearn/messages/x${i}`).set({ room: 'linklearn', anonymousId: 'bob', message: 'm' + i, createdAt: Timestamp.fromMillis(NOW - 100) });
  for (let i = 0; i < 10; i++) await core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'x' + i, reason: 'spam' });
  await rejects(core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'x10', reason: 'spam' }), 'resource-exhausted');
  await core.createReport({ ...ctx(db), nowMs: NOW + 2 * 3600 * 1000 }, 'alice', { room: 'linklearn', messageId: 'x10', reason: 'spam' });
});
t('restrictionActive honours room, expiry and until-lifted', async () => {
  assert.ok(core.restrictionActive({ rooms: ['linklearn'], until: null }, 'linklearn', NOW));
  assert.ok(!core.restrictionActive({ rooms: ['linklearn'], until: null }, 'year1', NOW));
  assert.ok(core.restrictionActive({ rooms: ['year1'], until: Timestamp.fromMillis(NOW + 1) }, 'year1', NOW));
  assert.ok(!core.restrictionActive({ rooms: ['year1'], until: Timestamp.fromMillis(NOW - 1) }, 'year1', NOW));
  assert.ok(!core.restrictionActive(null, 'year1', NOW));
});
async function withReport() {
  const db = await world();
  await core.createReport(ctx(db), 'alice', { room: 'linklearn', messageId: 'm7', reason: 'harassment' });
  return db;
}
const mod = (db, input, now) => core.moderate({ ...ctx(db), nowMs: now || NOW }, 'admin1', input);
const RID = 'linklearn_m7_alice';
const logs = async (db) => (await db.collection('chatModerationLog').get()).docs.map((d) => d.data());

t('moderate: setStatus + audit', async () => {
  const db = await withReport();
  await mod(db, { reportId: RID, action: 'setStatus', status: 'resolved', note: 'ok' });
  const r = (await db.doc('chatReports/' + RID).get()).data();
  assert.strictEqual(r.status, 'resolved'); assert.strictEqual(r.reviewedBy, 'admin1');
  const l = await logs(db); assert.strictEqual(l.length, 1); assert.strictEqual(l[0].action, 'setStatus'); assert.strictEqual(l[0].by, 'admin1');
  await rejects(mod(db, { reportId: RID, action: 'setStatus', status: 'bogus' }), 'invalid-argument');
});
t('moderate: warn writes chatWarnings for the reported user', async () => {
  const db = await withReport();
  await mod(db, { reportId: RID, action: 'warn', text: 'Be kind.' });
  const w = (await db.collection('chatWarnings').get()).docs.map((d) => d.data());
  assert.strictEqual(w.length, 1); assert.strictEqual(w[0].uid, 'bob'); assert.strictEqual(w[0].room, 'linklearn');
  assert.strictEqual((await db.doc('chatReports/' + RID).get()).data().status, 'reviewed');
  await rejects(mod(db, { reportId: RID, action: 'warn', text: '  ' }), 'invalid-argument');
  assert.strictEqual((await logs(db)).length, 1);
});
t('moderate: deleteMessage removes only that room\'s message + reactions', async () => {
  const db = await withReport();
  await mod(db, { reportId: RID, action: 'deleteMessage' });
  assert.ok(!(await db.doc('chatRooms/linklearn/messages/m7').get()).exists);
  assert.ok(!(await db.doc('chatRooms/linklearn/reactions/m7_x').get()).exists);
  assert.ok((await db.doc('chatRooms/year1/reactions/m7_x').get()).exists, 'other room untouched');
  assert.ok((await db.doc('chatRooms/year1/messages/s1').get()).exists);
  assert.strictEqual((await db.doc('chatReports/' + RID).get()).data().messageDeleted, true);
});
t('moderate: restrict (room / both / until lifted) then unrestrict', async () => {
  const db = await withReport();
  await mod(db, { reportId: RID, action: 'restrict', hours: 24, scope: 'room' });
  let r = (await db.doc('chatRestrictions/bob').get()).data();
  assert.deepStrictEqual(r.rooms, ['linklearn']); assert.strictEqual(r.until.toMillis(), NOW + 24 * 3600 * 1000);
  await mod(db, { reportId: RID, action: 'restrict', hours: 0, scope: 'both' });
  r = (await db.doc('chatRestrictions/bob').get()).data();
  assert.deepStrictEqual(r.rooms.sort(), ['linklearn', 'year1', 'year2']); assert.strictEqual(r.until, null);
  await mod(db, { reportId: RID, action: 'unrestrict', scope: 'room' });
  r = (await db.doc('chatRestrictions/bob').get()).data();
  assert.deepStrictEqual(r.rooms.sort(), ['year1', 'year2']);
  await mod(db, { reportId: RID, action: 'unrestrict', scope: 'both' });
  assert.ok(!(await db.doc('chatRestrictions/bob').get()).exists);
  await rejects(mod(db, { reportId: RID, action: 'restrict', hours: 5, scope: 'x' }), 'invalid-argument');
  await rejects(mod(db, { reportId: RID, action: 'restrict', hours: 99999, scope: 'room' }), 'invalid-argument');
  assert.strictEqual((await logs(db)).length, 4);
});
t('moderate: dismiss resolves; unknown report / action rejected', async () => {
  const db = await withReport();
  await mod(db, { reportId: RID, action: 'dismiss' });
  const r = (await db.doc('chatReports/' + RID).get()).data();
  assert.strictEqual(r.status, 'resolved'); assert.strictEqual(r.lastAction, 'dismissed');
  await rejects(mod(db, { reportId: 'nope', action: 'dismiss' }), 'not-found');
  await rejects(mod(db, { reportId: RID, action: 'ban' }), 'invalid-argument');
  await rejects(mod(db, {}), 'invalid-argument');
});
t('non-admin callable is denied (index.js guard)', async () => {
  const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
  assert.ok(/token\.owner !== true[\s\S]{0,80}permission-denied/.test(src), 'chatModerate must refuse non-owners');
  assert.ok(/!req\.auth[\s\S]{0,120}unauthenticated/.test(src));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exit(1); }
  }
  console.log(`${passed}/${tests.length} community tests passed`);
})();

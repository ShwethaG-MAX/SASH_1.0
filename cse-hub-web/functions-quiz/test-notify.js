'use strict';
/* Offline unit test for lib/notify.js (reminders + results). Uses the REAL core.js helpers with firebase stubbed out, so it runs without npm install.
   Run: node test-notify.js */
const Module = require('module'), assert = require('assert');
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'firebase-admin') { const f = () => ({}); f.firestore = Object.assign(() => ({}), { FieldValue: { serverTimestamp() {}, increment() {} }, Timestamp: {} }); return { apps: [1], initializeApp() {}, firestore: f.firestore }; }
  if (req === 'firebase-functions/v2/https') return { HttpsError: class extends Error {} };
  return origLoad.call(this, req, ...a);
};
const core = require('./lib/core');
Module._load = origLoad;
const { makeNotifier } = require('./lib/notify');
const { makeDb } = require('./test/fakeFirestore');

const today = core.istDate(), yday = core.addDays(today, -1);
function setup() {
  const db = makeDb(), sent = [];
  const messaging = { async sendEach(list) { list.forEach((m) => sent.push(m)); return { responses: list.map((m) => m.token.startsWith('BAD') ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true }) }; } };
  return { db, sent, n: makeNotifier({ db, messaging, core }) };
}
const T = (s) => s + 'x'.repeat(30);
async function seedUsers(db) {
  const U = { a: ['Asha K', '2', 'CSE'], b: ['Bala', '2', 'ISE'], c: ['Chitra', '1', 'ECE'], d: ['Dev', '2', 'CSE'], e: ['Esha', '2', 'CSE'] };
  for (const [uid, [name, year, branch]] of Object.entries(U)) {
    await db.doc('userProfiles/' + uid).set({ name, year, branch });
    await db.doc('deviceTokens/' + uid).set({ token: T(uid), answers: true, platform: 'android' });
  }
}
(async () => {
  // ---- reminders ----
  let { db, sent, n } = setup(); await seedUsers(db);
  await db.doc(`dailyQuizzes/${today}_SY_CSE_GROUP`).set({ status: 'published' });          // only second year has a quiz today
  await db.doc(`quizAttempts/${today}_SY_CSE_GROUP_a`).set({ uid: 'a', date: today, groupId: 'SY_CSE_GROUP', status: 'submitted' });
  await db.doc(`quizAttempts/${today}_SY_CSE_GROUP_b`).set({ uid: 'b', date: today, groupId: 'SY_CSE_GROUP', status: 'started' });
  await db.doc('deviceTokens/e').set({ token: T('e'), answers: true, platform: 'android', quiz: false });   // opted out
  let r = await n.sendReminders('evening');
  const to = sent.map((m) => m.token[0]).sort().join('');
  assert.strictEqual(to, 'bd', 'a solved, c has no quiz (year 1), e opted out → only b (unfinished) and d (never started): got ' + to);
  assert(/unfinished|haven’t submitted/.test(sent.find((m) => m.token[0] === 'b').notification.body));
  assert(/Dev, /.test(sent.find((m) => m.token[0] === 'd').notification.body));
  assert.strictEqual(sent[0].data.route, 'quiz'); assert.strictEqual(sent[0].android.notification.channel_id, 'quiz');
  sent.length = 0; r = await n.sendReminders('evening'); assert.strictEqual(sent.length, 0); assert.strictEqual(r.skipped, 'already sent');   // idempotent
  r = await n.sendReminders('last'); assert.strictEqual(sent.length, 2);                                                                      // other slot still runs
  assert(/Last call/.test(sent[0].notification.title));

  // no quiz published → nothing
  ({ db, sent, n } = setup()); await seedUsers(db);
  r = await n.sendReminders('evening'); assert.strictEqual(sent.length, 0); assert(r.skipped);

  // stale token is removed
  ({ db, sent, n } = setup()); await seedUsers(db);
  await db.doc('deviceTokens/d').set({ token: 'BAD' + 'x'.repeat(30), answers: true, platform: 'android' });
  await db.doc(`dailyQuizzes/${today}_SY_CSE_GROUP`).set({ status: 'published' });
  r = await n.sendReminders('evening'); assert.strictEqual(r.removed, 1); assert(!(await db.doc('deviceTokens/d').get()).exists);

  // ---- results ----
  ({ db, sent, n } = setup()); await seedUsers(db);
  const g = 'SY_CSE_GROUP', key = `${yday}_${g}`;
  await db.doc(`dailyQuizzes/${key}`).set({ status: 'finalized' });
  await db.doc(`dailyQuizResults/${key}_a`).set({ uid: 'a', date: yday, groupId: g, name: 'Asha K', rank: 1, correctCount: 3, xpAwarded: 50 });
  await db.doc(`dailyQuizResults/${key}_b`).set({ uid: 'b', date: yday, groupId: g, name: 'Bala', rank: 2, correctCount: 2, xpAwarded: 30 });
  r = await n.sendResults();
  const by = (u) => sent.find((m) => m.token[0] === u);
  assert(/topped/.test(by('a').notification.title) && /#1 of 2/.test(by('a').notification.body) && /3\/3/.test(by('a').notification.body) && /\+50 XP/.test(by('a').notification.body));
  assert(/podium/.test(by('b').notification.title));
  assert(/Top scorers: Asha, Bala/.test(by('d').notification.body), 'non-participant gets the summary');
  assert(!by('c'), 'year-1 student gets nothing for a second-year quiz');
  const before = sent.length; await n.sendResults(); assert.strictEqual(sent.length, before, 'results are sent once');

  // not finalised yet → nothing
  ({ db, sent, n } = setup()); await seedUsers(db);
  await db.doc(`dailyQuizzes/${key}`).set({ status: 'published' });
  await n.sendResults(); assert.strictEqual(sent.length, 0);

  // ---- weekly leaderboard (yesterday was a Sunday) ----
  {
    const c2 = Object.assign({}, core, { istDate: () => '2026-11-09' }); const db2 = makeDb(), sent2 = [];
    const m2 = { async sendEach(l) { l.forEach((m) => sent2.push(m)); return { responses: l.map(() => ({ success: true })) }; } };
    const nn = makeNotifier({ db: db2, messaging: m2, core: c2 }); await seedUsers(db2);
    const k = '2026-11-08_SY_CSE_GROUP', wk = core.weekId('2026-11-08');
    await db2.doc('dailyQuizzes/' + k).set({ status: 'finalized' });
    await db2.doc(`weeklyQuizResults/${wk}_SY_CSE_GROUP_a`).set({ uid: 'a', weekId: wk, groupId: 'SY_CSE_GROUP', rank: 1, totalXP: 120 });
    await nn.sendResults();
    const w = sent2.filter((m) => /Weekly/.test(m.notification.title));
    assert.strictEqual(w.length, 1); assert(/#1 of 1 this week with 120 XP/.test(w[0].notification.body));
    const c = sent2.length; await nn.sendResults(); assert.strictEqual(sent2.length, c, 'weekly sent once');
  }

  console.log('notify tests passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

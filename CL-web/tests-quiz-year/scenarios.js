'use strict';
const assert = require('assert');
const { store, fn, C } = require('./harness');
const date = C.istDate(), yday = C.addDays(date, -1);
let pass = 0, fail = 0; const failures = [];
async function t(name, f) { try { await f(); pass++; console.log('  PASS', name); } catch (e) { fail++; failures.push(name); console.log('  FAIL', name, '→', e.message.split('\n')[0]); } }
const req = (uid, data) => ({ auth: { uid, token: {} }, data: data || {} });
const qs = (tag) => [0, 1, 2].map((i) => ({ id: tag + i, text: `${tag} question number ${i}`, options: ['a', 'b', 'c', 'd'], category: 'X', difficulty: 'easy' }));
function seed() {
  store.clear();
  for (const d of [date, yday]) for (const g of ['FY_ALL', 'SY_CSE_GROUP']) {
    store.set(`dailyQuizzes/${d}_${g}`, { date: d, groupId: g, status: 'published', questions: qs(g) });
    store.set(`quizAnswerKeys/${d}_${g}`, { answers: [0, 0, 0], explanations: ['e', 'e', 'e'] });
  }
}
const profile = (uid, p) => store.set(`userProfiles/${uid}`, p);
const FY = { name: 'Fiona', year: '1', branch: 'CSE', sem: '1', cycle: 'P', section: 'FY-A1_A7' };
const SY = { name: 'Sam', year: '2', branch: 'CSE', sem: '3', section: 'A' };

(async () => {
  console.log('Group derivation');
  await t('1st-year profile → FY_ALL', async () => { seed(); profile('u1', FY); assert.equal((await fn.quizGetToday(req('u1'))).groupId, 'FY_ALL'); });
  await t('2nd-year CSE profile → SY_CSE_GROUP', async () => { seed(); profile('u2', SY); assert.equal((await fn.quizGetToday(req('u2'))).groupId, 'SY_CSE_GROUP'); });
  await t('2nd-year ISE / CSE AIML quiz-only branches → SY_CSE_GROUP', async () => { seed(); profile('u3', { name: 'I', year: '2', branch: 'ISE', section: 'SY-ISE_A' }); profile('u4', { name: 'A', year: '2', branch: 'CSEAIML' }); assert.equal((await fn.quizGetToday(req('u3'))).groupId, 'SY_CSE_GROUP'); assert.equal((await fn.quizGetToday(req('u4'))).groupId, 'SY_CSE_GROUP'); });
  await t('1st-year ECE (non-CSE) → FY_ALL', async () => { seed(); profile('u5', { name: 'E', year: '1', branch: 'ECE', section: 'FY-B' }); assert.equal((await fn.quizGetToday(req('u5'))).groupId, 'FY_ALL'); });
  await t('legacy profile, no year: section A–G → SY, section FY-* → FY', async () => { seed(); profile('l1', { name: 'L', section: 'B' }); profile('l2', { name: 'L', section: 'FY-B' }); assert.equal((await fn.quizGetToday(req('l1'))).groupId, 'SY_CSE_GROUP'); assert.equal((await fn.quizGetToday(req('l2'))).groupId, 'FY_ALL'); });

  console.log('Quiz content is year-specific (list / start / review / submit)');
  await t('1st-year student is served ONLY FY questions on start', async () => { seed(); profile('u1', FY); const r = await fn.quizStart(req('u1')); assert.equal(r.groupId, 'FY_ALL'); assert.ok(r.questions.every((q) => q.id.startsWith('FY_ALL'))); });
  await t('2nd-year student is served ONLY SY questions on start', async () => { seed(); profile('u2', SY); const r = await fn.quizStart(req('u2')); assert.equal(r.groupId, 'SY_CSE_GROUP'); assert.ok(r.questions.every((q) => q.id.startsWith('SY_CSE_GROUP'))); });
  await t('client-supplied groupId is ignored (direct access to other year)', async () => { seed(); profile('u1', FY); const g = await fn.quizGetToday(req('u1', { groupId: 'SY_CSE_GROUP' })); assert.equal(g.groupId, 'FY_ALL'); const s = await fn.quizStart(req('u1', { groupId: 'SY_CSE_GROUP', key: `${date}_SY_CSE_GROUP` })); assert.equal(s.groupId, 'FY_ALL'); assert.ok(s.questions.every((q) => q.id.startsWith('FY_ALL'))); });
  await t('review of another year\'s quiz is impossible (returns own year only)', async () => { seed(); profile('u1', FY); const r = await fn.quizReview(req('u1', { date: yday, groupId: 'SY_CSE_GROUP' })); assert.equal(r.groupId, 'FY_ALL'); assert.ok(r.review.every((q) => q.id.startsWith('FY_ALL'))); });
  await t('submit writes the attempt/board entry under the student\'s own year', async () => { seed(); profile('u1', FY); await fn.quizStart(req('u1')); const r = await fn.quizSubmit(req('u1', { answers: [0, 0, 0] })); assert.equal(r.correctCount, 3); assert.ok(store.has(`quizBoards/${date}_FY_ALL/entries/u1`)); assert.ok(!store.has(`quizBoards/${date}_SY_CSE_GROUP/entries/u1`)); });
  await t('submit without starting in own year is rejected (cannot submit into other year)', async () => { seed(); profile('u1', FY); await assert.rejects(() => fn.quizSubmit(req('u1', { answers: [0, 0, 0], groupId: 'SY_CSE_GROUP' })), /Start the quiz first/); });

  console.log('Switching year / accounts / refresh');
  await t('same device switches 2nd-year → 1st-year AFTER starting a quiz (stale weekly pin)', async () => { seed(); profile('dev', SY); await fn.quizStart(req('dev')); profile('dev', FY); const g = await fn.quizGetToday(req('dev')); assert.equal(g.groupId, 'FY_ALL', 'got ' + g.groupId); const s = await fn.quizStart(req('dev')); assert.equal(s.groupId, 'FY_ALL'); assert.ok(s.questions.every((q) => q.id.startsWith('FY_ALL'))); });
  await t('same device switches 1st-year → 2nd-year after starting a quiz', async () => { seed(); profile('dev', FY); await fn.quizStart(req('dev')); profile('dev', SY); const g = await fn.quizGetToday(req('dev')); assert.equal(g.groupId, 'SY_CSE_GROUP', 'got ' + g.groupId); });
  await t('two different accounts back-to-back each get their own year', async () => { seed(); profile('a', FY); profile('b', SY); for (let i = 0; i < 3; i++) { assert.equal((await fn.quizGetToday(req('a'))).groupId, 'FY_ALL'); assert.equal((await fn.quizGetToday(req('b'))).groupId, 'SY_CSE_GROUP'); } });
  await t('repeated calls (refresh / re-login) are stable', async () => { seed(); profile('a', FY); await fn.quizStart(req('a')); for (let i = 0; i < 4; i++) assert.equal((await fn.quizGetToday(req('a'))).groupId, 'FY_ALL'); });
  await t('submitted state follows the profile year after a switch', async () => { seed(); profile('dev', SY); await fn.quizStart(req('dev')); await fn.quizSubmit(req('dev', { answers: [0, 0, 0] })); profile('dev', FY); const g = await fn.quizGetToday(req('dev')); assert.equal(g.groupId, 'FY_ALL'); assert.equal(g.state, 'ready', 'FY quiz must not show the SY submission'); });
  await t('stats/history keep every attempt (progress tracking unchanged)', async () => { seed(); profile('dev', SY); await fn.quizStart(req('dev')); await fn.quizSubmit(req('dev', { answers: [0, 0, 0] })); profile('dev', FY); const s = await fn.quizMyStats(req('dev')); assert.equal(s.attempted, 1); assert.equal(s.groupId, 'FY_ALL'); });

  console.log('Missing / invalid academic year is handled safely (never defaults to 2nd year)');
  for (const [label, p] of [
    ['no profile document', null], ['name only', { name: 'N' }], ['year "3"', { name: 'N', year: '3', branch: 'CSE' }], ['year "abc"', { name: 'N', year: 'abc' }],
    ['year 2 but FY section (contradiction)', { name: 'N', year: '2', branch: 'CSE', section: 'FY-A1_A7' }], ['year 1 but section A (contradiction)', { name: 'N', year: '1', branch: 'CSE', section: 'A' }],
    ['year 2 with unsupported branch ECE', { name: 'N', year: '2', branch: 'ECE' }], ['year 1 with unknown branch', { name: 'N', year: '1', branch: 'XYZ' }], ['year 2 no branch, no section', { name: 'N', year: '2' }],
  ]) await t(label + ' → needs_profile, no quiz, start refused', async () => { seed(); if (p) profile('x', p); const g = await fn.quizGetToday(req('x')); assert.equal(g.state, 'needs_profile'); assert.ok(!g.groupId); assert.ok(!g.questions); await assert.rejects(() => fn.quizStart(req('x')), /PROFILE_(GROUP|NAME)/); });
  await t('profile missing → stale pin from earlier cannot resurrect a quiz', async () => { seed(); profile('dev', SY); await fn.quizStart(req('dev')); profile('dev', { name: 'Sam' }); const g = await fn.quizGetToday(req('dev')); assert.equal(g.state, 'needs_profile'); });
  await t('numeric year (1 / 2) from a client is tolerated', async () => { seed(); profile('n1', { name: 'N', year: 1, branch: 'CSE' }); profile('n2', { name: 'N', year: 2, branch: 'CSE' }); assert.equal((await fn.quizGetToday(req('n1'))).groupId, 'FY_ALL'); assert.equal((await fn.quizGetToday(req('n2'))).groupId, 'SY_CSE_GROUP'); });

  console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
})();

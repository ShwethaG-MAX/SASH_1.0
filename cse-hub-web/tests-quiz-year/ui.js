'use strict';
const assert = require('assert');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { store, fn, C } = require('./harness');
const HTML = fs.readFileSync(process.env.HTML || require('path').resolve(__dirname, '../public/index.html'), 'utf8');
const quizJs = HTML.match(/<script id="quizJs">([\s\S]*?)<\/script>/)[1];
const date = C.istDate(), yday = C.addDays(date, -1);
const qs = (tag) => [0, 1, 2].map((i) => ({ id: tag + i, text: `${tag} question ${i}`, options: ['a', 'b', 'c', 'd'], category: 'X', difficulty: 'easy' }));
function seed() { store.clear(); for (const d of [date, yday]) for (const g of ['FY_ALL', 'SY_CSE_GROUP']) { store.set(`dailyQuizzes/${d}_${g}`, { date: d, groupId: g, status: 'published', questions: qs(g) }); store.set(`quizAnswerKeys/${d}_${g}`, { answers: [0, 0, 0], explanations: ['e', 'e', 'e'] }); } }
const FY = { year: '1', branch: 'CSE', sem: '1', cycle: 'P' }, SY = { year: '2', branch: 'CSE', sem: '3', cycle: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hooks = { tamper: null, calls: [] };

function boot(account) {                      // one "page load"
  const dom = new JSDOM(`<body data-mode="quiz"><div id="quizMode"><div id="qzBody"></div>
    <button data-qztab="daily"></button><button data-qztab="dboard"></button><button data-qztab="wboard"></button><button data-qztab="stats"></button></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.__acct = account;
  w.ACAD = account.acad; w.fbReady = true; w.fbUid = account.uid; w.currentUser = { name: account.name };
  w.escapeHtml = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w.toast = (m) => { w.__toast = m; };
  const cur = () => ({ uid: w.fbUid });
  w.firebase = {
    auth: () => ({ get currentUser() { return w.__acct.signedOut ? null : cur(); } }),
    functions: true,
    app: () => ({ functions: () => ({ httpsCallable: (name) => async (data) => {
      hooks.calls.push([name, w.fbUid]);
      try { let r = await fn[name]({ auth: { uid: w.fbUid, token: {} }, data }); if (hooks.tamper) r = hooks.tamper(name, r); return { data: r }; }
      catch (e) { const x = new Error(e.message); x.code = 'functions/' + e.code; throw x; } } }) }),
    firestore: { FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) } },
  };
  w.fbDb = { collection: (c) => ({
    doc: (id) => ({ set: async (d, o) => { store.set(`${c}/${id}`, Object.assign({}, (o && o.merge && store.get(`${c}/${id}`)) || {}, JSON.parse(JSON.stringify(d)))); } }),
    orderBy() { return this; }, limit() { return this; }, where() { return this; },
    onSnapshot(cb) { w.__boardPath = c; cb({ docs: [] }); return () => {}; }, get: async () => ({ docs: [] }) }) };
  w.eval(quizJs);
  return w;
}
const text = (w) => w.document.getElementById('qzBody').textContent;
const html = (w) => w.document.getElementById('qzBody').innerHTML;
const settle = async () => { for (let i = 0; i < 12; i++) await sleep(25); };
const clickTab = async (w, t) => { w.document.querySelector(`[data-qztab="${t}"]`).click(); await settle(); };
const clickQz = async (w, a) => { const b = w.document.querySelector(`[data-qz="${a}"]`); assert.ok(b, 'button ' + a + ' missing'); b.click(); await settle(); };
const FYLBL = 'First Year', SYLBL = 'Second Year';
let pass = 0, fail = 0; const failed = [];
async function t(name, f) { try { seed(); hooks.tamper = null; hooks.calls = []; await f(); pass++; console.log('  PASS', name); } catch (e) { fail++; failed.push(name); console.log('  FAIL', name, '→', e.message.split('\n')[0]); } }

(async () => {
  console.log('Client + server, simulated browser');
  await t('1. 1st-year login → only the 1st-year quiz is shown (profile not yet on server)', async () => {
    const w = boot({ uid: 'fy1', name: 'Fiona', acad: FY }); w.quizShow(); await settle();
    assert.ok(text(w).includes(FYLBL), text(w)); assert.ok(!text(w).includes(SYLBL)); assert.ok(text(w).includes('Start Quiz'));
    assert.equal(store.get('userProfiles/fy1').year, '1'); });
  await t('2. 2nd-year login → only the 2nd-year quiz is shown', async () => {
    const w = boot({ uid: 'sy1', name: 'Sam', acad: SY }); w.quizShow(); await settle();
    assert.ok(text(w).includes(SYLBL), text(w)); assert.ok(!text(w).includes(FYLBL)); });
  await t('3. switching accounts in the same page session updates the quiz (1st ↔ 2nd year)', async () => {
    const acct = { uid: 'fy1', name: 'Fiona', acad: FY }; const w = boot(acct); w.quizShow(); await settle(); assert.ok(text(w).includes(FYLBL));
    w.fbUid = 'sy1'; w.ACAD = SY; w.currentUser = { name: 'Sam' }; w.quizShow(); await settle(); assert.ok(text(w).includes(SYLBL) && !text(w).includes(FYLBL), text(w));
    w.fbUid = 'fy1'; w.ACAD = FY; w.currentUser = { name: 'Fiona' }; w.quizShow(); await settle(); assert.ok(text(w).includes(FYLBL) && !text(w).includes(SYLBL), text(w)); });
  await t('3b. logout → login as a different year keeps no stale quiz (also mid-quiz)', async () => {
    const w = boot({ uid: 'sy1', name: 'Sam', acad: SY }); w.quizShow(); await settle(); await clickQz(w, 'start'); assert.ok(text(w).includes('SY_CSE_GROUP question 0'), 'run started: ' + text(w).slice(0, 120));
    w.fbUid = 'fy1'; w.ACAD = FY; w.currentUser = { name: 'Fiona' }; w.quizShow(); await settle();
    assert.ok(text(w).includes(FYLBL) && !text(w).includes('SY_CSE_GROUP question') && !text(w).includes(SYLBL), text(w)); });
  await t('3c. SAME device/uid, 2nd-year quiz started, then switched to 1st year → 1st-year quiz (the reported bug)', async () => {
    const w = boot({ uid: 'dev', name: 'Dev', acad: SY }); w.quizShow(); await settle(); await clickQz(w, 'start');
    const w2 = boot({ uid: 'dev', name: 'Dev', acad: FY });          // academic switch reloads the app
    w2.quizShow(); await settle(); assert.ok(text(w2).includes(FYLBL) && !text(w2).includes(SYLBL), text(w2));
    await clickQz(w2, 'start'); assert.ok(text(w2).includes('FY_ALL question 0') && !text(w2).includes('SY_CSE_GROUP question'), 'questions must be 1st-year: ' + text(w2).slice(0, 160)); });
  await t('4. refresh (fresh page load) keeps the right year', async () => {
    for (const [acct, ok, no] of [[{ uid: 'fy1', name: 'F', acad: FY }, FYLBL, SYLBL], [{ uid: 'sy1', name: 'S', acad: SY }, SYLBL, FYLBL]]) {
      for (let i = 0; i < 3; i++) { const w = boot(acct); w.quizShow(); await settle(); assert.ok(text(w).includes(ok) && !text(w).includes(no)); } } });
  await t('5. leaderboards are locked to the student\'s own year (no year switcher)', async () => {
    const w = boot({ uid: 'fy1', name: 'Fiona', acad: FY }); w.quizShow(); await settle(); await clickTab(w, 'dboard');
    assert.ok(!html(w).includes('data-bg='), 'no group buttons'); assert.ok(html(w).includes(FYLBL) && !html(w).includes(SYLBL)); assert.ok(w.__boardPath.includes('_FY_ALL'), w.__boardPath);
    await clickTab(w, 'wboard'); assert.ok(!html(w).includes('data-bg=')); });
  await t('5b. 2nd-year student board reads only the 2nd-year board', async () => {
    const w = boot({ uid: 'sy1', name: 'Sam', acad: SY }); w.quizShow(); await settle(); await clickTab(w, 'dboard'); assert.ok(w.__boardPath.includes('_SY_CSE_GROUP'), w.__boardPath); assert.ok(!html(w).includes(FYLBL)); });
  await t('6. server answers with the other year\'s quiz → client refuses to display it', async () => {
    hooks.tamper = (n, r) => (n === 'quizGetToday' ? Object.assign({}, r, { groupId: 'SY_CSE_GROUP', groupLabel: 'Second Year' }) : r);
    const w = boot({ uid: 'fy1', name: 'Fiona', acad: FY }); w.quizShow(); await settle(); assert.ok(!text(w).includes('Start Quiz'), text(w)); assert.ok(text(w).includes('does not match your academic year')); });
  await t('6b. same on quizStart: wrong-year questions are never drawn', async () => {
    const w = boot({ uid: 'fy1', name: 'Fiona', acad: FY }); w.quizShow(); await settle();
    hooks.tamper = (n, r) => (n === 'quizStart' ? Object.assign({}, r, { groupId: 'SY_CSE_GROUP' }) : r); await clickQz(w, 'start');
    assert.ok(!text(w).includes('question 0'), 'no questions rendered'); });
  await t('7. no academic year known → no quiz is shown and no quiz call is made (no silent default)', async () => {
    const w = boot({ uid: 'x', name: 'N', acad: null }); w.quizShow(); await settle();
    assert.ok(!text(w).includes('Start Quiz') && !text(w).includes(FYLBL) && !text(w).includes(SYLBL), text(w)); assert.ok(text(w).includes('choose your year'));
    assert.ok(!hooks.calls.some((c) => c[0] === 'quizGetToday'), JSON.stringify(hooks.calls)); });
  await t('8. unsupported year/branch value → no quiz', async () => {
    const w = boot({ uid: 'x', name: 'N', acad: { year: '3', branch: 'CSE', sem: '1' } }); w.quizShow(); await settle(); assert.ok(!text(w).includes('Start Quiz')); });
  await t('9. scoring/submission/history still work end to end', async () => {
    const w = boot({ uid: 'fy1', name: 'Fiona', acad: FY }); w.quizShow(); await settle(); await clickQz(w, 'start');
    const r = await fn.quizSubmit({ auth: { uid: 'fy1', token: {} }, data: { answers: [0, 0, 0] } }); assert.equal(r.correctCount, 3);
    const stats = await fn.quizMyStats({ auth: { uid: 'fy1', token: {} }, data: {} }); assert.equal(stats.attempted, 1);
    const w2 = boot({ uid: 'fy1', name: 'Fiona', acad: FY }); w2.quizShow(); await settle(); assert.ok(text(w2).includes('3') && !text(w2).includes('Start Quiz'), text(w2).slice(0, 200)); });
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log(' - ' + failed.join('\n - ')); process.exit(1); } process.exit(0);
})();

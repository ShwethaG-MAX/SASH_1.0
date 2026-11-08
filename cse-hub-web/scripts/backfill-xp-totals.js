'use strict';
/* ONE-OFF, run once right after deploying the new functions + rules + indexes.
   It makes the Test leaderboard and the Overall leaderboard correct for history:
     1. every existing testResults row without `xp` gets XP (same formula as testSubmit; uses the attempt's unanswered count),
     2. testStats/{uid} is rebuilt (adds totalXp),
     3. xpTotals/{uid} is built from scratch:  quizXP (sum of quizXpLedger) + testXP (testStats.totalXp) + legacyXP (userXp.syllabusXP).
   It SETS absolute values, so run it when nobody is submitting a test / no quiz is being finalised (a few seconds late at night is fine).
   Safe to re-run. Run from functions-test/ with Admin credentials:
     GOOGLE_APPLICATION_CREDENTIALS=key.json node ../scripts/backfill-xp-totals.js [--dry] */
const path = require('path');
const admin = require(path.join(process.cwd(), 'node_modules', 'firebase-admin'));
const S = require(path.join(process.cwd(), 'lib', 'score.js'));
admin.initializeApp(); const db = admin.firestore(); const FV = admin.firestore.FieldValue; const dry = process.argv.includes('--dry');

(async () => {
  // 1. test results -> xp
  const results = (await db.collection('testResults').get()).docs;
  const byUid = {}; let patched = 0;
  for (const d of results) {
    const r = d.data();
    let xp = r.xp;
    if (!Number.isFinite(xp)) {
      const a = (await db.doc(`testAttempts/${d.id}`).get()).data() || {};
      const unanswered = Number.isFinite(a.unanswered) ? a.unanswered : 0;
      xp = S.testXp({ total: r.total, unanswered, percentage: r.percentage });
      patched++;
      if (!dry) { await d.ref.update({ xp }); if (a.status === 'submitted') await db.doc(`testAttempts/${d.id}`).update({ xp }); }
    }
    (byUid[r.uid] = byUid[r.uid] || []).push({ ...r, xp });
  }
  // 2. testStats
  const info = {};
  for (const uid of Object.keys(byUid)) {
    const rows = byUid[uid], last = rows[0];
    info[uid] = { name: last.name || 'Student', branch: last.branch || '', year: last.year || '' };
    if (!dry) await db.doc(`testStats/${uid}`).set({ uid, ...info[uid], ...S.aggregateStats(rows), updatedAt: FV.serverTimestamp() });
  }
  // 3. xpTotals
  const quiz = {};
  (await db.collection('quizXpLedger').select('uid', 'xp').get()).docs.forEach((d) => { const x = d.data(); quiz[x.uid] = (quiz[x.uid] || 0) + (Number(x.xp) || 0); });
  const legacy = {};
  (await db.collection('userXp').get()).docs.forEach((d) => { legacy[d.id] = Math.max(0, Math.round(Number(d.data().syllabusXP) || 0)); });
  const uids = new Set([...Object.keys(byUid), ...Object.keys(quiz), ...Object.keys(legacy)]);
  let written = 0, batch = db.batch(), n = 0;
  for (const uid of uids) {
    let who = info[uid];
    if (!who) { const p = (await db.doc(`userProfiles/${uid}`).get()).data() || {}; who = { name: String(p.name || '').trim().slice(0, 40) || 'Student', branch: String(p.branch || '').slice(0, 20), year: String(p.year || '').slice(0, 2) }; }
    const quizXP = Math.max(0, Math.round(quiz[uid] || 0)), legacyXP = legacy[uid] || 0;
    const testXP = byUid[uid] ? S.aggregateStats(byUid[uid]).totalXp : 0;
    written++;
    if (dry) continue;
    batch.set(db.doc(`xpTotals/${uid}`), { uid, ...who, quizXP, testXP, legacyXP, totalXP: quizXP + testXP + legacyXP, updatedAt: FV.serverTimestamp() });
    if (++n === 400) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (!dry && n) await batch.commit();
  console.log((dry ? '[dry run] ' : '') + `test results given XP: ${patched}, students with test results: ${Object.keys(byUid).length}, xpTotals rows: ${written}`);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/* OPTIONAL one-off: give students XP for Syllabus Tests they completed BEFORE the XP system existed.
   Uses each unit's best percentage in userSyllabusProgress with the same formula as sylSubmit. Idempotent (skips units that already have xpPaid).
   Run from functions-syllabus/ with Admin credentials:  GOOGLE_APPLICATION_CREDENTIALS=key.json node ../scripts/backfill-syllabus-xp.js [--dry] */
const path = require('path');
const admin = require(path.join(process.cwd(), 'node_modules', 'firebase-admin'));
const { computeXp, cleanXpConfig } = require(path.join(process.cwd(), 'xp.js'));
admin.initializeApp(); const db = admin.firestore(); const FV = admin.firestore.FieldValue; const dry = process.argv.includes('--dry');
(async () => {
  const cfg = cleanXpConfig(((await db.doc('syllabusConfig/settings').get()).data() || {}).xp);
  const snap = await db.collection('userSyllabusProgress').get(); let units = 0, total = 0;
  for (const d of snap.docs) {
    const p = d.data(); if (p.xpPaid != null || !(p.attempts > 0)) continue;
    const xp = computeXp({ total: 1, unanswered: 0, percentage: p.bestPercentage || 0 }, cfg); units++; total += xp;
    if (dry || !xp) continue;
    const b = db.batch();
    b.set(d.ref, { xpPaid: xp }, { merge: true });
    b.set(db.doc('userXp/' + p.uid), { uid: p.uid, syllabusXP: FV.increment(xp), updatedAt: FV.serverTimestamp() }, { merge: true });
    b.create(db.doc('syllabusXpLedger/backfill_' + d.id), { uid: p.uid, unitId: p.unitId, subjectId: p.subjectId || '', xp, xpEarned: xp, type: 'syllabus_test_backfill', createdAt: FV.serverTimestamp() });
    await b.commit();
  }
  console.log((dry ? '[dry run] ' : '') + 'units: ' + units + ', XP: ' + total);
})();

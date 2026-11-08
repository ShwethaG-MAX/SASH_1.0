'use strict';
/* ===== Overall XP summary (XP popup) =====
   Overall XP = Daily Quiz XP (sum of the student's quizXpLedger rows, written only by the quiz functions)
              + Test XP (testStats/{uid}.totalXp, written only by the test functions when a test is submitted)
              + legacy Syllabus Test XP (userXp/{uid}.syllabusXP, frozen — written by nobody any more).
   The popup shows Test XP and legacy Syllabus XP together as "Tests". Region MUST match REGION in the website (asia-south1). */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

setGlobalOptions({ region: 'asia-south1', maxInstances: 20 });
admin.initializeApp();
const db = admin.firestore();

async function dailyQuizXp(uid) {
  try {
    const agg = await db.collection('quizXpLedger').where('uid', '==', uid).aggregate({ total: admin.firestore.AggregateField.sum('xp') }).get();
    return Math.max(0, Math.round(agg.data().total || 0));
  } catch (e) {   /* older SDK / transient error: fall back to summing the (small) per-student ledger */
    const sn = await db.collection('quizXpLedger').where('uid', '==', uid).limit(2000).get();
    return Math.max(0, sn.docs.reduce((n, d) => n + (d.data().xp || 0), 0));
  }
}
async function xpTotals(uid) {
  const [u, ts, dailyXP] = await Promise.all([db.collection('userXp').doc(uid).get(), db.collection('testStats').doc(uid).get(), dailyQuizXp(uid)]);
  const syllabusXP = Math.max(0, u.exists ? Math.round(u.data().syllabusXP || 0) : 0);
  const testXP = Math.max(0, ts.exists ? Math.round(ts.data().totalXp || 0) : 0);
  return { syllabusXP, testXP, dailyXP, totalXP: syllabusXP + testXP + dailyXP };
}

exports.xpGetSummary = onCall({ cors: true, timeoutSeconds: 30, memory: '256MiB' }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please wait for your account to connect, then try again.');
  return xpTotals(req.auth.uid);
});

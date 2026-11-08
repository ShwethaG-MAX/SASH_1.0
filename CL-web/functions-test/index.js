'use strict';
/* ===== Test — paper upload, extraction, server-side scoring, Test leaderboard =====
   Region MUST match REGION in the website (asia-south1). See ../API-CONTRACT.md (section A).
   Students never receive an answer key before submitting. Each submitted test awards XP (see lib/score.js testXp); the per-student totals are kept in
   testStats (Test leaderboard) and mirrored into xpTotals/{uid} (Overall leaderboard = Daily Quiz XP + Test XP). Daily Quiz collections are never read here. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { parseQuestions } = require('./lib/parse');
const { extractWithAi } = require('./lib/ai');
const { extractText } = require('./lib/extract');
const S = require('./lib/score');

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });
admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const QUIZ_AI_API_KEY = defineSecret('QUIZ_AI_API_KEY');
const GRACE_MS = 120000;

function requireAuth(req) { if (!req.auth) throw new HttpsError('unauthenticated', 'Please wait for your account to connect, then try again.'); return req.auth.uid; }
function requireOwner(req) { requireAuth(req); if (req.auth.token.owner !== true) throw new HttpsError('permission-denied', 'Only the admin can do this.'); return req.auth.uid; }
const attemptId = (t, u) => `${t}_${u}`;

async function studentInfo(uid) {
  let p = {};
  try { const s = await db.doc(`userProfiles/${uid}`).get(); p = s.exists ? s.data() : {}; } catch (e) { /* fall through to defaults */ }
  return { name: String(p.name || '').trim().slice(0, 40) || 'Student', branch: String(p.branch || '').slice(0, 20), year: String(p.year || '').slice(0, 2) };
}

async function commitChunks(ops) {   // ops: [(batch)=>void], 400 per batch
  for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach((f) => f(b)); await b.commit(); }
}

/* Questions a student may see/be scored on: included + complete. Keys stay server-side. */
async function loadServed(testId) {
  const qs = await db.collection('testQuestions').where('testId', '==', testId).get();
  const all = qs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((q) => q.included !== false).sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
  const ks = await Promise.all(all.map((q) => db.doc(`testKeys/${q.id}`).get()));
  const keys = {}; ks.forEach((k) => { if (k.exists) keys[k.id] = k.data(); });
  return { all, keys, served: all.filter((q) => !S.questionProblem(q, keys[q.id])) };
}

/* xpTotals/{uid} = the student's all-time XP split by source, used by the Overall leaderboard:
     quizXP   (incremented by the quiz functions)   testXP (set here, = testStats.totalXp)   legacyXP (old Syllabus Test XP, set by the backfill script)
     totalXP  = quizXP + testXP + legacyXP.  Must be called INSIDE a transaction, after all reads of that transaction. */
async function readTotals(tx, uid) { const s = await tx.get(db.doc(`xpTotals/${uid}`)); return s.exists ? s.data() : {}; }
function writeTotals(tx, uid, info, cur, testXP) {
  const quizXP = Number(cur.quizXP) || 0, legacyXP = Number(cur.legacyXP) || 0;
  tx.set(db.doc(`xpTotals/${uid}`), { uid, name: info.name, branch: info.branch, year: info.year, quizXP, legacyXP, testXP, totalXP: quizXP + legacyXP + testXP, updatedAt: FV.serverTimestamp() }, { merge: true });
}

async function recomputeStats(uid) {
  const rs = await db.collection('testResults').where('uid', '==', uid).get();
  const ref = db.doc(`testStats/${uid}`);
  const rows = rs.docs.map((d) => d.data()), last = rows[0];
  const info = last ? { name: last.name || 'Student', branch: last.branch || '', year: last.year || '' } : await studentInfo(uid);
  const stats = rows.length ? S.aggregateStats(rows) : null;
  await db.runTransaction(async (tx) => {
    const cur = await readTotals(tx, uid);
    if (stats) tx.set(ref, { uid, ...info, ...stats, updatedAt: FV.serverTimestamp() }); else tx.delete(ref);
    writeTotals(tx, uid, info, cur, stats ? stats.totalXp : 0);
  });
}

async function rankOf(testId, score, durationMs) {
  try {
    const base = db.collection('testResults').where('testId', '==', testId);
    const [tot, better, tie] = await Promise.all([
      base.count().get(), base.where('score', '>', score).count().get(),
      base.where('score', '==', score).where('durationMs', '<', durationMs).count().get()]);
    return { position: better.data().count + tie.data().count + 1, outOf: tot.data().count };
  } catch (e) { console.warn('rank lookup failed', e.message); return { position: null, outOf: null }; }
}

function publicAttempt(id, a) {
  const o = { state: 'submitted', attemptId: id };
  ['testId', 'testTitle', 'score', 'maxScore', 'percentage', 'correct', 'incorrect', 'unanswered', 'total', 'durationMs', 'review'].forEach((k) => { o[k] = a[k]; });
  o.xp = Number(a.xp) || 0;
  return o;
}

/* ---------------- admin ---------------- */
exports.testExtract = onCall({ cors: true, timeoutSeconds: 300, memory: '1GiB', secrets: [QUIZ_AI_API_KEY] }, async (req) => {
  const uid = requireOwner(req);
  const d = req.data || {};
  let meta;
  try { meta = S.cleanTestMeta(d); } catch (e) { throw new HttpsError('invalid-argument', e.message); }
  if (typeof d.dataBase64 !== 'string' || !d.dataBase64) throw new HttpsError('invalid-argument', 'Choose a question paper file (PDF or DOCX).');
  const buf = Buffer.from(d.dataBase64, 'base64');
  if (!buf.length || buf.length > S.MAX_FILE_BYTES) throw new HttpsError('invalid-argument', 'The file must be 6 MB or smaller.');
  const kind = S.sniffFile(buf);
  if (kind === 'doc') throw new HttpsError('invalid-argument', 'Old .doc files are not supported. Save the paper as DOCX or PDF and upload that.');
  if (kind !== 'pdf' && kind !== 'docx') throw new HttpsError('invalid-argument', 'Only PDF and DOCX question papers are supported.');

  let text = '';
  try {
    text = await extractText(buf, kind);
  } catch (e) { console.warn('text extraction failed', e.message); throw new HttpsError('invalid-argument', 'This file could not be read. It may be corrupted or password-protected.'); }
  if (text.replace(/\s/g, '').length < 40) throw new HttpsError('failed-precondition', kind === 'pdf'
    ? 'This PDF has no selectable text (it looks scanned). Upload a text-based PDF or a DOCX version.' : 'This document contains no readable text.');

  const warnings = []; let questions = null, method = 'heuristic';
  let cfg = { provider: 'anthropic', model: '' };
  try { const c = await db.doc('quizSettings/config').get(); if (c.exists) cfg = { provider: c.data().generationProvider || 'anthropic', model: c.data().generationModel || '' }; } catch (e) { /* defaults */ }
  let key = ''; try { key = QUIZ_AI_API_KEY.value(); } catch (e) { key = ''; }
  if (key) {
    try { questions = await extractWithAi(text, cfg, key); method = 'ai'; }
    catch (e) { console.warn('AI extraction failed, using rule-based parser:', String(e.message).slice(0, 200)); warnings.push('AI extraction was unavailable, so the rule-based extractor was used. Please review every question carefully.'); }
  } else warnings.push('AI extraction is not configured, so the rule-based extractor was used. Please review every question carefully.');
  if (!questions) {
    const r = parseQuestions(text); questions = r.questions;
    if (r.truncated) warnings.push('Only the first 300 questions were kept.');
    if (r.flatPython) warnings.push('Some code questions have no indentation in the uploaded file (common with PDFs), so Python-style code could not be re-indented. Open those questions in the editor and fix the indentation, or upload a DOCX version.');
  }
  if (!questions.length) throw new HttpsError('failed-precondition', 'No questions could be found in this file. Check the paper uses numbered questions (1., 2., …) with options A) B) C) D).');
  if (questions.length !== meta.totalQuestions) warnings.push(`You declared ${meta.totalQuestions} questions but ${questions.length} were extracted. Check for missing or merged questions.`);
  const noKey = questions.filter((q) => !q.answer).length;
  if (noKey) warnings.push(`${noKey} question(s) have no answer key. Set the correct answer before publishing.`);

  const ref = db.collection('tests').doc();
  const safe = S.cleanFileName(d.fileName), path = `testPapers/${ref.id}/${safe}`;
  let storagePath = '';
  try { await admin.storage().bucket().file(path).save(buf, { contentType: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', resumable: false }); storagePath = path; }
  catch (e) { console.warn('storing original failed', e.message); warnings.push('The original file could not be stored, but the questions were saved.'); }

  const ops = [(b) => b.set(ref, { ...meta, status: 'draft', questionCount: 0,
    sourceFile: { name: safe, size: buf.length, mime: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', storagePath },
    extraction: { status: 'ready', method, warnings, questionCount: questions.length },
    createdBy: uid, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), publishedAt: null })];
  questions.forEach((q, i) => {
    const qr = db.collection('testQuestions').doc();
    ops.push((b) => b.set(qr, { testId: ref.id, order: i + 1, text: q.text, options: q.options, marks: q.marks || 1, subject: q.subject || 'Uncategorised', unit: q.unit || '', topic: q.topic || 'Uncategorised',
      included: true, needsReview: !!q.needsReview, confidence: q.confidence || 0 }));
    ops.push((b) => b.set(db.doc(`testKeys/${qr.id}`), { testId: ref.id, correctAnswer: q.answer || '', explanation: q.explanation || '' }));
  });
  await commitChunks(ops);
  const { valid } = S.validateForPublish(questions.map((q, i) => ({ ...q, id: 'x' + i, included: true })), Object.fromEntries(questions.map((q, i) => ['x' + i, { correctAnswer: q.answer }])));
  await ref.update({ questionCount: valid });
  return { testId: ref.id, questionCount: questions.length, method, warnings };
});

exports.testSetStatus = onCall({ cors: true, timeoutSeconds: 60 }, async (req) => {
  requireOwner(req);
  const testId = String((req.data || {}).testId || ''), status = (req.data || {}).status;
  if (!testId || !['published', 'unpublished'].includes(status)) throw new HttpsError('invalid-argument', 'Invalid request.');
  const ref = db.doc(`tests/${testId}`), t = await ref.get();
  if (!t.exists) throw new HttpsError('not-found', 'Test not found.');
  const { all, keys, served } = await loadServed(testId);
  if (status === 'published') {
    const v = S.validateForPublish(all, keys);
    if (!v.ok) throw new HttpsError('failed-precondition', 'Fix these before publishing: ' + v.problems.slice(0, 8).join('; ') + (v.problems.length > 8 ? ` (+${v.problems.length - 8} more)` : '') + '.');
  }
  await ref.update({ status, questionCount: served.length, updatedAt: FV.serverTimestamp(), ...(status === 'published' ? { publishedAt: FV.serverTimestamp() } : {}) });
  return { ok: true, status, questionCount: served.length };
});

exports.testDelete = onCall({ cors: true, timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  requireOwner(req);
  const testId = String((req.data || {}).testId || '');
  const ref = db.doc(`tests/${testId}`), t = await ref.get();
  if (!testId || !t.exists) throw new HttpsError('not-found', 'Test not found.');
  const uids = new Set(), ops = [];
  for (const col of ['testQuestions', 'testKeys', 'testAttempts', 'testResults']) {
    const sn = await db.collection(col).where('testId', '==', testId).get();
    sn.docs.forEach((d) => { if (col === 'testResults') uids.add(d.data().uid); ops.push((b) => b.delete(d.ref)); });
  }
  ops.push((b) => b.delete(ref));
  await commitChunks(ops);
  try { await admin.storage().bucket().deleteFiles({ prefix: `testPapers/${testId}/` }); } catch (e) { console.warn('file delete failed', e.message); }
  for (const u of uids) await recomputeStats(u);
  return { ok: true };
});

exports.testResetAttempt = onCall({ cors: true, timeoutSeconds: 60 }, async (req) => {
  requireOwner(req);
  const d = req.data || {}, testId = String(d.testId || ''), uid = String(d.uid || '');
  if (!testId || !uid) throw new HttpsError('invalid-argument', 'Invalid request.');
  const id = attemptId(testId, uid);
  await Promise.all([db.doc(`testAttempts/${id}`).delete(), db.doc(`testResults/${id}`).delete()]);
  await recomputeStats(uid);
  return { ok: true };
});

/* ---------------- student ---------------- */
async function loadPublished(testId) {
  const t = await db.doc(`tests/${testId}`).get();
  if (!testId || !t.exists || t.data().status !== 'published') throw new HttpsError('not-found', 'This test is not available.');
  return t.data();
}

exports.testStart = onCall({ cors: true, timeoutSeconds: 60 }, async (req) => {
  const uid = requireAuth(req);
  const testId = String((req.data || {}).testId || '');
  const test = await loadPublished(testId);
  const aref = db.doc(`testAttempts/${attemptId(testId, uid)}`);
  const ex = await aref.get();
  if (ex.exists && ex.data().status === 'submitted') return publicAttempt(ex.id, ex.data());
  if (ex.exists && ex.data().status === 'expired') return { state: 'expired' };
  const { served } = await loadServed(testId);
  if (!served.length) throw new HttpsError('failed-precondition', 'This test has no questions yet.');
  const now = Date.now();
  let deadlineMs;
  if (ex.exists) {
    deadlineMs = ex.data().deadlineMs;
    if (now > deadlineMs) { await aref.update({ status: 'expired' }); return { state: 'expired' }; }
  } else {
    deadlineMs = now + test.durationMin * 60000;
    try { await aref.create({ uid, testId, testTitle: test.title, status: 'started', startedAt: FV.serverTimestamp(), startedAtMs: now, deadlineMs }); }
    catch (e) { const again = await aref.get(); if (!again.exists) throw e; deadlineMs = again.data().deadlineMs; }   // double click / two devices: use the first start
  }
  return { state: 'in_progress', test: { id: testId, title: test.title, description: test.description || '', durationMin: test.durationMin, questionCount: served.length, maxMarks: test.maxMarks == null ? null : test.maxMarks },
    deadlineMs, serverNowMs: Date.now(),
    questions: served.map((q) => ({ id: q.id, order: q.order, text: q.text, options: q.options, marks: q.marks || 1, subject: q.subject || '', topic: q.topic || '' })) };
});

exports.testSubmit = onCall({ cors: true, timeoutSeconds: 60 }, async (req) => {
  const uid = requireAuth(req);
  const d = req.data || {}, testId = String(d.testId || '');
  const id = attemptId(testId, uid), aref = db.doc(`testAttempts/${id}`);
  const ex = await aref.get();
  if (ex.exists && ex.data().status === 'submitted') return { ...publicAttempt(id, ex.data()), rank: await rankOf(testId, ex.data().score, ex.data().durationMs) };
  if (!ex.exists) throw new HttpsError('failed-precondition', 'Start the test before submitting it.');
  const a = ex.data(), now = Date.now();
  if (a.status === 'expired' || now > a.deadlineMs + GRACE_MS) {
    if (a.status !== 'expired') await aref.update({ status: 'expired' });
    throw new HttpsError('deadline-exceeded', 'TIME_UP');
  }
  const test = (await db.doc(`tests/${testId}`).get()).data() || {};
  const { served, keys } = await loadServed(testId);
  if (!served.length) throw new HttpsError('failed-precondition', 'This test is no longer available.');
  const given = d.answers && typeof d.answers === 'object' ? d.answers : {};
  const answers = {}; served.forEach((q) => { const v = S.cleanAnswer(given[q.id], q.options.length); if (v) answers[q.id] = v; });
  const r = S.scoreAttempt(served, keys, answers, test.maxMarks);
  const durationMs = Math.max(0, Math.min(now - a.startedAtMs, test.durationMin * 60000 + GRACE_MS));
  const info = await studentInfo(uid);
  const rref = db.doc(`testResults/${id}`), sref = db.doc(`testStats/${uid}`);
  const xp = S.testXp(r);
  const done = await db.runTransaction(async (tx) => {
    const [cur, stRows, totals] = await Promise.all([tx.get(aref), tx.get(db.collection('testResults').where('uid', '==', uid)), readTotals(tx, uid)]);
    if (cur.data().status === 'submitted') return { dup: true, data: cur.data() };
    const attempt = { status: 'submitted', submittedAt: FV.serverTimestamp(), answers, score: r.score, maxScore: r.maxScore, percentage: r.percentage,
      correct: r.correct, incorrect: r.incorrect, unanswered: r.unanswered, total: r.total, durationMs, review: r.review, xp };
    const result = { testId, testTitle: test.title || a.testTitle || '', uid, name: info.name, branch: info.branch, year: info.year, score: r.score, maxScore: r.maxScore,
      percentage: r.percentage, correct: r.correct, total: r.total, durationMs, xp, submittedAt: FV.serverTimestamp() };
    const rows = stRows.docs.filter((x) => x.id !== id).map((x) => x.data()).concat([result]);
    const stats = S.aggregateStats(rows);
    tx.update(aref, attempt); tx.create(rref, result);
    tx.set(sref, { uid, name: info.name, branch: info.branch, year: info.year, ...stats, updatedAt: FV.serverTimestamp() });
    writeTotals(tx, uid, info, totals, stats.totalXp);
    return { dup: false, data: { ...a, ...attempt, testId, testTitle: result.testTitle } };
  });
  return { ...publicAttempt(id, done.data), rank: await rankOf(testId, done.data.score, done.data.durationMs) };
});

exports.testMyResult = onCall({ cors: true, timeoutSeconds: 30 }, async (req) => {
  const uid = requireAuth(req);
  const testId = String((req.data || {}).testId || ''), id = attemptId(testId, uid);
  const s = await db.doc(`testAttempts/${id}`).get();
  if (!s.exists || s.data().status !== 'submitted') return { state: s.exists ? s.data().status === 'expired' ? 'expired' : 'in_progress' : 'none' };
  return { ...publicAttempt(id, s.data()), rank: await rankOf(testId, s.data().score, s.data().durationMs) };
});


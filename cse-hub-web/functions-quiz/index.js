'use strict';
/**
 * Student Hub — Daily Quiz backend.
 *   Student callables : quizGetToday, quizStart, quizSubmit, quizReview, quizMyStats
 *   Admin callables   : quizAdminOverview, quizAdminSetSettings, quizAdminSaveDraft, quizAdminPublish,
 *                       quizAdminGenerate, quizAdminGetQuiz, quizAdminCorrect, quizAdminFinalize
 *   Schedulers        : quizDailyRollover (00:00 IST), quizEnsureHourly (:15 every hour, retry + catch-up)
 * Admin = Firebase Auth custom claim owner:true (the app's existing owner/admin system). Nothing here trusts client roles.
 */
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const C = require('./lib/core');
const { generateQuiz, PROVIDERS, GEN_CATALOG_PUBLIC, cleanGenSettings, resolveGen } = require('./lib/ai');

const { db, FV, TS, HttpsError, GROUPS, GROUP_IDS } = C;
const AI_KEY = defineSecret('QUIZ_AI_API_KEY');

setGlobalOptions({ region: 'asia-south1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 60 });
const CALL = { cors: true };                       // callables: Firebase Auth token is verified automatically
const CALL_AI = { cors: true, secrets: [AI_KEY], timeoutSeconds: 300, memory: '512MiB' };

const isGroup = (g) => { if (!GROUPS[g]) throw new HttpsError('invalid-argument', 'Unknown quiz group.'); return g; };
const secret = () => { try { return AI_KEY.value(); } catch (e) { return ''; } };

/* ======================================================================================= student ===== */

exports.quizGetToday = onCall(CALL, async (request) => {
  const uid = C.requireAuth(request);
  await C.rateLimit(uid, 'today', 40, 60);
  const cfg = await C.getConfig();
  const date = C.istDate();
  const st = await C.resolveStudent(uid);
  const base = { date, serverNowMs: Date.now(), closesAtMs: C.dayEndMs(date), rewards: cfg.xpRewardConfig, maxAttemptSeconds: cfg.maxAttemptSeconds, revealAnswersMode: cfg.revealAnswersMode, weekId: C.weekId(date) };
  // profileYear = the academic year STORED in the database for this account ('' if none); the client uses it to heal a missing/stale value.
  if (!st.hasName || !st.groupId) return Object.assign(base, { state: 'needs_profile', reason: !st.hasName ? 'name' : 'group', profileYear: st.profileYear, student: { name: st.name, branch: st.branchShort } });
  const key = C.quizKey(date, st.groupId);
  const out = Object.assign(base, { groupId: st.groupId, year: st.year, profileYear: st.profileYear, groupLabel: GROUPS[st.groupId].label, student: { name: st.name, branch: st.branchShort } });
  const other = await C.attemptInOtherGroup(uid, date, st.groupId);
  if (other) return Object.assign(out, { state: 'unavailable', message: `You already took today\u2019s ${GROUPS[other].short} quiz with this account, so today\u2019s ${GROUPS[st.groupId].short} quiz is locked. Come back tomorrow.` });
  const quiz = await db.doc(`dailyQuizzes/${key}`).get();
  if (!quiz.exists) return Object.assign(out, { state: 'unavailable', message: cfg.automaticGenerationEnabled ? 'Today\u2019s quiz has not been published yet. It is created automatically \u2014 please check back shortly.' : 'Today\u2019s quiz has not been published yet. Your admin will publish it soon.' });
  const att = await db.doc(`quizAttempts/${key}_${uid}`).get();
  if (!att.exists) return Object.assign(out, { state: 'ready', questionCount: C.QUESTIONS_PER_QUIZ });
  const a = att.data();
  if (a.status === 'started') return Object.assign(out, { state: 'in_progress', startedAtMs: a.startedAtMs });
  return Object.assign(out, { state: 'submitted', result: { status: a.status, correctCount: a.correctCount, total: C.QUESTIONS_PER_QUIZ, completionTimeMs: a.completionTimeMs, submittedAtMs: a.submittedAtMs } });
});

exports.quizStart = onCall(CALL, async (request) => {
  const uid = C.requireAuth(request);
  await C.rateLimit(uid, 'start', 10, 60);
  const cfg = await C.getConfig();
  const date = C.istDate();
  const st = await C.resolveStudent(uid, { pin: true });
  if (!st.hasName) throw new HttpsError('failed-precondition', 'PROFILE_NAME');
  if (!st.groupId) throw new HttpsError('failed-precondition', 'PROFILE_GROUP');
  const key = C.quizKey(date, st.groupId);
  const other = await C.attemptInOtherGroup(uid, date, st.groupId);
  if (other) throw new HttpsError('failed-precondition', `You already took today\u2019s ${GROUPS[other].short} quiz with this account. Come back tomorrow.`);
  const quizRef = db.doc(`dailyQuizzes/${key}`), attRef = db.doc(`quizAttempts/${key}_${uid}`);
  const out = await db.runTransaction(async (t) => {
    const [quiz, att] = await Promise.all([t.get(quizRef), t.get(attRef)]);
    if (!quiz.exists) throw new HttpsError('failed-precondition', 'Today\u2019s quiz is not published yet.');
    if (att.exists && att.data().status !== 'started') throw new HttpsError('already-exists', 'You have already submitted today\u2019s quiz.');
    let startedAtMs;
    if (att.exists) startedAtMs = att.data().startedAtMs;               // resume: the clock never restarts
    else {
      startedAtMs = Date.now();
      t.create(attRef, { uid, date, groupId: st.groupId, year: st.year, name: st.name, branch: st.branchShort, status: 'started', startedAt: TS.fromMillis(startedAtMs), startedAtMs });
    }
    return { startedAtMs, questions: quiz.data().questions };
  });
  return { date, groupId: st.groupId, year: st.year, startedAtMs: out.startedAtMs, serverNowMs: Date.now(), maxAttemptSeconds: cfg.maxAttemptSeconds, questions: out.questions };
});

exports.quizSubmit = onCall(CALL, async (request) => {
  const uid = C.requireAuth(request);
  await C.rateLimit(uid, 'submit', 10, 60);
  const answers = request.data && request.data.answers;
  if (!Array.isArray(answers) || answers.length !== C.QUESTIONS_PER_QUIZ || answers.some((v) => !(v === null || (Number.isInteger(v) && v >= 0 && v <= 3)))) throw new HttpsError('invalid-argument', 'Invalid answers.');
  const cfg = await C.getConfig();
  // A client may name which of ITS OWN open attempts it is submitting (today, or yesterday if midnight passed mid-quiz).
  // The group still comes from the trusted profile and the attempt doc is keyed by the caller's uid, so nothing can be forged.
  const today = C.istDate();
  const date = request.data && request.data.date ? C.assertDate(request.data.date) : today;
  if (date !== today && date !== C.addDays(today, -1)) throw new HttpsError('invalid-argument', 'Invalid quiz date.');
  const st = await C.resolveStudent(uid);
  if (!st.groupId) throw new HttpsError('failed-precondition', 'PROFILE_GROUP');
  // The attempt doc is created server-side by quizStart under the group derived from the profile at that moment. Submit against THAT group
  // (never one supplied by the client), so a profile change in the middle of a quiz cannot strand or redirect the attempt.
  let gid = st.groupId;
  if (!(await db.doc(`quizAttempts/${C.quizKey(date, gid)}_${uid}`).get()).exists) {
    const other = await C.attemptInOtherGroup(uid, date, gid);
    if (other) gid = other;
  }
  const key = C.quizKey(date, gid);
  const attRef = db.doc(`quizAttempts/${key}_${uid}`), keyRef = db.doc(`quizAnswerKeys/${key}`), entRef = db.doc(`quizBoards/${key}/entries/${uid}`);
  const res = await db.runTransaction(async (t) => {
    const [att, k] = await Promise.all([t.get(attRef), t.get(keyRef)]);
    if (!att.exists) throw new HttpsError('failed-precondition', 'Start the quiz first.');
    const a = att.data();
    if (a.status !== 'started') throw new HttpsError('already-exists', 'This quiz was already submitted. Answers cannot be changed.');
    const now = Date.now();                                             // server clock is the only clock that counts
    const elapsed = Math.max(500, now - a.startedAtMs);
    const late = now >= C.dayEndMs(date) || elapsed > (cfg.maxAttemptSeconds + 10) * 1000;
    const correct = late ? 0 : answers.reduce((n, v, i) => n + (v === k.data().answers[i] ? 1 : 0), 0);
    t.update(attRef, { answers, status: late ? 'expired' : 'submitted', correctCount: correct, completionTimeMs: elapsed, submittedAt: TS.fromMillis(now), submittedAtMs: now });
    if (!late) t.set(entRef, { uid, date, groupId: gid, year: GROUPS[gid].year, name: a.name || st.name, branch: a.branch || st.branchShort, correctCount: correct, completionTimeMs: elapsed, submittedAtMs: now });
    return { late, correct, elapsed, now };
  });
  const out = { status: res.late ? 'expired' : 'submitted', correctCount: res.correct, total: C.QUESTIONS_PER_QUIZ, completionTimeMs: res.elapsed, submittedAtMs: res.now };
  if (res.late) out.message = 'Time limit exceeded \u2014 this attempt is not ranked.';
  if (cfg.revealAnswersMode === 'afterSubmit') out.review = await buildReview(date, gid, answers);
  return out;
});

async function buildReview(date, groupId, studentAnswers) {
  const key = C.quizKey(date, groupId);
  const [quiz, k] = await Promise.all([db.doc(`dailyQuizzes/${key}`).get(), db.doc(`quizAnswerKeys/${key}`).get()]);
  if (!quiz.exists || !k.exists) return null;
  return quiz.data().questions.map((q, i) => ({ id: q.id, text: q.text, options: q.options, category: q.category, difficulty: q.difficulty, correctIndex: k.data().answers[i], explanation: k.data().explanations[i], yourAnswer: studentAnswers ? studentAnswers[i] : null }));
}

exports.quizReview = onCall(CALL, async (request) => {
  const uid = C.requireAuth(request);
  await C.rateLimit(uid, 'review', 30, 60);
  const date = C.assertDate(request.data && request.data.date);
  const today = C.istDate();
  if (date > today) throw new HttpsError('invalid-argument', 'That quiz has not happened yet.');
  const cfg = await C.getConfig();
  const st = await C.resolveStudent(uid);
  if (!st.groupId) throw new HttpsError('failed-precondition', 'PROFILE_GROUP');
  const att = await db.doc(`quizAttempts/${C.quizKey(date, st.groupId)}_${uid}`).get();
  const a = att.exists ? att.data() : null;
  const closed = date < today;
  const submitted = !!(a && a.status !== 'started');
  if (!(closed || (submitted && cfg.revealAnswersMode === 'afterSubmit'))) throw new HttpsError('failed-precondition', 'Answers are revealed when the quiz closes.');
  const review = await buildReview(date, st.groupId, submitted ? a.answers : null);
  if (!review) throw new HttpsError('not-found', 'No quiz was published for that day.');
  return { date, groupId: st.groupId, review, result: submitted ? { correctCount: a.correctCount, completionTimeMs: a.completionTimeMs, status: a.status } : null };
});

exports.quizMyStats = onCall(CALL, async (request) => {
  const uid = C.requireAuth(request);
  await C.rateLimit(uid, 'stats', 20, 60);
  const st = await C.resolveStudent(uid);
  const wk = C.weekId(C.istDate());
  const [atts, results, ledger] = await Promise.all([
    db.collection('quizAttempts').where('uid', '==', uid).where('status', '==', 'submitted').limit(400).get(),
    db.collection('dailyQuizResults').where('uid', '==', uid).limit(400).get(),
    db.collection('quizXpLedger').where('uid', '==', uid).limit(1000).get(),
  ]);
  const resByKey = {}; results.docs.forEach((d) => { const r = d.data(); resByKey[r.date + '_' + r.groupId] = r; });
  const history = atts.docs.map((d) => d.data()).sort((a, b) => (a.date < b.date ? 1 : -1)).map((a) => {
    const r = resByKey[a.date + '_' + a.groupId];
    return { date: a.date, groupId: a.groupId, year: a.year || (GROUPS[a.groupId] || {}).year || '', correctCount: a.correctCount, total: C.QUESTIONS_PER_QUIZ, completionTimeMs: a.completionTimeMs, rank: r ? r.rank : null, xp: r ? r.xpAwarded : null, final: !!r };
  });
  const attempted = history.length, totalCorrect = history.reduce((n, h) => n + h.correctCount, 0);
  const ranks = history.filter((h) => h.rank).map((h) => h.rank);
  let totalXP = 0, weeklyXP = 0; const dailyXp = {};
  ledger.docs.forEach((d) => { const l = d.data(); totalXP += l.xp; if (l.weekId === wk) weeklyXP += l.xp; dailyXp[l.date] = (dailyXp[l.date] || 0) + l.xp; });
  let weeklyRank = null;
  if (st.groupId) { const w = await db.doc(`weeklyQuizResults/${wk}_${st.groupId}_${uid}`).get(); if (w.exists) weeklyRank = w.data().rank || null; }
  return {
    weekId: wk, groupId: st.groupId, attempted, totalCorrect, totalQuestions: attempted * C.QUESTIONS_PER_QUIZ,
    accuracy: attempted ? totalCorrect / (attempted * C.QUESTIONS_PER_QUIZ) : 0, totalXP, weeklyXP, weeklyRank,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    avgTimeMs: attempted ? Math.round(history.reduce((n, h) => n + h.completionTimeMs, 0) / attempted) : 0,
    history: history.slice(0, 30), dailyXp: Object.entries(dailyXp).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30).map(([date, xp]) => ({ date, xp })),
  };
});

/* ========================================================================================= admin ===== */

exports.quizAdminOverview = onCall(CALL, async (request) => {
  const uid = C.requireOwner(request);
  const cfg = await C.getConfig();
  const date = C.assertDate((request.data && request.data.date) || C.istDate());
  const today = C.istDate();
  const groups = {};
  for (const g of GROUP_IDS) {
    const key = C.quizKey(date, g);
    const [quiz, draft, cnt] = await Promise.all([db.doc(`dailyQuizzes/${key}`).get(), db.doc(`quizDrafts/${key}`).get(), db.collection('quizAttempts').where('date', '==', date).where('groupId', '==', g).count().get()]);
    const sub = await db.collection(`quizBoards/${key}/entries`).count().get();
    groups[g] = {
      label: GROUPS[g].label, published: quiz.exists, status: quiz.exists ? quiz.data().status : 'none', source: quiz.exists ? quiz.data().generationSource : '',
      attempts: cnt.data().count, submitted: sub.data().count,
      draft: draft.exists && draft.data().status !== 'published' ? { questions: draft.data().questions || [], source: draft.data().source || 'manual', settings: draft.data().settings || null } : null,
    };
  }
  const [logs, quizzes, corr] = await Promise.all([
    db.collection('quizGenerationLogs').orderBy('createdAt', 'desc').limit(25).get(),
    db.collection('dailyQuizzes').orderBy('date', 'desc').limit(30).get(),
    db.collection('quizCorrections').orderBy('createdAt', 'desc').limit(10).get(),
  ]);
  const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
  return {
    today, date, config: cfg, providers: Object.keys(PROVIDERS), providerDefaults: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.defaultModel])), genCatalog: GEN_CATALOG_PUBLIC, genSettings: resolveGen(cfg.secondYearGen), groups,
    logs: logs.docs.map((d) => { const x = d.data(); return { id: d.id, date: x.date, groupId: x.groupId, status: x.status, source: x.source, provider: x.provider, model: x.model, trigger: x.trigger, error: x.error, at: ms(x.createdAt) }; }),
    quizzes: quizzes.docs.map((d) => { const x = d.data(); return { key: d.id, date: x.date, groupId: x.groupId, status: x.status, source: x.generationSource, participants: x.participants || null, publishedAt: ms(x.publishedAt) }; }),
    corrections: corr.docs.map((d) => { const x = d.data(); return { id: d.id, date: x.date, groupId: x.groupId, index: x.index, reason: x.reason, at: ms(x.createdAt) }; }),
  };
});

exports.quizAdminSetSettings = onCall(CALL, async (request) => {
  const uid = C.requireOwner(request);
  const d = request.data || {}, patch = {};
  if ('automaticGenerationEnabled' in d) { if (typeof d.automaticGenerationEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'Toggle must be true/false.'); patch.automaticGenerationEnabled = d.automaticGenerationEnabled; }
  if ('xpRewardConfig' in d) patch.xpRewardConfig = C.validateXpConfig(d.xpRewardConfig);
  if ('generationProvider' in d) { if (!PROVIDERS[d.generationProvider]) throw new HttpsError('invalid-argument', 'Unknown provider.'); patch.generationProvider = d.generationProvider; }
  if ('generationModel' in d) { if (typeof d.generationModel !== 'string' || d.generationModel.length > 80 || /\s/.test(d.generationModel)) throw new HttpsError('invalid-argument', 'Invalid model name.'); patch.generationModel = d.generationModel; }
  if ('secondYearGen' in d) patch.secondYearGen = cleanGenSettings(d.secondYearGen);       // Second Year only; owner-checked above, validated against the server catalog
  if ('requireVerification' in d) patch.requireVerification = d.requireVerification === true;
  if ('revealAnswersMode' in d) { if (!['afterSubmit', 'afterClose'].includes(d.revealAnswersMode)) throw new HttpsError('invalid-argument', 'Invalid reveal mode.'); patch.revealAnswersMode = d.revealAnswersMode; }
  if ('maxAttemptSeconds' in d) { if (!Number.isInteger(d.maxAttemptSeconds) || d.maxAttemptSeconds < 60 || d.maxAttemptSeconds > 7200) throw new HttpsError('invalid-argument', 'Time limit must be 60–7200 seconds.'); patch.maxAttemptSeconds = d.maxAttemptSeconds; }
  if (!Object.keys(patch).length) throw new HttpsError('invalid-argument', 'Nothing to change.');
  await db.doc('quizSettings/config').set(Object.assign({ timezone: C.TZ, dailyQuestionCount: C.QUESTIONS_PER_QUIZ }, patch, { updatedAt: FV.serverTimestamp(), updatedBy: uid }), { merge: true });
  await C.audit(uid, 'settings', patch);
  const cfgNow = await C.getConfig();
  return { config: cfgNow, genSettings: resolveGen(cfgNow.secondYearGen) };
});

exports.quizAdminSaveDraft = onCall(CALL, async (request) => {
  const uid = C.requireOwner(request);
  const { date, groupId, questions } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  if (date < C.istDate()) throw new HttpsError('invalid-argument', 'Drafts can only be saved for today or a future date.');
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > C.QUESTIONS_PER_QUIZ) throw new HttpsError('invalid-argument', 'Provide 1 to 3 questions.');
  const cleaned = questions.map((q, i) => { const c = C.cleanQuestion(q); if (!c.ok) throw new HttpsError('invalid-argument', `Question ${i + 1}: ${c.errors.join(' ')}`); return c.q; });
  const key = C.quizKey(date, groupId);
  if ((await db.doc(`dailyQuizzes/${key}`).get()).exists) throw new HttpsError('failed-precondition', 'This quiz is already published. Use Replace or the correction process.');
  const prevDraft = await db.doc(`quizDrafts/${key}`).get();      // keep the generator settings an AI draft was made with
  await db.doc(`quizDrafts/${key}`).set({ date, groupId, status: cleaned.length === C.QUESTIONS_PER_QUIZ ? 'ready' : 'draft', questions: cleaned, source: 'manual', settings: (prevDraft.exists && prevDraft.data().settings) || null, updatedAt: FV.serverTimestamp(), updatedBy: uid });
  await C.audit(uid, 'saveDraft', { key, count: cleaned.length });
  return { key, count: cleaned.length, ready: cleaned.length === C.QUESTIONS_PER_QUIZ };
});

exports.quizAdminPublish = onCall(CALL, async (request) => {
  const uid = C.requireOwner(request);
  const { date, groupId, replace } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  if (date < C.istDate()) throw new HttpsError('invalid-argument', 'You cannot publish a quiz for a past date.');
  const key = C.quizKey(date, groupId);
  const draft = await db.doc(`quizDrafts/${key}`).get();
  if (!draft.exists || draft.data().status === 'published' || !Array.isArray(draft.data().questions)) throw new HttpsError('failed-precondition', 'Save a complete draft of three questions first.');
  await C.publishQuiz({ date, groupId, questions: draft.data().questions, source: draft.data().source === 'ai-draft' ? 'ai-reviewed' : 'manual', actor: uid, replace: replace === true, genSettings: draft.data().settings || null });
  await C.logGeneration({ date, groupId, status: 'published', source: 'manual', trigger: 'admin' });
  await C.audit(uid, 'publish', { key, replace: replace === true });
  return { key, published: true };
});

exports.quizAdminGenerate = onCall(CALL_AI, async (request) => {
  const uid = C.requireOwner(request);
  await C.rateLimit(uid, 'gen', 6, 600);
  const { date, groupId, publishNow, replace } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  if (date < C.istDate()) throw new HttpsError('invalid-argument', 'Choose today or a future date.');
  const key = C.quizKey(date, groupId);
  const doReplace = replace === true;                // owner-requested regeneration: the old quiz is swapped for a new one only after the new one is ready
  if ((await db.doc(`dailyQuizzes/${key}`).get()).exists) {
    if (!doReplace) throw new HttpsError('failed-precondition', 'A quiz is already published for that date and group.');
    const started = await db.collection('quizAttempts').where('date', '==', date).where('groupId', '==', groupId).limit(1).get();
    if (!started.empty) throw new HttpsError('failed-precondition', 'Students have already started this quiz, so it cannot be replaced. Use Inspect \u2192 Correct instead.');
  }
  const cfg = await C.getConfig();
  let g;
  try { g = await generateQuiz({ date, groupId, cfg, apiKey: secret(), trigger: 'admin' }); }
  catch (e) { await C.logGeneration({ date, groupId, status: 'failed', provider: cfg.generationProvider, model: cfg.generationModel, trigger: 'admin', error: e.message }); throw e; }
  if (publishNow === true || doReplace) {
    await C.publishQuiz({ date, groupId, questions: g.questions, source: g.source === 'pool' ? 'pool' : 'ai', actor: uid, poolIds: g.poolIds, replace: doReplace, genSettings: g.settings });
    await C.logGeneration({ date, groupId, status: 'published', source: g.source, provider: g.provider, model: g.model, trigger: 'admin', settings: g.settings });
  } else {
    await db.doc(`quizDrafts/${key}`).set({ date, groupId, status: 'ready', questions: g.questions, source: 'ai-draft', poolIds: g.poolIds, settings: g.settings || null, updatedAt: FV.serverTimestamp(), updatedBy: uid });
    await C.logGeneration({ date, groupId, status: 'drafted', source: g.source, provider: g.provider, model: g.model, trigger: 'admin', settings: g.settings });
  }
  await C.audit(uid, 'generate', { key, publishNow: publishNow === true, replace: doReplace, source: g.source });
  return { key, published: publishNow === true || doReplace, source: g.source, questions: g.questions };
});

/** Owner-only: remove a published quiz in ANY case (today, future, or past/finalised, with or without student attempts). XP already paid for it is reversed. */
exports.quizAdminDelete = onCall(CALL, async (request) => {
  const uid = C.requireOwner(request);
  const { date, groupId } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  const key = C.quizKey(date, groupId);
  const quizRef = db.doc(`dailyQuizzes/${key}`);
  if (!(await quizRef.get()).exists) throw new HttpsError('not-found', 'No published quiz for that date/group.');
  await quizRef.delete();                                   // first: students can no longer open or start it
  await db.doc(`quizAnswerKeys/${key}`).delete();
  const removeAll = async (snap) => { for (let i = 0; i < snap.docs.length; i += 400) { const bt = db.batch(); snap.docs.slice(i, i + 400).forEach((d) => bt.delete(d.ref)); await bt.commit(); } return snap.docs.length; };
  const attempts = await removeAll(await db.collection('quizAttempts').where('date', '==', date).where('groupId', '==', groupId).get());
  const entries = await removeAll(await db.collection(`quizBoards/${key}/entries`).get());
  // If the day was already ranked, take back the XP it paid and fix the weekly totals/ranks.
  const wk = C.weekId(date);
  const ledger = await db.collection('quizXpLedger').where('date', '==', date).where('groupId', '==', groupId).get();
  const perUid = {}; ledger.docs.forEach((d) => { const l = d.data(); perUid[l.uid] = (perUid[l.uid] || 0) + (l.xp || 0); });
  const uids = Object.keys(perUid);
  for (let i = 0; i < uids.length; i += 400) {
    const bt = db.batch();
    uids.slice(i, i + 400).forEach((u) => { if (perUid[u]) {
      bt.set(db.doc(`weeklyQuizResults/${wk}_${groupId}_${u}`), { totalXP: FV.increment(-perUid[u]), updatedAt: FV.serverTimestamp() }, { merge: true });
      bt.set(db.doc(`xpTotals/${u}`), { uid: u, quizXP: FV.increment(-perUid[u]), totalXP: FV.increment(-perUid[u]), updatedAt: FV.serverTimestamp() }, { merge: true });   // keep the Overall leaderboard in step
    } });
    await bt.commit();
  }
  const ledgerRemoved = await removeAll(ledger);
  const results = await removeAll(await db.collection('dailyQuizResults').where('date', '==', date).where('groupId', '==', groupId).get());
  if (uids.length || results) await C.recomputeWeeklyRanks(wk, groupId);
  await C.logGeneration({ date, groupId, status: 'deleted', source: 'admin', trigger: 'admin' });
  await C.audit(uid, 'delete', { key, attempts, entries, results, ledgerRemoved });
  return { key, deleted: true, attempts, entries, results };
});

exports.quizAdminGetQuiz = onCall(CALL, async (request) => {
  C.requireOwner(request);
  const { date, groupId } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  const key = C.quizKey(date, groupId);
  const [quiz, k] = await Promise.all([db.doc(`dailyQuizzes/${key}`).get(), db.doc(`quizAnswerKeys/${key}`).get()]);
  if (!quiz.exists) throw new HttpsError('not-found', 'No published quiz for that date/group.');
  const q = quiz.data();
  return { key, status: q.status, source: q.generationSource, questions: q.questions.map((x, i) => Object.assign({}, x, { correctIndex: k.data().answers[i], explanation: k.data().explanations[i] })) };
});

exports.quizAdminCorrect = onCall({ cors: true, timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const uid = C.requireOwner(request);
  const { date, groupId, index, reason } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  if (!Number.isInteger(index) || index < 0 || index >= C.QUESTIONS_PER_QUIZ) throw new HttpsError('invalid-argument', 'Invalid question number.');
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 400) throw new HttpsError('invalid-argument', 'A documented reason (10–400 characters) is required.');
  const key = C.quizKey(date, groupId);
  const quizRef = db.doc(`dailyQuizzes/${key}`), keyRef = db.doc(`quizAnswerKeys/${key}`);
  const before = await db.runTransaction(async (t) => {
    const [quiz, k] = await Promise.all([t.get(quizRef), t.get(keyRef)]);
    if (!quiz.exists) throw new HttpsError('not-found', 'No published quiz for that date/group.');
    const cur = quiz.data().questions[index];
    const merged = C.cleanQuestion({
      text: request.data.text != null ? request.data.text : cur.text,
      options: request.data.options != null ? request.data.options : cur.options,
      correctIndex: request.data.correctIndex != null ? request.data.correctIndex : k.data().answers[index],
      explanation: request.data.explanation != null ? request.data.explanation : k.data().explanations[index],
      difficulty: cur.difficulty, category: cur.category,
    });
    if (!merged.ok) throw new HttpsError('invalid-argument', merged.errors.join(' '));
    const questions = quiz.data().questions.slice(), answers = k.data().answers.slice(), explanations = k.data().explanations.slice();
    const snapshot = { text: cur.text, options: cur.options, correctIndex: answers[index], explanation: explanations[index] };
    questions[index] = Object.assign({}, cur, { text: merged.q.text, options: merged.q.options });
    answers[index] = merged.q.correctIndex; explanations[index] = merged.q.explanation;
    t.update(quizRef, { questions, correctedAt: FV.serverTimestamp() });
    t.update(keyRef, { answers, explanations, updatedAt: FV.serverTimestamp() });
    t.set(db.collection('quizCorrections').doc(), { date, groupId, index, reason: reason.trim(), before: snapshot, after: { text: merged.q.text, options: merged.q.options, correctIndex: merged.q.correctIndex, explanation: merged.q.explanation }, actor: uid, createdAt: FV.serverTimestamp() });
    return snapshot;
  });
  const rescored = await C.rescoreQuiz(date, groupId, uid);
  await C.audit(uid, 'correct', { key, index, reason, answerChanged: request.data.correctIndex != null });
  return { corrected: true, rescored: rescored.updated, previous: before };
});

exports.quizAdminFinalize = onCall({ cors: true, timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const uid = C.requireOwner(request);
  const { date, groupId } = request.data || {};
  C.assertDate(date); isGroup(groupId);
  const r = await C.finalizeQuiz(date, groupId, { reason: 'admin re-finalise', actor: uid });
  await C.audit(uid, 'finalize', r);
  return r;
});

/* ===================================================================================== schedulers ===== */

/** Create today's quizzes for any group that has none. Honors the ON/OFF toggle; never overwrites; never publishes invalid data. */
async function ensureQuizzes(date, trigger) {
  const cfg = await C.getConfig();
  if (!cfg.automaticGenerationEnabled) return { skipped: 'automatic generation is OFF' };
  const out = {};
  for (const g of GROUP_IDS) {
    const key = C.quizKey(date, g);
    if ((await db.doc(`dailyQuizzes/${key}`).get()).exists) { out[g] = 'exists'; continue; }
    // 1) an admin-prepared complete draft for this date wins (that is how a day is overridden)
    const draft = await db.doc(`quizDrafts/${key}`).get();
    try {
      if (draft.exists && draft.data().status === 'ready' && (draft.data().questions || []).length === C.QUESTIONS_PER_QUIZ) {
        await C.publishQuiz({ date, groupId: g, questions: draft.data().questions, source: draft.data().source === 'ai-draft' ? 'ai-reviewed' : 'manual', actor: 'scheduler', genSettings: draft.data().settings || null });
        await C.logGeneration({ date, groupId: g, status: 'published', source: 'draft', trigger });
        out[g] = 'published-draft'; continue;
      }
    } catch (e) { if (e.code === 'already-exists') { out[g] = 'exists'; continue; } await C.logGeneration({ date, groupId: g, status: 'failed', source: 'draft', trigger, error: e.message }); }
    // 2) cap automatic retries so a broken key doesn't burn money all day
    const fails = await db.collection('quizGenerationLogs').where('date', '==', date).where('groupId', '==', g).where('status', '==', 'failed').count().get();
    if (fails.data().count >= 6) { out[g] = 'gave-up'; continue; }
    // 3) AI (then backup pool)
    try {
      const gen = await generateQuiz({ date, groupId: g, cfg, apiKey: secret(), trigger });
      await C.publishQuiz({ date, groupId: g, questions: gen.questions, source: gen.source, actor: 'scheduler', poolIds: gen.poolIds, genSettings: gen.settings });
      await C.logGeneration({ date, groupId: g, status: 'published', source: gen.source, provider: gen.provider, model: gen.model, trigger, settings: gen.settings });
      out[g] = 'published-' + gen.source;
    } catch (e) {
      if (e.code === 'already-exists') { out[g] = 'exists'; continue; }
      await C.logGeneration({ date, groupId: g, status: 'failed', provider: cfg.generationProvider, model: cfg.generationModel, trigger, error: e.message });
      out[g] = 'failed';
    }
  }
  return out;
}

/** Finalise every closed-but-unfinalised quiz (normally just yesterday; also catches up after an outage). */
async function finalizeClosed() {
  const today = C.istDate();
  const snap = await db.collection('dailyQuizzes').where('status', '==', 'published').where('date', '<', today).limit(20).get();
  const done = [];
  for (const d of snap.docs) { const q = d.data(); try { done.push(await C.finalizeQuiz(q.date, q.groupId, { reason: 'scheduled' })); } catch (e) { console.error('finalize failed', d.id, e); } }
  return done;
}

// 00:00 IST — close yesterday (rank + XP + weekly) and open today.
exports.quizDailyRollover = onSchedule({ schedule: '0 0 * * *', timeZone: C.TZ, secrets: [AI_KEY], timeoutSeconds: 540, memory: '512MiB', retryCount: 0 }, async () => {
  const fin = await finalizeClosed();
  const ens = await ensureQuizzes(C.istDate(), 'schedule');
  console.log('[quizDailyRollover]', JSON.stringify({ finalized: fin.length, ensure: ens }));
});

// Every hour at :15 — retry anything that failed at midnight and finalise anything that was missed. Cheap when nothing is missing.
exports.quizEnsureHourly = onSchedule({ schedule: '15 * * * *', timeZone: C.TZ, secrets: [AI_KEY], timeoutSeconds: 540, memory: '512MiB', retryCount: 0 }, async () => {
  const fin = await finalizeClosed();
  const ens = await ensureQuizzes(C.istDate(), 'schedule-retry');
  console.log('[quizEnsureHourly]', JSON.stringify({ finalized: fin.length, ensure: ens }));
});

/* ===================================================================================== push notifications ===== */
// Student Centro: Daily Quiz reminders + results, sent to each student's own phone (FCM token in deviceTokens/{uid}). See lib/notify.js.
const { makeNotifier } = require('./lib/notify');
const notifier = () => makeNotifier({ db, messaging: require('firebase-admin/messaging').getMessaging(), core: C });
const NOTIFY = { timeZone: C.TZ, timeoutSeconds: 300, memory: '256MiB', retryCount: 0 };

// 18:00 IST — everyone who has not SUBMITTED today's quiz (never started, or started and left).
exports.quizReminderEvening = onSchedule({ ...NOTIFY, schedule: '0 18 * * *' }, async () => {
  console.log('[quizReminderEvening]', JSON.stringify(await notifier().sendReminders('evening')));
});
// 21:30 IST — last call, only for those still not submitted.
exports.quizReminderLastCall = onSchedule({ ...NOTIFY, schedule: '30 21 * * *' }, async () => {
  console.log('[quizReminderLastCall]', JSON.stringify(await notifier().sendReminders('last')));
});
// 08:00 IST — yesterday's results (finalised at 00:00) + weekly leaderboard after a Sunday. Safe to run again: guarded per quiz.
exports.quizResultsMorning = onSchedule({ ...NOTIFY, schedule: '0 8 * * *' }, async () => {
  console.log('[quizResultsMorning]', JSON.stringify(await notifier().sendResults()));
});

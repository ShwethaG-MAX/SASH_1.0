'use strict';
/**
 * Student Hub Quiz — shared core: constants, IST date helpers, group derivation,
 * question validation, XP maths, publishing, finalisation (ranking + XP + weekly) and re-scoring.
 * Everything that touches XP / ranks / answer keys lives on the server (Admin SDK).
 */
const admin = require('firebase-admin');
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;

const TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const QUESTIONS_PER_QUIZ = 3;

/* ---------- groups (stable internal ids) ---------- */
const GROUPS = {
  FY_ALL:        { id: 'FY_ALL',        year: '1', label: 'First Year',                       short: 'First Year' },
  SY_CSE_GROUP:  { id: 'SY_CSE_GROUP',  year: '2', label: 'Second Year (CSE · CSE AIML · ISE)', short: 'Second Year' },
};
const GROUP_IDS = Object.keys(GROUPS);
// Branch ids exactly as configured in the app (FY_BRANCHES / SY_BRANCHES).
const FY_BRANCHES = ['CSE','CSEAIML','ISE','ECE','EEE','EI','CV','IP','ENV','BT','CTM','ME','PST','CSBS'];
const SY_QUIZ_BRANCHES = ['CSE','CSEAIML','ISE'];
const BRANCH_SHORT = { CSEAIML:'CSE AIML', EI:'E&I' };
const branchShort = (id) => BRANCH_SHORT[id] || id || '';

/**
 * Group comes ONLY from the stored profile (userProfiles/{uid}) — never from the request.
 * The stored academic YEAR is authoritative. The section key is consulted only for older profiles that pre-date
 * the year field (a profile with no year at all), so a stale/foreign section can never override a known year.
 */
function deriveGroup(p) {
  p = p || {};
  let year = String(p.year || ''), section = String(p.section || '');
  let branch = String(p.branch || '');
  if (year !== '1' && year !== '2') {                               // legacy profile: infer the year from the section key
    if (/^FY-/.test(section)) year = '1';
    else if (/^[A-G]$/.test(section) || /^SY-/.test(section)) year = '2';
    else return null;
  }
  if (year === '1') {
    if (!branch || FY_BRANCHES.includes(branch)) return { groupId: 'FY_ALL', branch, year: '1' };
    return null;
  }
  if (!branch) branch = 'CSE';                                      // legacy second-year profiles are CSE sections A–G
  if (SY_QUIZ_BRANCHES.includes(branch)) return { groupId: 'SY_CSE_GROUP', branch, year: '2' };
  return null;
}

/* ---------- IST date helpers (daily rollover and week boundary are Asia/Kolkata) ---------- */
const pad = (n) => String(n).padStart(2, '0');
function istDate(ms = Date.now()) {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) throw new HttpsError('invalid-argument', 'Invalid date.');
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new HttpsError('invalid-argument', 'Invalid date.');
  return s;
}
const dayStartMs = (date) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) - IST_OFFSET_MS; };
const dayEndMs = (date) => dayStartMs(date) + 86400000;       // exclusive
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
/** Week = ISO week, Monday 00:00 IST → Sunday 23:59:59 IST. Id like 2026-W44. */
function weekId(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const ys = Date.UTC(t.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((t - ys) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(wk)}`;
}
const quizKey = (date, groupId) => `${date}_${groupId}`;

/* ---------- settings ---------- */
const DEFAULT_CONFIG = {
  automaticGenerationEnabled: false,       // OFF until the admin switches it on (after secrets are configured)
  timezone: TZ,
  dailyQuestionCount: QUESTIONS_PER_QUIZ,
  xpRewardConfig: { rank1: 100, rank2: 80, rank3: 65, rank4to10: 40, rank11to25: 25, participation: 10, zeroCorrect: 0 },
  generationProvider: 'anthropic',         // 'anthropic' | 'openai' | 'gemini'
  generationModel: '',                     // blank = provider default (see ai.js)
  requireVerification: true,               // second-pass AI check of every generated question
  revealAnswersMode: 'afterSubmit',        // 'afterSubmit' | 'afterClose'
  maxAttemptSeconds: 1800,
  poolBuffer: 3,                           // spare approved questions generated per call → backup pool
};
async function getConfig() {
  const s = await db.doc('quizSettings/config').get();
  const c = Object.assign({}, DEFAULT_CONFIG, s.exists ? s.data() : {});
  c.xpRewardConfig = Object.assign({}, DEFAULT_CONFIG.xpRewardConfig, (s.exists && s.data().xpRewardConfig) || {});
  c.dailyQuestionCount = QUESTIONS_PER_QUIZ;
  return c;
}
function validateXpConfig(x) {
  const keys = ['rank1', 'rank2', 'rank3', 'rank4to10', 'rank11to25', 'participation', 'zeroCorrect'];
  const out = {};
  for (const k of keys) {
    const v = x && x[k];
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw new HttpsError('invalid-argument', `XP value "${k}" must be a whole number between 0 and 1000.`);
    out[k] = v;
  }
  return out;
}
function xpFor(rank, correct, cfg) {
  const x = cfg.xpRewardConfig;
  if (!correct) return x.zeroCorrect;
  if (rank === 1) return x.rank1;
  if (rank === 2) return x.rank2;
  if (rank === 3) return x.rank3;
  if (rank <= 10) return x.rank4to10;
  if (rank <= 25) return x.rank11to25;
  return x.participation;
}

/* ---------- auth helpers ---------- */
function requireAuth(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Please wait for sign-in to finish and try again.');
  return request.auth.uid;
}
/** Admin = the existing Firebase Auth custom claim owner:true (set via Admin SDK). CRs and students never have it. */
function requireOwner(request) {
  const uid = requireAuth(request);
  if (request.auth.token.owner !== true) throw new HttpsError('permission-denied', 'Admin access required.');
  return uid;
}
async function rateLimit(uid, key, max, windowSec) {
  const ref = db.doc(`quizRate/${uid}_${key}`);
  const now = Date.now();
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    let d = s.exists ? s.data() : { start: 0, count: 0 };
    if (now - d.start > windowSec * 1000) d = { start: now, count: 0 };
    if (d.count >= max) throw new HttpsError('resource-exhausted', 'Too many requests. Please wait a moment and try again.');
    t.set(ref, { start: d.start, count: d.count + 1, expireAt: TS.fromMillis(now + windowSec * 2000) });
  });
}

/* ---------- student context (always derived from the stored profile) ---------- */
/**
 * The quiz group is derived from userProfiles/{uid} on EVERY call. It used to be "pinned" for the week and the pin overrode the
 * profile, which kept showing the wrong year's quiz after a student's academic year was set or corrected. The pin is now only
 * recorded for audit (quizProfiles/{uid}); it never decides which quiz a student sees.
 * Double-dipping across years is prevented separately: see attemptInOtherGroup().
 */
async function resolveStudent(uid, { pin = false } = {}) {
  const snap = await db.doc(`userProfiles/${uid}`).get();
  const p = snap.exists ? snap.data() : {};
  const name = String(p.name || '').trim().slice(0, 40);
  const derived = deriveGroup(p);
  const groupId = derived ? derived.groupId : null;
  const branch = derived ? derived.branch : '';
  if (pin && derived && name) {
    try { await db.doc(`quizProfiles/${uid}`).set({ groupId, branch, weekId: weekId(istDate()), updatedAt: FV.serverTimestamp() }); } catch (e) { console.error('quizProfiles audit write failed', e); }
  }
  const profileYear = p.year === '1' || p.year === '2' ? p.year : '';
  return { uid, name, groupId, year: derived ? derived.year : '', profileYear, branch, branchShort: branchShort(branch), hasName: !!name };
}
/** If this student already has an attempt on `date` under a DIFFERENT year's quiz, return that group id (else null). */
async function attemptInOtherGroup(uid, date, groupId) {
  const others = GROUP_IDS.filter((g) => g !== groupId);
  if (!others.length) return null;
  const snaps = await Promise.all(others.map((g) => db.doc(`quizAttempts/${quizKey(date, g)}_${uid}`).get()));
  const i = snaps.findIndex((s) => s.exists);
  return i === -1 ? null : others[i];
}

/* ---------- question validation ---------- */
const DIFFICULTIES = ['beginner', 'easy', 'medium', 'hard', 'advanced', 'expert'];
const BANNED = /(all of the above|none of the above|both (a|b|c|d) and|a and b|b and c|c and d|a, b|not sure)/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const qHash = (text) => crypto.createHash('sha1').update(norm(text)).digest('hex');
/** Returns {ok, errors, q} where q is a cleaned question. Used for AI output AND manual admin input. */
function cleanQuestion(raw) {
  const errors = [];
  const q = {
    text: String((raw && raw.text) || '').trim(),
    options: Array.isArray(raw && raw.options) ? raw.options.map((o) => String(o == null ? '' : o).trim()) : [],
    correctIndex: raw && raw.correctIndex,
    explanation: String((raw && raw.explanation) || '').trim(),
    difficulty: String((raw && raw.difficulty) || 'medium').toLowerCase(),
    category: String((raw && raw.category) || 'General').trim().slice(0, 40),
  };
  if (q.text.length < 10 || q.text.length > 400) errors.push('Question must be 10–400 characters.');
  if (q.options.length !== 4) errors.push('Exactly four options are required.');
  else {
    if (q.options.some((o) => !o || o.length > 160)) errors.push('Every option must be 1–160 characters.');
    if (new Set(q.options.map(norm)).size !== 4) errors.push('Options must all be different.');
    if (q.options.some((o) => BANNED.test(o))) errors.push('Options like "all/none of the above" are not allowed.');
  }
  if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) errors.push('Exactly one correct option (0–3) is required.');
  if (q.explanation.length < 10 || q.explanation.length > 500) errors.push('Explanation must be 10–500 characters.');
  if (!DIFFICULTIES.includes(q.difficulty)) errors.push('Difficulty must be beginner, easy, medium, hard, advanced or expert.');
  // optional metadata (Second Year generator); keys are only present when supplied, so older questions are unchanged
  const meta = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);
  for (const [k, n] of [['domain', 60], ['topic', 80], ['format', 60], ['language', 30]]) { const v = meta(raw && raw[k], n); if (v) q[k] = v; }
  const est = Math.round(Number(raw && raw.estSeconds)); if (est >= 10 && est <= 900) q.estSeconds = est;
  return { ok: errors.length === 0, errors, q };
}
const publicQuestion = (q, i) => Object.assign({ id: 'q' + (i + 1), text: q.text, options: q.options, difficulty: q.difficulty, category: q.category },
  ...['domain', 'topic', 'format', 'language', 'estSeconds'].filter((k) => q[k] != null && q[k] !== '').map((k) => ({ [k]: q[k] })));

/* ---------- logging ---------- */
async function logGeneration(o) {
  try {
    await db.collection('quizGenerationLogs').add({
      date: o.date, groupId: o.groupId || null, status: o.status, source: o.source || '', provider: o.provider || '', model: o.model || '',
      trigger: o.trigger || '', error: String(o.error || '').slice(0, 600), settings: o.settings || null, createdAt: FV.serverTimestamp(),
    });
  } catch (e) { console.error('log failed', e); }
}
async function audit(actor, action, detail) {
  try { await db.collection('quizAdminAudit').add({ actor, action, detail: detail || {}, createdAt: FV.serverTimestamp() }); } catch (e) { console.error('audit failed', e); }
}

/* ---------- publishing (atomic; never overwrites unless replace=true and nobody has started) ---------- */
async function publishQuiz({ date, groupId, questions, source, actor, replace = false, poolIds = [], genSettings = null }) {
  if (!GROUPS[groupId]) throw new HttpsError('invalid-argument', 'Unknown group.');
  assertDate(date);
  if (!Array.isArray(questions) || questions.length !== QUESTIONS_PER_QUIZ) throw new HttpsError('failed-precondition', 'A quiz needs exactly three questions.');
  const cleaned = questions.map((q) => cleanQuestion(q));
  const bad = cleaned.findIndex((c) => !c.ok);
  if (bad !== -1) throw new HttpsError('failed-precondition', `Question ${bad + 1}: ${cleaned[bad].errors.join(' ')}`);
  const qs = cleaned.map((c) => c.q);
  const key = quizKey(date, groupId);
  const quizRef = db.doc(`dailyQuizzes/${key}`);
  const keyRef = db.doc(`quizAnswerKeys/${key}`);
  await db.runTransaction(async (t) => {
    const existing = await t.get(quizRef);
    if (existing.exists) {
      if (!replace) throw new HttpsError('already-exists', 'A quiz is already published for this date and group.');
      const started = await t.get(db.collection('quizAttempts').where('date', '==', date).where('groupId', '==', groupId).limit(1));
      if (!started.empty) throw new HttpsError('failed-precondition', 'Students have already started this quiz. Use the correction process instead of replacing it.');
    }
    t.set(quizRef, {
      date, groupId, status: 'published', questionCount: QUESTIONS_PER_QUIZ,
      questions: qs.map(publicQuestion), generationSource: source, generationSettings: genSettings || null,
      publishedAt: FV.serverTimestamp(), createdAt: existing.exists ? existing.data().createdAt : FV.serverTimestamp(), publishedBy: actor || 'system',
    });
    t.set(keyRef, { date, groupId, answers: qs.map((q) => q.correctIndex), explanations: qs.map((q) => q.explanation), updatedAt: FV.serverTimestamp() });
    qs.forEach((q) => t.set(db.doc(`quizQuestionHashes/${qHash(q.text)}`), { groupId, date, text: q.text.slice(0, 200), createdAt: FV.serverTimestamp() }));
    poolIds.forEach((id) => t.set(db.doc(`quizQuestionPool/${id}`), { used: true, usedOn: date }, { merge: true }));
    t.set(db.doc(`quizDrafts/${key}`), { status: 'published', updatedAt: FV.serverTimestamp() }, { merge: true });
  });
  return { key };
}

/* ---------- finalisation: rank → XP → ledger → weekly (idempotent, safe to re-run) ---------- */
const rankSort = (a, b) =>
  (b.correctCount - a.correctCount) || (a.completionTimeMs - b.completionTimeMs) || (a.submittedAtMs - b.submittedAtMs) || (a.uid < b.uid ? -1 : 1);

async function recomputeWeeklyRanks(wk, groupId) {
  const snap = await db.collection('weeklyQuizResults').where('weekId', '==', wk).where('groupId', '==', groupId).get();
  const rows = snap.docs.map((d) => ({ ref: d.ref, totalXP: d.data().totalXP || 0, name: d.data().name || '', rank: d.data().rank }));
  rows.sort((a, b) => (b.totalXP - a.totalXP) || a.name.localeCompare(b.name));
  let rank = 0, prev = null;                       // competition ranking: equal XP shares a rank
  rows.forEach((r, i) => { if (r.totalXP !== prev) { rank = i + 1; prev = r.totalXP; } r.newRank = rank; });
  for (let i = 0; i < rows.length; i += 400) {
    const b = db.batch();
    rows.slice(i, i + 400).forEach((r) => { if (r.rank !== r.newRank) b.update(r.ref, { rank: r.newRank }); });
    await b.commit();
  }
}

/** Keeps xpTotals/{uid} (all-time XP by source, read by the Overall leaderboard) in step with every quizXpLedger write.
 *  quizXP / totalXP are only ever INCREMENTED here; the Test functions own testXP and legacyXP (totalXP = quizXP + testXP + legacyXP). */
function addQuizXpTotal(t, e, xp) {
  if (!xp) return;
  t.set(db.doc(`xpTotals/${e.uid}`), { uid: e.uid, name: e.name || '', branch: e.branch || '', quizXP: FV.increment(xp), totalXP: FV.increment(xp), updatedAt: FV.serverTimestamp() }, { merge: true });
}

async function finalizeQuiz(date, groupId, { reason = 'scheduled', actor = 'system' } = {}) {
  assertDate(date);
  if (date >= istDate()) throw new HttpsError('failed-precondition', 'A quiz can only be finalised after its day has closed.');
  const key = quizKey(date, groupId);
  const cfg = await getConfig();
  const wk = weekId(date);
  const entries = (await db.collection(`quizBoards/${key}/entries`).get()).docs.map((d) => d.data());
  entries.sort(rankSort);
  const rows = entries.map((e, i) => ({ e, rank: i + 1, xp: xpFor(i + 1, e.correctCount, cfg) }));

  let changed = 0;
  const work = async (r) => {
    const { e } = r;
    const resRef = db.doc(`dailyQuizResults/${key}_${e.uid}`);
    const weeklyRef = db.doc(`weeklyQuizResults/${wk}_${groupId}_${e.uid}`);
    await db.runTransaction(async (t) => {
      const cur = await t.get(resRef);
      const prevXp = cur.exists ? (cur.data().xpAwarded || 0) : 0;
      const delta = r.xp - prevXp;
      t.set(resRef, {
        uid: e.uid, date, groupId, weekId: wk, name: e.name, branch: e.branch, rank: r.rank,
        correctCount: e.correctCount, completionTimeMs: e.completionTimeMs, submittedAtMs: e.submittedAtMs,
        xpAwarded: r.xp, finalizedAt: FV.serverTimestamp(),
      });
      if (!cur.exists) {
        // first award: deterministic ledger id + create() ⇒ the same quiz can never pay the same student twice
        t.create(db.doc(`quizXpLedger/${key}_${e.uid}_daily`), {
          uid: e.uid, date, groupId, weekId: wk, xp: r.xp, type: 'daily', rank: r.rank,
          reason: `Daily rank #${r.rank}`, createdAt: FV.serverTimestamp(), actor,
        });
        t.set(weeklyRef, { uid: e.uid, weekId: wk, groupId, name: e.name, branch: e.branch, totalXP: FV.increment(r.xp), updatedAt: FV.serverTimestamp() }, { merge: true });
        addQuizXpTotal(t, e, r.xp);
        changed++;
      } else if (delta !== 0) {
        t.set(db.collection('quizXpLedger').doc(), {
          uid: e.uid, date, groupId, weekId: wk, xp: delta, type: 'correction', rank: r.rank,
          reason: `Correction (${reason}): rank #${r.rank}`, createdAt: FV.serverTimestamp(), actor,
        });
        t.set(weeklyRef, { uid: e.uid, weekId: wk, groupId, name: e.name, branch: e.branch, totalXP: FV.increment(delta), updatedAt: FV.serverTimestamp() }, { merge: true });
        addQuizXpTotal(t, e, delta);
        changed++;
      }
    });
  };
  for (let i = 0; i < rows.length; i += 15) await Promise.all(rows.slice(i, i + 15).map(work));

  await recomputeWeeklyRanks(wk, groupId);
  await db.doc(`dailyQuizzes/${key}`).set({ status: 'finalized', finalizedAt: FV.serverTimestamp(), participants: rows.length }, { merge: true });
  return { key, participants: rows.length, changed };
}

/** Re-score every submitted attempt after a documented correction; if the day is already final, re-pay XP safely. */
async function rescoreQuiz(date, groupId, actor) {
  const key = quizKey(date, groupId);
  const answers = (await db.doc(`quizAnswerKeys/${key}`).get()).data().answers;
  const snap = await db.collection('quizAttempts').where('date', '==', date).where('groupId', '==', groupId).where('status', '==', 'submitted').get();
  let updated = 0;
  for (let i = 0; i < snap.docs.length; i += 200) {
    const b = db.batch();
    snap.docs.slice(i, i + 200).forEach((d) => {
      const a = d.data();
      const cc = (a.answers || []).reduce((n, v, idx) => n + (v === answers[idx] ? 1 : 0), 0);
      if (cc !== a.correctCount) {
        updated++;
        b.update(d.ref, { correctCount: cc });
        b.update(db.doc(`quizBoards/${key}/entries/${a.uid}`), { correctCount: cc });
      }
    });
    await b.commit();
  }
  const quiz = (await db.doc(`dailyQuizzes/${key}`).get()).data();
  if (quiz && quiz.status === 'finalized') await finalizeQuiz(date, groupId, { reason: 'question correction', actor });
  return { updated };
}

module.exports = {
  admin, db, FV, TS, HttpsError, TZ, GROUPS, GROUP_IDS, QUESTIONS_PER_QUIZ, FY_BRANCHES, SY_QUIZ_BRANCHES,
  DIFFICULTIES, deriveGroup, branchShort, istDate, assertDate, dayStartMs, dayEndMs, addDays, weekId, quizKey,
  DEFAULT_CONFIG, getConfig, validateXpConfig, xpFor, requireAuth, requireOwner, rateLimit, resolveStudent,
  attemptInOtherGroup, cleanQuestion, publicQuestion, qHash, norm, logGeneration, audit, publishQuiz, finalizeQuiz, rescoreQuiz, recomputeWeeklyRanks, rankSort,
};

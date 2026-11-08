'use strict';
/* Pure logic (no Firebase): scoring, publish validation, file-type sniffing, stats aggregation. */
const LETTERS = 'ABCDEF';

function cleanAnswer(v, nOpts) {
  v = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return v && LETTERS.slice(0, nOpts).includes(v) ? v : null;
}

/* A question may be served / scored only if complete. Returns '' when fine, else the problem. */
function questionProblem(q, key) {
  if (!q || typeof q.text !== 'string' || !q.text.trim()) return 'has no question text';
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) return 'needs 2 to 6 options';
  if (q.options.some((o) => typeof o !== 'string' || !o.trim())) return 'has an empty option';
  if (!key || typeof key.correctAnswer !== 'string' || key.correctAnswer.length !== 1 || !LETTERS.slice(0, q.options.length).includes(key.correctAnswer)) return 'has no valid correct answer';
  return '';
}

/* All included questions must be valid to publish. Returns {ok, problems:[ 'Q3 needs …' ], valid:n} */
function validateForPublish(questions, keys) {
  const inc = questions.filter((q) => q.included !== false);
  const problems = [];
  inc.forEach((q) => { const p = questionProblem(q, keys[q.id]); if (p) problems.push(`Q${q.order} ${p}`); });
  if (!inc.length) problems.push('The test has no included questions');
  return { ok: !problems.length, problems, valid: inc.length - problems.filter((p) => !p.startsWith('The test')).length };
}

/* questions: [{id,order,text,options,marks,subject,topic}], keys {id:{correctAnswer,explanation}}, answers {id:'A'|null}.
   maxMarks (optional): the admin-declared total; marks are scaled so a full score equals it. */
function scoreAttempt(questions, keys, answers, maxMarks) {
  let correct = 0, incorrect = 0, unanswered = 0, raw = 0, rawMax = 0;
  const review = questions.map((q) => {
    const key = keys[q.id] || {};
    const marks = Number(q.marks) > 0 ? Number(q.marks) : 1;
    const given = cleanAnswer(answers && answers[q.id], q.options.length);
    rawMax += marks;
    const isCorrect = given !== null && given === key.correctAnswer;
    if (given === null) unanswered++; else if (isCorrect) { correct++; raw += marks; } else incorrect++;
    return { questionId: q.id, text: q.text, options: q.options, marks, subject: q.subject || '', topic: q.topic || '',
      yourAnswer: given, correctAnswer: key.correctAnswer, explanation: key.explanation || '', isCorrect };
  });
  const scale = Number(maxMarks) > 0 && rawMax > 0 ? Number(maxMarks) / rawMax : 1;
  const r2 = (n) => Math.round(n * 100) / 100;
  const score = r2(raw * scale), maxScore = r2(rawMax * scale);
  const percentage = rawMax > 0 ? Math.round((raw / rawMax) * 1000) / 10 : 0;
  return { correct, incorrect, unanswered, score, maxScore, percentage, total: questions.length, review };
}

/* PDF ('%PDF') or DOCX (zip 'PK' + word/document.xml). Legacy .doc (OLE) is detected so we can explain. */
function sniffFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return 'unknown';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return buf.includes(Buffer.from('word/')) ? 'docx' : 'zip';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'doc';
  return 'unknown';
}

const MAX_FILE_BYTES = 6 * 1024 * 1024;
/* Validates and normalises testExtract input. Throws Error(message) with a student/admin-readable message. */
function cleanTestMeta(d) {
  d = d || {};
  const title = String(d.title || '').trim();
  if (!title || title.length > 120) throw new Error('Enter a test title (up to 120 characters).');
  const description = String(d.description || '').trim().slice(0, 400);
  const durationMin = Number(d.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 600) throw new Error('Duration must be a whole number of minutes between 1 and 600.');
  const totalQuestions = Number(d.totalQuestions);
  if (!Number.isInteger(totalQuestions) || totalQuestions < 1 || totalQuestions > 300) throw new Error('Total questions must be a whole number between 1 and 300.');
  let maxMarks = null;
  if (d.maxMarks !== undefined && d.maxMarks !== null && d.maxMarks !== '') {
    maxMarks = Number(d.maxMarks);
    if (!(maxMarks > 0 && maxMarks <= 10000)) throw new Error('Maximum marks must be a positive number.');
  }
  return { title, description, durationMin, totalQuestions, maxMarks };
}
function cleanFileName(n) { return String(n || 'paper').replace(/[^\w.\-]+/g, '_').slice(-80) || 'paper'; }

/* ---- Test XP ----
   XP for one submitted test = completion XP + score bonus (same shape as the old Syllabus Test and the Daily Quiz participation XP):
     completion : 10 XP when at least one question was answered (an empty submission earns nothing)
     bonus      : round(percentage / 100 * 40)
   => 10..50 XP per test. There is ONE attempt per test, so a test can never pay twice. */
const TEST_XP = { completion: 10, scoreBonusMax: 40 };
/* r = { total, unanswered, percentage } (the result of scoreAttempt) */
function testXp(r) {
  const answered = (Number(r && r.total) || 0) - (Number(r && r.unanswered) || 0);
  if (answered < 1) return 0;
  const pct = Math.max(0, Math.min(100, Number(r.percentage) || 0));
  return TEST_XP.completion + Math.round((pct / 100) * TEST_XP.scoreBonusMax);
}

/* results: [{score,maxScore,percentage,durationMs,xp}] -> testStats numbers. totalXp = sum of each test's stored xp. */
function aggregateStats(results) {
  const n = results.length;
  const sum = (k) => results.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totalPoints = Math.round(sum('percentage') * 10) / 10;
  return { testsTaken: n, totalPoints, totalXp: Math.round(sum('xp')), avgPercentage: n ? Math.round((totalPoints / n) * 10) / 10 : 0,
    totalScore: Math.round(sum('score') * 100) / 100, totalMax: Math.round(sum('maxScore') * 100) / 100, totalTimeMs: sum('durationMs') };
}

module.exports = { LETTERS, cleanAnswer, questionProblem, validateForPublish, scoreAttempt, sniffFile, cleanTestMeta, cleanFileName, aggregateStats, testXp, TEST_XP, MAX_FILE_BYTES };

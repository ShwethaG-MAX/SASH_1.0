'use strict';
/* Pure scoring logic (no Firebase) so it can be unit-tested. */
const LETTERS = 'ABCDEF';

function cleanAttemptKey(k) {
  k = String(k == null ? '' : k);
  return /^[A-Za-z0-9_-]{8,48}$/.test(k) ? k : '';
}

/* questions: [{id, text, options:[..], marks, topic}], keys: {id:{correctAnswer, explanation}}, answers: {id:'A'|null}
   Returns the full result + review snapshot. Unknown / out-of-range answers count as unanswered. */
function scoreAttempt(questions, keys, answers, passPercent) {
  let correct = 0, incorrect = 0, unanswered = 0, score = 0, maxScore = 0;
  const review = questions.map((q) => {
    const key = keys[q.id] || {};
    const marks = Number(q.marks) > 0 ? Number(q.marks) : 1;
    const valid = LETTERS.slice(0, q.options.length);
    let given = answers && answers[q.id];
    given = typeof given === 'string' && valid.includes(given.toUpperCase()) ? given.toUpperCase() : null;
    maxScore += marks;
    const isCorrect = given !== null && given === key.correctAnswer;
    if (given === null) unanswered++;
    else if (isCorrect) { correct++; score += marks; }
    else incorrect++;
    return {
      questionId: q.id, text: q.text, options: q.options, marks,
      topic: q.topic || '', yourAnswer: given, correctAnswer: key.correctAnswer,
      explanation: key.explanation || '', isCorrect,
    };
  });
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;
  return { correct, incorrect, unanswered, score, maxScore, percentage,
    passed: percentage >= (Number(passPercent) || 0), total: questions.length, review };
}

/* A question may be shown to / scored for students only if it is complete. */
function isValidQuestion(q, key) {
  if (!q || q.status !== 'published') return false;
  if (typeof q.questionText !== 'string' || !q.questionText.trim()) return false;
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) return false;
  if (q.options.some((o) => typeof o !== 'string' || !o.trim())) return false;
  if (!key || typeof key.correctAnswer !== 'string') return false;
  return LETTERS.slice(0, q.options.length).includes(key.correctAnswer);
}

module.exports = { scoreAttempt, isValidQuestion, cleanAttemptKey, LETTERS };

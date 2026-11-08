'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseQuestions, splitInlineOptions, parseAnswerKeySection } = require('./lib/parse');
const S = require('./lib/score');
const { validateAiQuestions, parseJson, chunkText, extractWithAi } = require('./lib/ai');
const fx = (n) => path.join(__dirname, 'test', 'fixtures', n);

/* ---- parser on a realistic paper: units, marks, inline options, per-question answer, trailing answer key ---- */
const paper = fs.readFileSync(fx('paper.txt'), 'utf8');
const r = parseQuestions(paper);
assert.strictEqual(r.questions.length, 4);
assert(r.hadKeySection);
const [q1, q2, q3, q4] = r.questions;
assert.strictEqual(q1.text, 'Which data structure uses LIFO order?');
assert.strictEqual(q1.marks, 2);
assert.deepStrictEqual(q1.options, ['Queue', 'Stack', 'Tree', 'Graph']);
assert.strictEqual(q1.answer, 'B');                       // from the Answer Key table
assert.strictEqual(q2.answer, 'C'); assert.strictEqual(q2.options[2], 'O(1)');   // "A." style options
assert.strictEqual(q3.options.length, 4); assert.strictEqual(q3.answer, 'A');    // inline options + per-question answer
assert.strictEqual(q4.answer, 'B');
assert.strictEqual(q1.subject, 'Data Structures');
assert.strictEqual(q1.unit, 'Unit 1 Arrays and Linked Lists'); assert.strictEqual(q1.topic, 'Arrays and Linked Lists');
assert.strictEqual(q3.unit, 'Unit 2 Trees'); assert.strictEqual(q3.topic, 'Trees');
assert(r.questions.every((q) => !q.needsReview));
assert.deepStrictEqual(r.questions.map((q) => q.order), [1, 2, 3, 4]);

/* no headings, no answers => Uncategorised + flagged for review; multi-line question and option text are joined */
const r2 = parseQuestions('Q1. Explain what a compiler\ndoes in one line?\nA) translates\nsource code\nB) runs code\n2) Name any sorting algorithm.');
assert.strictEqual(r2.questions.length, 2);
assert.strictEqual(r2.questions[0].text, 'Explain what a compiler does in one line?');
assert.deepStrictEqual(r2.questions[0].options, ['translates source code', 'runs code']);
assert.strictEqual(r2.questions[0].subject, 'Uncategorised'); assert.strictEqual(r2.questions[0].topic, 'Uncategorised');
assert(r2.questions[0].needsReview); assert(r2.questions[1].needsReview); assert.strictEqual(r2.questions[1].options.length, 0);
assert.strictEqual(parseQuestions('').questions.length, 0);
assert.strictEqual(parseQuestions('just some prose without numbering').questions.length, 0);
assert.strictEqual(splitInlineOptions('stem (A) one (C) two'), null);          // letters must run A,B,C…
assert.deepStrictEqual(parseAnswerKeySection(['1-A, 2) B', '3. C 10 D']), { 1: 'A', 2: 'B', 3: 'C', 10: 'D' });
const many = Array.from({ length: 320 }, (_, i) => `${(i % 99) + 1 + Math.floor(i / 99) * 0}. q${i}`).join('\n');   // numbering that restarts must not crash or exceed the cap
assert(parseQuestions(many).questions.length <= 300);

/* ---- scoring ---- */
const qs = [0, 1, 2].map((i) => ({ id: 'q' + i, order: i + 1, text: 'T' + i, options: ['a', 'b', 'c', 'd'], marks: 1 }));
const keys = { q0: { correctAnswer: 'A', explanation: 'e0' }, q1: { correctAnswer: 'C' }, q2: { correctAnswer: 'D' } };
let s = S.scoreAttempt(qs, keys, { q0: 'A', q1: 'B', q2: null });
assert.deepStrictEqual([s.correct, s.incorrect, s.unanswered, s.score, s.maxScore, s.percentage], [1, 1, 1, 1, 3, 33.3]);
assert.strictEqual(s.review[0].correctAnswer, 'A'); assert.strictEqual(s.review[0].explanation, 'e0');
s = S.scoreAttempt(qs, keys, { q0: 'a', q1: 'C', q2: 'D' }); assert.strictEqual(s.percentage, 100);
s = S.scoreAttempt(qs, keys, { q0: 'Z', q1: 'E', q2: 7 }); assert.strictEqual(s.unanswered, 3);   // junk is unanswered, never correct
s = S.scoreAttempt(qs, keys, null); assert.strictEqual(s.unanswered, 3);
s = S.scoreAttempt(qs, keys, { q0: 'A', q1: 'C', q2: 'D' }, 30);                                  // declared max marks scales the score
assert.deepStrictEqual([s.score, s.maxScore, s.percentage], [30, 30, 100]);
s = S.scoreAttempt(qs, keys, { q0: 'A' }, 30); assert.deepStrictEqual([s.score, s.maxScore], [10, 30]);
const w = [{ id: 'x', order: 1, text: 't', options: ['a', 'b'], marks: 2 }];
assert.strictEqual(S.scoreAttempt(w, { x: { correctAnswer: 'B' } }, { x: 'B' }).score, 2);
assert.strictEqual(S.scoreAttempt(w, { x: { correctAnswer: 'B' } }, { x: 'C' }).unanswered, 1);

/* ---- publish validation ---- */
const pq = (o) => ({ id: 'a', order: 1, text: 'Q', options: ['1', '2', '3', '4'], included: true, ...o });
assert(S.validateForPublish([pq()], { a: { correctAnswer: 'D' } }).ok);
let v = S.validateForPublish([pq(), pq({ id: 'b', order: 2 })], { a: { correctAnswer: 'A' }, b: { correctAnswer: '' } });
assert(!v.ok); assert(v.problems[0].startsWith('Q2')); assert.strictEqual(v.valid, 1);
assert(!S.validateForPublish([pq({ options: ['1', ''] })], { a: { correctAnswer: 'A' } }).ok);
assert(!S.validateForPublish([pq({ options: ['1', '2'] })], { a: { correctAnswer: 'C' } }).ok);   // key letter outside the options
assert(S.validateForPublish([pq({ included: false })], {}).problems[0].includes('no included questions'));
assert(S.validateForPublish([pq(), pq({ id: 'c', order: 2, included: false, options: [] })], { a: { correctAnswer: 'A' } }).ok);   // excluded questions are ignored

/* ---- extraction input validation + file sniffing ---- */
const ok = { title: ' Mid Test ', durationMin: 45, totalQuestions: 20, maxMarks: '40', description: 'd' };
assert.deepStrictEqual(S.cleanTestMeta(ok), { title: 'Mid Test', description: 'd', durationMin: 45, totalQuestions: 20, maxMarks: 40 });
assert.strictEqual(S.cleanTestMeta({ ...ok, maxMarks: '' }).maxMarks, null);
[{ title: '' }, { title: 'x'.repeat(121) }, { durationMin: 0 }, { durationMin: 601 }, { durationMin: 1.5 }, { totalQuestions: 0 }, { totalQuestions: 301 }, { maxMarks: -1 }]
  .forEach((bad) => assert.throws(() => S.cleanTestMeta({ ...ok, ...bad })));
assert.strictEqual(S.sniffFile(fs.readFileSync(fx('paper.pdf'))), 'pdf');
assert.strictEqual(S.sniffFile(fs.readFileSync(fx('paper.docx'))), 'docx');
assert.strictEqual(S.sniffFile(Buffer.from('MZ not a doc at all')), 'unknown');
assert.strictEqual(S.sniffFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0])), 'doc');
assert.strictEqual(S.sniffFile(Buffer.alloc(3)), 'unknown');
assert.strictEqual(S.cleanFileName('../../etc/pass wd.pdf'), '.._.._etc_pass_wd.pdf'.slice(-80).replace(/^\.\._/, '.._'));
assert(!S.cleanFileName('a/b\\c d.pdf').match(/[\/\\ ]/));

/* ---- stats aggregation (leaderboard points; one result per test) ---- */
const st = S.aggregateStats([{ score: 8, maxScore: 10, percentage: 80, durationMs: 1000 }, { score: 15, maxScore: 20, percentage: 75, durationMs: 2000 }]);
assert.deepStrictEqual(st, { testsTaken: 2, totalPoints: 155, totalXp: 0, avgPercentage: 77.5, totalScore: 23, totalMax: 30, totalTimeMs: 3000 });
assert.strictEqual(S.aggregateStats([{ xp: 40 }, { xp: 25 }, {}]).totalXp, 65);   // totalXp = sum of each test's stored xp (rows without xp count 0)

/* ---- Test XP: 10 for answering anything + up to 40 by percentage; nothing for an empty submission ---- */
assert.strictEqual(S.testXp({ total: 10, unanswered: 0, percentage: 100 }), 50);
assert.strictEqual(S.testXp({ total: 10, unanswered: 5, percentage: 50 }), 30);
assert.strictEqual(S.testXp({ total: 10, unanswered: 0, percentage: 0 }), 10);    // answered, all wrong: completion XP only
assert.strictEqual(S.testXp({ total: 10, unanswered: 10, percentage: 0 }), 0);    // empty submission
assert.strictEqual(S.testXp({ total: 4, unanswered: 1, percentage: 33.3 }), 10 + Math.round(0.333 * 40));
assert.strictEqual(S.testXp({ total: 4, unanswered: 0, percentage: 250 }), 50);   // clamped
assert.strictEqual(S.testXp(null), 0);
assert.strictEqual(S.aggregateStats([]).testsTaken, 0);

/* ---- AI payload validation (strict; bad items dropped, never trusted) ---- */
const ai = validateAiQuestions({ questions: [
  { text: 'Good?', options: ['a', 'b', 'c'], answer: 'b', marks: 2, subject: 'Maths', unit: 'Unit 1', topic: 'Sets' },
  { text: '', options: ['a', 'b'] },                                   // no text -> dropped
  { text: 'Bad answer', options: ['a', 'b'], answer: 'D' },            // answer outside options -> blanked + review
  { text: 'No options' },
  'junk', null] });
assert.strictEqual(ai.length, 3);
assert.strictEqual(ai[0].answer, 'B'); assert.strictEqual(ai[0].marks, 2); assert(!ai[0].needsReview);
assert.strictEqual(ai[1].answer, ''); assert(ai[1].needsReview);
assert.strictEqual(ai[2].subject, 'Uncategorised'); assert(ai[2].needsReview);
assert.deepStrictEqual(ai.map((q) => q.order), [1, 2, 3]);
assert.strictEqual(validateAiQuestions(null).length, 0);
assert.strictEqual(parseJson('```json\n{"questions":[]}\n```').questions.length, 0);
assert.strictEqual(parseJson('Sure! {"questions":[{"text":"x"}]} done').questions.length, 1);
assert.throws(() => parseJson('no json here'));
assert(chunkText('x\n'.repeat(20000), 14000).length >= 3);

/* ---- code questions: line breaks + indentation kept, wrapped in a ``` fence (rendered monospace by the website) ---- */
{
  const { looksCode, fenceBlock, reindentBraces, capText } = require('./lib/parse');
  const { rich } = require('./lib/ai');
  const { linesFromItems } = require('./lib/extract');
  const paper = ['1. What is the output of the following program? [2 marks]', '#include <stdio.h>', 'int main() {', '    int i;', '    for (i = 0; i < 3; i++) {',
    '        if (i == 1)', '            continue;', '        printf("%d", i);', '    }', '    return 0;', '}', 'A) 02', 'B) 012', 'C) 01', 'D) 12', 'Answer: A',
    '2. Which keyword exits a loop? A) skip B) break C) stop D) exit', 'Answer: B',
    '3. What does this print?', 'def f(n):', '    if n == 0:', '        return 1', '    return n * f(n - 1)', '', 'print(f(3))', 'A. 3', 'B. 6', 'C. 9', 'D. 1', 'Answer: B',
    '4. Which is a valid call?', 'A) a.push(5)', 'B) push a 5', 'C) 5.push', 'D) none', 'Answer: A'].join('\n');
  const r = parseQuestions(paper), q = r.questions;
  assert.strictEqual(q.length, 4);
  assert.strictEqual(q[0].text.split('\n')[0], 'What is the output of the following program?');          // marks tag removed, no trailing space
  assert(q[0].text.includes('```\n#include <stdio.h>\nint main() {\n    int i;\n    for (i = 0; i < 3; i++) {\n        if (i == 1)\n            continue;\n'), 'C indentation kept');
  assert(q[0].text.endsWith('}\n```'));
  assert.deepStrictEqual(q[0].options, ['02', '012', '01', '12']); assert.strictEqual(q[0].answer, 'A'); assert.strictEqual(q[0].marks, 2);
  assert.strictEqual(q[1].text, 'Which keyword exits a loop?'); assert.strictEqual(q[1].options.length, 4);   // plain prose unchanged
  assert(q[2].text.includes('```\ndef f(n):\n    if n == 0:\n        return 1\n    return n * f(n - 1)\n\nprint(f(3))\n```'), 'python indentation + inner blank line kept');
  assert.strictEqual(q[3].options[0], 'a.push(5)', '"a.push(5)" is code, not option A of a new question'); assert.strictEqual(q[3].options.length, 4);
  assert(!r.flatPython);
  // the same paper after a PDF flattened all indentation
  const flat = parseQuestions(paper.split('\n').map((l) => l.trim()).join('\n'));
  assert(flat.questions[0].text.includes('int main() {\n    int i;\n    for (i = 0; i < 3; i++) {'), 'brace code is re-indented from its braces');
  assert(flat.questions[0].text.includes('\n    }\n    return 0;\n}\n```'));
  assert(flat.flatPython, 'flattened Python cannot be rebuilt, so the admin is warned');
  // prose is never mistaken for code
  ['Which of the following is true about arrays?', 'Consider the following statements (a) and (b).', 'Given x = 5 and y = 3, find z.', 'The value of pi is approximately 3.14.'].forEach((t) => assert(!looksCode(t, false), t));
  ['for (i = 0; i < n; i++) {', 'x = x + 1', 'printf("%d", x);', 'return n * f(n - 1)', 'if x == 3:'].forEach((t) => assert(looksCode(t, false), t));
  assert(looksCode('    total', true) && !looksCode('total', true));                      // indented body line continues a code block
  assert.deepStrictEqual(reindentBraces(['if (a) {', 'b();', '}', 'else {', 'c();', '}']), ['if (a) {', '    b();', '}', 'else {', '    c();', '}']);
  assert.strictEqual(fenceBlock(['', '      a', '        b', '']).text, '```\na\n  b\n```');         // common left margin removed, relative indent kept
  const long = capText('x\n```\n' + 'y\n'.repeat(2000) + '```', 100); assert(long.length <= 100 && (long.match(/```/g) || []).length % 2 === 0, 'never cut inside a fence');
  // AI path keeps fenced code, still collapses ordinary text
  assert.strictEqual(rich('What prints?\n```\nfor i in x:\n\tprint(i)\n```', 500), 'What prints?\n```\nfor i in x:\n    print(i)\n```');
  assert.strictEqual(rich('Plain   text\n over lines', 500), 'Plain text over lines');
  assert.strictEqual(validateAiQuestions({ questions: [{ text: 'Out?\n```\nif (x) {\n  y();\n}\n```', options: ['`a[0]`', 'b'], answer: 'A' }] })[0].text.split('\n').length, 6);
  // PDF: indentation comes back from each text item's x-position
  const item = (s, x, y) => ({ str: s, width: s.length * 6, transform: [10, 0, 0, 10, x, y] });
  const txt = linesFromItems([item('def f(n):', 50, 700), item('if n == 0:', 74, 688), item('return 1', 98, 676), item('print(f(1))', 50, 664)]);
  assert.strictEqual(txt, 'def f(n):\n    if n == 0:\n        return 1\nprint(f(1))');
  assert.strictEqual(linesFromItems([item('Hello', 50, 700), item('world', 86, 700)]), 'Hello world');   // same baseline -> one line, gap kept
}

(async () => {
  const good = async () => JSON.stringify({ questions: [{ text: 'Q', options: ['a', 'b'], answer: 'A' }] });
  const res = await extractWithAi('paper', { provider: 'anthropic', model: '' }, 'k', good);
  assert.strictEqual(res.length, 1);
  await assert.rejects(extractWithAi('paper', { provider: 'anthropic' }, 'k', async () => 'garbage'));           // caller falls back to parser
  await assert.rejects(extractWithAi('paper', { provider: 'anthropic' }, 'k', async () => '{"questions":[]}'));

  /* ---- real PDF / DOCX round trip (needs `npm install` for pdf-parse + mammoth; skipped, loudly, if they are missing) ---- */
  const { extractText } = require('./lib/extract');
  for (const [kind, file] of [['pdf', 'paper.pdf'], ['docx', 'paper.docx']]) {
    let text;
    try { text = await extractText(fs.readFileSync(fx(file)), kind); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND') { console.log(`SKIPPED ${kind} round trip: ${e.message.split('\n')[0]}`); continue; } throw e; }
    const q = parseQuestions(text).questions;
    assert.strictEqual(q.length, 4, kind + ' fixture should yield 4 questions');
    assert.strictEqual(q[0].answer, 'B', kind + ' answer key');
  }
  console.log('functions-test: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

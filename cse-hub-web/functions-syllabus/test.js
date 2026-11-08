'use strict';
const assert = require('assert');
const { DEFAULT_XP, cleanXpConfig, computeXp, xpDelta } = require('./xp');
/* xp.js is kept as the documented, historical rule set for the legacy Syllabus Test XP (no longer awarded). */
const r = (percentage, total, unanswered) => ({ percentage, total, unanswered });
assert.strictEqual(computeXp(r(100, 3, 0), DEFAULT_XP), 50);
assert.strictEqual(computeXp(r(33.3, 3, 1), DEFAULT_XP), 10 + Math.round(0.333 * 40));
assert.strictEqual(computeXp(r(0, 3, 3), DEFAULT_XP), 0);
assert.strictEqual(computeXp(r(0, 3, 0), DEFAULT_XP), 10);
assert.deepStrictEqual(cleanXpConfig({ completion: -1, scoreBonusMax: 'x' }), DEFAULT_XP);
assert.deepStrictEqual(cleanXpConfig({ completion: 5, scoreBonusMax: 20 }), { completion: 5, scoreBonusMax: 20 });
assert.strictEqual(xpDelta(50, 30), 20); assert.strictEqual(xpDelta(30, 50), 0); assert.strictEqual(xpDelta(30, undefined), 30);
console.log('functions-syllabus (XP summary) tests: all passed');

'use strict';
/* Pure XP rules for Syllabus Tests (no Firebase) so they can be unit-tested.

   XP for one submitted unit test  =  completion XP  +  score bonus
     completion XP : awarded when at least one question was answered (an empty submission earns nothing)
     score bonus   : round(percentage / 100 * scoreBonusMax)
   Defaults: 10 + up to 40  => 10..50 XP per unit.  Both numbers can be changed by the owner in syllabusConfig/settings.xp
   ({ completion, scoreBonusMax }) without redeploying.

   Anti-farming: a unit pays out at most its best-ever XP. A retake only adds the IMPROVEMENT over the best XP that unit
   has already paid (nothing if the new score is not higher). The same submission can never pay twice (see index.js). */
const DEFAULT_XP = { completion: 10, scoreBonusMax: 40 };

function cleanXpConfig(x) {
  const ok = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 1000 ? v : d);
  x = x && typeof x === 'object' ? x : {};
  return { completion: ok(x.completion, DEFAULT_XP.completion), scoreBonusMax: ok(x.scoreBonusMax, DEFAULT_XP.scoreBonusMax) };
}

/* r = result of scoreAttempt() */
function computeXp(r, cfg) {
  const c = cleanXpConfig(cfg);
  const answered = (r.total || 0) - (r.unanswered || 0);
  if (answered < 1) return 0;
  const pct = Math.max(0, Math.min(100, Number(r.percentage) || 0));
  return c.completion + Math.round((pct / 100) * c.scoreBonusMax);
}

/* How much of `xp` is NEW for a unit that has already paid `alreadyPaid`. */
function xpDelta(xp, alreadyPaid) {
  return Math.max(0, (Number(xp) || 0) - (Number(alreadyPaid) || 0));
}

module.exports = { DEFAULT_XP, cleanXpConfig, computeXp, xpDelta };

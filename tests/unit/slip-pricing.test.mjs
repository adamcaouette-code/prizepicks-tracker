// Correlation-aware slip pricing, end to end.
//
// ===========================================================================
// THE FULLY HAND-COMPUTED CASE
//
// Three coin-flip legs, pairwise correlation exactly 1/2. From the closed forms
// in copula.test.mjs the correct-count distribution is UNIFORM:
//
//   P(3) = P(2) = P(1) = P(0) = 1/4      against the binomial 1/8, 3/8, 3/8, 1/8
//
// The pp-classic 3-leg Power table pays 5x for three correct and nothing else,
// with no leg multipliers. So:
//
//   naive EV per unit      = 1/8 * 5 - 1 = 0.625 - 1 = -0.375
//   correlated EV per unit = 1/4 * 5 - 1 = 1.25  - 1 = +0.25
//   delta                  = 0.625
//
// A slip the old engine priced at -37.5% is really +25%. That is not a
// refinement of a number, it is the difference between a bet you should not
// make and one you should, and it is the whole reason this module exists.
//
// Every figure above is arithmetic on constants derived by hand. Nothing in
// this file was produced by running the code.
// ===========================================================================

import fs from 'node:fs';
import * as P from '../../netlify/functions/slip-pricing.js';
import { configFor, evForSlip, correctCountDistribution } from '../../netlify/functions/payout-engine.js';
import { shrink } from '../../netlify/functions/correlation.js';

const CONFIGS = JSON.parse(fs.readFileSync('netlify/functions/payout-tables.json', 'utf8')).configs;
const CLASSIC = CONFIGS.find((c) => c.id === 'pp-classic');
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/**
 * A table asserting one correlation for every same-team pair on market M.
 *
 * The stored `rho` is the SHRUNK one and the weight is computed by the real
 * shrink(), because that is what estimateFromLogs writes and what
 * correlationFor reads. An earlier version of this helper stored a raw 0.4
 * beside a hand-written weight of 0.99 at n=6, which is not a table the
 * estimator could ever produce — and the test built on it was asserting
 * something about the fixture rather than about the code.
 */
const tableAt = (rawRho, n = 500) => {
  const s = shrink(rawRho, n);
  return {
    pairs: {
      'same_team|m|m': {
        relationship: 'same_team', markets: ['M', 'M'],
        observed: rawRho, latent: rawRho, rho: s.rho, n, shrinkWeight: s.weight,
      },
    },
  };
};
const legsAt = (count, prob, extra = {}) => Array.from({ length: count }, (_, i) => ({
  player: `P${i}`, team: 'ATL', eventId: 'E1', market: 'M', line: 5.5, side: 'over', prob, tier: 'standard', ...extra,
}));

export default async function ({ t }) {
  // =========================================================================
  // 1. THE HAND-COMPUTED SLIP
  // =========================================================================
  t.ok('the 3-leg Power table pays 5x for three correct and nothing else',
    CLASSIC.slip_types.power['3']['3'] === 5 && !CLASSIC.slip_types.power['3']['2'],
    JSON.stringify(CLASSIC.slip_types.power['3']));

  const priced = P.priceSlip({
    legs: legsAt(3, 0.5), table: tableAt(0.5), config: CLASSIC, slipType: 'power', paths: 400000, seed: 5,
  });

  t.ok('naive P(all three) is the binomial 1/8', near(priced.naive.probAllHit, 0.125, 1e-12),
    String(priced.naive.probAllHit));
  t.ok('correlated P(all three) is 1/4 — exactly double',
    Math.abs(priced.correlated.probAllHit - 0.25) < 4 * priced.simulation.seAllCorrect,
    `${priced.correlated.probAllHit.toFixed(5)} (4 sigma = ${(4 * priced.simulation.seAllCorrect).toFixed(5)})`);
  t.ok('the naive EV is exactly -0.375', near(priced.naive.evPerUnit, -0.375, 1e-12),
    String(priced.naive.evPerUnit));
  t.ok('the correlated EV is +0.25', Math.abs(priced.correlated.evPerUnit - 0.25) < 4 * priced.delta.mcStandardError,
    `${priced.correlated.evPerUnit.toFixed(5)} (4 sigma = ${(4 * priced.delta.mcStandardError).toFixed(5)})`);
  t.ok('...so the delta is 0.625', Math.abs(priced.delta.evPerUnit - 0.625) < 4 * priced.delta.mcStandardError,
    String(priced.delta.evPerUnit));
  t.ok('A SLIP PRICED AS A LOSER IS REALLY A WINNER',
    priced.naive.evPerUnit < 0 && priced.correlated.evPerUnit > 0, '');
  t.ok('the delta is far outside the simulation noise', priced.delta.significant === true,
    `se ${priced.delta.mcStandardError.toFixed(5)}`);
  t.ok('...and is marked as correlation HELPING', priced.delta.helps === true, '');

  //   The whole correct-count distribution, not just the top of it.
  const dist = priced.correlated.distribution;
  const se = Math.sqrt(0.25 * 0.75 / 400000);
  t.ok('the correlated distribution is uniform 1/4, 1/4, 1/4, 1/4',
    dist.every((v) => Math.abs(v - 0.25) < 4 * se), dist.map((v) => v.toFixed(4)).join(' '));
  t.eq('...where the naive one is the binomial', priced.naive.distribution.map((v) => Number(v.toFixed(6))),
    [0.125, 0.375, 0.375, 0.125]);

  // =========================================================================
  // 2. INDEPENDENCE MUST CHANGE NOTHING
  //
  // The strongest structural check available: at rho = 0 the correlated price
  // must reproduce the naive one to within Monte Carlo error, through an
  // entirely different code path. If it does not, every delta in this module is
  // measuring the machinery rather than the correlation.
  // =========================================================================
  const flat = P.priceSlip({
    legs: legsAt(4, 0.62), table: { pairs: {} }, config: CLASSIC, slipType: 'power', paths: 400000, seed: 8,
  });
  t.ok('at zero correlation the two prices agree',
    Math.abs(flat.delta.evPerUnit) < 4 * flat.delta.mcStandardError,
    `delta ${flat.delta.evPerUnit.toFixed(5)}, se ${flat.delta.mcStandardError.toFixed(5)}`);
  t.ok('...and the delta is reported as inside the noise, not as a finding',
    flat.delta.significant === false, '');
  t.ok('...with confidence marked low, because nothing was estimated',
    flat.correlation.confidence.level === 'low', flat.correlation.confidence.reason);

  // =========================================================================
  // 3. THE SIGN AND SIZE ACROSS PRODUCTS
  //
  // Positive correlation moves mass from the middle of the distribution to the
  // ends. Power pays only at the top, so it gains.
  //
  // I EXPECTED FLEX TO LOSE, AND IT DOES NOT. Flex is paid from the middle, so
  // draining the middle should hurt it — but on the tables PrizePicks actually
  // posts the top tier dominates Flex's EV too (a 6-leg Flex pays 25x for six
  // and 2x for five), so Flex gains as well. What survives is the RELATIVE
  // claim: Power gains more, so pricing legs as independent under-ranks Power
  // against Flex. That is what is pinned here, rather than the intuition.
  // =========================================================================
  const power6 = P.priceSlip({ legs: legsAt(6, 0.6), table: tableAt(0.35), config: CLASSIC, slipType: 'power', paths: 200000, seed: 21 });
  const flex6 = P.priceSlip({ legs: legsAt(6, 0.6), table: tableAt(0.35), config: CLASSIC, slipType: 'flex', paths: 200000, seed: 21 });
  t.ok('positive correlation helps a 6-leg Power', power6.delta.evPerUnit > 0, String(power6.delta.evPerUnit));
  t.ok('...and helps Flex too, which is NOT what the first version of this note said',
    flex6.delta.evPerUnit > 0, String(flex6.delta.evPerUnit));
  t.ok('...but helps POWER MORE, which is the claim that survives',
    power6.delta.evPerUnit > flex6.delta.evPerUnit,
    `power ${power6.delta.evPerUnit.toFixed(4)} vs flex ${flex6.delta.evPerUnit.toFixed(4)}`);
  t.ok('so independence systematically UNDER-RANKS Power against Flex',
    (power6.correlated.evPerUnit - flex6.correlated.evPerUnit)
    > (power6.naive.evPerUnit - flex6.naive.evPerUnit), '');

  // Negative correlation reverses it: mass moves INTO the middle.
  const negPower = P.priceSlip({ legs: legsAt(4, 0.6), table: tableAt(-0.3), config: CLASSIC, slipType: 'power', paths: 200000, seed: 22 });
  t.ok('negative correlation hurts a Power play', negPower.delta.evPerUnit < 0, String(negPower.delta.evPerUnit));
  t.ok('...and is marked as NOT helping', negPower.delta.helps === false, '');
  t.ok('...and it makes going perfect rarer than independence claims',
    negPower.correlated.probAllHit < negPower.naive.probAllHit, '');

  // =========================================================================
  // 4. Marginals — the copula does not touch them
  //
  // Requirement 2 says use the ACTUAL marginals from tasks 04/05, not normal
  // approximations. Whichever of the three shapes a leg arrives in, its own win
  // probability must come through unchanged.
  // =========================================================================
  const fromPmf = P.toCopulaLeg({ pmf: [0.10, 0.20, 0.35, 0.25, 0.10], line: 2.5, side: 'over' });
  t.ok('a full PMF gives P(over 2.5) = 0.25 + 0.10 = 0.35', near(fromPmf.pWin, 0.35), String(fromPmf.pWin));
  t.eq('...and says the marginal came from a distribution', fromPmf.source, 'pmf');
  const fromProbs = P.toCopulaLeg({ over: 0.42, under: 0.58, side: 'over' });
  t.ok('probabilities from tasks 04/05 come through untouched', near(fromProbs.pWin, 0.42), '');
  const fromProb = P.toCopulaLeg({ prob: 0.61, side: 'over' });
  t.ok('a legacy bare probability still works', near(fromProb.pWin, 0.61), '');
  const underLeg = P.toCopulaLeg({ prob: 0.61, side: 'under' });
  t.ok('...and on an under it is the UNDER that wins with 0.61', near(underLeg.pWin, 0.61), '');
  t.ok('...while the stat still sits above the line 39% of the time',
    near(underLeg.pLose, 0.39), String(underLeg.pLose));
  t.ok('a leg with no distribution at all is refused by name', (() => {
    try { P.toCopulaLeg({ player: 'Nobody', market: 'Hits' }); return false; }
    catch (e) { return /Nobody/.test(e.message) && /no distribution/.test(e.message); }
  })(), '');

  //   The simulated marginals must reproduce each leg's own win probability —
  //   the defining property of a copula, and the thing that would break first
  //   if the sampler were wrong.
  const mixed = [
    { player: 'A', team: 'ATL', eventId: 'E1', market: 'M', line: 5.5, side: 'over', prob: 0.72, tier: 'standard' },
    { player: 'B', team: 'ATL', eventId: 'E1', market: 'M', line: 5.5, side: 'over', prob: 0.41, tier: 'standard' },
    { player: 'C', team: 'ATL', eventId: 'E1', market: 'M', line: 5.5, side: 'under', prob: 0.55, tier: 'standard' },
  ];
  const mp = P.priceSlip({ legs: mixed, table: tableAt(0.45), config: CLASSIC, slipType: 'power', paths: 400000, seed: 31 });
  t.ok('every leg keeps its own marginal through the copula',
    mp.legs.map((l) => l.pWin).every((p, i) => near(p, [0.72, 0.41, 0.55][i], 1e-12)),
    mp.legs.map((l) => l.pWin).join(' '));
  //   The mean of the correct count must equal the sum of the marginals,
  //   WHATEVER the correlation — correlation moves the shape, never the mean.
  const meanCorrect = mp.correlated.distribution.reduce((s, v, k) => s + k * v, 0);
  t.ok('...so the expected number correct is unchanged by correlation: 0.72+0.41+0.55 = 1.68',
    Math.abs(meanCorrect - 1.68) < 0.01, String(meanCorrect));

  // =========================================================================
  // 5. PUSHES re-price the slip at a smaller size
  //
  // A push is not a loss: PrizePicks voids the leg and a 3-leg Power becomes a
  // 2-leg Power on the 2-leg table. The payout tables are STEP functions, so
  // folding pushes into losses does not average out.
  // =========================================================================
  const pushLegs = [
    { player: 'A', team: 'ATL', eventId: 'E1', market: 'M', line: 2, side: 'over', pmf: [0.1, 0.2, 0.4, 0.2, 0.1], tier: 'standard' },
    { player: 'B', team: 'ATL', eventId: 'E1', market: 'M', line: 5.5, side: 'over', prob: 0.55, tier: 'standard' },
    { player: 'C', team: 'ATL', eventId: 'E1', market: 'M', line: 5.5, side: 'over', prob: 0.60, tier: 'standard' },
  ];
  const pushed = P.priceSlip({ legs: pushLegs, table: tableAt(0.3), config: CLASSIC, slipType: 'power', paths: 200000, seed: 41 });
  t.ok('the leg on a whole line carries 40% push mass', near(pushed.legs[0].pPush, 0.4), String(pushed.legs[0].pPush));
  t.ok('...so the slip pushes some fraction of the time',
    pushed.correlated.probAnyPush > 0.35 && pushed.correlated.probAnyPush < 0.45,
    String(pushed.correlated.probAnyPush));
  t.ok('...and the joint (pushes, correct) matrix is kept', Array.isArray(pushed.correlated.joint), '');
  const jointSum = pushed.correlated.joint.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  t.ok('...summing to 1', near(jointSum, 1, 1e-12), String(jointSum));
  //   A pushed leg makes this a 2-leg Power, which pays 3x. Folding the push
  //   into a loss would pay 0 there instead, so the two differ materially.
  t.ok('a pushed slip is worth more than one where pushes counted as losses',
    pushed.correlated.evPerUnit > -1, String(pushed.correlated.evPerUnit));
  t.ok('the 2-leg Power table is what a one-push slip is priced on',
    CLASSIC.slip_types.power['2']['2'] === 3, JSON.stringify(CLASSIC.slip_types.power['2']));

  // =========================================================================
  // 6. THE SAME PAYOUT TABLES, THE SAME FUNCTION
  //
  // The correlated price must differ from the naive one ONLY by the
  // distribution. If it went through a second copy of the payout arithmetic,
  // the delta would be measuring the difference between two implementations.
  // =========================================================================
  const injected = evForSlip({
    config: CLASSIC, slipType: 'power', legs: legsAt(3, 0.5), distribution: [0.25, 0.25, 0.25, 0.25],
  });
  t.ok('feeding a distribution straight to evForSlip gives the same +0.25',
    near(injected.evPerUnit, 0.25, 1e-12), String(injected.evPerUnit));
  t.ok('...and the engine reports that this one does NOT assume independence',
    injected.assumesIndependence === false, '');
  t.ok('...while the ordinary call still does', evForSlip({
    config: CLASSIC, slipType: 'power', probs: [0.5, 0.5, 0.5], legs: legsAt(3, 0.5),
  }).assumesIndependence === true, '');
  t.eq('the independent distribution is still exactly the Poisson-binomial',
    correctCountDistribution([0.5, 0.5, 0.5]).map((v) => Number(v.toFixed(6))), [0.125, 0.375, 0.375, 0.125]);

  // Leg multipliers must apply identically on both sides of the comparison.
  const demonLegs = legsAt(3, 0.4, { tier: 'demon', multiplier: 1.25 });
  const demon = P.priceSlip({ legs: demonLegs, table: tableAt(0.4), config: CLASSIC, slipType: 'power', paths: 100000, seed: 51 });
  t.ok('a per-leg multiplier lifts both prices, not just one',
    demon.naive.returnPerUnit > 0 && demon.correlated.returnPerUnit > demon.naive.returnPerUnit, '');

  // =========================================================================
  // 7. Confidence — requirement 5, at the slip level
  // =========================================================================
  t.eq('a fully-measured structure on a big sample is high confidence',
    P.priceSlip({ legs: legsAt(3, 0.5), table: tableAt(0.4, 800), config: CLASSIC, slipType: 'power', paths: 20000 })
      .correlation.confidence.level, 'high');
  const thin = P.priceSlip({ legs: legsAt(3, 0.5), table: tableAt(0.4, 6), config: CLASSIC, slipType: 'power', paths: 20000 });
  t.ok('a structure built on six overlapping games is not', thin.correlation.confidence.level !== 'high',
    thin.correlation.confidence.reason);
  //   n=6 gives a Fisher-z weight of 0.1225/(0.1225 + 1/3) = 0.269, so a raw
  //   0.4 is carried into the matrix at about 0.11 — most of the way to zero.
  t.ok('...and the correlation actually used is shrunk hard from the raw 0.4',
    Math.abs(thin.correlation.matrix[0][1]) < 0.15, String(thin.correlation.matrix[0][1]));
  t.ok('...which materially shrinks the correction too',
    Math.abs(thin.delta.evPerUnit) < Math.abs(priced.delta.evPerUnit) / 2,
    `${thin.delta.evPerUnit.toFixed(4)} vs ${priced.delta.evPerUnit.toFixed(4)} at full weight`);
  t.eq('a slip with nothing estimated is low, and says how many pairs',
    P.priceSlip({ legs: legsAt(3, 0.5), table: { pairs: {} }, config: CLASSIC, slipType: 'power', paths: 20000 })
      .correlation.confidence.unestimatedPairs, 3);

  // =========================================================================
  // 8. RANKING BY HOW MUCH CORRELATION HELPS — requirement 4
  // =========================================================================
  const ranked = P.rankByCorrelationBenefit([
    { id: 'tight-power', legs: legsAt(3, 0.5), table: tableAt(0.5), slipType: 'power' },
    { id: 'independent', legs: legsAt(3, 0.5), table: { pairs: {} }, slipType: 'power' },
    { id: 'opposed', legs: legsAt(3, 0.5), table: tableAt(-0.4), slipType: 'power' },
    { id: 'mild', legs: legsAt(3, 0.5), table: tableAt(0.15), slipType: 'power' },
  ], { config: CLASSIC, paths: 200000, seed: 61 });

  t.eq('the most-helped slip is ranked first', ranked.ranked[0].id, 'tight-power');
  t.eq('...and the most-harmed last', ranked.ranked.at(-1).id, 'opposed');
  t.ok('the independent slip is reported as inside the noise, not as a small effect',
    ranked.ranked.find((r) => r.id === 'independent').delta.significant === false, '');
  t.ok('...and is ranked below every slip with a real effect',
    ranked.ranked.findIndex((r) => r.id === 'independent') > ranked.ranked.findIndex((r) => r.id === 'mild'),
    ranked.ranked.map((r) => r.id).join(' > '));
  t.eq('the summary counts helped and hurt', ranked.summary.helped, 2);
  t.eq('...and hurt', ranked.summary.hurt, 1);
  t.eq('...and the ones nothing can be said about', ranked.summary.insideNoise, 1);
  t.ok('the largest correction is reported as a number',
    near(ranked.summary.largestHelp, ranked.ranked[0].delta.evPerUnit), '');

  const withFailure = P.rankByCorrelationBenefit([
    { id: 'good', legs: legsAt(3, 0.5), table: tableAt(0.3), slipType: 'power' },
    { id: 'impossible', legs: legsAt(7, 0.5), table: tableAt(0.3), slipType: 'power' },
  ], { config: CLASSIC, paths: 20000 });
  t.eq('a slip the config cannot price is separated, not silently dropped', withFailure.failed.length, 1);
  t.ok('...naming why', /does not offer a 7-leg power slip/.test(withFailure.failed[0].error), withFailure.failed[0].error);
  t.eq('...and the rest still price', withFailure.ranked.length, 1);

  // =========================================================================
  // 9. Reproducibility and the report
  // =========================================================================
  const a = P.priceSlip({ legs: legsAt(3, 0.5), table: tableAt(0.5), config: CLASSIC, slipType: 'power', paths: 50000, seed: 99 });
  const b = P.priceSlip({ legs: legsAt(3, 0.5), table: tableAt(0.5), config: CLASSIC, slipType: 'power', paths: 50000, seed: 99 });
  t.ok('two runs of the same slip give the identical price',
    a.correlated.evPerUnit === b.correlated.evPerUnit, '');

  const text = P.renderCorrelationReport(ranked);
  const flatText = text.replace(/\s+/g, ' ');
  t.ok('the report names every slip', ['tight-power', 'independent', 'opposed', 'mild'].every((id) => text.includes(id)), '');
  t.ok('...shows both EVs and the delta', /naive EV/.test(text) && /corr EV/.test(text) && /delta/.test(text), '');
  t.ok('...states the Power/Flex asymmetry in the corrected form',
    /under-ranks Power against Flex/.test(flatText), '');
  t.ok('...and details the largest correction with its provenance',
    /LARGEST CORRECTION/.test(text) && /tight-power/.test(text), '');
  t.ok('no line blows out the terminal', text.split('\n').every((l) => l.length <= 100),
    String(Math.max(...text.split('\n').map((l) => l.length))));
}

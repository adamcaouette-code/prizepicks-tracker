// Bankroll management.
//
// ===========================================================================
// THE TWO-OUTCOME KELLY FORMULA IS WRONG FOR A FLEX SLIP
//
// f* = (bp - q)/b assumes one way to win and one way to lose. A 3-leg Flex has
// THREE paying outcomes. Applying the two-outcome formula means picking one and
// discarding the rest, and the tests below show the gap it produces.
//
// The correct object is expected log growth over every tier, maximised
// numerically. Where a slip really does have two outcomes, the numeric answer
// must reproduce the closed form exactly — that is the check that the numerics
// are right rather than merely plausible.
// ===========================================================================

import * as B from '../../netlify/functions/bankroll.js';
import { kellyFraction } from '../../netlify/functions/payout-engine.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const CONFIG = { kelly_multiplier: 0.25, min_stake: 5, max_pct_of_bankroll: 0.05, max_slate_stake: 100 };

/** A two-outcome bet: multiplier m on a win, nothing on a loss. */
const twoWay = (p, m) => [{ probability: p, multiplier: m }, { probability: 1 - p, multiplier: 0 }];

export default async function ({ t }) {
  // =========================================================================
  // 1. THE NUMERIC SOLVER REPRODUCES THE CLOSED FORM
  //
  //   For a two-outcome bet returning m per unit staked, f* = (p*m - 1)/(m - 1).
  //     p=0.6, m=2:   (1.2-1)/1   = 0.2      (the classic 2p-1)
  //     p=0.5, m=3:   (1.5-1)/2   = 0.25
  //     p=0.25, m=5:  (1.25-1)/4  = 0.0625
  // =========================================================================
  for (const [p, m, want] of [[0.6, 2, 0.2], [0.5, 3, 0.25], [0.25, 5, 0.0625]]) {
    t.ok(`two-outcome Kelly at p=${p}, ${m}x is exactly ${want}`,
      near(kellyFraction(twoWay(p, m), { multiplier: 1 }).full, want, 1e-10),
      kellyFraction(twoWay(p, m), { multiplier: 1 }).full.toFixed(12));
  }

  // =========================================================================
  // 2. AND IT DIFFERS FROM THE TWO-OUTCOME FORMULA ON A REAL FLEX SLIP
  //
  // A 3-leg Flex at 60% a leg, paying 2.25x for three and 1.25x for two:
  //   P(3) = 0.216, P(2) = 3 * 0.6^2 * 0.4 = 0.432, P(<=1) = 0.352
  //   EV = 0.216*2.25 + 0.432*1.25 = 0.486 + 0.54 = 1.026  -> +2.6%
  //
  // Treating it as two outcomes by calling "three correct" the win and
  // everything else a loss gives f = (0.216*2.25 - 1)/1.25 = -0.4112 — a
  // NEGATIVE fraction, i.e. "do not bet", on a slip that is positive-EV. The
  // 1.25x consolation tier is the entire edge, and the simple formula throws
  // it away.
  // =========================================================================
  const flex3 = [
    { probability: 0.216, multiplier: 2.25 },
    { probability: 0.432, multiplier: 1.25 },
    { probability: 0.352, multiplier: 0 },
  ];
  const full = kellyFraction(flex3, { multiplier: 1 });
  t.ok('the multi-tier solver finds a positive stake on a +2.6% Flex slip',
    full.full > 0, String(full.full));
  t.ok('...and its edge is the true 2.6%', near(full.edge, 0.026, 1e-12), String(full.edge));

  const naiveTwoOutcome = (0.216 * 2.25 - 1) / 1.25;
  t.ok('THE TWO-OUTCOME FORMULA SAYS DO NOT BET THE SAME SLIP',
    naiveTwoOutcome < 0, naiveTwoOutcome.toFixed(4));
  t.ok('...because it discards the 1.25x consolation tier, which IS the edge',
    near(0.216 * 2.25 + 0.432 * 1.25, 1.026, 1e-12), '');

  // Every paying tier moves the answer — the defining property of the solver.
  const noConsolation = kellyFraction([
    { probability: 0.216, multiplier: 2.25 }, { probability: 0.784, multiplier: 0 },
  ], { multiplier: 1 });
  t.ok('removing the middle tier removes the bet entirely', noConsolation.fraction === 0, '');

  // =========================================================================
  // 3. THE CALIBRATION HAIRCUT — requirement 2
  // =========================================================================
  t.ok('a slope of 1 leaves Kelly alone', B.calibrationHaircut(1).factor === 1, '');
  t.ok('a slope of 0.6 cuts Kelly to 60%', near(B.calibrationHaircut(0.6).factor, 0.6), '');
  t.ok('...explaining that the probabilities are too spread out',
    /spread further from 50% than outcomes justify/.test(B.calibrationHaircut(0.6).reason),
    B.calibrationHaircut(0.6).reason);
  t.ok('...and softening the wording when 1.0 is still inside the interval',
    /precaution rather than a measurement/.test(B.calibrationHaircut(0.6, { oneInsideCI: true }).reason), '');
  t.ok('a very low slope is floored rather than taken to zero',
    B.calibrationHaircut(0.05).factor === 0.25, String(B.calibrationHaircut(0.05).factor));

  //   THE HAIRCUT ONLY EVER REDUCES. A slope above 1 says the model is
  //   underconfident; betting MORE on that basis risks ruin rather than growth.
  t.ok('A SLOPE ABOVE 1 DOES NOT INCREASE THE STAKE', B.calibrationHaircut(1.4).factor === 1, '');
  t.ok('...and says why not', /costs ruin rather than growth/.test(B.calibrationHaircut(1.4).reason), '');

  t.ok('no calibration at all applies no haircut', B.calibrationHaircut(null).factor === 1, '');
  t.ok('...and flags that this is the OPTIMISTIC choice, which it is',
    /OPTIMISTIC choice/.test(B.calibrationHaircut(null).reason), B.calibrationHaircut(null).reason);

  //   End to end: the same slip, sized with and without a calibration finding.
  const good = twoWay(0.65, 2);
  //   The slate cap is lifted here so the haircut, not the cap, is what moves
  //   the number — an earlier version of this fixture had both stakes pinned at
  //   the $100 cap and was asserting nothing.
  const uncapped = { ...CONFIG, max_slate_stake: Infinity };
  const plain = B.recommendStake({ outcomes: good, bankroll: 10000, config: uncapped });
  const cut = B.recommendStake({ outcomes: good, bankroll: 10000, config: uncapped, calibration: { slope: 0.6 } });
  t.ok('a miscalibrated model stakes less on the identical slip',
    cut.stake < plain.stake, `${plain.stake} -> ${cut.stake}`);
  t.ok('...and the output explains that full Kelly assumes the probabilities are right',
    plain.notes.some((n) => /assumes these probabilities are exactly right/.test(n)), '');

  // =========================================================================
  // 4. FLOORS AND CEILINGS — requirement 3
  // =========================================================================
  const capped = B.recommendStake({ outcomes: twoWay(0.9, 2), bankroll: 1000, config: CONFIG });
  t.ok('the stake is capped at 5% of bankroll', capped.stake <= 50, String(capped.stake));
  t.ok('...and says which cap bound it', /% of bankroll/.test(capped.reason), capped.reason);

  const slateFull = B.recommendStake({
    outcomes: twoWay(0.9, 2), bankroll: 10000, config: CONFIG, slateStakedSoFar: 100,
  });
  t.eq('with the slate cap already spent, the answer is no bet', slateFull.stake, 0);

  const tiny = B.recommendStake({ outcomes: twoWay(0.51, 2), bankroll: 200, config: CONFIG });
  t.eq('a Kelly stake under the $5 minimum is NOT rounded up to $5', tiny.stake, 0);
  t.ok('...and the reason says why that would be wrong',
    /staking above Kelly on an edge too small to justify it/.test(tiny.reason), tiny.reason);

  //   BLUNT ON A LOSING BET — the brief's explicit ask.
  const losing = B.recommendStake({ outcomes: twoWay(0.4, 2), bankroll: 10000, config: CONFIG });
  t.eq('a negative-edge slip is staked at exactly zero', losing.stake, 0);
  t.eq('...with a verdict, not a small number', losing.verdict, 'NO BET');
  t.ok('...saying the edge does not support it',
    /non-positive edge/.test(losing.reason), losing.reason);

  // =========================================================================
  // 5. RISK OF RUIN — requirement 4
  // =========================================================================
  const ruin = B.riskOfRuin({
    outcomes: twoWay(0.60, 2), bankroll: 1000, config: CONFIG, slips: 200, paths: 2000,
  });
  t.ok('a healthy edge at quarter Kelly rarely ruins', ruin.probabilityOfRuin < 0.02,
    `${(ruin.probabilityOfRuin * 100).toFixed(2)}%`);
  t.ok('...and grows the median bankroll', ruin.median > 1000, `$${ruin.median.toFixed(0)}`);
  //   THE 5TH PERCENTILE IS THE POINT. Even a good edge has a bad tail.
  t.ok('the 5th percentile is far below the median', ruin.p05 < ruin.median,
    `p05 $${ruin.p05.toFixed(0)} vs median $${ruin.median.toFixed(0)}`);
  t.ok('...and is reported alongside it, not buried', ruin.p05 != null && ruin.median != null, '');
  t.ok('ruin is defined as being unable to place the minimum, not as reaching zero',
    /minimum stake/.test(ruin.ruinDefinition), ruin.ruinDefinition);

  //   OVERBETTING THE SAME EDGE — the whole case for fractional Kelly, in one
  //   table. The edge is IDENTICAL in every row: a 60/40 coin at even money,
  //   $200 bankroll, 300 slips. Only the Kelly multiple changes.
  //
  //     0.25x   median $2,766   p05 $681   halves  0.7%   ruin  0.0%
  //     1.00x   median $84,021  p05  $23   halves 44.4%   ruin  0.0%
  //     2.00x   median     $11  p05   $8   halves 91.7%   ruin  0.0%
  //     3.00x   median      $6  p05   $3   halves  100%   ruin 31.5%
  //
  //   Full Kelly has the best median by a mile AND a 44% chance of halving the
  //   bankroll at some point along the way. Double it and the median falls from
  //   $84,021 to $11 — on the same edge, correctly estimated. Kelly is not a
  //   safety margin you can spend; past the optimum the growth rate goes
  //   negative and no amount of edge saves it.
  const loose = { min_stake: 5, max_pct_of_bankroll: 1, max_slate_stake: Infinity };
  const atMultiple = (km) => B.riskOfRuin({
    outcomes: twoWay(0.60, 2), bankroll: 200, config: { ...loose, kelly_multiplier: km },
    slips: 300, paths: 1500, seed: 3,
  });
  const quarter = atMultiple(0.25);
  const fullK = atMultiple(1);
  const twiceK = atMultiple(2);
  const thriceK = atMultiple(3);

  t.ok('full Kelly has the best median of the four', fullK.median > quarter.median && fullK.median > twiceK.median,
    `$${quarter.median.toFixed(0)} / $${fullK.median.toFixed(0)} / $${twiceK.median.toFixed(0)}`);
  t.ok('...and a 5th percentile far below quarter Kelly, on the same edge',
    fullK.p05 < quarter.p05 / 10, `$${fullK.p05.toFixed(0)} vs $${quarter.p05.toFixed(0)}`);
  t.ok('...with a large chance of halving on the way', fullK.probabilityOfHalving > 0.3,
    `${(fullK.probabilityOfHalving * 100).toFixed(1)}%`);
  t.ok('QUARTER KELLY BARELY EVER HALVES', quarter.probabilityOfHalving < 0.05,
    `${(quarter.probabilityOfHalving * 100).toFixed(1)}%`);

  t.ok('DOUBLING KELLY ON THE SAME EDGE DESTROYS THE MEDIAN',
    twiceK.median < fullK.median / 100, `$${fullK.median.toFixed(0)} -> $${twiceK.median.toFixed(0)}`);
  t.ok('...because past the optimum the growth rate turns negative',
    twiceK.median < 200, `$${twiceK.median.toFixed(0)} from a $200 start`);
  t.ok('TRIPLE KELLY RUINS OUTRIGHT, on an edge that is real and correctly estimated',
    thriceK.probabilityOfRuin > 0.2, `${(thriceK.probabilityOfRuin * 100).toFixed(1)}%`);
  t.ok('...while quarter Kelly on the identical edge never does',
    quarter.probabilityOfRuin === 0, `${(quarter.probabilityOfRuin * 100).toFixed(1)}%`);
  t.ok('the probability of merely HALVING is reported too — the level people quit at',
    twiceK.probabilityOfHalving >= twiceK.probabilityOfRuin,
    String(twiceK.probabilityOfHalving));

  //   Seeded, so a risk figure does not wander between runs.
  const a = B.riskOfRuin({ outcomes: twoWay(0.6, 2), bankroll: 1000, config: CONFIG, slips: 50, paths: 200, seed: 7 });
  const b = B.riskOfRuin({ outcomes: twoWay(0.6, 2), bankroll: 1000, config: CONFIG, slips: 50, paths: 200, seed: 7 });
  t.eq('the same seed gives the same risk of ruin', a.probabilityOfRuin, b.probabilityOfRuin);

  // =========================================================================
  // 6. ACTUAL VS RECOMMENDED — requirement 5
  // =========================================================================
  const over = B.stakeDiscipline([
    { stake: 20, recommended_stake: 10 }, { stake: 30, recommended_stake: 15 },
    { stake: 25, recommended_stake: 12 }, { stake: 18, recommended_stake: 10 },
  ]);
  t.ok('consistent overbetting is detected', over.meanRatio > 1.5, over.meanRatio.toFixed(2));
  t.eq('...counted', over.overbet, 4);
  t.ok('...and named bluntly, because it is the finding that costs most',
    /Overbetting a real edge is how a winning system goes broke/.test(over.verdict), over.verdict);

  const disciplined = B.stakeDiscipline([
    { stake: 10, recommended_stake: 10 }, { stake: 11, recommended_stake: 10 }, { stake: 9.5, recommended_stake: 10 },
  ]);
  t.eq('staking on plan is reported as such', disciplined.onPlan, 3);
  t.ok('...without a warning', /close to the recommendation/.test(disciplined.verdict), '');

  const under = B.stakeDiscipline([{ stake: 5, recommended_stake: 20 }, { stake: 4, recommended_stake: 15 }]);
  t.ok('underbetting is flagged as a growth cost, not a solvency one',
    /costs growth but not solvency/.test(under.verdict), under.verdict);

  t.eq('a log with no recommendations says so rather than reporting 1.0',
    B.stakeDiscipline([{ stake: 10 }]).n, 0);

  //   The bankroll path over the log.
  const path = B.bankrollPath(
    [{ slip_id: 'S1', placed_at: '2026-09-01T12:00:00Z', stake: 100, payout_multiplier: 3, legs: [{ leg_id: 'S1#L0' }, { leg_id: 'S1#L1' }] },
      { slip_id: 'S2', placed_at: '2026-09-02T12:00:00Z', stake: 100, payout_multiplier: 3, legs: [{ leg_id: 'S2#L0' }] }],
    [{ leg_id: 'S1#L0', outcome: 'won' }, { leg_id: 'S1#L1', outcome: 'won' }, { leg_id: 'S2#L0', outcome: 'lost' }],
    { starting: 1000 },
  );
  t.eq('a winning slip pays the multiplier', path.path[1].bankroll, 1200);
  t.eq('...and a losing one costs the stake', path.ending, 1100);
  t.eq('an unsettled slip does not move the bankroll',
    B.bankrollPath([{ slip_id: 'S1', placed_at: 'x', stake: 100, legs: [{ leg_id: 'S1#L0' }] }], [], { starting: 500 }).ending, 500);

  // =========================================================================
  // 7. The report
  // =========================================================================
  const text = B.renderBankroll({ recommendation: plain, ruin, discipline: over });
  t.ok('the 5th percentile is printed ABOVE the median',
    text.indexOf('5th percentile') < text.indexOf('median'), '');
  t.ok('...and marked as the number to plan around', /← the number to plan around/.test(text), '');
  t.ok('the calibration caveat is in the output, not just the code',
    /assumes these probabilities are exactly right/.test(text), '');
  const noBetText = B.renderBankroll({ recommendation: losing });
  t.ok('a no-bet renders as $0.00 in a box, not as a small stake',
    /RECOMMENDED STAKE: \$0\.00/.test(noBetText), '');
  t.ok('no line blows out the terminal', text.split('\n').every((l) => l.length <= 100),
    String(Math.max(...text.split('\n').map((l) => l.length))));
}

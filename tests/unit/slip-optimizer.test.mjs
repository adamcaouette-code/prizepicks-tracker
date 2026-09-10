// The slip optimizer — search, constraints, staking, and the refusal.
//
// ===========================================================================
// THE MOST IMPORTANT TEST IN THIS FILE IS "NO BET TODAY"
//
// Every other assertion here is about finding a good slip. That one is about
// NOT finding one, and it is the assertion a tool like this fails in the way
// that costs money. A board with nothing on it must produce a refusal — not an
// empty list that reads as an error, not the least-bad losing slip dressed up
// as a recommendation, and above all not a positive-looking number arrived at
// by relaxing a floor until something cleared it.
//
// The optimum is also checked against BRUTE FORCE on boards small enough to
// enumerate. A beam search that quietly returns the second-best slip is the
// failure this module is most exposed to, and comparing it against a heuristic
// would prove nothing.
// ===========================================================================

import fs from 'node:fs';
import * as O from '../../netlify/functions/slip-optimizer.js';
import { configFor, evForSlip, kellyFraction } from '../../netlify/functions/payout-engine.js';

const CONFIGS = JSON.parse(fs.readFileSync('netlify/functions/payout-tables.json', 'utf8')).configs;
const CLASSIC = CONFIGS.find((c) => c.id === 'pp-classic');
const OPT = JSON.parse(fs.readFileSync('netlify/functions/optimizer-config.json', 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** A board of independent props, one per player, per team, per game. */
const board = (probs, extra = {}) => probs.map((prob, i) => ({
  player: `P${i}`, market: 'Strikeouts', line: 5.5, side: 'over', tier: 'standard',
  league: 'mlb', team: `T${i}`, eventId: `E${i}`, prob, ...extra,
}));

/** Exhaustive best slip, for the boards small enough to enumerate. */
function bruteForce(props, config, { maxLegs = 6, minLegs = 2 } = {}) {
  let best = null;
  const n = props.length;
  const walk = (start, set) => {
    if (set.length >= minLegs) {
      for (const type of ['power', 'flex']) {
        if (!config.slip_types?.[type]?.[String(set.length)]) continue;
        const ev = evForSlip({ config, slipType: type, probs: set.map((l) => l.prob), legs: set }).evPerUnit;
        if (!best || ev > best.ev) best = { ev, slipType: type, legs: [...set] };
      }
    }
    if (set.length === maxLegs) return;
    for (let i = start; i < n; i++) { set.push(props[i]); walk(i + 1, set); set.pop(); }
  };
  walk(0, []);
  return best;
}

const optimizerConfig = (over = {}) => ({
  ...OPT,
  constraints: { ...OPT.constraints, ...(over.constraints || {}) },
  staking: { ...OPT.staking, ...(over.staking || {}) },
  search: { ...OPT.search, screen_paths: 3000, final_paths: 20000, ...(over.search || {}) },
  reporting: { ...OPT.reporting, ...(over.reporting || {}) },
});

export default async function ({ t }) {
  // =========================================================================
  // 1. "NO BET TODAY" — requirement 6
  //
  // A board of coin flips. The 3-leg Power break-even is 4.75^(-1/3) = 59.49%
  // per leg, the 2-leg is 3^(-1/2) = 57.74%, and nothing at 0.50 clears any
  // shape. There is no bet here and the only correct output says so.
  // =========================================================================
  const hopeless = O.optimize({
    props: board([0.50, 0.48, 0.52, 0.49, 0.51, 0.47, 0.50, 0.53]),
    config: CLASSIC,
    optimizerConfig: optimizerConfig(),
  });
  t.ok('a board with no edge produces NO BET', hopeless.noBet === true, '');
  t.eq('...as a verdict, not an empty list', hopeless.verdict, 'NO BET TODAY');
  t.ok('...and no slips at all', hopeless.slips.length === 0, '');
  //   Either refusal is correct and both are honest: the prefilter can rule out
  //   every leg before a slip is ever priced, or a slip gets priced and fails
  //   the floor. What must never happen is a refusal without a stated cause.
  t.ok('...saying why, in words that name the cause',
    /is not positive|unable to appear in any winning slip|smallest legal slip/.test(hopeless.reason),
    hopeless.reason);
  t.ok('...and showing the best thing it REJECTED, so the refusal can be checked',
    hopeless.bestRejected === null || hopeless.bestRejected.ev.perUnit <= 0,
    hopeless.bestRejected ? `${(hopeless.bestRejected.ev.perUnit * 100).toFixed(1)}%` : 'nothing survived the prefilter');

  // The floor is not a tie-breaker. A board that is close but still negative
  // must refuse just as firmly as one that is hopeless.
  //
  //   Under pp-classic the LOOSEST bar on the whole board is the 5-leg Flex,
  //   which turns positive at about 54.3% a leg. A flat board at 54.0% is
  //   -1.6% on its best shape — genuinely close, and still not a bet.
  const nearMiss = O.optimize({
    props: board([0.540, 0.542, 0.538, 0.541, 0.539, 0.540]),
    config: CLASSIC,
    optimizerConfig: optimizerConfig(),
  });
  t.ok('a board that ALMOST clears the bar still refuses', nearMiss.noBet === true,
    nearMiss.noBet ? '' : `proposed ${(nearMiss.slips[0]?.ev.perUnit * 100).toFixed(2)}%`);
  t.ok('...and names how close it came',
    /prices at -?\d/.test(nearMiss.reason || ''), nearMiss.reason);

  // NOTHING NEGATIVE EVER APPEARS, on any board.
  const mixed = O.optimize({
    props: board([0.80, 0.78, 0.76, 0.50, 0.45, 0.40, 0.72]),
    config: CLASSIC,
    optimizerConfig: optimizerConfig(),
  });
  t.ok('on a board that DOES have a bet, every proposed slip is positive',
    mixed.noBet === false && mixed.slips.every((s) => s.ev.perUnit > 0),
    mixed.slips.map((s) => (s.ev.perUnit * 100).toFixed(1)).join(' '));

  // =========================================================================
  // 2. THE SEARCH FINDS THE OPTIMUM — checked against brute force
  // =========================================================================
  const small = board([0.82, 0.80, 0.78, 0.76, 0.74, 0.72, 0.55, 0.52]);
  const exact = bruteForce(small, CLASSIC);
  const found = O.optimize({
    props: small, config: CLASSIC,
    optimizerConfig: optimizerConfig({ search: { beam_width: 40 } }),
  });
  t.ok('the beam finds a slip', found.noBet === false, found.reason || '');
  //   Compared on the INDEPENDENT EV, because that is what brute force computed
  //   — the correlated price is a different (and here, uninformative) number.
  const foundIndependent = evForSlip({
    config: CLASSIC, slipType: found.slips[0].slipType,
    probs: found.slips[0]._legs.map((l) => l.prob), legs: found.slips[0]._legs,
  }).evPerUnit;
  t.ok('...and it is the one exhaustive search finds',
    near(foundIndependent, exact.ev, 1e-9),
    `beam ${(foundIndependent * 100).toFixed(3)}% vs brute force ${(exact.ev * 100).toFixed(3)}%`);
  t.eq('...at the same shape', found.slips[0].slipType, exact.slipType);

  //   A wider board, still enumerable, where the best slip is NOT simply the
  //   top legs by probability — the payout curve decides the size.
  const shaped = board([0.95, 0.94, 0.60, 0.59, 0.585, 0.58, 0.575, 0.57, 0.56]);
  const shapedExact = bruteForce(shaped, CLASSIC);
  const shapedFound = O.optimize({
    props: shaped, config: CLASSIC, optimizerConfig: optimizerConfig({ search: { beam_width: 60 } }),
  });
  const shapedIndep = evForSlip({
    config: CLASSIC, slipType: shapedFound.slips[0].slipType,
    probs: shapedFound.slips[0]._legs.map((l) => l.prob), legs: shapedFound.slips[0]._legs,
  }).evPerUnit;
  t.ok('on a board where the payout curve picks the size, the beam still matches brute force',
    near(shapedIndep, shapedExact.ev, 1e-9),
    `beam ${(shapedIndep * 100).toFixed(3)}% (${shapedFound.slips[0].legCount}-${shapedFound.slips[0].slipType}) `
    + `vs ${(shapedExact.ev * 100).toFixed(3)}% (${shapedExact.legs.length}-${shapedExact.slipType})`);

  // IT IS NEVER PRESENTED AS OPTIMAL, because it is a beam.
  t.ok('the result labels itself a heuristic', /heuristic/.test(found.search.optimality), found.search.optimality);
  t.ok('...and reports how much of the space it touched', found.search.expansions > 0, String(found.search.expansions));

  // =========================================================================
  // 3. THE PREFILTER MUST NOT DISCARD WINNERS
  //
  // Legs at 0.90, 0.90 and 0.40 have a product of 0.324 against a 3-leg Power
  // break-even of 1/4.75 = 0.2105. The 40% leg belongs in a comfortably
  // positive slip, and any per-leg threshold at the break-even would drop it.
  // =========================================================================
  const carried = board([0.90, 0.90, 0.40]);
  const pf = O.prefilter(carried, { config: CLASSIC, constraints: { min_legs: 2, max_legs: 6 }, slack: 0.05 });
  t.eq('a 40% leg beside two 90% legs is KEPT', pf.kept.length, 3);
  t.ok('...and the slip built from it is positive',
    evForSlip({ config: CLASSIC, slipType: 'power', probs: [0.9, 0.9, 0.4], legs: carried }).evPerUnit > 0.5,
    String(evForSlip({ config: CLASSIC, slipType: 'power', probs: [0.9, 0.9, 0.4], legs: carried }).evPerUnit));

  //   THE FREE RIDER, and it is why the prefilter has to look at every shape.
  //
  //   A 5% leg beside three 90% legs is worthless on a 4-Power (-63.6%) and
  //   worth having on a 4-FLEX (+23.9%), because Flex pays 1.5x for three of
  //   four and three 90% legs deliver that almost every time. The bad leg is
  //   carried for free. A prefilter that checked only the Power shapes — or
  //   only the shape at the leg's own size — would throw it away.
  const freeRider = O.prefilter(board([0.90, 0.90, 0.90, 0.05]), {
    config: CLASSIC, constraints: { min_legs: 2, max_legs: 6 }, slack: 0.05,
  });
  t.eq('a 5% leg that rides free on a Flex slip is KEPT', freeRider.kept.length, 4);
  t.ok('...because 4-flex on 0.9/0.9/0.9/0.05 really is positive',
    evForSlip({ config: CLASSIC, slipType: 'flex', probs: [0.9, 0.9, 0.9, 0.05], legs: board([0.9, 0.9, 0.9, 0.05]) }).evPerUnit > 0.2,
    String(evForSlip({ config: CLASSIC, slipType: 'flex', probs: [0.9, 0.9, 0.9, 0.05], legs: board([0.9, 0.9, 0.9, 0.05]) }).evPerUnit));
  t.ok('...while the same four legs as a POWER slip are a disaster',
    evForSlip({ config: CLASSIC, slipType: 'power', probs: [0.9, 0.9, 0.9, 0.05], legs: board([0.9, 0.9, 0.9, 0.05]) }).evPerUnit < -0.6, '');

  //   A leg that cannot help ANY slip IS dropped — and it takes weak partners
  //   to make one, which is itself the finding: on a strong board almost
  //   nothing is hopeless, so the prefilter earns its keep on poor slates.
  const hopelessLeg = O.prefilter(board([0.60, 0.60, 0.60, 0.05]), {
    config: CLASSIC, constraints: { min_legs: 2, max_legs: 6 }, slack: 0.05,
  });
  t.eq('beside weak partners the same 5% leg is dropped', hopelessLeg.kept.length, 3);
  const drop = hopelessLeg.dropped.find((d) => d.stage === 'hopeless');
  t.ok('...naming the best shape it was tried in and what that priced at',
    /best shape \(\d-\w+\) prices at/.test(drop.reason), drop.reason);

  // =========================================================================
  // 4. HARD CONSTRAINTS — requirement 3
  // =========================================================================
  const sameGame = [
    { player: 'A', market: 'K', line: 5.5, side: 'over', tier: 'standard', league: 'mlb', team: 'ATL', eventId: 'E1', prob: 0.9 },
    { player: 'B', market: 'K', line: 5.5, side: 'over', tier: 'standard', league: 'mlb', team: 'ATL', eventId: 'E1', prob: 0.9 },
    { player: 'C', market: 'K', line: 5.5, side: 'over', tier: 'standard', league: 'mlb', team: 'ATL', eventId: 'E1', prob: 0.9 },
  ];
  t.ok('three legs from one game violates a max of 2',
    /more than 2 legs from one game/.test(O.violatesConstraints(sameGame, { max_legs_per_game: 2 })), '');
  t.ok('...two do not', O.violatesConstraints(sameGame.slice(0, 2), { max_legs_per_game: 2 }) === null, '');
  t.ok('three legs from one team violates a max of 2',
    /one team/.test(O.violatesConstraints(sameGame, { max_legs_per_game: 9, max_legs_per_team: 2 })), '');
  t.ok('two markets on the same player violates a max of 1',
    /one player/.test(O.violatesConstraints(
      [sameGame[0], { ...sameGame[0], market: 'Outs' }], { max_legs_per_player: 1 },
    )), '');

  //   THE CONSTRAINTS ARE PREFIX-CLOSED, which is what lets the beam prune.
  //   Adding a leg can move a set from legal to illegal, never back.
  t.ok('a set that violates cannot be repaired by adding legs',
    O.violatesConstraints([...sameGame, { ...sameGame[0], player: 'D', eventId: 'E2', team: 'PHI' }],
      { max_legs_per_game: 2 }) !== null, '');

  //   End to end: a board where the only high-probability legs are in one game.
  const oneGame = O.optimize({
    props: [0.95, 0.94, 0.93, 0.92].map((prob, i) => ({
      player: `P${i}`, market: 'K', line: 5.5, side: 'over', tier: 'standard',
      league: 'mlb', team: 'ATL', eventId: 'E1', prob,
    })),
    config: CLASSIC,
    optimizerConfig: optimizerConfig({ constraints: { max_legs_per_game: 2, max_legs_per_team: 2 } }),
  });
  t.ok('with a 2-per-game cap, a four-leg one-game board can only make a 2-leg slip',
    oneGame.noBet === false && oneGame.slips.every((s) => s.legCount === 2),
    oneGame.noBet ? oneGame.reason : oneGame.slips.map((s) => s.legCount).join(','));

  //   Per-leg constraints.
  t.ok('a low-confidence leg is refused when the config says so',
    /low confidence/.test(O.legAdmissible({ prob: 0.9, lowConfidence: true }, { allow_low_confidence_legs: false })), '');
  t.ok('...and allowed when it does not',
    O.legAdmissible({ prob: 0.9, lowConfidence: true }, { allow_low_confidence_legs: true }) === null, '');
  t.ok('a leg under the probability floor is refused, with the number',
    /30\.0% is under the 35% floor/.test(O.legAdmissible({ prob: 0.30 }, { min_leg_probability: 0.35 })), '');
  t.ok('a sport outside the allowed list is refused by name',
    /sport "nba" is not in the allowed list/.test(
      O.legAdmissible({ prob: 0.9, league: 'nba' }, { allowed_sports: ['mlb', 'soccer'] })), '');
  t.ok('...and null means every sport',
    O.legAdmissible({ prob: 0.9, league: 'nba' }, { allowed_sports: null }) === null, '');

  const filtered = O.optimize({
    props: board([0.85, 0.84, 0.83, 0.82]).map((p, i) => ({ ...p, league: i < 2 ? 'mlb' : 'nba' })),
    config: CLASSIC,
    optimizerConfig: optimizerConfig({ constraints: { allowed_sports: ['mlb'] } }),
  });
  t.ok('the sport filter reaches the search: only mlb legs appear',
    filtered.noBet === false && filtered.slips.every((s) => s._legs.every((l) => l.league === 'mlb')), '');
  t.ok('...and the two dropped legs are counted', filtered.board.droppedForConstraints === 2,
    JSON.stringify(filtered.board.dropReasons));

  // =========================================================================
  // 5. KELLY — requirement 4
  //
  //   Even money at p = 0.6: f* = 2p - 1 = 0.2.
  //   A 3x return at p = 0.5: f* = (p(1+b) - 1)/b = (1.5 - 1)/2 = 0.25.
  // =========================================================================
  t.ok('Kelly on an even-money bet at 60% is exactly 0.2',
    near(kellyFraction([{ probability: 0.6, multiplier: 2 }, { probability: 0.4, multiplier: 0 }], { multiplier: 1 }).full, 0.2, 1e-10), '');
  t.ok('...and on a 3x at 50% it is exactly 0.25',
    near(kellyFraction([{ probability: 0.5, multiplier: 3 }, { probability: 0.5, multiplier: 0 }], { multiplier: 1 }).full, 0.25, 1e-10), '');
  t.ok('THE KELLY STAKE ON A LOSING BET IS ZERO, not a small positive number',
    kellyFraction([{ probability: 0.4, multiplier: 2 }, { probability: 0.6, multiplier: 0 }]).fraction === 0, '');
  t.ok('...and says so rather than returning a bare 0',
    /non-positive edge/.test(kellyFraction([{ probability: 0.4, multiplier: 2 }, { probability: 0.6, multiplier: 0 }]).reason), '');
  t.ok('the default is QUARTER Kelly, not full',
    near(kellyFraction([{ probability: 0.6, multiplier: 2 }, { probability: 0.4, multiplier: 0 }]).fraction, 0.05, 1e-10),
    'full 0.2 -> quarter 0.05');

  const staked = mixed.slips[0];
  t.ok('every proposed slip carries a stake', staked.staking.stake > 0, String(staked.staking.stake));
  t.ok('...capped per slip', mixed.slips.every((s) => s.staking.stake <= OPT.staking.max_stake_per_slip + 1e-9), '');
  t.ok('...and the fraction is a quarter of full Kelly',
    near(staked.staking.kellyFraction, staked.staking.fullKelly * 0.25, 1e-12), '');

  //   THE SLATE CAP MUST ACTUALLY HOLD. Rounding each stake to the nearest cent
  //   can push the total a cent over, and a cap exceeded by a cent is not a cap.
  const capped = O.optimize({
    props: board([0.92, 0.91, 0.90, 0.89, 0.88, 0.87, 0.86, 0.85, 0.84]),
    config: CLASSIC,
    optimizerConfig: optimizerConfig({ staking: { max_slate_stake: 37, bankroll: 5000 } }),
  });
  const total = capped.slips.reduce((s, x) => s + x.staking.stake, 0);
  t.ok('the slate cap is never exceeded, not even by a cent', total <= 37 + 1e-9, String(total));
  t.ok('...and the report says the stakes were scaled', capped.staking.scaledBySlateCap === true, '');
  //   The currency EV is quoted against the stake, so it has to follow it down.
  //   It was computed before the cap was applied and reported the EV of a bet
  //   several times larger than the one being recommended.
  t.ok('...and the currency EV follows the capped stake, not the uncapped one',
    capped.slips.every((s) => near(s.ev.atRecommendedStake, s.ev.perUnit * s.staking.stake, 1e-9)),
    `${capped.slips[0].ev.atRecommendedStake.toFixed(2)} against ${(capped.slips[0].ev.perUnit * capped.slips[0].staking.stake).toFixed(2)}`);
  t.ok('...keeping what each would have been uncapped',
    capped.slips.every((s) => s.staking.stakeBeforeSlateCap >= s.staking.stake), '');

  // =========================================================================
  // 6. THE REPORT — requirement 4
  // =========================================================================
  const s0 = mixed.slips[0];
  t.ok('EV is reported per unit AND as a percentage of stake',
    near(s0.ev.percentOfStake, s0.ev.perUnit * 100, 1e-12), '');
  t.ok('...and in currency at the recommended stake',
    near(s0.ev.atRecommendedStake, s0.ev.perUnit * s0.staking.stake, 1e-9), '');
  t.ok('every payout tier has a probability and the multiplier it pays',
    s0.tiers.length > 0 && s0.tiers.every((x) => x.probability > 0 && x.multiplier != null), JSON.stringify(s0.tiers[0]));
  t.ok('...summing to no more than 1', s0.tiers.reduce((a, b) => a + b.probability, 0) <= 1 + 1e-9, '');
  t.ok('every leg says why it cleared the bar', s0.legs.every((l) => typeof l.why === 'string' && l.why.length > 20),
    s0.legs[0]?.why);
  t.ok('...quoting its probability against the per-leg break-even',
    s0.legs.every((l) => l.perLegBreakEven != null && l.edge != null), '');
  t.ok('...and whether it carries its own weight or is being carried',
    s0.legs.every((l) => typeof l.carries === 'boolean'), '');
  t.ok('...naming where its marginal came from', s0.legs.every((l) => !!l.marginalSource), s0.legs[0]?.marginalSource);
  t.ok('the correlation contribution is reported separately from the EV',
    s0.correlation.contributionPerUnit != null && s0.correlation.confidence != null, '');
  t.ok('...with whether it is bigger than the simulation noise',
    typeof s0.correlation.significant === 'boolean', '');
  t.ok('...and the naive EV kept beside it, so the correction is visible',
    s0.ev.naivePerUnit != null, '');

  // =========================================================================
  // 7. THE RUNNER-UP — requirement 5
  // =========================================================================
  t.ok('a second slip is reported', mixed.slips.length > 1, String(mixed.slips.length));
  t.ok('...with a diff against the TRUE second best', !!mixed.runnerUpDiff, '');
  t.ok('...telling the story in words, not just numbers',
    typeof mixed.runnerUpDiff.story === 'string' && mixed.runnerUpDiff.story.length > 30, mixed.runnerUpDiff.story);
  t.ok('...listing which legs are shared and which changed',
    Array.isArray(mixed.runnerUpDiff.sharedLegs) && Array.isArray(mixed.runnerUpDiff.onlyInBest), '');
  t.ok('...and the EV gap', mixed.runnerUpDiff.evGapPerUnit >= 0, String(mixed.runnerUpDiff.evGapPerUnit));

  //   The three stories the diff has to be able to tell.
  const legOf = (player, pWin) => ({ player, market: 'K', line: 5.5, side: 'over', pWin });
  const slip = (id, slipType, legCount, legs, ev, corr = 0) => ({
    id, slipType, legCount, legs, ev: { perUnit: ev }, correlation: { contributionPerUnit: corr },
  });
  const swap = O.diffSlips(
    slip('a', 'power', 3, [legOf('A', 0.8), legOf('B', 0.8), legOf('C', 0.8)], 0.20),
    slip('b', 'power', 3, [legOf('A', 0.8), legOf('B', 0.8), legOf('D', 0.79)], 0.19),
  );
  t.ok('a one-leg swap is described as one', /One leg apart/.test(swap.story), swap.story);
  t.ok('...naming both legs and the EV it is worth', /C/.test(swap.story) && /D/.test(swap.story), '');
  t.ok('...and calling a small gap near-indifference', /nearly indifferent/.test(swap.story), swap.story);

  const reshape = O.diffSlips(
    slip('a', 'power', 3, [legOf('A', 0.8), legOf('B', 0.8), legOf('C', 0.8)], 0.20),
    slip('b', 'flex', 3, [legOf('A', 0.8), legOf('B', 0.8), legOf('C', 0.8)], 0.15),
  );
  t.ok('identical legs at a different shape is called out as a payout-curve decision',
    /payout curve, not the picks/.test(reshape.story), reshape.story);
  t.ok('...and flagged structurally', reshape.shapeChanged === true, '');

  const unrelated = O.diffSlips(
    slip('a', 'power', 2, [legOf('A', 0.8), legOf('B', 0.8)], 0.20),
    slip('b', 'power', 2, [legOf('X', 0.8), legOf('Y', 0.8)], 0.18),
  );
  t.ok('two slips with nothing in common are named as two separate ideas',
    /No legs in common/.test(unrelated.story), unrelated.story);

  // =========================================================================
  // 8. Diversity — the list must not be five copies of one idea
  // =========================================================================
  const wide = O.optimize({
    props: board(Array.from({ length: 14 }, (_, i) => 0.86 - i * 0.005)),
    config: CLASSIC,
    optimizerConfig: optimizerConfig({ reporting: { min_distinct_legs: 2 } }),
  });
  t.ok('the reported slips differ from each other by at least two legs', (() => {
    const key = (s) => new Set(s._legs.map((l) => l.player));
    for (let i = 0; i < wide.slips.length; i++) {
      for (let j = i + 1; j < wide.slips.length; j++) {
        const a = key(wide.slips[i]), b = key(wide.slips[j]);
        let shared = 0;
        for (const x of a) if (b.has(x)) shared++;
        if (Math.max(a.size, b.size) - shared < 2) return false;
      }
    }
    return true;
  })(), wide.slips.map((s) => s._legs.map((l) => l.player).join('+')).join(' | '));
  t.ok('...while the runner-up diff still uses the TRUE second best, which may be one leg away',
    !!wide.runnerUpDiff && !!wide.runnerUp, '');
  t.ok('...and both are reported, because they answer different questions',
    !!wide.nextDistinctDiff, '');

  // =========================================================================
  // 9. Board accounting — what happened to every prop
  // =========================================================================
  t.eq('every prop is accounted for',
    mixed.board.propsIn,
    mixed.board.afterPrefilter + mixed.board.droppedForConstraints + mixed.board.droppedAsHopeless);
  t.ok('drop reasons are grouped and counted', typeof mixed.board.dropReasons === 'object', JSON.stringify(mixed.board.dropReasons));
  t.ok('the shapes searched are listed', mixed.search.shapes.includes('3-power'), mixed.search.shapes.join(','));

  // =========================================================================
  // 10. Degenerate boards refuse rather than throwing
  // =========================================================================
  t.ok('an empty board is a no-bet, not a crash',
    O.optimize({ props: [], config: CLASSIC, optimizerConfig: optimizerConfig() }).noBet === true, '');
  t.ok('a single prop is a no-bet — the smallest legal slip needs two',
    O.optimize({ props: board([0.99]), config: CLASSIC, optimizerConfig: optimizerConfig() }).noBet === true, '');
  //   And it blames the BOARD, not the prop. With one prop there are no
  //   partners to build a hopelessness bound against, so the prefilter would
  //   fall through and report "no prop survived" — which reads as though the
  //   prop were bad rather than as though the board were empty.
  t.ok('...and says exactly that, blaming the board rather than the prop',
    /1 prop on the board is playable, and the smallest legal slip needs 2/.test(
      O.optimize({ props: board([0.99]), config: CLASSIC, optimizerConfig: optimizerConfig() }).reason),
    O.optimize({ props: board([0.99]), config: CLASSIC, optimizerConfig: optimizerConfig() }).reason);
  // =========================================================================
  // 11. The rendered report
  // =========================================================================
  const text = O.renderOptimizerReport(mixed);
  const flat = text.replace(/[\u2502\u250c\u2510\u2514\u2518]/g, ' ').replace(/\s+/g, ' ');
  t.ok('the report shows the stake and the EV in currency beside it',
    /stake [\d.]+ +EV [+-]/.test(text), '');
  t.ok('...every leg with the bar it cleared', /per-leg bar/.test(text), '');
  t.ok('...the payout tiers with their multipliers', /payout tiers:.*@\d/.test(text), '');
  t.ok('...the correlation contribution beside the naive EV',
    /correlation:/.test(text) && /naive EV:/.test(text), '');
  t.ok('...the Kelly fraction at both full and fractional',
    /kelly: +[\d.]+% full, [\d.]+% at/.test(text), '');
  t.ok('...and what separates the best from the second best',
    /WHAT SEPARATES THE BEST SLIP FROM THE SECOND BEST/.test(text), '');
  t.ok('the search is labelled a heuristic in the output, not just in the object',
    /heuristic/.test(flat), '');
  t.ok('no line blows out the terminal', text.split('\n').every((l) => l.length <= 100),
    String(Math.max(...text.split('\n').map((l) => l.length))));

  const refusal = O.renderOptimizerReport(hopeless);
  t.ok('a refusal renders as NO BET TODAY, in a box', /NO BET TODAY/.test(refusal), '');
  t.ok('...with the reason and the board accounting',
    /props in/.test(refusal) && /failed a constraint/.test(refusal), '');
  t.ok('...and no slip anywhere in it', !/payout tiers/.test(refusal), '');

  t.ok('a prop with no probability at all is dropped, not treated as zero',
    O.optimize({ props: [{ player: 'X', market: 'K', line: 1, side: 'over' }, ...board([0.9, 0.9])],
      config: CLASSIC, optimizerConfig: optimizerConfig() }).board.droppedForConstraints >= 1, '');
}

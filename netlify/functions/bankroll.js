// netlify/functions/bankroll.js
//
// How much to stake, and whether to stake at all.
//
// ===========================================================================
// THE SIMPLE KELLY FORMULA IS WRONG FOR THIS PRODUCT
//
// f* = (bp - q) / b is the two-outcome formula. It assumes exactly one way to
// win and one way to lose. A Flex slip has FIVE outcomes on six legs — 25x,
// 2x, 0.4x and two zeros — and applying the two-outcome formula to it means
// picking one of those to call "the win" and discarding the rest.
//
// The correct object is expected log growth over EVERY tier:
//
//   G(f) = sum_k P_k * ln(1 - f + f * m_k)
//
// which is what payout-engine's kellyFraction() maximises, by bisection on
// G'(f) rather than by scanning a grid. This module is the policy layer on top
// of it: the floors, the ceilings, the calibration haircut and the ruin
// simulation.
//
// ---------------------------------------------------------------------------
// FULL KELLY ASSUMES THE PROBABILITIES ARE EXACTLY RIGHT
//
// They are not. The scoreboard fits a calibration slope, and a slope below 1
// means the probabilities are spread further from 50% than the outcomes
// justify — overconfident. Kelly is quadratically sensitive to that: staking
// full Kelly on an edge that is really half what you think loses money on
// average even though the bet is still positive-EV.
//
// So the fraction is reduced automatically when the slope says to, and the
// output SAYS SO in a sentence rather than quietly returning a smaller number.
// ===========================================================================

import { kellyFraction } from './payout-engine.js';
import { rng } from './copula.js';

// ---------------------------------------------------------------------------
// 1. The calibration haircut

/**
 * How much of Kelly to use, given what the calibration report says.
 *
 * A slope of s means a stated probability p is really sigmoid(s * logit(p)).
 * Betting as if p were right, when the truth is shrunk toward the base rate,
 * overstates the edge by roughly the same factor — so the Kelly fraction is
 * scaled by the slope. Below 1 it cuts; at 1 it does nothing; ABOVE 1 IT DOES
 * NOTHING EITHER.
 *
 * That asymmetry is deliberate. A slope above 1 says the model is
 * underconfident and full Kelly would be too small — but acting on that means
 * betting MORE because a fit on a few hundred graded props came out above one,
 * and the downside of being wrong about that is ruin rather than slower growth.
 * The haircut only ever reduces.
 */
export function calibrationHaircut(slope, { oneInsideCI = null, floor = 0.25 } = {}) {
  if (slope == null || !isFinite(slope)) {
    return {
      factor: 1,
      reason: 'no calibration slope available — no haircut applied, which is the OPTIMISTIC choice and the '
        + 'one place in this module that leans that way. Run the scoreboard.',
    };
  }
  if (slope >= 1) {
    return {
      factor: 1,
      reason: `calibration slope ${slope.toFixed(3)} is at or above 1, so no haircut. It is NOT used to bet more: `
        + 'a slope above 1 says the model is underconfident, and being wrong about that costs ruin rather than growth.',
    };
  }
  const factor = Math.max(floor, slope);
  return {
    factor,
    reason: oneInsideCI
      ? `calibration slope ${slope.toFixed(3)} is below 1, so Kelly is cut to ${(factor * 100).toFixed(0)}% of itself — `
        + 'though 1.0 is still inside its confidence interval, so this is a precaution rather than a measurement'
      : `calibration slope ${slope.toFixed(3)} is below 1 and measurably so: the probabilities are spread further from `
        + `50% than outcomes justify, so Kelly is cut to ${(factor * 100).toFixed(0)}% of itself`,
    floored: factor === floor && slope < floor,
  };
}

// ---------------------------------------------------------------------------
// 2. The stake

/**
 * The recommended stake for one priced slip.
 *
 * BLUNT BY DESIGN. If the edge does not support betting, the answer is zero and
 * the reason is a sentence, not a small number that looks like a
 * recommendation.
 */
export function recommendStake({
  outcomes,
  bankroll,
  config = {},
  calibration = null,
  slateStakedSoFar = 0,
}) {
  const mult = config.kelly_multiplier ?? 0.25;
  const minStake = config.min_stake ?? 5;
  const maxPct = config.max_pct_of_bankroll ?? 0.05;
  const maxSlate = config.max_slate_stake ?? Infinity;

  const hair = calibrationHaircut(calibration?.slope, {
    oneInsideCI: calibration?.oneInsideCI,
    floor: config.calibration_haircut_floor ?? 0.25,
  });

  const k = kellyFraction(outcomes, { multiplier: mult * hair.factor });
  const notes = [
    `Full Kelly assumes these probabilities are exactly right. ${hair.reason}`,
    `Fractional Kelly at ${mult} is applied on top of that.`,
  ];

  if (!(k.fraction > 0)) {
    return {
      stake: 0,
      fraction: 0,
      fullKelly: k.full ?? 0,
      edge: k.edge ?? null,
      verdict: 'NO BET',
      // The whole point of the brief's "be blunt".
      reason: k.reason || 'the edge does not support a stake',
      notes,
      calibration: hair,
    };
  }

  const raw = k.fraction * bankroll;
  const caps = [];
  let stake = raw;
  if (stake > bankroll * maxPct) { stake = bankroll * maxPct; caps.push(`${(maxPct * 100).toFixed(1)}% of bankroll`); }
  const slateRoom = Math.max(0, maxSlate - slateStakedSoFar);
  if (stake > slateRoom) { stake = slateRoom; caps.push(`the ${maxSlate} slate cap (${slateStakedSoFar.toFixed(2)} already committed)`); }
  // ROUNDED DOWN. A run of slips each rounded up to the nearest cent is a run
  // of slips staked above the size they were sized for.
  stake = Math.floor(stake * 100) / 100;

  if (stake < minStake) {
    return {
      stake: 0,
      fraction: k.fraction,
      fullKelly: k.full,
      edge: k.edge,
      verdict: 'NO BET',
      reason: `Kelly sizes this at ${stake.toFixed(2)}, under the ${minStake} minimum. `
        + 'Betting the minimum anyway would be staking above Kelly on an edge too small to justify it.',
      notes,
      calibration: hair,
      caps,
    };
  }

  return {
    stake,
    fraction: k.fraction,
    fullKelly: k.full,
    edge: k.edge,
    expectedLogGrowth: k.expectedLogGrowth,
    verdict: 'BET',
    reason: caps.length ? `Kelly wanted ${raw.toFixed(2)}, capped by ${caps.join(' and ')}` : 'Kelly, uncapped',
    caps,
    notes,
    calibration: hair,
  };
}

// ---------------------------------------------------------------------------
// 3. Risk of ruin — requirement 4

/**
 * Simulate bankroll paths under this sizing rule.
 *
 * THE 5TH PERCENTILE IS THE NUMBER TO READ. A median is what happens if things
 * go about as expected, and the reason people go broke betting is not that
 * things go as expected. Both are returned and the renderer gives them equal
 * weight — see the report, where the 5th percentile is printed first.
 *
 * Ruin is defined as falling below the point where the minimum stake can no
 * longer be placed, not as reaching zero. A bankroll of $3 with a $5 minimum is
 * finished, and calling that "not ruined" would understate the risk.
 */
export function riskOfRuin({
  outcomes,
  bankroll,
  config = {},
  calibration = null,
  slips = 500,
  paths = 10000,
  seed = 20260910,
}) {
  const minStake = config.min_stake ?? 5;
  const random = rng(seed);

  // The cumulative outcome distribution, sampled once per slip.
  const cum = [];
  let run = 0;
  for (const o of outcomes) { run += o.probability; cum.push({ upTo: run, mult: o.multiplier }); }
  const total = run;
  const draw = () => {
    const u = random() * total;
    for (const c of cum) if (u <= c.upTo) return c.mult;
    return cum[cum.length - 1].mult;
  };

  const finals = [];
  let ruined = 0;
  let everBelowHalf = 0;

  for (let p = 0; p < paths; p++) {
    let bank = bankroll;
    let wasRuined = false, dipped = false;
    for (let i = 0; i < slips; i++) {
      const rec = recommendStake({ outcomes, bankroll: bank, config, calibration });
      if (rec.stake <= 0) {
        // Cannot place the minimum any more. That is ruin for this purpose.
        if (bank < minStake / (config.max_pct_of_bankroll ?? 0.05)) { wasRuined = true; break; }
        break;   // no edge at this bankroll — stop betting, not ruined
      }
      bank = bank - rec.stake + rec.stake * draw();
      if (bank < bankroll / 2) dipped = true;
      if (bank < minStake) { wasRuined = true; break; }
    }
    if (wasRuined) ruined++;
    if (dipped) everBelowHalf++;
    finals.push(bank);
  }

  finals.sort((a, b) => a - b);
  const q = (p) => finals[Math.min(finals.length - 1, Math.floor(p * finals.length))];

  return {
    paths,
    slips,
    startingBankroll: bankroll,
    probabilityOfRuin: ruined / paths,
    // Given equal billing in the report, deliberately.
    p05: q(0.05),
    median: q(0.5),
    p95: q(0.95),
    // How often the path halved at any point, which is what actually makes
    // people stop betting a system that would have worked.
    probabilityOfHalving: everBelowHalf / paths,
    ruinDefinition: `bankroll below the ${minStake} minimum stake`,
  };
}

// ---------------------------------------------------------------------------
// 4. Actual vs recommended — requirement 5

/**
 * Compare what was staked against what Kelly said, over a bet log.
 *
 * `bets` are ledger rows carrying `stake`, plus `recommended_stake` where the
 * app recorded one. The gap is what this surfaces: consistent overbetting is
 * the single most common way a positive-EV system loses money.
 */
export function stakeDiscipline(bets, { tolerance = 0.15 } = {}) {
  const withRec = bets.filter((b) => b.recommended_stake != null && b.stake != null && b.recommended_stake > 0);
  if (!withRec.length) {
    return { n: 0, reason: 'no bet in the log carries the stake that was recommended at the time' };
  }
  const ratios = withRec.map((b) => b.stake / b.recommended_stake);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const over = ratios.filter((r) => r > 1 + tolerance).length;
  const under = ratios.filter((r) => r < 1 - tolerance).length;
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    n: withRec.length,
    meanRatio: mean,
    medianRatio: sorted[Math.floor(sorted.length / 2)],
    overbet: over,
    underbet: under,
    onPlan: withRec.length - over - under,
    // Blunt, because this is the finding that costs the most.
    verdict: mean > 1 + tolerance
      ? `You stake ${((mean - 1) * 100).toFixed(0)}% MORE than Kelly on average. Overbetting a real edge is how a `
        + 'winning system goes broke — the growth rate turns negative long before the edge does.'
      : mean < 1 - tolerance
        ? `You stake ${((1 - mean) * 100).toFixed(0)}% less than Kelly on average. That costs growth but not solvency.`
        : 'Staking is close to the recommendation.',
    ratios: sorted,
  };
}

/** The bankroll over time, from the log. */
export function bankrollPath(bets, results, { starting = 1000 } = {}) {
  const byLeg = new Map((results || []).map((r) => [r.leg_id, r]));
  const rows = [...(bets || [])].sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)));
  let bank = starting;
  const path = [{ at: null, bankroll: bank, slip: null }];
  for (const b of rows) {
    const legs = b.legs || [];
    const settled = legs.map((l) => byLeg.get(l.leg_id)).filter(Boolean);
    if (settled.length < legs.length) continue;      // unsettled slips do not move it
    const won = settled.filter((r) => r.outcome === 'won').length;
    const mult = b.payout_multiplier != null && won === legs.length ? b.payout_multiplier : (won === legs.length ? 1 : 0);
    bank = bank - Number(b.stake) + Number(b.stake) * mult;
    path.push({ at: b.placed_at, bankroll: bank, slip: b.slip_id });
  }
  return { starting, ending: bank, path };
}

// ---------------------------------------------------------------------------
// 5. Rendering

const wrapAt = (text, width) => {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
};

export function renderBankroll({ recommendation, ruin, discipline }, { width = 78 } = {}) {
  const L = [];
  const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
  L.push('═'.repeat(width));
  L.push('BANKROLL');
  L.push('═'.repeat(width));

  if (recommendation) {
    L.push('');
    if (recommendation.verdict === 'NO BET') {
      L.push('┌' + '─'.repeat(width - 2) + '┐');
      L.push('│ RECOMMENDED STAKE: $0.00' + ' '.repeat(width - 27) + '│');
      for (const line of wrapAt(recommendation.reason, width - 4)) {
        L.push('│ ' + line.padEnd(width - 4) + ' │');
      }
      L.push('└' + '─'.repeat(width - 2) + '┘');
    } else {
      L.push(`  RECOMMENDED STAKE: ${money(recommendation.stake)}`);
      L.push(`  full Kelly ${(recommendation.fullKelly * 100).toFixed(2)}% · `
        + `used ${(recommendation.fraction * 100).toFixed(2)}% · ${recommendation.reason}`);
    }
    for (const n of recommendation.notes || []) {
      for (const line of wrapAt(n, width - 6)) L.push(`    ${line}`);
    }
  }

  if (ruin) {
    L.push('');
    L.push('─'.repeat(width));
    L.push(`RISK OF RUIN — ${ruin.paths.toLocaleString()} paths, ${ruin.slips} slips each`);
    L.push('─'.repeat(width));
    // THE 5TH PERCENTILE FIRST. The median is what happens if things go as
    // expected, and that is not why people go broke.
    L.push(`  5th percentile     ${money(ruin.p05)}   ← the number to plan around`);
    L.push(`  median             ${money(ruin.median)}`);
    L.push(`  95th percentile    ${money(ruin.p95)}`);
    L.push('');
    L.push(`  probability of ruin      ${(ruin.probabilityOfRuin * 100).toFixed(2)}%  (${ruin.ruinDefinition})`);
    L.push(`  probability of halving   ${(ruin.probabilityOfHalving * 100).toFixed(2)}%`);
    L.push('    — the level at which people stop betting a system that would have worked');
  }

  if (discipline && discipline.n) {
    L.push('');
    L.push('─'.repeat(width));
    L.push('ACTUAL VS RECOMMENDED');
    L.push('─'.repeat(width));
    L.push(`  ${discipline.n} bets carry a recommendation · mean ratio ${discipline.meanRatio.toFixed(2)}x · `
      + `${discipline.overbet} over, ${discipline.underbet} under, ${discipline.onPlan} on plan`);
    for (const line of wrapAt(discipline.verdict, width - 4)) L.push(`  ${line}`);
  }

  L.push('');
  L.push('═'.repeat(width));
  return L.join('\n');
}

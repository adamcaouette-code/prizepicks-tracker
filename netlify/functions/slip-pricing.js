// netlify/functions/slip-pricing.js
//
// Correlation-aware slip pricing. Replaces naive probability multiplication.
//
// ===========================================================================
// WHAT THIS CHANGES
//
// Every EV this app has ever printed multiplied the legs together. That is
// correct only if the legs are independent, and slips are built from one slate
// and often one game, so they never are.
//
// The error has a KNOWN SIGN and it is not the same sign for both products:
//
//   POWER pays only for going perfect. Positive correlation concentrates mass
//         at the top of the correct-count distribution, so independence
//         UNDERSTATES a positively-correlated Power play. Three coin-flip legs
//         go perfect 12.5% of the time independent and 25% at a pairwise
//         correlation of 0.5 — exactly double, and that is the whole slip.
//
//   FLEX  I expected the opposite, and MEASURING IT SAYS OTHERWISE. The
//         reasoning was that Flex is paid out of the middle of the distribution
//         (4-of-6, 5-of-6) and correlation drains the middle into the ends, so
//         a correlated Flex should be overstated by independence. The first half
//         is right; the conclusion is not, for the tables PrizePicks actually
//         posts. A 6-leg Flex pays 25x for six and 2x for five: the perfect
//         tier dominates Flex's EV as well, and the middle tiers are consolation
//         rather than the product. Across both configs in payout-tables.json,
//         every leg count 3-6 and every leg probability 0.3-0.7, positive
//         correlation HELPS Flex too — just about half as much as it helps
//         Power. Negative correlation hurts both.
//
// What survives, and is the thing that matters: independence understates POWER
// MORE THAN FLEX, in every cell of that grid. So the naive engine's ranking of
// the two products was biased in a known direction — it under-ranked Power —
// even though the mechanism I first wrote down for the Flex side was wrong.
// The test suite pins the corrected version rather than the intuition.
//
// ---------------------------------------------------------------------------
// THE PIPELINE
//
//   marginals   tasks 04/05/06: a de-vigged book price, an alt-line
//               translation, or a projected PMF. Untouched — the copula
//               changes only the dependence.
//   R           correlation.js: estimated per market-pair and relationship,
//               inverted to the latent scale, shrunk toward zero by sample size.
//   simulate    copula.js: 100k paths, joint (pushes, correct) distribution.
//   price       payout-engine.js: the SAME payout tables as the naive path, fed
//               the correlated distribution instead of the independent one.
//
// Both prices are always returned. The delta between them is the deliverable —
// not the correlated number on its own — because the delta is what says whether
// this module is doing anything on this slip, and its sign says whether the
// old number was too high or too low.
// ===========================================================================

import { buildMatrix } from './correlation.js';
import { simulateSlip, legFromProbs, legFromPmf, identity } from './copula.js';
import { evForSlip, evFromJoint, payoutTable, correctCountDistribution } from './payout-engine.js';

/**
 * Turn whatever a leg knows about its own distribution into copula bands.
 *
 * Three shapes, in order of how much they know:
 *
 *   pmf     a full projected distribution (task 06). The line is applied to it
 *           here, so the push band on a whole-number line is exact.
 *   over/under/push  probabilities already computed (tasks 04, 05).
 *   prob    a bare win probability, the shape the old engine took. Accepted so
 *           this can price a legacy slip, but it carries no push mass and
 *           cannot: a bare number does not know whether its line was whole.
 */
export function toCopulaLeg(leg) {
  if (Array.isArray(leg.pmf) && leg.line != null) {
    return { ...legFromPmf({ pmf: leg.pmf, line: leg.line, side: leg.side }), source: 'pmf' };
  }
  if (leg.over != null || leg.under != null) {
    return { ...legFromProbs({ over: leg.over, under: leg.under, push: leg.push || 0, side: leg.side }), source: 'probs' };
  }
  const p = Number(leg.prob);
  if (!isFinite(p)) throw new Error(`leg "${leg.player || '?'} ${leg.market || '?'}" has no distribution, no probabilities and no prob`);
  const isUnder = String(leg.side || 'over').toLowerCase() === 'under';
  return {
    ...legFromProbs({ over: isUnder ? 1 - p : p, under: isUnder ? p : 1 - p, push: 0, side: leg.side }),
    source: 'prob',
  };
}

/**
 * Price one slip both ways.
 *
 * `legs` carry their identity (player, team, eventId, market, tier) so the
 * correlation table can be looked up, and their distribution in any of the
 * three shapes above.
 */
export function priceSlip({
  legs,
  table,
  config,
  slipType,
  stake = 1,
  paths = 100000,
  seed = 20260910,
  correlationConfig = {},
}) {
  const n = legs.length;
  const copulaLegs = legs.map(toCopulaLeg);
  const winProbs = copulaLegs.map((l) => l.pWin);

  if (!payoutTable(config, slipType, n)) {
    throw new Error(`${config?.id || 'config'} does not offer a ${n}-leg ${slipType} slip`);
  }

  // ---- the naive price, unchanged -----------------------------------------
  const naive = evForSlip({ config, slipType, probs: winProbs, legs, stake });

  // ---- the correlation structure ------------------------------------------
  const { R, provenance, confidence } = buildMatrix(legs, table, { config: correlationConfig });

  // ---- simulate ------------------------------------------------------------
  const sim = simulateSlip({ legs: copulaLegs, R, paths, seed });

  // ---- price it with the same tables ---------------------------------------
  // Two routes, and the choice is not stylistic. With no push mass anywhere the
  // correct-count vector is the whole answer and goes through evForSlip, which
  // is the same function the naive price used — so the two numbers differ only
  // by the distribution, never by the code path. The moment a leg CAN push, the
  // slip may be re-priced at a smaller size and the joint matrix is required.
  const correlated = sim.anyPush
    ? evFromJoint({ config, slipType, joint: sim.joint, legs, stake })
    : evForSlip({ config, slipType, legs, stake, distribution: sim.correctCount });

  const deltaPerUnit = correlated.evPerUnit - naive.evPerUnit;

  // Monte Carlo error, propagated to the EV rather than quoted on the
  // probability. A delta of 0.004 on a simulation whose standard error is 0.003
  // is not a finding, and the report has to be able to say so.
  const evSe = mcStandardError(sim, config, slipType, legs, stake);

  return {
    slipType,
    legCount: n,
    stake,
    naive: {
      evPerUnit: naive.evPerUnit,
      returnPerUnit: naive.returnPerUnit,
      probAllHit: naive.probAllHit,
      distribution: correctCountDistribution(winProbs),
    },
    correlated: {
      evPerUnit: correlated.evPerUnit,
      returnPerUnit: correlated.returnPerUnit,
      probAllHit: correlated.probAllHit,
      distribution: sim.correctCount,
      joint: sim.anyPush ? sim.joint : null,
      probAnyPush: correlated.probAnyPush ?? 0,
      // The payout-tier breakdown, carried through rather than rebuilt. It is
      // what the Kelly solver needs — a probability beside the MULTIPLIER it
      // pays, which only the payout engine knows — and reconstructing it
      // anywhere else would be a second copy of the table lookup.
      byOutcome: correlated.byOutcome,
      probAnyPayout: correlated.probAnyPayout,
    },
    // THE DELTAS — requirement 4.
    delta: {
      evPerUnit: deltaPerUnit,
      ev: deltaPerUnit * stake,
      probAllHit: correlated.probAllHit - naive.probAllHit,
      // Positive means correlation HELPS this slip. On a Power play that is
      // what positively-correlated legs do, and it is exactly what a Power play
      // pays for.
      helps: deltaPerUnit > 0,
      // Whether the move is bigger than the noise in the simulation that
      // produced it. Without this the ranking would sort on Monte Carlo error
      // wherever the real effect is small.
      significant: Math.abs(deltaPerUnit) > 2 * evSe,
      mcStandardError: evSe,
    },
    correlation: {
      matrix: R,
      provenance,
      confidence,
      meanOffDiagonal: meanOffDiagonal(R),
      maxAbsOffDiagonal: maxAbsOffDiagonal(R),
      matrixAdjusted: sim.matrixAdjusted,
      minEigenvalue: sim.minEigenvalue,
    },
    simulation: { paths: sim.paths, seed: sim.seed, seAllCorrect: sim.seAllCorrect },
    legs: legs.map((l, i) => ({
      player: l.player ?? null, market: l.market ?? null, line: l.line ?? null,
      side: copulaLegs[i].side, tier: l.tier ?? null,
      pWin: copulaLegs[i].pWin, pPush: copulaLegs[i].pPush,
      marginalSource: copulaLegs[i].source,
    })),
  };
}

/**
 * The Monte Carlo standard error of the EV, not of a probability.
 *
 * The EV is a weighted sum of multinomial cell frequencies, so its variance is
 * (E[payout^2] - E[payout]^2) / paths. Computed from the simulated distribution
 * itself rather than assumed, because the payout table is a step function and
 * the variance depends entirely on where the steps fall.
 */
export function mcStandardError(sim, config, slipType, legs, stake = 1) {
  const n = sim.correctCount.length - 1;
  const mult = legs ? evForSlip({ config, slipType, probs: new Array(n).fill(0.5), legs, stake }).legMultiplier : 1;
  let m1 = 0, m2 = 0;
  for (let pushes = 0; pushes <= n; pushes++) {
    const size = n - pushes;
    const t = payoutTable(config, slipType, size);
    for (let k = 0; k <= size; k++) {
      const prob = sim.joint[pushes][k];
      if (!(prob > 0)) continue;
      const pay = t ? (t[String(k)] || 0) * mult : 1;
      m1 += prob * pay;
      m2 += prob * pay * pay;
    }
  }
  return Math.sqrt(Math.max(0, m2 - m1 * m1) / sim.paths);
}

const offDiagonals = (R) => {
  const out = [];
  for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) out.push(R[i][j]);
  return out;
};
const meanOffDiagonal = (R) => {
  const v = offDiagonals(R);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
};
const maxAbsOffDiagonal = (R) => {
  const v = offDiagonals(R).map(Math.abs);
  return v.length ? Math.max(...v) : 0;
};

/**
 * Price a set of slips and rank them by HOW MUCH CORRELATION HELPS.
 *
 * Requirement 4, and the ordering is deliberate: this is not a ranking by EV.
 * Ranking by EV is what the payout engine already does. This ranks by the size
 * of the correction, which answers a different and more useful question — where
 * was the old number most wrong, and in which direction.
 *
 * The sort key is the delta, but a delta INSIDE THE SIMULATION'S OWN NOISE is
 * treated as exactly zero for ordering. Sorting on the raw point estimate would
 * let Monte Carlo error float to the top of the list wherever the real effect is
 * small — which is most slips. Ranking every non-significant slip below every
 * significant one would be worse still: it would push a slip correlation
 * actively HARMS above one where nothing is known, and the bottom of the list
 * would stop meaning "most harmed".
 *
 * Zeroing instead keeps the order monotone in the effect: significant help at
 * the top, descending; everything indistinguishable from nothing in the middle;
 * significant harm at the bottom, most harmed last.
 */
export function rankByCorrelationBenefit(slips, opts) {
  const priced = slips.map((slip) => {
    try {
      return {
        id: slip.id ?? null,
        ...priceSlip({ ...opts, ...slip }),
        error: null,
      };
    } catch (e) {
      return { id: slip.id ?? null, error: String(e.message || e) };
    }
  });
  const ok = priced.filter((p) => !p.error);
  const key = (p) => (p.delta.significant ? p.delta.evPerUnit : 0);
  ok.sort((a, b) => (key(b) - key(a)) || (Math.abs(a.delta.evPerUnit) - Math.abs(b.delta.evPerUnit)));
  return {
    ranked: ok,
    failed: priced.filter((p) => p.error),
    summary: {
      slips: ok.length,
      helped: ok.filter((p) => p.delta.helps && p.delta.significant).length,
      hurt: ok.filter((p) => !p.delta.helps && p.delta.significant).length,
      insideNoise: ok.filter((p) => !p.delta.significant).length,
      lowConfidence: ok.filter((p) => p.correlation.confidence.level === 'low').length,
      // The biggest single correction, which is the number that says whether
      // this module was worth building on today's board.
      largestHelp: ok.length ? Math.max(...ok.map((p) => p.delta.evPerUnit)) : null,
      largestHarm: ok.length ? Math.min(...ok.map((p) => p.delta.evPerUnit)) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting

const pc = (v, d = 2) => `${(v * 100).toFixed(d)}%`;
const sgn = (v, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

/** The delta report, as text. Requirement 4. */
export function renderCorrelationReport(result, { width = 78 } = {}) {
  const L = [];
  L.push('═'.repeat(width));
  L.push('CORRELATION-AWARE SLIP PRICING');
  L.push('═'.repeat(width));
  const s = result.summary;
  L.push('');
  L.push(`  ${s.slips} slips priced · ${s.helped} helped by correlation · ${s.hurt} hurt · `
    + `${s.insideNoise} inside simulation noise`);
  if (s.lowConfidence) {
    L.push(`  ⚠ ${s.lowConfidence} slip(s) priced on a correlation structure that is mostly unmeasured`);
  }
  L.push('');
  L.push(`  ${'slip'.padEnd(22)}${'type'.padStart(7)}${'naive EV'.padStart(11)}${'corr EV'.padStart(11)}`
    + `${'delta'.padStart(10)}${'conf'.padStart(8)}`);
  L.push('  ' + '─'.repeat(width - 4));
  for (const p of result.ranked) {
    const name = String(p.id ?? p.legs.map((l) => l.player).join('+')).slice(0, 21);
    const mark = p.delta.significant ? (p.delta.helps ? '▲' : '▼') : '·';
    L.push(`  ${name.padEnd(22)}${`${p.legCount}-${p.slipType}`.padStart(7)}`
      + `${sgn(p.naive.evPerUnit).padStart(11)}${sgn(p.correlated.evPerUnit).padStart(11)}`
      + `${(mark + sgn(p.delta.evPerUnit)).padStart(10)}`
      + `${p.correlation.confidence.level.padStart(8)}`);
  }
  L.push('');
  L.push('  ▲ correlation helps (significant)   ▼ hurts   · inside Monte Carlo noise');
  L.push('');
  L.push('  Positively correlated legs on a POWER play raise the chance of going');
  L.push('  perfect, which is the only outcome a Power play pays for. Flex is');
  L.push('  helped too — its top tier dominates its EV on the tables PrizePicks');
  L.push('  posts — but by roughly half as much, so pricing legs as independent');
  L.push('  systematically under-ranks Power against Flex.');

  const top = result.ranked[0];
  if (top && top.delta.significant) {
    L.push('');
    L.push('─'.repeat(width));
    L.push(`LARGEST CORRECTION: ${top.id ?? top.legs.map((l) => l.player).join(' + ')}`);
    L.push('─'.repeat(width));
    L.push(`  ${top.legCount}-leg ${top.slipType}, mean pairwise correlation ${top.correlation.meanOffDiagonal.toFixed(3)}`);
    L.push(`  P(all hit)   naive ${pc(top.naive.probAllHit)}   correlated ${pc(top.correlated.probAllHit)}`);
    L.push(`  EV per unit  naive ${sgn(top.naive.evPerUnit)}   correlated ${sgn(top.correlated.evPerUnit)}`);
    L.push('');
    L.push(`  correlation confidence: ${top.correlation.confidence.level} — ${top.correlation.confidence.reason}`);
    for (const pr of top.correlation.provenance) {
      const a = top.legs[pr.i], b = top.legs[pr.j];
      L.push(`    ${String(`${a.player} ${a.market}`).slice(0, 28).padEnd(29)}`
        + `${String(`${b.player} ${b.market}`).slice(0, 28).padEnd(29)}`
        + `${pr.rho.toFixed(3).padStart(7)}  ${pr.source}${pr.n ? ` n=${pr.n}` : ''}`);
    }
  }
  L.push('');
  L.push('═'.repeat(width));
  return L.join('\n');
}

export { identity };

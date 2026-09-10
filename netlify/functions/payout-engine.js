// netlify/functions/payout-engine.js
//
// What a slip pays, what it is worth, and what it needs to hit to break even.
//
// PURE. Zero imports, no I/O, no clock, no randomness. Every number comes in as
// an argument, including the payout table — see payout-tables.json. That is the
// whole design: the engine holds no payout constants of its own, so a table
// that changes by state or promo is a data edit and a new effective_date rather
// than a code change.
//
// ===========================================================================
// TODO(correlation): EVERY PROBABILITY HERE ASSUMES THE LEGS ARE INDEPENDENT.
//
// They are not, and the error is not symmetric. Legs in the same game move
// together: two overs in a game that turns into a shootout both hit, and both
// miss in a pitchers' duel. Two props on the SAME PLAYER (hits and total bases)
// are close to a copy of each other. A pitcher's strikeouts and the opposing
// hitters' unders are directly opposed.
//
// What that does to these numbers:
//   POWER  is UNDERSTATED on positively-correlated legs. All-hit is a joint
//          event, and positive correlation makes joint outcomes more likely
//          than the product of the marginals.
//   FLEX   is ALSO understated, which is NOT what this note originally claimed.
//          The claim was that Flex is overstated because its middle tiers are
//          paid for the scattered outcomes correlation makes rarer. The premise
//          holds — correlation does drain the middle — but the conclusion does
//          not, for the tables in payout-tables.json: a 6-leg Flex pays 25x for
//          six and 2x for five, so the perfect tier dominates Flex's EV too.
//          Measured across both configs, leg counts 3-6 and leg probabilities
//          0.3-0.7, positive correlation raises Flex EV in every case.
//
// So this engine's ranking of Power against Flex IS biased in a known direction
// — it understates Power MORE than Flex in every one of those cells, and so
// under-ranks Power — but not for the reason first written here. The bias is
// largest exactly where slips are built: several legs from one slate, one game.
//
// RESOLVED, and the seam turned out to be exactly where this note predicted.
// correctCountDistribution() convolves independent Bernoullis; slip-pricing.js
// replaces that one distribution with a Gaussian-copula simulation of the same
// object and passes it in through `distribution` below. Nothing else in this
// file changed, and the payout tables stayed the single source of truth.
//
// This function is STILL the independent version and is still correct as such —
// it is the naive baseline the correlated price is reported against. What
// changed is that it is no longer the only option, and every result says which
// one it is (`assumesIndependence`). A caller that passes no distribution gets
// independence, and gets told so.
// ===========================================================================

export const SLIP_TYPES = ['power', 'flex'];

// ---------------------------------------------------------------------------
// Config

/**
 * Everything wrong with a config, as a list. Returns [] when it is usable.
 *
 * A payout table is the one input where a typo is silent and expensive: an
 * extra zero on a multiplier does not throw, it just makes every slip look
 * like a good bet. So this is strict about shape and about ranges that cannot
 * be real, and it is meant to be run at load rather than at first use.
 */
export function validateConfig(config) {
  const e = [];
  if (!config || typeof config !== 'object') return ['config is not an object'];
  if (!config.id) e.push('id is required');
  if (!config.effective_date) e.push('effective_date is required — a payout table without one cannot be versioned');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(config.effective_date)) e.push('effective_date must be YYYY-MM-DD');
  const st = config.slip_types;
  if (!st || typeof st !== 'object') return [...e, 'slip_types is required'];

  for (const [type, byCount] of Object.entries(st)) {
    if (!SLIP_TYPES.includes(type)) e.push(`unknown slip type "${type}"`);
    for (const [countStr, tiers] of Object.entries(byCount || {})) {
      const n = Number(countStr);
      if (!Number.isInteger(n) || n < 1) { e.push(`${type}: "${countStr}" is not a leg count`); continue; }
      const ks = Object.keys(tiers || {});
      if (!ks.length) { e.push(`${type}/${n}: no payout tiers`); continue; }
      for (const kStr of ks) {
        const k = Number(kStr);
        const m = tiers[kStr];
        if (!Number.isInteger(k) || k < 0 || k > n) e.push(`${type}/${n}: correct-count "${kStr}" is not 0..${n}`);
        if (typeof m !== 'number' || !isFinite(m) || m < 0) e.push(`${type}/${n}/${k}: multiplier must be a non-negative number`);
      }
      // A payout that falls as you get MORE legs right is either a typo or a
      // product nobody would offer, and it would quietly break the monotonicity
      // that breakEven()'s search relies on.
      const sorted = ks.map(Number).sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (tiers[String(sorted[i])] < tiers[String(sorted[i - 1])]) {
          e.push(`${type}/${n}: paying ${tiers[String(sorted[i])]} for ${sorted[i]} correct but `
            + `${tiers[String(sorted[i - 1])]} for ${sorted[i - 1]} — payouts must not decrease as you get more right`);
        }
      }
    }
  }
  for (const [tier, m] of Object.entries(config.leg_multipliers || {})) {
    if (typeof m !== 'number' || !isFinite(m) || m <= 0) e.push(`leg_multipliers.${tier} must be a positive number`);
  }
  return e;
}

export function assertConfig(config) {
  const errs = validateConfig(config);
  if (errs.length) throw new Error(`invalid payout config: ${errs.join('; ')}`);
  return config;
}

/**
 * The config in force on a date, from a list of them.
 *
 * Latest effective_date at or before `on`. This is the reason effective_date
 * exists: a slip placed in March has to be priced by March's table forever,
 * however many times the table has changed since. Re-pricing history against
 * today's numbers is how a ledger starts lying about what a bet was worth.
 */
export function configFor(configs, on, { jurisdiction = null } = {}) {
  const day = String(on).slice(0, 10);
  const eligible = (configs || [])
    .filter((c) => !jurisdiction || c.jurisdiction === jurisdiction || c.jurisdiction === 'default')
    .filter((c) => c.effective_date <= day)
    .filter((c) => !c.end_date || c.end_date >= day)
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1));
  return eligible[0] || null;
}

/** The {correctCount: multiplier} table for one slip shape, or null. */
export function payoutTable(config, slipType, legCount) {
  const t = config?.slip_types?.[slipType]?.[String(legCount)];
  return t ? { ...t } : null;
}

/** Every (slipType, legCount) this config actually offers at this size. */
export function legalSlips(config, legCount) {
  return SLIP_TYPES
    .filter((type) => payoutTable(config, type, legCount))
    .map((slipType) => ({ slipType, legCount }));
}

// ---------------------------------------------------------------------------
// Probability

/**
 * P(exactly k of these legs hit), for k = 0..n.
 *
 * The Poisson-binomial distribution, by DP convolution: start with "0 legs, 0
 * correct, probability 1" and fold in one leg at a time. Exact and O(n^2),
 * which at n<=6 is nothing.
 *
 * IT MUST NOT BE A BINOMIAL ON THE MEAN PROBABILITY. Legs at 0.9 and 0.5 are
 * not two legs at 0.7: the binomial gives P(both) = 0.49 where the truth is
 * 0.45, and the gap grows with the spread. Flex tiers are paid out of exactly
 * that middle of the distribution, so the shortcut misprices the product it is
 * most often used on.
 *
 * THIS IS THE INDEPENDENT VERSION, and it is the naive baseline the correlated
 * price is measured against — see slip-pricing.js, which produces the dependent
 * equivalent by Gaussian copula and hands it to evForSlip as `distribution`.
 */
export function correctCountDistribution(probs) {
  let dist = [1];
  for (const raw of probs) {
    const p = Number(raw);
    if (!(p >= 0 && p <= 1)) throw new Error(`probability ${raw} is not in [0, 1]`);
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);      // this leg misses
      next[k + 1] += dist[k] * p;        // this leg hits
    }
    dist = next;
  }
  return dist;
}

/** The product of each leg's payout multiplier, defaults filled from the config. */
export function legMultiplier(config, legs) {
  return (legs || []).reduce((m, leg) => {
    // An explicit per-leg multiplier always wins. Real PrizePicks prints the
    // exact number on every goblin/demon card and the line-snapshot archive
    // captures it; the config's tier defaults are a fallback for when it is
    // genuinely unknown, not a preferred source.
    if (leg && typeof leg.multiplier === 'number' && isFinite(leg.multiplier)) return m * leg.multiplier;
    const tier = String(leg?.tier || 'standard').toLowerCase();
    const fromConfig = config?.leg_multipliers?.[tier];
    return m * (typeof fromConfig === 'number' ? fromConfig : 1);
  }, 1);
}

// ---------------------------------------------------------------------------
// EV

/**
 * Exact EV for one slip.
 *
 * EV = sum over k of P(exactly k correct) * payout(k) * legMultiplier - stake,
 * where payout(k) is 0 for any k the table does not pay.
 *
 * Returned per unit staked as well as absolute, because `ev` alone cannot be
 * compared between a $5 and a $50 slip and that comparison is the entire point
 * of rankSlips().
 */
export function evForSlip({ config, slipType, probs, legs, stake = 1, distribution = null }) {
  const p = probs || (legs || []).map((l) => l.prob);
  const n = distribution ? distribution.length - 1 : p.length;
  const table = payoutTable(config, slipType, n);
  if (!table) {
    throw new Error(`${config?.id || 'config'} does not offer a ${n}-leg ${slipType} slip`);
  }
  // A caller may supply the correct-count distribution instead of letting it be
  // convolved from independent legs — that is how correlation enters, and it
  // enters HERE rather than by anyone else learning the payout tables.
  const dist = distribution || correctCountDistribution(p);
  const mult = legMultiplier(config, legs);

  let gross = 0;
  const byOutcome = [];
  for (let k = n; k >= 0; k--) {
    const payout = (table[String(k)] || 0) * mult;
    const prob = dist[k];
    gross += prob * payout;
    if (payout > 0 || prob > 1e-12) {
      byOutcome.push({ correct: k, probability: prob, multiplier: payout, contribution: prob * payout });
    }
  }
  const returnPerUnit = gross;                 // multiple of stake returned
  return {
    slipType,
    legCount: n,
    stake,
    // Fraction of stake returned on average: 1.0 is break-even, 0.9 loses 10c
    // per dollar. The number to compare slips on.
    returnPerUnit,
    evPerUnit: returnPerUnit - 1,
    ev: (returnPerUnit - 1) * stake,
    probAllHit: dist[n],
    // Anything the table pays at all, so a Flex slip's "cashed but lost money"
    // outcomes are visible rather than folded into one number.
    probAnyPayout: byOutcome.reduce((s, o) => s + (o.multiplier > 0 ? o.probability : 0), 0),
    legMultiplier: mult,
    byOutcome,
    // Never silently absent — every EV in this module rests on it, and now it
    // is a fact about the call rather than about the module.
    assumesIndependence: !distribution,
  };
}

/**
 * EV over a JOINT distribution of (pushes, correct), which is what a copula
 * simulation produces once any leg can push.
 *
 * A PUSH IS NOT A LOSS. PrizePicks voids the leg and re-prices the slip at the
 * smaller size — a 6-pick Power with one push becomes a 5-pick Power, on the
 * 5-pick table. Folding pushes into losses would misprice every whole-number
 * line in the book, and because the payout tables are STEP FUNCTIONS the error
 * does not average out: it moves the slip across a tier boundary or it does
 * not.
 *
 * When the reduced size has no table at all — a 2-pick that loses a leg — the
 * stake is returned, which is what the operator does and what a multiplier of
 * exactly 1.0 means here.
 *
 * `joint[pushes][correct]`. Row 0 alone is the ordinary case, and when no leg
 * can push this agrees with evForSlip to the last bit.
 */
export function evFromJoint({ config, slipType, joint, legs, stake = 1 }) {
  const n = joint.length - 1;
  const mult = legMultiplier(config, legs);
  let gross = 0;
  const byOutcome = [];
  for (let pushes = 0; pushes <= n; pushes++) {
    const size = n - pushes;
    const table = payoutTable(config, slipType, size);
    for (let k = 0; k <= size; k++) {
      const prob = joint[pushes][k];
      if (!(prob > 0)) continue;
      // No table at this size means the slip cannot stand: stake returned.
      const payout = table ? (table[String(k)] || 0) * mult : 1;
      gross += prob * payout;
      byOutcome.push({
        pushes, correct: k, effectiveLegs: size, probability: prob,
        multiplier: payout, contribution: prob * payout,
        refunded: !table,
      });
    }
  }
  byOutcome.sort((a, b) => b.contribution - a.contribution);
  const topTable = payoutTable(config, slipType, n);
  return {
    slipType,
    legCount: n,
    stake,
    returnPerUnit: gross,
    evPerUnit: gross - 1,
    ev: (gross - 1) * stake,
    probAllHit: joint[0][n],
    probAnyPayout: byOutcome.reduce((s, o) => s + (o.multiplier > 0 ? o.probability : 0), 0),
    probAnyPush: 1 - joint[0].reduce((s, v) => s + v, 0),
    legMultiplier: mult,
    byOutcome,
    topTable,
    assumesIndependence: false,
  };
}

// ---------------------------------------------------------------------------
// Break-even

/**
 * The shared per-leg probability at which a slip returns exactly its stake.
 *
 * Bisection, not algebra. Power has a closed form (M^(-1/n)) but Flex does not:
 * its EV is a polynomial in p with a term per payout tier, and the root has no
 * general expression. One numeric method for both means the two can never be
 * subtly different in a way nobody notices — and bisection is exact to machine
 * precision here in ~50 iterations.
 *
 * Safe because EV is monotonically increasing in p: payouts never decrease as
 * you get more legs right (validateConfig enforces it), so raising p moves
 * probability mass toward better-paying outcomes and can only raise EV.
 *
 * Returns null when the slip cannot break even at ANY probability — a table
 * whose top multiplier is below 1 is a losing product at p = 1, and returning
 * 1.0 there would read as "you need certainty" instead of "this is impossible".
 */
export function breakEven({ config, slipType, legCount, legs = null, tol = 1e-12 }) {
  const table = payoutTable(config, slipType, legCount);
  if (!table) return null;
  const at = (p) => evForSlip({
    config, slipType, probs: new Array(legCount).fill(p), legs, stake: 1,
  }).evPerUnit;

  if (at(1) < 0) return null;          // unwinnable even with certainty
  if (at(0) >= 0) return 0;            // free money: a table that pays on 0 correct

  let lo = 0, hi = 1;
  for (let i = 0; i < 200 && hi - lo > tol; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Ranking real legs

const combinations = (arr, k) => {
  const out = [];
  const walk = (start, picked) => {
    if (picked.length === k) { out.push([...picked]); return; }
    for (let i = start; i <= arr.length - (k - picked.length); i++) {
      picked.push(arr[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
};

const nCk = (n, k) => {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
};

/**
 * Every legal slip these legs could form, best first.
 *
 * Legs have DIFFERENT probabilities — that is the point of this function, and
 * why it cannot just raise one number to a power. For each legal (type, size)
 * it finds the best subset of that size and reports it.
 *
 * SUBSET SELECTION. For Power the best subset is provably the top k by
 * probability: EV is a strictly increasing function of the product, and a
 * product of k factors is maximised by the k largest. For Flex that argument
 * does not hold — the middle tiers pay, so a slip of five near-certainties and
 * one coin flip can beat six good legs — so every subset is enumerated and
 * scored exactly. That is C(n,k) evaluations, which is trivial at the sizes
 * PrizePicks allows and is capped below for anything larger, with the fallback
 * LABELLED rather than silent.
 */
export function rankSlips({ config, legs, probs, stake = 1, maxSubsets = 20000 }) {
  const items = legs || (probs || []).map((prob) => ({ prob }));
  if (!items.length) return [];
  const n = items.length;
  const sizes = [...new Set(
    SLIP_TYPES.flatMap((type) => Object.keys(config?.slip_types?.[type] || {}).map(Number)),
  )].filter((k) => k <= n).sort((a, b) => a - b);

  const out = [];
  for (const size of sizes) {
    for (const { slipType } of legalSlips(config, size)) {
      const exhaustive = nCk(n, size) <= maxSubsets;
      const candidates = exhaustive
        ? combinations(items, size)
        : [[...items].sort((a, b) => b.prob - a.prob).slice(0, size)];

      let best = null;
      for (const subset of candidates) {
        const ev = evForSlip({ config, slipType, legs: subset, stake });
        if (!best || ev.evPerUnit > best.evPerUnit) best = { ...ev, legs: subset };
      }
      out.push({
        ...best,
        // How the subset was chosen. An exhaustive answer is optimal; the
        // top-k fallback is a heuristic and must never be reported as if it
        // were the best available slip.
        selection: exhaustive ? 'exhaustive' : 'top-k-by-probability (heuristic — too many subsets to enumerate)',
        subsetsConsidered: candidates.length,
      });
    }
  }
  // Best EV per unit staked first. Ties broken by the smaller slip, because two
  // slips with the same edge are not equally good — fewer legs is less variance
  // and, under TODO(correlation), less exposure to the assumption being wrong.
  return out.sort((a, b) => (b.evPerUnit - a.evPerUnit) || (a.legCount - b.legCount));
}

// ---------------------------------------------------------------------------
// The grid

/** The break-even grid as data, for anything that wants to render it itself. */
export function breakEvenGrid(config) {
  const rows = [];
  for (const type of SLIP_TYPES) {
    for (const countStr of Object.keys(config?.slip_types?.[type] || {}).sort((a, b) => a - b)) {
      const legCount = Number(countStr);
      const table = payoutTable(config, type, legCount);
      rows.push({
        slipType: type,
        legCount,
        table,
        topMultiplier: Math.max(...Object.values(table)),
        paysBelowTop: Object.keys(table).length > 1,
        breakEven: breakEven({ config, slipType: type, legCount }),
      });
    }
  }
  return rows;
}

/**
 * The whole grid as text, so it can be read at a glance.
 *
 * Returns a string rather than printing it. A module that writes to stdout
 * cannot be tested without capturing console, and cannot be used by anything
 * that wants the text somewhere other than a terminal — `console.log(report())`
 * is the caller's line to write, and it is the only I/O in the whole feature.
 */
export function breakEvenReport(config, { referenceProb = null } = {}) {
  const rows = breakEvenGrid(config);
  const pct = (x) => (x == null ? '   —   ' : `${(x * 100).toFixed(2)}%`.padStart(7));
  const lines = [];

  lines.push(`PAYOUT GRID — ${config.label || config.id}`);
  lines.push(`effective ${config.effective_date}${config.end_date ? ` to ${config.end_date}` : ' (current)'}`
    + `   jurisdiction: ${config.jurisdiction || 'default'}`);
  lines.push('');
  lines.push('  slip      legs   payouts (correct: x)                    break-even');
  lines.push('  ' + '-'.repeat(72));

  for (const r of rows) {
    const payouts = Object.keys(r.table).sort((a, b) => b - a)
      .map((k) => `${k}:${r.table[k]}x`).join('  ').padEnd(38);
    lines.push(`  ${r.slipType.padEnd(9)} ${String(r.legCount).padEnd(6)} ${payouts} ${pct(r.breakEven)}`);
  }

  if (referenceProb != null) {
    lines.push('');
    lines.push(`  At a per-leg ${(referenceProb * 100).toFixed(1)}%:`);
    lines.push('  ' + '-'.repeat(72));
    for (const r of rows) {
      const ev = evForSlip({ config, slipType: r.slipType, probs: new Array(r.legCount).fill(referenceProb) });
      const edge = referenceProb - r.breakEven;
      lines.push(`  ${r.slipType.padEnd(9)} ${String(r.legCount).padEnd(6)} `
        + `EV ${(ev.evPerUnit >= 0 ? '+' : '')}${(ev.evPerUnit * 100).toFixed(1)}%`.padEnd(16)
        + `all-hit ${(ev.probAllHit * 100).toFixed(1)}%`.padEnd(17)
        + `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(2)}pts vs break-even`);
    }
  }

  lines.push('');
  lines.push('  Every number above assumes the legs are INDEPENDENT. They are not — see');
  lines.push('  TODO(correlation) in payout-engine.js. Power is understated on correlated');
  lines.push('  legs and Flex is overstated, so the ranking between them is directional.');
  return lines.join('\n');
}

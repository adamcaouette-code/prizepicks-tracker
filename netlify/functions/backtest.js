// netlify/functions/backtest.js
//
// Walk-forward backtest with point-in-time discipline.
//
// ===========================================================================
// THIS TOOL IS BUILT TO SAY NO
//
// The brief: "I would rather this tool tell me I have no edge than flatter me.
// Bias every ambiguous decision toward pessimism and note where you did so."
//
// Every such decision is listed in `pessimism` on the result, with what was
// chosen and what the flattering alternative would have been. They are not
// buried in comments — they are output, because a reader deciding whether to
// believe an ROI needs to know which thumb was on which scale.
//
//   unresolved outcomes     COUNTED AS LOSSES, not excluded. Excluding them
//                           assumes an ungraded prop would have gone like the
//                           graded ones, and ungradeable props are not a random
//                           sample — they are DNPs, voids and name mismatches,
//                           which skew toward the messy end of the board.
//   ambiguous availability  the prop is NOT bet. A prop whose presence at the
//                           decision timestamp cannot be established is a prop
//                           you cannot prove you could have taken.
//   two payout tables       the one that PAYS LESS is used.
//   stake rounding          DOWN, always, to the cent.
//   missing closing line    excluded from CLV and the exclusion is counted, so
//                           a CLV computed on a third of the slips cannot be
//                           read as a CLV on all of them.
//   the headline number     the LOWER bound of the ROI interval is printed
//                           beside the point estimate, every time.
//
// ---------------------------------------------------------------------------
// WALK-FORWARD, AND NO REFITTING
//
// Fit on a training window, evaluate on the next untouched window, roll. The
// strategy is handed a `fit` object built ONLY from the training window, and
// the evaluation window's outcomes are read after it has committed. A strategy
// that wanted to refit on evaluation data would have to be given evaluation
// outcomes, and there is no argument through which it could receive them.
// ===========================================================================

import { PointInTimeStore, sandbox, LeakError } from './point-in-time.js';
import { configFor, evForSlip, breakEven, payoutTable, kellyStake } from './payout-engine.js';
import { rng } from './copula.js';

const iso = (d) => new Date(d).toISOString();
const day = (d) => iso(d).slice(0, 10);

// ---------------------------------------------------------------------------
// 1. Windows

/**
 * Walk-forward folds over a span.
 *
 * The first fold's training window starts at the beginning of the data, and
 * every evaluation window is disjoint from every training window that precedes
 * a later fold. `anchored: false` (the default) rolls the training window
 * forward too; `anchored: true` grows it from a fixed start.
 */
export function walkForwardWindows({ from, to, trainDays = 28, testDays = 7, anchored = false }) {
  const start = Date.parse(from), end = Date.parse(to);
  const D = 86400000;
  const out = [];
  let trainStart = start;
  let trainEnd = start + trainDays * D;
  while (trainEnd + testDays * D <= end + 1) {
    out.push({
      index: out.length,
      train: { from: iso(anchored ? start : trainStart), to: iso(trainEnd) },
      test: { from: iso(trainEnd), to: iso(trainEnd + testDays * D) },
    });
    trainStart += testDays * D;
    trainEnd += testDays * D;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Metrics

/** Mean squared error of the leg probabilities against their outcomes. */
export function brier(legs) {
  const use = legs.filter((l) => l.prob != null && (l.hit === true || l.hit === false));
  if (!use.length) return null;
  return use.reduce((s, l) => s + (l.prob - (l.hit ? 1 : 0)) ** 2, 0) / use.length;
}

/** Largest peak-to-trough fall along a bankroll path, as a fraction. */
export function maxDrawdown(path) {
  let peak = -Infinity, worst = 0;
  for (const v of path) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

/**
 * A bootstrap interval for ROI.
 *
 * Resampled over SLIPS rather than a normal approximation on the mean, because
 * slip returns are wildly skewed — a 6-leg Power is zero most of the time and
 * 37.5x occasionally, and a normal interval on that is meaningless at the
 * sample sizes this will ever have. Seeded, so an ROI does not move between
 * runs for reasons unrelated to the data.
 */
export function roiInterval(slips, { draws = 2000, alpha = 0.05, seed = 20260910 } = {}) {
  const n = slips.length;
  if (n < 2) return { lo: null, hi: null, n, reason: 'fewer than two slips' };
  const random = rng(seed);
  const rois = [];
  for (let d = 0; d < draws; d++) {
    let staked = 0, returned = 0;
    for (let i = 0; i < n; i++) {
      const s = slips[Math.floor(random() * n)];
      staked += s.stake; returned += s.returned;
    }
    rois.push(staked > 0 ? (returned - staked) / staked : 0);
  }
  rois.sort((a, b) => a - b);
  const at = (q) => rois[Math.min(rois.length - 1, Math.max(0, Math.floor(q * rois.length)))];
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2), n, draws };
}

// ---------------------------------------------------------------------------
// 3. The engine

/**
 * Run a walk-forward backtest.
 *
 * `strategy(view, ctx)` receives a point-in-time view and a context carrying
 * `fit` (built from the training window only), `asOf`, `bankroll` and the
 * payout config in force on that date. It returns slips:
 *
 *   { legs: [{ id, prob, side }], slipType, stake? }
 *
 * `stake` is advisory — the engine applies the bankroll rules and will lower it.
 */
export async function backtest({
  store,
  strategy,
  fitter = null,
  payoutConfigs,
  from = null,
  to = null,
  trainDays = 28,
  testDays = 7,
  anchored = false,
  bankroll = 1000,
  rules = {},
  closingProbFor = null,
  countUnresolvedAsLoss = true,
  seed = 20260910,
}) {
  if (!(store instanceof PointInTimeStore)) {
    throw new LeakError('backtest needs a PointInTimeStore — a plain array has no ingestion times to filter on');
  }
  const span = store.span();
  const windows = walkForwardWindows({
    from: from || span.from, to: to || span.to, trainDays, testDays, anchored,
  });

  const run = sandbox(strategy);
  const pessimism = [];
  const note = (what, chose, flattering) => {
    if (!pessimism.some((p) => p.what === what)) pessimism.push({ what, chose, flattering_alternative: flattering });
  };

  const results = [];
  let bank = bankroll;
  const bankPath = [bank];
  let unresolvedLegs = 0, clvMissing = 0;

  for (const w of windows) {
    // ---- FIT, on the training window only -------------------------------
    //
    // The fitter is handed a view bound to the END of the training window. It
    // cannot see the evaluation window because that window has not happened at
    // that timestamp, which is a fact about the view rather than a rule the
    // fitter is asked to respect.
    const fit = fitter ? await fitter(store.asOf(w.train.to), { window: w }) : null;

    // ---- EVALUATE, day by day across the untouched window ----------------
    const slips = [];
    const legRows = [];
    let staked = 0, returned = 0;
    const windowPath = [bank];

    const days = [];
    for (let t = Date.parse(w.test.from); t < Date.parse(w.test.to); t += 86400000) days.push(t);

    for (const t of days) {
      const asOf = iso(t);
      const view = store.asOf(asOf);
      const config = configFor(payoutConfigs, day(t));
      if (!config) continue;

      let proposed = [];
      try {
        proposed = (await run(view, Object.freeze({
          fit, asOf, bankroll: bank, config, day: day(t),
        }))) || [];
      } catch (e) {
        if (e instanceof LeakError) throw e;      // never swallow a leak
        continue;
      }

      // Every leg must be a prop the VIEW could see. A strategy that returned
      // an id it could not have known is caught here rather than silently
      // priced — which is the last line of defence behind the store itself.
      const visible = new Set(view.props().map((p) => p.id));

      let slateStake = 0;
      for (const slip of proposed) {
        const legs = slip.legs || [];
        if (!legs.length) continue;
        const unseen = legs.find((l) => !visible.has(l.id));
        if (unseen) {
          throw new LeakError(
            `the strategy proposed prop "${unseen.id}" on ${asOf}, which was not visible in the point-in-time view`,
          );
        }
        // AMBIGUOUS AVAILABILITY IS A SKIP. A prop whose row does not say it was
        // on the board at this instant is one you cannot prove you could have
        // taken, so it is not bet.
        const rows = legs.map((l) => view.get(l.id));
        if (rows.some((r) => !r || r.available === false)) {
          note('a prop whose availability at the timestamp was not established',
            'the slip was skipped', 'betting it anyway and counting the result');
          continue;
        }

        const table = payoutTable(config, slip.slipType, legs.length);
        if (!table) continue;

        const stake = sizeStake({ slip, legs, config, bank, rules, slateStake, note });
        if (!(stake > 0)) continue;
        slateStake += stake;

        // ---- settle -------------------------------------------------------
        //
        // BETTING A SETTLED EVENT IS A LEAK, and it is the one the point-in-time
        // store cannot catch on its own. A row about yesterday's game can be
        // perfectly visible today — it WAS knowable — and a strategy that takes
        // it is betting on a result that already exists. The store filters
        // ingestion time, which is right; this filters RESOLUTION time, which is
        // the other half.
        //
        // Found by the leakage test in the suite: the cheating strategy went
        // 100% through a store that was behaving exactly as designed, because it
        // was betting games that had already finished.
        for (const l of legs) {
          const o0 = store.outcomeFor(l.id);
          if (o0 && Date.parse(o0.resolved_at) <= Date.parse(asOf)) {
            throw new LeakError(
              `the strategy proposed prop "${l.id}" on ${asOf}, but its outcome had already resolved at `
              + `${o0.resolved_at} — that is a bet on a known result`,
            );
          }
        }

        let correct = 0, resolvedAll = true;
        for (const l of legs) {
          const o = store.outcomeFor(l.id);
          const row = view.get(l.id);
          let hit = null;
          if (o && (o.hit === true || o.hit === false)) {
            hit = String(l.side || 'over').toLowerCase() === 'under' ? !o.hit : o.hit;
          }
          if (hit === null) {
            resolvedAll = false;
            unresolvedLegs++;
            // UNRESOLVED IS A LOSS, not an exclusion. See the header.
            note('a leg whose outcome never resolved',
              countUnresolvedAsLoss ? 'counted as a loss' : 'excluded from the result',
              'excluding it, which assumes it would have gone like the graded ones');
            if (!countUnresolvedAsLoss) { resolvedAll = false; }
          }
          if (hit === true) correct++;
          legRows.push({ id: l.id, prob: l.prob ?? null, hit, side: l.side || 'over', line: row?.line ?? null });
        }

        const mult = (table[String(correct)] || 0);
        const back = stake * mult;
        staked += stake; returned += back;
        bank = bank - stake + back;
        windowPath.push(bank); bankPath.push(bank);

        // ---- CLV -----------------------------------------------------------
        let clv = null;
        if (closingProbFor) {
          const deltas = [];
          for (const l of legs) {
            const closing = closingProbFor(l.id);
            if (closing == null || l.prob == null) { clvMissing++; continue; }
            deltas.push(closing - l.prob);
          }
          if (deltas.length === legs.length) clv = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          else {
            note('a slip with no closing line for every leg',
              'excluded from CLV entirely and counted', 'averaging the legs that did have one');
          }
        }

        slips.push({
          asOf, slipType: slip.slipType, legCount: legs.length,
          stake, returned: back, correct, mult, clv, resolvedAll,
          perLegBreakEven: breakEven({ config, slipType: slip.slipType, legCount: legs.length, legs: rows }),
          configId: config.id,
        });
      }
    }

    results.push(scoreWindow(w, slips, legRows, windowPath, { seed }));
  }

  const allSlips = results.flatMap((r) => r._slips);
  const overall = summarise(allSlips, results.flatMap((r) => r._legs), bankPath, { seed });

  return {
    windows: results.map(({ _slips, _legs, ...rest }) => rest),
    overall,
    bankroll: { start: bankroll, end: bank, path: bankPath.length },
    span,
    folds: windows.length,
    settings: { trainDays, testDays, anchored, countUnresolvedAsLoss, rules },
    counts: { slips: allSlips.length, unresolvedLegs, clvMissingLegs: clvMissing },
    // Every thumb, and which way it pressed.
    pessimism,
  };
}

/** Bankroll rules — requirement 6's "cap stakes at my real bankroll rules". */
function sizeStake({ slip, legs, config, bank, rules, slateStake, note }) {
  const min = rules.min_stake ?? 5;
  const maxPct = rules.max_pct_of_bankroll ?? 0.05;
  const maxSlate = rules.max_slate_stake ?? Infinity;

  let stake = slip.stake;
  if (stake == null) {
    const ev = evForSlip({ config, slipType: slip.slipType, probs: legs.map((l) => l.prob), legs });
    const k = kellyStake(ev, { bankroll: bank, multiplier: rules.kelly_multiplier ?? 0.25 });
    stake = k.stake;
  }
  stake = Math.min(stake, bank * maxPct, Math.max(0, maxSlate - slateStake));
  // ROUNDED DOWN, always. Rounding to nearest would let a run of slips each
  // gain half a cent of stake it was never sized for.
  stake = Math.floor(stake * 100) / 100;
  if (stake < min) {
    note('a stake below the $5 minimum', 'the slip was not bet at all', 'rounding it up to the minimum');
    return 0;
  }
  if (stake > bank) return 0;
  return stake;
}

function scoreWindow(w, slips, legs, path, { seed }) {
  const s = summarise(slips, legs, path, { seed });
  return { index: w.index, train: w.train, test: w.test, ...s, _slips: slips, _legs: legs };
}

function summarise(slips, legs, path, { seed }) {
  const staked = slips.reduce((a, b) => a + b.stake, 0);
  const returned = slips.reduce((a, b) => a + b.returned, 0);
  const roi = staked > 0 ? (returned - staked) / staked : null;
  const ci = roiInterval(slips, { seed });

  const graded = legs.filter((l) => l.hit === true || l.hit === false);
  const hitRate = graded.length ? graded.filter((l) => l.hit).length / graded.length : null;
  // The bar those legs actually had to clear, weighted by how many legs each
  // slip contributed — a 6-leg slip's break-even applies to six legs.
  const barSum = slips.reduce((a, b) => a + (b.perLegBreakEven ?? 0) * b.legCount, 0);
  const barLegs = slips.reduce((a, b) => a + (b.perLegBreakEven == null ? 0 : b.legCount), 0);
  const requiredHitRate = barLegs ? barSum / barLegs : null;

  const clvs = slips.map((s2) => s2.clv).filter((v) => v != null);

  return {
    slips: slips.length,
    staked: round2(staked),
    returned: round2(returned),
    roi,
    roiCI: ci,
    // THE NUMBER TO READ FIRST. A positive point estimate whose interval spans
    // zero has not shown anything.
    indistinguishableFromNoise: ci.lo == null ? null : (ci.lo <= 0 && ci.hi >= 0),
    hitRate,
    requiredHitRate,
    hitRateEdge: hitRate != null && requiredHitRate != null ? hitRate - requiredHitRate : null,
    brier: brier(legs),
    clv: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
    clvCoverage: slips.length ? clvs.length / slips.length : null,
    maxDrawdown: maxDrawdown(path),
    legs: legs.length,
    gradedLegs: graded.length,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// 4. Rendering — requirement 5's wording, at the top, before any ROI

export function renderBacktest(r, { width = 78 } = {}) {
  const L = [];
  const pct = (v, d = 2) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
  L.push('═'.repeat(width));
  L.push('BACKTEST — WALK-FORWARD, POINT-IN-TIME');
  L.push('═'.repeat(width));

  const o = r.overall;

  // ---- THE VERDICT, BEFORE ANY ROI NUMBER --------------------------------
  L.push('');
  if (!o.slips) {
    L.push('┌' + '─'.repeat(width - 2) + '┐');
    L.push('│ NO SLIPS WERE BET' + ' '.repeat(width - 20) + '│');
    L.push('│ Nothing to measure. This is not a zero result, it is an absent one.'
      + ' '.repeat(Math.max(0, width - 70)) + '│');
    L.push('└' + '─'.repeat(width - 2) + '┘');
  } else if (o.indistinguishableFromNoise) {
    L.push('┌' + '─'.repeat(width - 2) + '┐');
    L.push('│ ⚠  THE RESULT IS INDISTINGUISHABLE FROM NOISE' + ' '.repeat(Math.max(0, width - 48)) + '│');
    L.push('│' + ' '.repeat(width - 2) + '│');
    L.push(`│ The 95% interval on ROI runs from ${pct(o.roiCI.lo)} to ${pct(o.roiCI.hi)} and contains zero.`
      .padEnd(width - 1) + '│');
    L.push(`│ On ${o.slips} slips, nothing here separates this strategy from a coin.`
      .padEnd(width - 1) + '│');
    L.push('└' + '─'.repeat(width - 2) + '┘');
  } else if (o.roiCI.hi < 0) {
    L.push('┌' + '─'.repeat(width - 2) + '┐');
    L.push('│ ⛔  THE STRATEGY LOST MONEY, AND THE INTERVAL AGREES' + ' '.repeat(Math.max(0, width - 54)) + '│');
    L.push(`│ 95% interval ${pct(o.roiCI.lo)} to ${pct(o.roiCI.hi)}, entirely below zero.`.padEnd(width - 1) + '│');
    L.push('└' + '─'.repeat(width - 2) + '┘');
  } else {
    L.push(`✓ ROI ${pct(o.roi)}, 95% interval ${pct(o.roiCI.lo)} to ${pct(o.roiCI.hi)} — above zero on ${o.slips} slips.`);
  }

  L.push('');
  L.push(`  sample achieved:  ${o.slips} slips · ${o.gradedLegs} graded legs · ${r.folds} walk-forward folds`);
  L.push(`  ROI              ${pct(o.roi)}   [${pct(o.roiCI.lo)}, ${pct(o.roiCI.hi)}]`);
  L.push(`  hit rate         ${pct(o.hitRate)} against a ${pct(o.requiredHitRate)} break-even `
    + `(${o.hitRateEdge == null ? '—' : `${o.hitRateEdge > 0 ? '+' : ''}${(o.hitRateEdge * 100).toFixed(2)}pp`})`);
  L.push(`  Brier            ${o.brier == null ? '—' : o.brier.toFixed(4)}`);
  L.push(`  CLV              ${o.clv == null ? '—' : `${(o.clv * 100).toFixed(2)}pp`} `
    + `(on ${pct(o.clvCoverage, 0)} of slips)`);
  L.push(`  max drawdown     ${pct(o.maxDrawdown)}`);
  L.push(`  bankroll         ${r.bankroll.start} → ${round2(r.bankroll.end)}`);

  L.push('');
  L.push('─'.repeat(width));
  L.push('PER WINDOW');
  L.push('─'.repeat(width));
  L.push(`  ${'test window'.padEnd(24)}${'slips'.padStart(6)}${'ROI'.padStart(9)}${'hit'.padStart(8)}`
    + `${'need'.padStart(8)}${'brier'.padStart(8)}${'CLV'.padStart(8)}${'dd'.padStart(7)}`);
  for (const w of r.windows) {
    L.push(`  ${`${day(w.test.from)}→${day(w.test.to)}`.padEnd(24)}${String(w.slips).padStart(6)}`
      + `${pct(w.roi, 1).padStart(9)}${pct(w.hitRate, 1).padStart(8)}${pct(w.requiredHitRate, 1).padStart(8)}`
      + `${(w.brier == null ? '—' : w.brier.toFixed(3)).padStart(8)}`
      + `${(w.clv == null ? '—' : `${(w.clv * 100).toFixed(1)}`).padStart(8)}`
      + `${pct(w.maxDrawdown, 0).padStart(7)}`);
  }

  // ---- where the thumb was ------------------------------------------------
  L.push('');
  L.push('─'.repeat(width));
  L.push('WHERE THIS WAS BIASED TOWARD PESSIMISM');
  L.push('─'.repeat(width));
  if (!r.pessimism.length) {
    L.push('  No ambiguous case arose in this run.');
  } else {
    for (const p of r.pessimism) {
      L.push(`  • ${p.what}`);
      L.push(`      chose: ${p.chose}`);
      L.push(`      the flattering alternative would have been: ${p.flattering_alternative}`);
    }
  }
  L.push('');
  L.push(`  ${r.counts.unresolvedLegs} leg(s) never resolved · `
    + `${r.counts.clvMissingLegs} leg(s) had no closing line`);
  L.push('');
  L.push('═'.repeat(width));
  return L.join('\n');
}

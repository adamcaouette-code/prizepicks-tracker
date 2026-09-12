// netlify/functions/calibration.js
//
// Reads the graded pick log and answers the only question that matters: when the
// engine says 65%, does it actually hit ~65%? Computes calibration bands (predicted
// vs actual), a Brier score, play/lean win rate, and breakdowns by tier and league.
//
// View:  https://atombets.netlify.app/api/calibration
// JSON:  https://atombets.netlify.app/api/calibration?format=json
// Filter: ?league=mlb   ?days=30

import { getStore } from '@netlify/blobs';
// Judge models the user has named. Reports read in those names rather than in
// model ids, the same way the prompt versions do.
import { modelName } from './bet-finder-background.js';

const isGraded = (p) => p.hit === true || p.hit === false;
const isCombo = (p) => /combo/i.test(p.stat || '') || /\s\+\s/.test(p.player || '');

// Re-running the engine on a day appends the same picks again, so the log holds
// duplicates. Collapse by projectionId (falling back to a content key), preferring
// the graded copy, so each distinct pick is counted exactly once.
export function dedupe(picks) {
  const m = new Map();
  for (const p of picks) {
    // Source AND judge config are part of the identity: the same projection can
    // be predicted by the board engine and again by the slip judge, or by two
    // different judge versions or models on the same slate. Those are separate
    // forecasts and every one of them deserves to be scored — collapsing them
    // would throw away exactly the comparison the versioning exists to make.
    const key = [
      p.source || 'board', p.promptVersion || '', p.judgeModel || '',
      p.projectionId || `${p.date}|${p.player}|${p.stat}|${p.line}`,
    ].join('|');
    const prev = m.get(key);
    if (!prev) { m.set(key, p); continue; }
    if (isGraded(p) && !isGraded(prev)) m.set(key, p); // prefer a graded copy
  }
  return [...m.values()];
}

// `perLeague` is off for the recursive call so a league's own summary doesn't
// try to split itself again.
// Leagues kept out of the record entirely.
//
// The World Cup runs once every four years. A handful of picks from one
// tournament tell you nothing about how the engine will perform on a slate you
// can actually bet, and they will not be refreshed for years — so leaving them
// in only drags the overall number around for no informational gain. That is
// different from a league performing badly: a bad league is a finding worth
// keeping, a dormant one is noise.
//
// Excluded here rather than only deleted from the log, so a future tournament
// does not silently start counting again without a decision being made.
export const EXCLUDED_LEAGUES = new Set(['world_cup', 'fifa_world_cup']);

const isExcluded = (p) => EXCLUDED_LEAGUES.has(String(p.league || '').toLowerCase());

// THE STANDING DEFAULT ENGINE. See docs/judge-measurement.md, "Vilifiant-only
// scoping" — every headline figure, tier table, guardrail split, band and
// baseline on this page defaults to rows this model produced, refit on exactly
// those rows. A pooled figure that mixes Vilifiant with retired models (Psyche's
// Opus runs, Sonnet experiments) is not a measurement of the engine in use; it
// is an average of four different engines that happen to share a page.
//
// "model" is one of the standing constraints in judge-measurement.md — this is
// a deliberate scoping change to how the page REPORTS, not a change to
// selection, sizing, tier weighting, or any prompt, and it does not touch which
// model actually judges a run.
const CURRENT_ENGINE = 'Vilifiant';
const isLegacyRow = (p) => modelName(p.judgeModel) !== CURRENT_ENGINE;

/**
 * What a three-row lookup table would have scored on these same picks.
 *
 * The predictor is: output the tier's own base rate for every pick in that tier,
 * and nothing else — no player, no matchup, no model. It is the cheapest thing
 * that could possibly work, and it is the bar the judge has to clear to justify
 * existing at all. Until this number is on the page there is nothing for a
 * change to beat, only a Brier score with no scale attached to it.
 *
 * When a predictor outputs exactly the empirical rate p of the rows it is scored
 * on, its Brier collapses to p(1-p) — the misses contribute p² at weight (1-p),
 * the hits (1-p)² at weight p, and the two sum to p(1-p). So this is the
 * count-weighted mean of p(1-p) across tiers, computed directly rather than by
 * summing squared errors, which also makes it obvious that the baseline is
 * exactly the variance the tier alone cannot explain.
 *
 * Fitted on the rows being scored, deliberately. That hands the baseline the
 * benefit of hindsight on those exact picks and makes it HARDER to beat, which
 * is the right direction for a bar the judge is supposed to clear.
 */
// Below this a tier's rate is noise. The gate is PER TIER, not per config,
// because the baseline is fitted per tier: a config with 40 rows split 30/5/5
// would clear a config-level gate and then fit two tier baselines on five picks
// each, where h(n-h) collapses toward zero and nothing could beat them.
const BASELINE_MIN_TIER_N = 10;

/**
 * What a three-row lookup table would have scored on these same picks.
 *
 * The predictor is: output the tier's own base rate for every pick in that tier,
 * and nothing else — no player, no matchup, no model. It is the cheapest thing
 * that could possibly work, and the bar the judge must clear to justify existing.
 * Without it a Brier score has no scale: 0.240 means nothing on its own.
 *
 * LEAVE-ONE-OUT. Fitting the rate on all the rows and then scoring it against
 * those same rows lets the baseline predict outcomes it has already seen. The
 * optimism is small here — about 0.0003 Brier, ~1% of the current gap — but it
 * is a real objection and the exact fix is cheap, so each pick is predicted by
 * its tier's rate computed EXCLUDING that pick: (h - y_i) / (n - 1).
 *
 * That has a closed form. For a tier with n picks and h hits:
 *   a hit  predicts (h-1)/(n-1), squared error (n-h)^2/(n-1)^2, occurring h times
 *   a miss predicts  h/(n-1),    squared error     h^2/(n-1)^2, occurring (n-h) times
 *   total = [h(n-h)^2 + (n-h)h^2] / (n-1)^2 = h(n-h)·n / (n-1)^2
 *   mean  = h(n-h) / (n-1)^2
 * which is exactly the in-sample p(1-p) scaled by (n/(n-1))^2 — the optimism,
 * made explicit rather than argued about.
 *
 * Tiers under the gate are dropped from BOTH sides: the judge is re-scored on
 * precisely the rows the baseline covers, so the delta compares like with like
 * rather than two different row sets.
 */
function tierBaseline(rows) {
  const byTier = {};
  for (const p of rows) {
    const b = (byTier[p.oddsType || 'unknown'] ||= { n: 0, hits: 0, judge: 0 });
    b.n++;
    if (p.hit === true) b.hits++;
    const prob = Number(p.prob) || 0;
    b.judge += (prob - (p.hit === true ? 1 : 0)) ** 2;
  }
  let loo = 0, inSample = 0, judge = 0, covered = 0;
  for (const b of Object.values(byTier)) {
    if (b.n < BASELINE_MIN_TIER_N) continue;          // see the gate note above
    const rate = b.hits / b.n;
    loo += b.n * (b.hits * (b.n - b.hits)) / ((b.n - 1) ** 2);
    inSample += b.n * rate * (1 - rate);
    judge += b.judge;
    covered += b.n;
  }
  if (!covered) return null;
  return {
    baseline: loo / covered,
    inSample: inSample / covered,
    judgeBrier: judge / covered,
    covered,
    dropped: rows.length - covered,
  };
}

/** Attach baseline, delta and verdict to any scored bucket. */
function scoreAgainstBaseline(target, rows) {
  const r = tierBaseline(rows);
  if (!r) {
    target.baseline = null; target.baselineInSample = null;
    target.baselineDelta = null; target.beatsBaseline = null;
    target.baselineCoverage = 0;
    return target;
  }
  target.baseline = r.baseline;
  // Kept for comparison: the difference between these two IS the hindsight the
  // in-sample version was getting.
  target.baselineInSample = r.inSample;
  target.baselineCoverage = r.covered;
  target.baselineDropped = r.dropped;
  // Judge re-scored on exactly the covered rows, so this is like-for-like.
  target.brierOnBaselineRows = r.judgeBrier;
  // Brier is a loss, so a POSITIVE delta means the judge lost to a lookup table.
  target.baselineDelta = Math.round((r.judgeBrier - r.baseline) * 10000) / 10000;
  target.beatsBaseline = target.baselineDelta < 0;
  return target;
}

// Per-leg hit rate a pure-tier 3-pick Power needs to return the stake, from the
// real payout tables: goblin 2.0x, standard 4.75x, demon 12.0x. Three legs is the
// reference because the ORDERING between tiers holds at every size.
const BREAK_EVEN = { goblin: 2.0 ** (-1 / 3), standard: 4.75 ** (-1 / 3), demon: 12.0 ** (-1 / 3) };

/**
 * A scored bucket that also tracks what its picks NEEDED to hit. A raw win rate
 * is unreadable across tiers — 67% is a disaster on goblins and a fortune on
 * demons — so every bucket carries the sum of its own break-evens alongside its
 * hits, and `scoreBucket` turns the pair into the only number that means the
 * same thing everywhere: how far above or below its own bar it landed.
 */
const newBucket = () => ({ n: 0, hits: 0, beSum: 0, priced: 0, brierSum: 0, predSum: 0 });

function addToBucket(b, hit, prob, be) {
  b.n++; b.hits += hit;
  b.brierSum += (prob - hit) ** 2; b.predSum += prob;
  if (be != null) { b.beSum += be; b.priced++; }
}

function scoreBucket(b) {
  if (!b.n) return { n: 0, rate: null, needed: null, deltaPP: null, sigma: null, ev: null, brier: null };
  const rate = b.hits / b.n;
  const needed = b.priced ? b.beSum / b.priced : null;
  // Under the null "these picks hit exactly their break-even", the count of hits
  // is Binomial(n, needed) — so the standard error is that of the NULL, not of
  // the observed rate. Using the observed rate here would make a 0-for-40 run
  // look infinitely significant.
  const se = needed == null ? null : Math.sqrt((needed * (1 - needed)) / b.n);
  return {
    n: b.n, hits: b.hits, rate,
    needed,
    deltaPP: needed == null ? null : (rate - needed) * 100,
    sigma: se ? (rate - needed) / se : null,
    // A 3-leg power play built entirely out of this bucket. Break-even is
    // defined as payout^(-1/3), so (rate / needed)^3 - 1 is that slip's return
    // per dollar under the assumption legs are independent — which they are not
    // exactly, but the sign and the order of magnitude survive it.
    ev: needed ? (rate / needed) ** 3 - 1 : null,
    brier: b.brierSum / b.n,
    predicted: b.predSum / b.n,
  };
}

/**
 * The edge on the side that was actually recommended, reconstructed for rows
 * logged before `edge` existed as a field.
 *
 * Rows carrying a real `edge` use it. For the rest: `prob` is P(over) by a
 * convention the entire log rests on, and before sides existed every
 * recommendation WAS the over — so subtracting the tier's break-even gives the
 * exact number the field would have held. An under on a goblin or demon line is
 * the one case that stays null rather than being guessed: PrizePicks' odds_type
 * describes the over's payout only, so that side's break-even is genuinely
 * unknown and pretending otherwise would invent the very quantity being tested.
 */
function edgeOfRow(p) {
  if (p.edge != null && isFinite(Number(p.edge))) return Number(p.edge);
  if (p.side && p.side !== 'over') return null;
  const be = BREAK_EVEN[p.oddsType];
  const prob = Number(p.prob);
  return be == null || !isFinite(prob) ? null : prob - be;
}
// A hit rate on nine picks is not evidence. Printed beside a break-even it
// invites precisely the conclusion the sample cannot support, so thin cells are
// suppressed rather than rendered.
const MIN_SLICE_N = 20;

/**
 * Area under the ROC curve: the probability that a randomly chosen hit is ranked
 * above a randomly chosen miss. 0.5 is a coin flip, 1.0 is perfect ordering.
 *
 * This is the honest measure of a ranking, and `lift` is not. A median half-split
 * throws away everything except which side of the middle each pick fell on — at
 * n=200 that is most of the information, and the standard error balloons
 * accordingly. AUC uses every pairwise comparison, so it sees the same data with
 * far more power. `lift` is kept beside it for continuity and because it is the
 * easier number to explain.
 *
 * Computed by rank-sum with MIDRANKS, so a tie between a hit and a miss counts
 * half — which is exactly what a tie is worth to a ranking that has to choose.
 */
function aucOf(rows) {
  const pos = [], neg = [];
  for (const p of rows) (p.hit === true ? pos : neg).push(Number(p.prob) || 0);
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map((v) => ({ v, y: 1 })), ...neg.map((v) => ({ v, y: 0 }))]
    .sort((a, b) => a.v - b.v);
  let i = 0, rankSum = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const mid = (i + j) / 2 + 1;                      // 1-based midrank
    for (let k = i; k <= j; k++) if (all[k].y === 1) rankSum += mid;
    i = j + 1;
  }
  const A = (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
  // Hanley & McNeil: without an interval an AUC of 0.54 reads as skill when it
  // is usually noise.
  const q1 = A / (2 - A), q2 = (2 * A * A) / (1 + A);
  const se = Math.sqrt(Math.max(0,
    (A * (1 - A) + (pos.length - 1) * (q1 - A * A) + (neg.length - 1) * (q2 - A * A))
    / (pos.length * neg.length)));
  return { auc: A, se, pos: pos.length, neg: neg.length };
}

/**
 * Within-tier skill: does the judge's own ranking separate its good picks from
 * its bad ones INSIDE a single tier?
 *
 * Extracted so it can be run on a subset — the same question asked of the props
 * the judge had form for, and of the props it did not, is the only way to tell a
 * judge that cannot reason from what it was given apart from one that was given
 * nothing to reason from.
 */
function computeSkill(graded) {
  const out = {};
  const tiers = new Set(graded.map((p) => p.oddsType || 'unknown'));
  for (const tier of tiers) {
    const rows = graded.filter((p) => (p.oddsType || 'unknown') === tier)
      .sort((x, y) => (Number(y.prob) || 0) - (Number(x.prob) || 0));
    if (rows.length < 20) continue;              // a half of ten says nothing
    const half = Math.floor(rows.length / 2);
    const rate = (arr) => arr.filter((p) => p.hit === true).length / arr.length;
    const top = rows.slice(0, half), bottom = rows.slice(-half);
    const base = rate(rows);
    const be = BREAK_EVEN[tier] ?? null;
    const a = aucOf(rows);
    // Standard error of the difference of two independent proportions, each on
    // half the tier. Without it a -2.0pt lift on 402 picks reads as an inversion
    // when its own interval is +-4.6 and it cannot be told from zero.
    const pt = rate(top), pb = rate(bottom);
    const liftSE = Math.sqrt((pt * (1 - pt)) / half + (pb * (1 - pb)) / half);
    out[tier] = {
      n: rows.length,
      topHalf: pt, bottomHalf: pb,
      liftSE,
      // AUC over every pairwise comparison rather than a median split — same
      // data, far more power. See aucOf.
      auc: a ? a.auc : null,
      aucSE: a ? a.se : null,
      // The whole answer in one number: how many points the judge's own ranking
      // separates the good half from the bad half, inside one tier.
      lift: rate(top) - rate(bottom),
      tierRate: base,
      breakEven: be,
      // Betting every prop of this tier blind — the thing the engine has to beat
      // to be worth running at all.
      baselineClears: be == null ? null : base >= be,
      bestHalfClears: be == null ? null : rate(top) >= be,
      // THE SELECTION CURVE.
      //
      // bestHalfClears asks about the top 50% of a tier, and that is not a cut
      // anyone bets. Selection takes the top few of ~44 props, so a median split
      // on a genuinely skilled ranker averages the tail that gets wagered
      // together with the middle that never does — and can return "does not
      // clear break-even" as a false negative.
      //
      // Percentile slices over the pooled tier, and fixed top-N grouped BY RUN,
      // because the top 3 of a whole season's log is not a bet either: the
      // engine picks its best few from one slate at a time. Runs share a
      // loggedAt stamp, which is what makes them recoverable here.
      //
      // Cells under MIN_SLICE_N are suppressed rather than printed — a hit rate
      // on nine picks is not evidence about anything, and printed next to a
      // break-even it invites exactly the conclusion it cannot support.
      topSlices: [50, 25, 10, 5].map((pctile) => {
        const k = Math.floor(rows.length * (pctile / 100));
        if (k < MIN_SLICE_N) return { pctile, n: k, rate: null, clears: null };
        const r = rate(rows.slice(0, k));
        return { pctile, n: k, rate: r, clears: be == null ? null : r >= be };
      }),
      topN: [3, 5, 10].map((N) => {
        const byRun = {};
        for (const p of rows) (byRun[p.loggedAt || p.date || '?'] ||= []).push(p);
        const picked = [];
        for (const run of Object.values(byRun)) {
          picked.push(...run.sort((x, y) => (Number(y.prob) || 0) - (Number(x.prob) || 0)).slice(0, N));
        }
        if (picked.length < MIN_SLICE_N) return { N, runs: Object.keys(byRun).length, n: picked.length, rate: null, clears: null };
        const r = rate(picked);
        return { N, runs: Object.keys(byRun).length, n: picked.length, rate: r, clears: be == null ? null : r >= be };
      }),
    };
  }
  return out;
}

function aggregate(rawPicks, { perLeague = true } = {}) {
  const picks = dedupe(rawPicks).filter((p) => !isExcluded(p));
  const graded = picks.filter(isGraded);

  // Break down what is NOT graded, so a big "pending" number is honest instead of alarming.
  const ungradedPicks = picks.filter((p) => !isGraded(p));
  const combosN = ungradedPicks.filter((p) => p.ungradeable === 'combo' || isCombo(p)).length;
  const givenUpN = ungradedPicks.filter((p) => !isCombo(p) && (p.gradeAttempts || 0) >= 3).length;
  const gradeableN = ungradedPicks.length - combosN - givenUpN;
  // pending gradeable, grouped by date (the newest date is usually today's in-progress slate)
  const pendingByDate = {};
  for (const p of ungradedPicks) {
    if (p.ungradeable === 'combo' || isCombo(p) || (p.gradeAttempts || 0) >= 3) continue;
    pendingByDate[p.date] = (pendingByDate[p.date] || 0) + 1;
  }

  const out = {
    logged: picks.length,
    graded: graded.length,
    pending: picks.length - graded.length,
    pendingGradeable: gradeableN,
    combos: combosN,
    givenUp: givenUpN,
    pendingByDate,
    overall: null,
    brier: null,
    bands: [],
    byTier: {},
    // Per PROP TYPE. The question this answers: is the engine systematically
    // wrong about a KIND of prop rather than about individual players?
    //
    // It is not obvious that it should be, because PrizePicks already prices
    // rarity into the tier — a home run "over 0.5" is rare, which is exactly why
    // it posts as standard or demon rather than goblin. So the tier ought to
    // absorb most of what "this prop type is unlikely" means, and any residual
    // here is signal the tier does NOT capture. That residual is the whole
    // reason to look.
    byStat: {},
    // Does the judge add anything BEYOND the tier?
    //
    // This is a different question from calibration, and the more important one.
    // Calibration asks "when it says 65%, does it hit 65%" — whether the numbers
    // are honest. This asks whether they are USEFUL: within a single tier, do
    // the props the judge rated highly actually hit more often than the ones it
    // rated low? If they do not, the judge is only re-reading the tier back to
    // us and the whole model is doing no work that a one-line rule could not.
    //
    // Split within tier rather than across it on purpose. Across all picks the
    // judge looks like it has signal, but almost all of that is just goblins
    // scoring above demons — which the tier already told us for free.
    skill: {},
    byLeague: {},
    bySource: {},                    // board engine vs slip judge, scored apart
    // The judge version that produced each probability — 'psyche' (the original)
    // or 'aphrodite' (the refinement). This is the whole point of naming them:
    // pooled, two forecasters produce one blended calibration curve that
    // describes neither, and a prompt change becomes impossible to evaluate.
    // Rows logged before versioning read as 'psyche (untagged)'.
    byPrompt: {},
    // The model that produced each probability, scored the same way as the
    // prompt version and for the same reason. The judge runs on Opus because it
    // always has, not because a cheaper model was tried and lost. This is what
    // turns that into a question with an answer — and at 2.5-5x less per run, a
    // cheaper model that scores the same is not a small saving, it is several
    // times more graded data for the same budget.
    byModel: {},
    // How the judge BEHAVED, measured on every logged pick whether it has been
    // graded or not.
    //
    // Everything else on this page waits for games to settle, which means weeks
    // before a prompt or model change can be judged. But most of what goes wrong
    // is visible the moment a run returns: a judge that ignores the payout tier,
    // or clusters every answer at 0.65, or stops filling in the fields it was
    // asked for, is already broken and no outcome is needed to see it.
    //
    // This matters most for the model question. The worry about a cheaper model
    // is that it follows a demanding prompt less faithfully — Aphrodite asks it
    // to anchor on the tier, count the last five, use the full range and return
    // strict JSON. Those are all checkable against zero graded picks, on the day.
    behaviour: {},
    // HOW CLOSE, not just whether.
    //
    // Grading is binary and must stay that way: PrizePicks pays the same nothing
    // for missing over 3.5 with 3 as for missing over 6.5 with 1, so a scoring
    // rule that rewarded being close would be scoring something nobody pays for.
    //
    // But those two misses say completely different things about the JUDGE. The
    // first was nearly right — the distribution sat right on the line and the
    // night broke the wrong way. The second was not remotely right; the model
    // did not understand the prop. Both land as hit=false with an identical
    // Brier penalty, and that identical penalty is throwing away the single most
    // informative thing in the log.
    //
    // It also carries far more statistical power than a coin flip does. 1,855
    // binary outcomes barely separate three tiers; 1,855 MARGINS estimate a whole
    // distribution per stat, which is what distinguishes variance from a broken
    // model — losing by 0.5 repeatedly is luck, losing by 5 repeatedly is not.
    //
    // Margins are never pooled raw across stats: a miss of 0.5 is everything on a
    // home-run line and nothing on a Fantasy Score line of 25. Each stat is
    // z-scored against its own spread before anything is combined.
    margins: {},
    plays: { n: 0, hits: 0 },        // verdict "play"
    playsLeans: { n: 0, hits: 0 },   // verdict "play" or "lean"
    // THE GUARDRAIL, MEASURED. v4.34.0 stopped the auto-slip taking a leg whose
    // own edge is negative — a bet the payout says loses even if the judge's
    // probability is exactly right. That change is only defensible if the legs
    // it refuses really do lose, so it has to be scoreable, and waiting for new
    // `edgeVerdict` rows to accumulate would take months.
    //
    // It doesn't have to wait. Edge is a function of the probability and the
    // tier, both of which every row in the log already carries, so the split can
    // be run over the entire graded history as a counterfactual: of everything
    // the engine has ever called a play or a lean, how did the ones the
    // guardrail would have KEPT do against the ones it would have REFUSED?
    guardrail: { kept: newBucket(), refused: newBucket(), unpriced: newBucket() },
    // The forward-looking version of the same split, on the field itself. Small
    // until the log fills, and deliberately separate from the counterfactual
    // above so a reconstruction is never mistaken for a measurement.
    byEdgeVerdict: {},
    // Stage 1 screen vs the individually re-judged deep dive (v4.33.0). The
    // question the deep dive was built to answer — does a second, undivided look
    // at a pick produce a better probability than the batch screen? — is a Brier
    // comparison between these two, and nothing else in this file could make it.
    byDeepDive: { shallow: newBucket(), deep: newBucket() },
    // The PAIRED version, and the only one that can actually settle the deep
    // dive's cost. Comparing deep rows to shallow rows compares two different
    // sets of picks, and not a fair pair — the deep set exists because the
    // screen liked it most, so any gap is confounded with that selection. Same
    // pick, same game, two probabilities is immune to it.
    deepPaired: { n: 0, shallowBrierSum: 0, deepBrierSum: 0, moveSum: 0, closer: 0, decided: 0 },
  };
  // Behaviour runs over ALL picks, not just graded ones — that is the whole
  // point of it. Keyed by version AND model, because "did the instruction land"
  // is a question about the pair.
  for (const p of picks) {
    const prob = Number(p.prob);
    if (!isFinite(prob)) continue;
    const key = `${p.promptVersion || 'psyche (untagged)'} · ${modelName(p.judgeModel)}`;
    const b = (out.behaviour[key] ||= {
      n: 0, sum: 0, sumSq: 0, round: 0, cleared: 0, distinct: new Map(),
      countBoth: 0, countAgree: 0, countOver: 0, countUnder: 0, countDriftSum: 0,
      byTier: {},
    });
    b.n++; b.sum += prob; b.sumSq += prob * prob;
    // A probability landing exactly on a multiple of 0.05 is weak evidence on
    // its own and strong in aggregate: it is what a model produces when it picks
    // a verdict first and writes a number to match.
    if (Math.abs(prob * 20 - Math.round(prob * 20)) < 1e-9) b.round++;
    if (p.cleared != null) b.cleared++;
    // COUNTING, SCORED. Both numbers have been logged since the mismatch was
    // first noticed — `cleared` computed from recent5, `judgeClearedClaim` as
    // the model reported it — expressly so disagreement would be "measurable
    // rather than silently overwritten". It was never actually measured. It
    // turned out the model agreed 47% of the time and OVERCOUNTED 34 to 5,
    // while the prompt told it to start its probability from that count.
    //
    // Since v4.38.0 the count is supplied instead of asked for, so this stops
    // measuring arithmetic and starts measuring compliance: a config that still
    // disagrees is one not reading the field it was handed.
    if (p.cleared != null && p.judgeClearedClaim != null) {
      b.countBoth++;
      const d = Number(p.judgeClearedClaim) - Number(p.cleared);
      if (d === 0) b.countAgree++;
      else if (d > 0) { b.countOver++; b.countDriftSum += d; }
      else { b.countUnder++; b.countDriftSum += d; }
    }
    b.distinct.set(prob.toFixed(2), (b.distinct.get(prob.toFixed(2)) || 0) + 1);
    const t = (b.byTier[p.oddsType || 'unknown'] ||= { n: 0, sum: 0 });
    t.n++; t.sum += prob;
  }
  for (const b of Object.values(out.behaviour)) {
    b.meanProb = b.sum / b.n;
    b.spread = Math.sqrt(Math.max(0, b.sumSq / b.n - b.meanProb ** 2));
    b.roundShare = b.round / b.n;
    b.clearedShare = b.cleared / b.n;
    b.countChecked = b.countBoth;
    b.countAgreeShare = b.countBoth ? b.countAgree / b.countBoth : null;
    // Signed, because the DIRECTION is the whole finding: miscounting scattered
    // both ways would be noise, and miscounting that runs one way is a bias
    // pointed at the over.
    b.countMeanDrift = b.countBoth ? b.countDriftSum / b.countBoth : null;
    b.countOverShare = b.countBoth ? b.countOver / b.countBoth : null;
    // distinct/n was NOT comparable across configs: it falls mechanically as n
    // grows, so a judge with more picks looks less granular for free. On this
    // log Vilifiant scored 0.246 (51 distinct over 207) against Opus's 0.483
    // (28 over 58) — the config using nearly twice as many distinct values
    // reading as half as granular, purely from sample size.
    //
    // Perplexity fixes that. It is 2^H over the frequencies of the distinct
    // values, and answers "how many values is this judge EFFECTIVELY using" —
    // a judge splitting evenly across 8 values scores 8 whether it made 50 picks
    // or 5,000, and one that nominally uses 51 values but puts most of its mass
    // on three scores near 3. The raw count rides along beside it, since a
    // count is only readable next to the n it came from.
    b.distinctValues = b.distinct.size;
    let H = 0;
    for (const c of b.distinct.values()) { const q = c / b.n; H -= q * Math.log2(q); }
    b.effectiveValues = Math.round(Math.pow(2, H) * 100) / 100;
    for (const t of Object.values(b.byTier)) t.meanProb = t.sum / t.n;
    // THE headline number. Aphrodite's central instruction is that a goblin line
    // is priced as likely and a demon as unlikely, so a judge that read it puts
    // a wide gap between the two. Psyche was never told the tier at all and
    // averaged ~52% on everything, which is what a zero here looks like.
    const g = b.byTier.goblin?.meanProb, d = b.byTier.demon?.meanProb;
    b.tierGap = g != null && d != null ? g - d : null;
    delete b.sum; delete b.sumSq; delete b.round; delete b.cleared; delete b.distinct;
    delete b.countBoth; delete b.countAgree; delete b.countOver; delete b.countUnder; delete b.countDriftSum;
    for (const t of Object.values(b.byTier)) delete t.sum;
  }

  if (!graded.length) return out;

  // --- how close, per stat -------------------------------------------------
  const rawMargins = {};
  for (const p of graded) {
    const line = Number(p.line), res = Number(p.result);
    if (!isFinite(line) || !isFinite(res)) continue;
    const key = `${(p.league || 'unknown').toLowerCase()} :: ${p.stat || 'unknown'}`;
    (rawMargins[key] ||= []).push({ m: res - line, hit: p.hit === true, tier: p.oddsType || 'unknown', line, res });
  }
  const zAll = [];
  for (const [key, rows] of Object.entries(rawMargins)) {
    if (rows.length < 12) continue;                 // a spread from ten points is not a spread
    const ms = rows.map((r) => r.m);
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / ms.length) || 1;
    const losses = rows.filter((r) => !r.hit);
    out.margins[key] = {
      n: rows.length,
      // Positive means the actual result lands ABOVE the line on average — the
      // overs on this prop are live and the line is set low.
      meanMargin: Math.round(mean * 100) / 100,
      sd: Math.round(sd * 100) / 100,
      losses: losses.length,
      // Of the ones that LOST: how many were within half a standard deviation of
      // flipping, and how many were never in it at all.
      nearMissShare: losses.length ? losses.filter((r) => Math.abs(r.m) <= sd).length / losses.length : null,
      blowoutShare: losses.length ? losses.filter((r) => Math.abs(r.m) > 2 * sd).length / losses.length : null,
      // The directly actionable one: of the overs that lost, how many would have
      // won at a line one whole unit lower — which is roughly where the goblin
      // alt line sits on the same prop.
      savedByLowerLine: losses.length ? losses.filter((r) => r.res > r.line - 1).length / losses.length : null,
    };
    for (const r of rows) zAll.push({ z: (r.m - 0) / sd, hit: r.hit, tier: r.tier });
  }
  // Pooled only after z-scoring, and split by tier — the question "is a demon
  // line even in reach" is exactly a margin question and cannot be asked of a
  // hit rate.
  out.marginByTier = {};
  for (const r of zAll) {
    const t = (out.marginByTier[r.tier] ||= { n: 0, sum: 0 });
    t.n++; t.sum += r.z;
  }
  for (const t of Object.values(out.marginByTier)) {
    t.meanZ = Math.round((t.sum / t.n) * 100) / 100;
    delete t.sum;
  }

  let overHits = 0, brierSum = 0;
  const bandMap = {}; // lo(0..90) -> { n, hits, predSum }
  for (const p of graded) {
    const prob = Number(p.prob) || 0;
    const hit = p.hit === true ? 1 : 0;
    overHits += hit;
    brierSum += (prob - hit) ** 2;

    const lo = Math.min(90, Math.max(0, Math.floor(prob * 10) * 10));
    const b = (bandMap[lo] ||= { lo, n: 0, hits: 0, predSum: 0 });
    b.n++; b.hits += hit; b.predSum += prob;

    const tier = p.oddsType || 'unknown';
    const t = (out.byTier[tier] ||= { n: 0, hits: 0 });
    t.n++; t.hits += hit;

    // Keyed by league too: "Fantasy Score" means something completely different
    // in baseball and basketball, and pooling them would average two unrelated
    // things into one meaningless row.
    const st = `${p.league || 'unknown'} :: ${p.stat || 'unknown'}`;
    const sr = (out.byStat[st] ||= { n: 0, hits: 0, predSum: 0, tiers: {} });
    sr.n++; sr.hits += hit; sr.predSum += prob;
    // Hits AND count per tier, not just the count. A prop type's blended rate is
    // not usable as an anchor on its own: "Hitter Fantasy Score goes over 62% of
    // the time" is a mix of goblin lines that go over ~70% and demon lines that
    // go over ~20%, and handing that single number to a judge that already knows
    // the tier would push it the wrong way on both. The per-tier split is what
    // can actually be quoted at a specific prop.
    const tr = (sr.tiers[tier] ||= { n: 0, hits: 0 });
    tr.n++; tr.hits += hit;

    const lg = p.league || 'unknown';
    const l = (out.byLeague[lg] ||= { n: 0, hits: 0 });
    l.n++; l.hits += hit;

    // Per-source Brier too — hit rate alone can't tell a sharp engine from a lucky
    // one, and this is the number to put next to somebody else's engine.
    const src = p.source || 'board';
    const s = (out.bySource[src] ||= { n: 0, hits: 0, brierSum: 0 });
    s.n++; s.hits += hit; s.brierSum += (prob - hit) ** 2;

    // Per-version Brier AND mean predicted vs actual. The gap between those last
    // two is the number that answers "are the percentages honest?": a forecaster
    // averaging 0.68 that hits 0.52 is overstating by 16 points, and no hit rate
    // on its own shows that.
    const pv = p.promptVersion || 'psyche (untagged)';
    const v = (out.byPrompt[pv] ||= { n: 0, hits: 0, brierSum: 0, predSum: 0 });
    v.n++; v.hits += hit; v.brierSum += (prob - hit) ** 2; v.predSum += prob;

    const jm = modelName(p.judgeModel);
    const mv = (out.byModel[jm] ||= { n: 0, hits: 0, brierSum: 0, predSum: 0 });
    mv.n++; mv.hits += hit; mv.brierSum += (prob - hit) ** 2; mv.predSum += prob;

    if (p.verdict === 'play') { out.plays.n++; out.plays.hits += hit; }
    if (p.verdict === 'play' || p.verdict === 'lean') { out.playsLeans.n++; out.playsLeans.hits += hit; }

    // ---- the guardrail, scored ------------------------------------------
    //
    // THE SIDE THAT WAS RECOMMENDED, not the over. `prob` is P(over) and `hit`
    // is "the over cleared" — a convention the rest of this file rests on and
    // that must not change — but a recommended UNDER that lands is a win, and
    // scoring it as a loss because the over missed would invert the whole
    // measurement on exactly the picks this section exists to judge.
    const isUnder = p.side === 'under';
    const sideHit = isUnder ? 1 - hit : hit;
    const sideProb = Number(p.sideProb ?? (isUnder ? 1 - prob : prob));
    const e = edgeOfRow(p);
    // The bar this side had to clear, derived from the edge rather than looked
    // up by tier. Edge IS side probability minus break-even, so this is exact by
    // definition — and it is null precisely when the edge is, which is what
    // stops an unpriced under being scored against the OVER's break-even. That
    // bug shipped in the first draft of this block: a demon under came out
    // 13.7 points "below its bar", a bar it does not have.
    const sideBE = e == null || !isFinite(sideProb) ? null : sideProb - e;

    // Restricted to the recommendation stream, because that is the only place a
    // bad call costs money. A pass the engine never made is not a loss it
    // avoided, and pooling passes in would flatter both sides of the split.
    if (p.verdict === 'play' || p.verdict === 'lean') {
      const bucket = e == null ? out.guardrail.unpriced : (e < 0 ? out.guardrail.refused : out.guardrail.kept);
      addToBucket(bucket, sideHit, sideProb, sideBE);
    }

    // Forward-looking, on the field itself. Rows logged before v4.34.0 have no
    // edgeVerdict and are counted as such rather than being folded into 'pass',
    // which would read as the guardrail having refused them.
    const evb = (out.byEdgeVerdict[p.edgeVerdict || 'untagged'] ||= newBucket());
    addToBucket(evb, sideHit, sideProb, sideBE);

    // Stage 1 screen vs deep dive. `deepDive` is explicitly false on stage-1
    // rows since v4.33.0; anything older has no field at all and reads as
    // shallow, which is what it was.
    addToBucket(p.deepDive === true ? out.byDeepDive.deep : out.byDeepDive.shallow, sideHit, sideProb, sideBE);

    // The paired test. `shallowProb`, like `prob`, is P(over) — so it takes the
    // same side flip before the two can be compared at all.
    const shallowRaw = Number(p.shallowProb);
    if (p.deepDive === true && isFinite(shallowRaw)) {
      const sp = isUnder ? 1 - shallowRaw : shallowRaw;
      const dp = out.deepPaired;
      dp.n++;
      dp.shallowBrierSum += (sp - sideHit) ** 2;
      dp.deepBrierSum += (sideProb - sideHit) ** 2;
      dp.moveSum += Math.abs(sideProb - sp);
      // A sign test, which needs no distributional assumption at all: under
      // "the second look adds nothing", whether it lands closer to the truth is
      // a coin flip. Picks it didn't move are excluded rather than counted as
      // half — they are not evidence either way.
      const dDist = Math.abs(sideProb - sideHit), sDist = Math.abs(sp - sideHit);
      if (dDist !== sDist) { dp.decided++; if (dDist < sDist) dp.closer++; }
    }
  }

  {
    const dp = out.deepPaired;
    out.deepPaired = {
      n: dp.n,
      shallowBrier: dp.n ? dp.shallowBrierSum / dp.n : null,
      deepBrier: dp.n ? dp.deepBrierSum / dp.n : null,
      brierDelta: dp.n ? (dp.deepBrierSum - dp.shallowBrierSum) / dp.n : null,
      meanMove: dp.n ? dp.moveSum / dp.n : null,
      closer: dp.closer, decided: dp.decided,
      // Binomial(decided, 0.5) under the null.
      sigma: dp.decided ? (dp.closer - dp.decided / 2) / Math.sqrt(dp.decided / 4) : null,
    };
  }

  for (const k of ['kept', 'refused', 'unpriced']) out.guardrail[k] = scoreBucket(out.guardrail[k]);
  for (const k of Object.keys(out.byEdgeVerdict)) out.byEdgeVerdict[k] = scoreBucket(out.byEdgeVerdict[k]);
  for (const k of ['shallow', 'deep']) out.byDeepDive[k] = scoreBucket(out.byDeepDive[k]);

  out.skill = computeSkill(graded);

  // ---- does the judge have anything to work with? -------------------------
  //
  // ~40% of props reach the judge with no recent5 at all, and Aphrodite's own
  // fallback on those is to lean on the tier — which is precisely what the
  // baseline already is. So on that 40% the judge may be structurally unable to
  // beat the floor, and a pooled Brier would hide it behind the rows where it
  // did have something to reason from.
  //
  // recentAvg is written only when the payload carried recent5 (see attachSource
  // in bet-finder-background), so it is an exact record of what the judge was
  // fed rather than an inference about it.
  const hasForm = graded.filter((p) => p.recentAvg != null);
  const noForm = graded.filter((p) => p.recentAvg == null);
  const formBucket = (rows) => {
    const o = { n: rows.length };
    if (!rows.length) return o;
    o.brier = rows.reduce((a, p) => a + ((Number(p.prob) || 0) - (p.hit === true ? 1 : 0)) ** 2, 0) / rows.length;
    scoreAgainstBaseline(o, rows);
    o.skill = computeSkill(rows);
    // One number for the headline: the count-weighted lift across tiers that
    // qualified, so the two buckets can be compared at a glance.
    const lifts = Object.values(o.skill).filter((v) => v.lift != null);
    o.meanLift = lifts.length
      ? lifts.reduce((a, v) => a + v.lift * v.n, 0) / lifts.reduce((a, v) => a + v.n, 0) : null;
    return o;
  };
  out.byFormCoverage = { 'has-form': formBucket(hasForm), 'no-form': formBucket(noForm) };
  // Coverage stated the right way round: the share of graded picks that DID
  // reach the judge with recent form.
  out.byFormCoverage.formCoverage = graded.length ? hasForm.length / graded.length : null;

  // THE ONLY DEFENSIBLE COMPARISON HERE.
  //
  // A single bucket's lift cannot carry the claim: at n=402 a goblin lift of
  // -2.0pts has a standard error of +-4.6, and at n=200 a standard lift of
  // -11.0 has +-7.0. Neither is distinguishable from zero on its own, and
  // reading either as "the ranking is inverted" is reading noise.
  //
  // What CAN be said is the difference BETWEEN the buckets on the same tier,
  // pooled across tiers by inverse variance — a paired comparison, which is far
  // better powered than either half of it.
  const pooledDiff = (metric, seKey, only = null) => {
    let wsum = 0, wx = 0; const per = {};
    for (const tier of Object.keys(out.byFormCoverage['has-form'].skill || {})) {
      if (only && !only.includes(tier)) continue;
      const h = out.byFormCoverage['has-form'].skill[tier];
      const nf = out.byFormCoverage['no-form'].skill?.[tier];
      if (!h || !nf || h[metric] == null || nf[metric] == null) continue;
      const diff = nf[metric] - h[metric];
      const se = Math.sqrt(h[seKey] ** 2 + nf[seKey] ** 2);
      if (!isFinite(se) || se <= 0) continue;
      const w = 1 / (se * se);
      per[tier] = { diff, se };
      wsum += w; wx += w * diff;
    }
    if (!wsum) return null;
    const est = wx / wsum, se = Math.sqrt(1 / wsum);
    return { estimate: est, se, z: est / se, perTier: per };
  };
  // BOTH poolings are reported, deliberately.
  //
  // Over all three tiers the estimate is smaller, because demon shows almost no
  // difference between the buckets and its weight pulls toward zero. Dropping
  // demon raises it. There is a reasonable argument for the narrower set —
  // goblin and standard are most of the board, and demon is the one tier the
  // judge already ranks well in both buckets — but that argument was available
  // only AFTER seeing which tier diluted the result, and choosing a subset on
  // that basis is selecting on the outcome.
  //
  // So neither is presented as the number. Publishing both is the only honest
  // option when the choice between them cannot be made blind.
  const GS = ['goblin', 'standard'];
  out.byFormCoverage.noFormMinusHasForm = {
    lift: pooledDiff('lift', 'liftSE'),
    auc: pooledDiff('auc', 'aucSE'),
    liftGoblinStandard: pooledDiff('lift', 'liftSE', GS),
    aucGoblinStandard: pooledDiff('auc', 'aucSE', GS),
    note: 'Positive means the judge ranked BETTER without recent form than with it. '
        + 'Inverse-variance pooled across tiers. Both the all-tier and the '
        + 'goblin+standard pooling are given because the subset could only be '
        + 'chosen after seeing which tier diluted the estimate. AUC is the better '
        + 'powered of the two metrics, so where it disagrees with lift, believe it.',
  };
  // Per judge version too, so a version that only ever ran on well-covered props
  // is not credited with the difference.
  out.byFormCoverage.byPrompt = {};
  for (const v of new Set(graded.map((p) => p.promptVersion || 'psyche (untagged)'))) {
    const rows = graded.filter((p) => (p.promptVersion || 'psyche (untagged)') === v);
    out.byFormCoverage.byPrompt[v] = {
      'has-form': formBucket(rows.filter((p) => p.recentAvg != null)),
      'no-form': formBucket(rows.filter((p) => p.recentAvg == null)),
    };
  }
  // What the uncovered rows actually ARE — the actionable half of the finding.
  // If the deficit lives here, the fix is wiring form sources for these, not
  // touching a prompt.
  out.noFormBy = { stat: {}, league: {} };
  for (const p of noForm) {
    const sk = `${(p.league || 'unknown').toLowerCase()} :: ${p.stat || 'unknown'}`;
    out.noFormBy.stat[sk] = (out.noFormBy.stat[sk] || 0) + 1;
    out.noFormBy.league[p.league || 'unknown'] = (out.noFormBy.league[p.league || 'unknown'] || 0) + 1;
  }
  out.noFormBy.stat = Object.fromEntries(Object.entries(out.noFormBy.stat).sort((a, b) => b[1] - a[1]).slice(0, 25));

  out.overall = overHits / graded.length;
  out.brier = brierSum / graded.length;
  for (const v of Object.values(out.byStat)) {
    v.predicted = v.predSum / v.n;
    v.actual = v.hits / v.n;
    v.overstatement = v.predicted - v.actual;
    for (const tr of Object.values(v.tiers)) tr.rate = tr.hits / tr.n;
    delete v.predSum;
  }
  // Ranked by how much total error each prop type contributes — |gap| times the
  // number of picks. A 30-point miss on six picks is a curiosity; a 12-point
  // miss on four hundred is where the Brier score actually goes.
  out.byStat = Object.fromEntries(Object.entries(out.byStat)
    .sort((a, b) => Math.abs(b[1].overstatement) * b[1].n - Math.abs(a[1].overstatement) * a[1].n));

  for (const v of [...Object.values(out.byPrompt), ...Object.values(out.byModel)]) {
    v.brier = v.brierSum / v.n;
    v.predicted = v.predSum / v.n;      // what it claimed, on average
    v.actual = v.hits / v.n;            // what happened
    v.overstatement = v.predicted - v.actual;   // >0 means the numbers are too high
    delete v.brierSum; delete v.predSum;
  }

  // The bar, overall and per config. Each config is scored against a baseline
  // built from ITS OWN rows rather than the pooled one: two configs judge
  // different slates with different tier mixes, and a baseline fitted on
  // somebody else's picks is not the bar either of them actually faced.
  scoreAgainstBaseline(out, graded);
  const bucket = (key) => {
    const rows = {};
    for (const p of graded) (rows[key(p)] ||= []).push(p);
    return rows;
  };
  const promptRows = bucket((p) => p.promptVersion || 'psyche (untagged)');
  for (const [k, v] of Object.entries(out.byPrompt)) scoreAgainstBaseline(v, promptRows[k] || []);
  const modelRows = bucket((p) => modelName(p.judgeModel));
  for (const [k, v] of Object.entries(out.byModel)) scoreAgainstBaseline(v, modelRows[k] || []);
  out.bands = Object.values(bandMap)
    .sort((a, b) => a.lo - b.lo)
    .map((b) => ({ band: `${b.lo}-${b.lo + 10}%`, n: b.n, predicted: b.predSum / b.n, actual: b.hits / b.n }));

  // Raw prob() OUTPUT distribution per tier, from every LOGGED pick in this
  // window — graded or still pending. byTier/bands above answer "was the judge
  // right"; this answers "what does the judge currently say for this tier",
  // which is the question when checking whether an anchor documented in
  // judge-measurement.md (e.g. demons written up at 0.15-0.25) has drifted.
  // Waiting for grading would silently exclude the newest, most relevant rows.
  out.probDistByTier = {};
  for (const p of picks) {
    const prob = Number(p.prob);
    if (!Number.isFinite(prob)) continue;
    ((out.probDistByTier[p.oddsType || 'unknown'] ||= [])).push(prob);
  }
  for (const [tier, probs] of Object.entries(out.probDistByTier)) {
    probs.sort((a, b) => a - b);
    const n = probs.length;
    const at = (q) => probs[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    const buckets = {};
    for (const v of probs) {
      const lo = Math.min(0.95, Math.max(0, Math.floor(v * 20) / 20));
      const key = `${lo.toFixed(2)}-${(lo + 0.05).toFixed(2)}`;
      buckets[key] = (buckets[key] || 0) + 1;
    }
    out.probDistByTier[tier] = {
      n, min: probs[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: probs[n - 1],
      mean: Math.round((probs.reduce((s, v) => s + v, 0) / n) * 1000) / 1000,
      buckets,
    };
  }

  // A FULL, independent calibration per league — its own Brier, bands, record
  // and coverage, not just a hit count. Pooling them hides the thing you most
  // want to know: a rater can be sharp on baseball and hopeless on tennis, and
  // one blended number says neither.
  //
  // The cost is honest and worth stating: splitting the sample means each league
  // needs its own ~50 graded picks before its number means anything, so most
  // leagues read EARLY for a while. That is the truth about the data, not a
  // regression.
  if (perLeague) {
    out.leagues = {};
    for (const lg of [...new Set(picks.map((p) => p.league || 'unknown'))].sort()) {
      out.leagues[lg] = aggregate(picks.filter((p) => (p.league || 'unknown') === lg), { perLeague: false });
    }
  }
  return out;
}

// Blob reads are network round trips, and this endpoint reads one per logged day —
// sequentially that grows without bound as the log fills, and it now blocks the
// scoreboard on Today's Picks. Bounded parallelism keeps it flat-ish and well
// inside the function's synchronous time budget.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (x) => (x == null ? '—' : x.toLocaleString());

// ---- THE EDGE METER — identical to the board row's, on purpose --------------
//
// Same classes, same track/tick/fill shape as edgeMeterHtml/.emeter in
// public/index.html, so a user who reads one screen already knows how to read
// the other. A bucket carries a state the board never needs: sigma-inconclusive
// (amber) sits between clears (green) and short (red), because a single pick
// has no sample-size uncertainty to show, and a bucket of n picks does.
//
// ratePct/needPct are already percentages (0-100), matching the board's own
// `pc`/`bePct`. sigma is optional; omit it (or pass null) to fall back to a
// plain two-state read.
// `dim` forces the neutral/grey state regardless of over-short-close — the
// guardrail table this replaces greyed any bucket under 50 rows for the same
// reason a thin cell in the tier-lift table is greyed rather than coloured:
// a verdict on n=12 is a claim the sample can't support.
function edgeMeter(ratePct, needPct, sigma, dim = false) {
  if (needPct == null) {
    return `<div class="emeter"><div class="etrack"><i class="efill" style="width:${ratePct ?? 0}%"></i></div>
      <div class="enums"><span class="pct unpriced">${ratePct == null ? '—' : ratePct.toFixed(1) + '%'}</span><span class="needs">price unknown</span></div></div>`;
  }
  const inconclusive = sigma != null && Math.abs(sigma) < 2;
  const cls = dim ? 'dim' : ratePct >= needPct ? 'over' : (inconclusive ? 'close' : 'short');
  return `<div class="emeter"><div class="etrack">` +
    `<i class="etick" style="left:${needPct.toFixed(1)}%"></i>` +
    `<i class="efill ${cls}" style="width:${Math.max(0, Math.min(100, ratePct ?? 0))}%"></i></div>` +
    `<div class="enums"><span class="pct ${cls}">hits ${ratePct.toFixed(1)}%</span><span class="needs">needs ${needPct.toFixed(1)}%</span></div></div>`;
}

// A labelled block built around one edge meter — used for tier meters, the
// guardrail buckets, the live edge-verdict split and the deep-dive stages:
// every place a rate has to clear a bar gets the identical shape.
function meterRow({ icon = '', label, sub = '', n, ratePct, needPct, sigma, note = '', dim = false }) {
  if (!n) return `<div class="mrow"><div class="mrow-top"><div class="mrow-label">${icon}${esc(label)}</div><span class="mut">none yet</span></div></div>`;
  const gap = needPct == null ? null : ratePct - needPct;
  const inconclusive = gap != null && sigma != null && Math.abs(sigma) < 2;
  const gapCls = gap == null ? '' : dim ? 'dim' : gap >= 0 ? 'over' : inconclusive ? 'close' : 'short';
  return `<div class="mrow">
    <div class="mrow-top">
      <div class="mrow-label">${icon}<span>${esc(label)}</span>${sub ? ` <span class="mut">${sub}</span>` : ''}</div>
      ${gap == null ? '' : `<div class="mrow-gap ${gapCls}">${gap >= 0 ? '+' : ''}${gap.toFixed(1)}</div>`}
    </div>
    ${edgeMeter(ratePct, needPct, sigma, dim)}
    ${note ? `<div class="mut" style="margin-top:8px;font-size:10px;line-height:1.6">${note}</div>` : ''}
  </div>`;
}

const TIER_ICON = {
  goblin: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="margin-right:6px;vertical-align:-2px"><path d="M5.5 8 L4 3.6 L8 6.2" stroke="#7fb88f" stroke-width="1.6" stroke-linejoin="round"/><path d="M18.5 8 L20 3.6 L16 6.2" stroke="#7fb88f" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="7.4" stroke="#7fb88f" stroke-width="1.6"/><path d="M9.2 12.4 v1 M14.8 12.4 v1" stroke="#7fb88f" stroke-width="1.8" stroke-linecap="round"/></svg>',
  standard: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="margin-right:6px;vertical-align:-2px"><circle cx="12" cy="12" r="8.2" stroke="#c9a86a" stroke-width="1.6"/><path d="M8.6 14.2 Q12 17.4 15.4 14.2" stroke="#c9a86a" stroke-width="1.6" stroke-linecap="round"/><path d="M9 9.4 v1.2 M15 9.4 v1.2" stroke="#c9a86a" stroke-width="1.8" stroke-linecap="round"/></svg>',
  demon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="margin-right:6px;vertical-align:-2px"><path d="M4 9 L6 4 L9.5 7" stroke="#c97b72" stroke-width="1.6" stroke-linejoin="round"/><path d="M20 9 L18 4 L14.5 7" stroke="#c97b72" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="14" r="7.2" stroke="#c97b72" stroke-width="1.6"/><path d="M9.4 13.2 L10.6 14.4 M14.6 13.2 L13.4 14.4" stroke="#c97b72" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

// The break-even null distribution, same formula scoreBucket already uses
// elsewhere on this page — reused here so a tier meter's amber/red split is
// computed the identical way the guardrail's already-computed sigma is.
function tierSigma(rate, need, n) {
  if (need == null || !n) return null;
  const se = Math.sqrt((need * (1 - need)) / n);
  return se ? (rate - need) / se : null;
}

function renderHTML(a) {
  const n = a.graded;
  // Below ~50 graded picks a Brier score is mostly noise. Show the numbers with n
  // beside them, but say plainly that they don't mean much yet — this page exists
  // to be honest, not encouraging.
  const early = n > 0 && n < 50;
  const diffColor = (d) => (Math.abs(d) <= 0.04 ? 'var(--grn)' : Math.abs(d) <= 0.10 ? 'var(--amb)' : 'var(--red)');

  const bandRows = a.bands.map((b) => {
    const diff = b.actual - b.predicted;
    return `<tr>
      <td>${b.band}</td><td>${b.n}</td>
      <td>${pct(b.predicted)}</td><td>${pct(b.actual)}</td>
      <td style="color:${diffColor(diff)}">${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="mut">No graded picks yet.</td></tr>';

  // Per-league, each with its own Brier and its own small-sample warning. Sorted
  // by sample size so the league you actually have data on leads.
  const leagueRows = Object.entries(a.leagues || {})
    .filter(([, v]) => v.graded > 0)
    .sort((x, y) => y[1].graded - x[1].graded)
    .map(([lg, v]) => {
      const pl = v.playsLeans || { n: 0, hits: 0 };
      const rec = pl.n ? `${pl.hits}–${pl.n - pl.hits}` : '—';
      const win = pl.n ? pct(pl.hits / pl.n) : '—';
      const br = v.brier != null ? v.brier.toFixed(3) : '—';
      const brCol = v.brier == null ? 'var(--dim)' : v.brier <= 0.21 ? 'var(--grn)' : v.brier <= 0.25 ? 'var(--amb)' : 'var(--red)';
      const flag = v.graded < 50
        ? `<span style="color:var(--amb)">early · n=${v.graded}</span>`
        : `<span style="color:var(--faint)">n=${v.graded}</span>`;
      return `<tr><td>${esc(lg.toUpperCase())}</td><td>${v.graded}</td><td>${rec}</td><td>${win}</td>
        <td style="color:${brCol}">${br}</td><td>${flag}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="mut">No league has a graded pick yet.</td></tr>';

  const engineRows = Object.entries(a.bySource || {}).map(([k, v]) =>
    `<tr><td>${esc(k === 'slip' ? 'slip judge' : k + ' engine')}</td><td>${v.n}</td><td>${pct(v.hits / v.n)}</td><td>${(v.brierSum / v.n).toFixed(3)}</td></tr>`).join('') ||
    '<tr><td colspan="4" class="mut">—</td></tr>';

  // Judge head-to-head. The column that matters is "overstated": mean predicted
  // minus actual. A version can win on hit rate purely by being handed easier
  // slates, but overstatement is about its OWN claims and is comparable across
  // nights. Positive means the percentages are too high.
  const promptRows = Object.entries(a.byPrompt || {})
    .sort((x, y) => y[1].n - x[1].n)
    .map(([k, v]) => {
      const over = v.overstatement;
      const col = v.n < 50 ? 'var(--dim)'
        : Math.abs(over) <= 0.04 ? 'var(--grn)' : Math.abs(over) <= 0.10 ? 'var(--amb)' : 'var(--red)';
      const sign = over >= 0 ? '+' : '';
      return `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.predicted)}</td><td>${pct(v.actual)}</td>
        <td style="color:${col}">${sign}${(over * 100).toFixed(1)}pts</td><td>${v.brier.toFixed(3)}</td>
        <td>${v.baseline == null ? '<span class="mut">—</span>' : v.baseline.toFixed(4)}</td>
        <td style="color:${v.beatsBaseline == null ? 'var(--dim)' : v.beatsBaseline ? 'var(--grn)' : 'var(--red)'}">${
          v.baselineDelta == null ? '—' : (v.baselineDelta > 0 ? '+' : '') + v.baselineDelta.toFixed(4)}</td>
        <td>${v.n < 50 ? '<span style="color:var(--amb)">early</span>' : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="mut">No graded picks yet.</td></tr>';

  // Prop types, worst total error first. Below ~20 graded a row is mostly noise,
  // so it is shown greyed rather than dropped — a prop type the engine rates
  // often but grades rarely is itself worth seeing.
  const statRows = Object.entries(a.byStat || {}).slice(0, 25).map(([k, v]) => {
    const gap = v.overstatement * 100;
    const thin = v.n < 20;
    const col = thin ? 'var(--faint)'
      : Math.abs(gap) <= 5 ? 'var(--grn)' : Math.abs(gap) <= 12 ? 'var(--amb)' : 'var(--red)';
    // Each tier with its own rate, since that is the number that could be quoted
    // at a prop. Rates on fewer than 25 are omitted rather than shown thin.
    const tierMix = Object.entries(v.tiers).sort((x, y) => y[1].n - x[1].n)
      .map(([t, c]) => `${t.slice(0, 3)} ${c.n}${c.n >= 25 ? ` @${pct(c.rate)}` : ''}`).join(' · ');
    return `<tr${thin ? ' style="color:var(--faint)"' : ''}><td>${esc(k)}</td><td>${v.n}</td>
      <td>${pct(v.predicted)}</td><td>${pct(v.actual)}</td>
      <td style="color:${col}">${gap >= 0 ? '+' : ''}${gap.toFixed(1)}</td>
      <td class="mut">${esc(tierMix)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="mut">No graded picks yet.</td></tr>';

  const skillRows = Object.entries(a.skill || {}).map(([t, v]) => {
    const lift = v.lift * 100;
    const col = lift >= 5 ? 'var(--grn)' : lift >= 1 ? 'var(--amb)' : 'var(--red)';
    const clears = v.bestHalfClears ? '<span style="color:var(--grn)">yes</span>'
      : '<span style="color:var(--red)">no</span>';
    const cell = (rate, clears, n) => rate == null
      ? `<td class="mut">n=${n}</td>`
      : `<td style="color:${clears ? 'var(--grn)' : 'var(--dim)'}">${pct(rate)}<br><span class="mut" style="font-size:9px">n=${n}</span></td>`;
    const slices = (v.topSlices || []).map((sl) => cell(sl.rate, sl.clears, sl.n)).join('');
    const tn = (v.topN || []).map((x) => cell(x.rate, x.clears, x.n)).join('');
    return `<tr><td>${esc(t)}</td><td>${v.n}</td>${slices}${tn}
      <td style="color:${col}">${lift >= 0 ? '+' : ''}${lift.toFixed(1)}±${(v.liftSE * 100).toFixed(1)}</td>
      <td>${v.auc == null ? '—' : v.auc.toFixed(3) + '±' + v.aucSE.toFixed(3)}</td>
      <td>${pct(v.breakEven)}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="mut">Not enough graded picks in any tier yet.</td></tr>';

  const modelRows = Object.entries(a.byModel || {}).sort((x, y) => y[1].n - x[1].n).map(([k, v]) => {
    const over = v.overstatement, sign = over >= 0 ? '+' : '';
    const col = v.n < 50 ? 'var(--dim)' : Math.abs(over) <= 0.04 ? 'var(--grn)' : Math.abs(over) <= 0.10 ? 'var(--amb)' : 'var(--red)';
    return `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.predicted)}</td><td>${pct(v.actual)}</td>
      <td style="color:${col}">${sign}${(over * 100).toFixed(1)}pts</td><td>${v.brier.toFixed(3)}</td>
      <td>${v.baseline == null ? '<span class="mut">—</span>' : v.baseline.toFixed(4)}</td>
      <td style="color:${v.beatsBaseline == null ? 'var(--dim)' : v.beatsBaseline ? 'var(--grn)' : 'var(--red)'}">${
        v.baselineDelta == null ? '—' : (v.baselineDelta > 0 ? '+' : '') + v.baselineDelta.toFixed(4)}</td>
      <td>${v.n < 50 ? '<span style="color:var(--amb)">early</span>' : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="9" class="mut">No graded picks yet.</td></tr>';

  const runRows = Object.entries(a.spend?.perRun || {}).sort((x, y) => y[1].usd - x[1].usd).map(([k, v]) =>
    `<tr><td>${esc(k.replace(/· (\S+)$/, (_, id) => '· ' + modelName(id)))}</td><td>${v.runs}</td><td>$${v.usdPerRun.toFixed(3)}</td>
      <td>${(v.inPerRun / 1000).toFixed(0)}k</td><td>${(v.outPerRun / 1000).toFixed(1)}k</td>
      <td>${v.searchesPerRun}</td><td>${v.inputShare == null ? '—' : pct(v.inputShare)}</td></tr>`).join('')
    || '<tr><td colspan="7" class="mut">no metered calls yet</td></tr>';

  const behRows = Object.entries(a.behaviour || {}).sort((x, y) => y[1].n - x[1].n).map(([k, v]) => {
    const gapCol = v.tierGap == null ? 'var(--dim)'
      : v.tierGap >= 0.25 ? 'var(--grn)' : v.tierGap >= 0.10 ? 'var(--amb)' : 'var(--red)';
    const rndCol = v.roundShare <= 0.35 ? 'var(--grn)' : v.roundShare <= 0.6 ? 'var(--amb)' : 'var(--red)';
    return `<tr><td>${esc(k)}</td><td>${v.n}</td>
      <td style="color:${gapCol}">${v.tierGap == null ? '—' : (v.tierGap * 100).toFixed(0) + 'pts'}</td>
      <td>${(v.spread * 100).toFixed(1)}</td>
      <td style="color:${rndCol}">${pct(v.roundShare)}</td>
      <td>${pct(v.clearedShare)}</td><td>${v.effectiveValues} <span class="mut">of ${v.distinctValues}</span></td>
      <td>${v.countChecked ? `<span style="color:${v.countAgreeShare >= 0.95 ? 'var(--grn)' : v.countAgreeShare >= 0.8 ? 'var(--amb)' : 'var(--red)'}">${pct(v.countAgreeShare)}</span>
        <span class="mut">n=${v.countChecked}${v.countMeanDrift ? `, ${v.countMeanDrift > 0 ? '+' : ''}${v.countMeanDrift.toFixed(2)}` : ''}</span>` : '<span class="mut">—</span>'}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="mut">No logged picks yet.</td></tr>';

  const marginRows = Object.entries(a.margins || {}).sort((x, y) => y[1].n - x[1].n).slice(0, 18).map(([k, v]) => {
    const mCol = v.meanMargin > 0 ? 'var(--grn)' : v.meanMargin < 0 ? 'var(--red)' : 'var(--dim)';
    const nCol = v.nearMissShare >= 0.5 ? 'var(--amb)' : 'var(--dim)';
    return `<tr><td>${esc(k)}</td><td>${v.n}</td>
      <td style="color:${mCol}">${v.meanMargin > 0 ? '+' : ''}${v.meanMargin}</td>
      <td>${v.sd}</td><td>${v.losses}</td>
      <td style="color:${nCol}">${v.nearMissShare == null ? '—' : pct(v.nearMissShare)}</td>
      <td>${v.blowoutShare == null ? '—' : pct(v.blowoutShare)}</td>
      <td>${v.savedByLowerLine == null ? '—' : pct(v.savedByLowerLine)}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="mut">No graded picks with a numeric result yet.</td></tr>';

  const mtRows = Object.entries(a.marginByTier || {}).sort((x, y) => y[1].n - x[1].n).map(([t, v]) =>
    `<tr><td>${esc(t)}</td><td>${v.n}</td><td style="color:${v.meanZ >= 0 ? 'var(--grn)' : 'var(--red)'}">${v.meanZ > 0 ? '+' : ''}${v.meanZ}</td></tr>`).join('')
    || '<tr><td colspan="3" class="mut">—</td></tr>';

  const fc = a.byFormCoverage || {};
  const formRow = (label, v) => {
    if (!v || !v.n) return `<tr><td>${label}</td><td colspan="6" class="mut">no graded picks</td></tr>`;
    const d = v.baselineDelta;
    const col = d == null ? 'var(--dim)' : d < 0 ? 'var(--grn)' : 'var(--red)';
    // Every lift carries its own interval. A -2.0pt lift on 402 picks has a
    // standard error of +-4.6 and cannot be told from zero; printed bare it
    // reads as an inversion.
    const tiers = Object.entries(v.skill || {}).map(([t, k]) =>
      `${t.slice(0, 3)} ${(k.lift >= 0 ? '+' : '') + (k.lift * 100).toFixed(1)}±${(k.liftSE * 100).toFixed(1)}` +
      `<span class="mut"> auc ${k.auc == null ? '—' : k.auc.toFixed(3) + '±' + k.aucSE.toFixed(3)}</span>`).join('<br>');
    return `<tr><td>${label}</td><td>${v.n}</td>
      <td>${v.brier == null ? '—' : v.brier.toFixed(4)}</td>
      <td>${v.baseline == null ? '—' : v.baseline.toFixed(4)}</td>
      <td style="color:${col}">${d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(4)}</td>
      <td style="color:${col}">${d == null ? '—' : d < 0 ? 'beats it' : 'behind'}</td>
      <td style="font-size:10px;line-height:1.7">${tiers || '<span class="mut">—</span>'}</td></tr>`;
  };
  const formRows = [formRow('has form', fc['has-form']), formRow('NO form', fc['no-form'])].join('')
    + Object.entries(fc.byPrompt || {}).flatMap(([k, v]) => [
      formRow(`&nbsp;&nbsp;<span class="mut">${esc(k)} · has form</span>`, v['has-form']),
      formRow(`&nbsp;&nbsp;<span class="mut">${esc(k)} · NO form</span>`, v['no-form']),
    ]).join('');
  const noFormRows = Object.entries(a.noFormBy?.stat || {}).slice(0, 15)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')
    || '<tr><td colspan="2" class="mut">every graded pick had recent form</td></tr>';

  const pendDates = Object.entries(a.pendingByDate || {}).sort((x, y) => (x[0] < y[0] ? 1 : -1));
  const pendRows = pendDates.map(([d, c], i) =>
    `<tr><td>${d}${i === 0 ? ' <span class="mut">(newest — usually tonight, games not final)</span>' : ''}</td><td>${c}</td></tr>`).join('')
    || '<tr><td colspan="2" class="mut">none — everything gradeable is graded</td></tr>';

  // Guardrail / edge-verdict / deep-dive meters. One shape for all three,
  // since all three ask the same question a tier meter asks: did this group of
  // picks clear its own bar? scoreBucket() already computes {rate, needed,
  // sigma} for every one of these — the meter just draws what was already there.
  const bucketMeter = (label, v, note = '') => meterRow({
    label, n: v?.n, ratePct: v?.rate == null ? null : v.rate * 100,
    needPct: v?.needed == null ? null : v.needed * 100, sigma: v?.sigma,
    dim: (v?.n ?? 0) < 50,
    note: v?.n ? `${note}${note ? ' — ' : ''}${v.sigma == null ? '' : `${v.sigma.toFixed(1)}σ from break-even`}${v.ev == null ? '' : `, 3-leg slip EV ${v.ev >= 0 ? '+' : ''}${(v.ev * 100).toFixed(0)}%`}` : note,
  });
  const g = a.guardrail || {};
  const guardMeters = [
    bucketMeter('Kept — edge ≥ 0', g.kept),
    bucketMeter('Refused — edge < 0', g.refused),
    bucketMeter('Unpriced side', g.unpriced, 'payout unknown'),
  ].join('');
  const edgeVerdictOrder = ['play', 'lean', 'pass', 'untagged'];
  const edgeVerdictMeters = edgeVerdictOrder.filter((k) => a.byEdgeVerdict?.[k]?.n).length
    ? edgeVerdictOrder.filter((k) => a.byEdgeVerdict?.[k]?.n)
      .map((k) => bucketMeter(k, a.byEdgeVerdict[k], k === 'untagged' ? 'logged before v4.34.0' : '')).join('')
    : '<div class="mut">no rows carry an edge verdict yet</div>';
  const dd = a.byDeepDive || {};
  const deepMeters = [
    bucketMeter('Stage 1 — batch screen', dd.shallow),
    bucketMeter('Stage 2 — deep dive', dd.deep),
  ].join('');

  const plWin = a.playsLeans.n ? a.playsLeans.hits / a.playsLeans.n : null;
  const record = a.playsLeans.n ? `${a.playsLeans.hits}–${a.playsLeans.n - a.playsLeans.hits}` : '—';

  // n===0 has two different causes now that the page defaults to Vilifiant-only:
  // no graded picks at all, or graded picks that all belong to a legacy engine.
  // Those are different facts and get different messages — the second one names
  // the legacy count rather than reading as "nothing has ever been graded."
  const legacyN = a.legacy?.graded || 0;
  const stateNote = n === 0
    ? (legacyN
        ? `<div class="callout amber">No <b>Vilifiant</b>-graded picks yet. ${legacyN} legacy-engine pick${legacyN === 1 ? ' is' : 's are'} graded — see <b>Legacy engines</b> below, not pooled into anything above.</div>`
        : `<div class="callout">No graded picks yet. The grader runs every morning and fills in results once games settle — this page starts meaning something a day or two after your first logged slate.</div>`)
    : early
      ? `<div class="callout amber"><b>EARLY — n=${n}.</b> Below ~50 graded picks these numbers are mostly noise: a hot or cold week can swing them wildly. Don't draw conclusions (or settle arguments) yet.</div>`
      : `<div class="callout">Calibration scores every logged pick — plays, leans and passes alike — so the numbers can't be flattered by only counting winners. "Diff" is actual minus predicted; green is honest (±4pts), red is off by 10+.</div>`;

  const card = (v, l, sub) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

  // ---- Legacy engines — collapsed, never pooled, never a comparison --------
  //
  // Everything ABOVE this point is Vilifiant-only, the standing default (see
  // docs/judge-measurement.md, "Vilifiant-only scoping"). These rows are
  // whatever is left: Psyche's Opus runs, one-off Sonnet experiments, anything
  // logged before per-pick model tagging existed. They differ from the numbers
  // above in BOTH prompt version and model at once, so there is no clean
  // single-variable contrast to draw — this section is a historical record, not
  // a second opinion.
  const lg = a.legacy || {};
  const lgModelRows = Object.entries(lg.byModel || {}).sort((x, y) => y[1].n - x[1].n).map(([k, v]) => {
    const over = v.overstatement, sign = over >= 0 ? '+' : '';
    return `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.predicted)}</td><td>${pct(v.actual)}</td>
      <td>${sign}${(over * 100).toFixed(1)}pts</td><td>${v.brier.toFixed(3)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="mut">no legacy picks graded</td></tr>';
  const legacyBlock = !lg.graded
    ? `<div class="callout">No legacy-engine picks are graded.</div>`
    : `<div class="cards">
        ${card(lg.graded, 'graded', '')}
        ${card(pct(lg.overall), 'over rate', '')}
        ${card(lg.brier == null ? '—' : lg.brier.toFixed(3), 'brier ↓', '')}
        ${card(lg.baseline == null ? '—' : lg.baseline.toFixed(4), 'tier-only baseline (own rows)', '')}
      </div>
      <div class="wrap" style="margin-top:12px"><table><thead><tr><th>model</th><th>n</th><th>claimed</th><th>actual</th><th>overstated</th><th>brier ↓</th></tr></thead><tbody>${lgModelRows}</tbody></table></div>`;

  // ==========================================================================
  // THE THREE QUESTIONS — each section answers itself before it is opened.
  // ==========================================================================

  // ---- 1. Are its numbers honest? -----------------------------------------
  // Overall predicted rate, pooled from the bands (weighted by n) rather than
  // stored separately — this is the same "diff" every band row already shows,
  // just rolled up once for the headline.
  const bandN = (a.bands || []).reduce((s, b) => s + b.n, 0);
  const predOverall = bandN ? a.bands.reduce((s, b) => s + b.predicted * b.n, 0) / bandN : null;
  const honestyGapPts = predOverall != null ? (predOverall - a.overall) * 100 : null; // >0 = overstating
  const honestyState = honestyGapPts == null ? null : Math.abs(honestyGapPts) <= 4 ? 'good' : Math.abs(honestyGapPts) <= 10 ? 'mid' : 'bad';
  const honestyAnswer = !n ? 'no data yet' : honestyState == null ? '—' : honestyState === 'good' ? 'close' : honestyState === 'mid' ? 'a bit off' : 'overstated';
  const honestySub = !n
    ? 'The grader runs every morning and fills in results once games settle.'
    : `Says ${pct(predOverall)}, hits ${pct(a.overall)}. ${
        honestyGapPts >= 0
          ? (Math.abs(honestyGapPts) <= 4 ? 'Within a point — it is not lying to you about its confidence.' : `Overstating by ${Math.abs(honestyGapPts).toFixed(1)} points.`)
          : `Understating by ${Math.abs(honestyGapPts).toFixed(1)} points.`
      }`;

  // ---- 2. Does it make money? ----------------------------------------------
  const tierOrder = ['goblin', 'standard', 'demon'];
  const tierMoney = tierOrder.filter((t) => a.byTier?.[t]?.n).map((t) => {
    const b = a.byTier[t]; const rate = b.hits / b.n; const need = BREAK_EVEN[t];
    return { tier: t, n: b.n, ratePct: rate * 100, needPct: need * 100, gapPts: (rate - need) * 100, sigma: tierSigma(rate, need, b.n) };
  });
  const anyTierClears = tierMoney.some((t) => t.gapPts >= 0);
  const allTiersClear = tierMoney.length > 0 && tierMoney.every((t) => t.gapPts >= 0);
  const worstTier = tierMoney.length ? tierMoney.reduce((x, y) => (x.gapPts < y.gapPts ? x : y)) : null;
  const moneyAnswer = !tierMoney.length ? 'no data yet' : allTiersClear ? 'yes' : anyTierClears ? 'partially' : 'no';
  const moneySub = !tierMoney.length
    ? 'Not enough graded picks in any tier yet.'
    : allTiersClear
      ? 'Every priced tier clears its own break-even.'
      : anyTierClears
        ? `Some tiers clear their break-even, some don't.${worstTier ? ` The widest gap is ${worstTier.tier}, ${Math.abs(worstTier.gapPts).toFixed(1)} points under.` : ''}`
        : `Every tier lands short of what its payout needs.${worstTier ? ` The widest gap is ${worstTier.tier}, ${Math.abs(worstTier.gapPts).toFixed(1)} points under.` : ''}`;

  const tierMeters = tierOrder.map((t) => {
    const row = tierMoney.find((x) => x.tier === t);
    return meterRow({
      icon: TIER_ICON[t], label: t[0].toUpperCase() + t.slice(1), sub: `n=${fmt(row?.n)}`,
      n: row?.n, ratePct: row?.ratePct, needPct: row?.needPct, sigma: row?.sigma,
    });
  }).join('');

  // ---- 3. Is it getting better? --------------------------------------------
  // Pulled from exactly the AUC values the tables below already compute — the
  // one that sits furthest from a coin flip, in standard errors, is the one
  // worth naming in the answer line.
  const aucCandidates = [];
  for (const [tier, v] of Object.entries(a.skill || {})) {
    if (v.auc != null && v.aucSE) aucCandidates.push({ label: tier, auc: v.auc, se: v.aucSE });
  }
  for (const bucket of ['has-form', 'no-form']) {
    const sk = a.byFormCoverage?.[bucket]?.skill || {};
    for (const [tier, v] of Object.entries(sk)) {
      if (v.auc != null && v.aucSE) aucCandidates.push({ label: `${tier} · ${bucket}`, auc: v.auc, se: v.aucSE });
    }
  }
  aucCandidates.sort((x, y) => Math.abs(y.auc - 0.5) / y.se - Math.abs(x.auc - 0.5) / x.se);
  const bestAuc = aucCandidates[0] || null;
  const bestAucZ = bestAuc ? Math.abs(bestAuc.auc - 0.5) / bestAuc.se : null;
  const gettingBetterAnswer = !bestAuc ? 'no data yet' : bestAucZ >= 2 ? `yes, on ${bestAuc.label}` : 'not yet clear';
  const gettingBetterSub = !bestAuc
    ? 'Not enough graded picks in any tier yet.'
    : `Best measured discrimination: ${bestAuc.label} AUC ${bestAuc.auc.toFixed(3)} (±${bestAuc.se.toFixed(3)})${
        bestAucZ >= 2 ? ', clearing 2 standard errors from a coin flip.' : ', not yet distinguishable from a coin flip.'
      }`;

  const honestyCls = honestyState === 'good' ? 'good' : honestyState === 'mid' ? 'mid' : honestyState === 'bad' ? 'bad' : 'dim';
  const moneyCls = moneyAnswer === 'yes' ? 'good' : moneyAnswer === 'partially' ? 'mid' : moneyAnswer === 'no' ? 'bad' : 'dim';
  const gbCls = gettingBetterAnswer.startsWith('yes') ? 'good' : gettingBetterAnswer === 'not yet clear' ? 'mid' : 'dim';

  // ---- Housekeeping ---------------------------------------------------------
  const housekeepingAnswer = `$${(a.spend?.month ?? 0).toFixed(2)} / 30d`;

  // ---- THE VERDICT — a two-marker axis, never a fill meter -----------------
  // Lower Brier is better, so a fill-past-the-tick bar would read backwards
  // here: the worse score would draw the longer bar. Two markers on a shared
  // axis with the gap shaded between them reads correctly regardless of which
  // side is ahead.
  const verdictBlock = (() => {
    if (a.baseline == null || a.brier == null) {
      return `<div class="callout">Not enough graded picks yet to compare against the tier-only baseline.</div>`;
    }
    const behind = a.beatsBaseline === false;
    const pad = 0.35;
    const lo = Math.min(a.baseline, a.brier), hi = Math.max(a.baseline, a.brier);
    const range = (hi - lo) || 0.01;
    const axisMin = lo - range * pad, axisMax = hi + range * pad;
    const posOf = (v) => ((v - axisMin) / (axisMax - axisMin)) * 100;
    const baselinePos = posOf(a.baseline), judgePos = posOf(a.brier);
    const cls = behind ? 'short' : 'over';
    return `<div class="verdict${behind ? ' behind' : ''}">
      <div class="vlabel">The one that matters</div>
      <div class="vheadline">The judge is ${behind ? 'behind' : 'ahead of'} a lookup table.</div>
      <div class="vsub">A three-row <b>tier-only baseline</b> that knows only the tier scores <b>${a.baseline.toFixed(4)}</b>.
        The judge scores <b>${a.brier.toFixed(4)}</b>. Lower is better, so that's
        <span class="${cls}">${behind ? 'judge BEHIND by' : 'judge ahead by'} ${Math.abs(a.baselineDelta).toFixed(4)}</span>.</div>
      <div class="baxis">
        <div class="baxis-line"></div>
        <div class="bgap ${cls}" style="left:${Math.min(baselinePos, judgePos)}%;width:${Math.abs(judgePos - baselinePos)}%"></div>
        <div class="bmark base" style="left:${baselinePos}%"></div>
        <div class="bmark judge ${cls}" style="left:${judgePos}%"></div>
      </div>
      <div class="baxis-labels">
        <div class="baxis-label">${a.baseline.toFixed(4)}<br><span class="mut">lookup table</span></div>
        <div class="baxis-label right ${cls}">${a.brier.toFixed(4)}<br><span class="mut">the judge</span></div>
      </div>
      <div class="vfoot">The table is fitted on the same rows it is scored against, which hands it hindsight and makes it
        <i>harder</i> to beat. That is deliberate — a bar should be generous to itself.</div>
    </div>`;
  })();

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#000000"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>AtomBets · Calibration</title><style>
  :root{color-scheme:dark;--bg:#000;--ink:#fff;--dim:#8f8f8f;--faint:#4a4a4a;--line:#1c1c1c;
    --grn:#7fb88f;--amb:#c9a86a;--red:#c97b72;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}
  body{font:13px/1.6 var(--mono);background:var(--bg);color:var(--ink);margin:0;padding:26px 18px 60px;max-width:720px;margin-inline:auto}
  h1{font:800 22px/1.2 -apple-system,'Helvetica Neue',sans-serif;letter-spacing:-.02em;margin:0}
  h1 span{color:var(--dim);font-weight:600}
  .sub{color:var(--dim);font-size:11px;margin:6px 0 22px}
  .sub a{color:var(--dim)}
  h2{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim);font-weight:600;
    margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline}
  h2 a{color:var(--faint);text-decoration:none;letter-spacing:.04em;margin-left:auto}
  h3{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:24px 0 10px}
  h3:first-child{margin-top:4px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}
  .card{border:1px solid var(--line);border-radius:6px;padding:13px 14px}
  .card .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .card .l{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-top:5px}
  .card .s{font-size:10px;color:var(--faint);margin-top:3px}
  .callout{border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:11px;color:var(--dim);margin:16px 0;line-height:1.7}
  .callout.amber{border-color:var(--amb);color:var(--amb)}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  th{color:var(--faint);font-size:9px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
  tr:last-child td{border-bottom:none}
  .mut{color:var(--faint)}
  .wrap{overflow-x:auto}
  .over{color:var(--grn)} .short{color:var(--red)} .close{color:var(--amb)}
  .qdef{font-size:10px;color:var(--faint);line-height:1.6;margin:0 0 16px}

  /* ---- THE EDGE METER — identical to the board row's (public/index.html) ---- */
  .emeter{margin-top:9px}
  .etrack{height:4px;background:rgba(255,255,255,.10);border-radius:2px;position:relative}
  .etick{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--ink);opacity:.85}
  .efill{position:absolute;top:0;bottom:0;left:0;border-radius:2px;background:var(--faint)}
  .efill.over{background:var(--grn)} .efill.short{background:var(--red)} .efill.close{background:var(--amb)} .efill.dim{background:var(--faint)}
  .enums{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:6px;font-size:11px}
  .pct.over{color:var(--grn)} .pct.short{color:var(--red)} .pct.close{color:var(--amb)} .pct.unpriced{color:var(--faint)} .pct.dim{color:var(--dim)}
  .needs{color:var(--faint)}

  /* ---- money rows: label, big gap number, the meter, a note ---- */
  .mrow{border-top:1px solid var(--line);padding:14px 0 15px}
  .mrow:first-child{border-top:none}
  .mrow-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .mrow-label{font-size:14px;font-weight:600;font-family:-apple-system,'Helvetica Neue',sans-serif}
  .mrow-label .mut{font-size:10px;font-weight:400;margin-left:3px;font-family:var(--mono)}
  .mrow-gap{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;flex:none}
  .mrow-gap.over{color:var(--grn)} .mrow-gap.short{color:var(--red)} .mrow-gap.close{color:var(--amb)} .mrow-gap.dim{color:var(--dim)}

  /* ---- the verdict: two markers on a shared axis, NEVER a fill meter — a
     lower-is-better score would draw the fill backwards. ---- */
  .verdict{border:1px solid rgba(201,123,114,.45);border-radius:6px;padding:17px 15px 18px;margin:18px 0}
  .verdict:not(.behind){border-color:rgba(127,184,143,.4)}
  .vlabel{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--red)}
  .verdict:not(.behind) .vlabel{color:var(--grn)}
  .vheadline{font-size:22px;font-weight:600;line-height:1.25;margin-top:9px;font-family:-apple-system,'Helvetica Neue',sans-serif}
  .vsub{font-size:11px;color:var(--dim);line-height:1.65;margin-top:9px}
  .baxis{margin-top:18px;position:relative;height:24px}
  .baxis-line{position:absolute;left:0;right:0;top:11px;height:2px;background:rgba(255,255,255,.10)}
  .bmark{position:absolute;top:5px;width:2px;height:14px;background:var(--dim)}
  .bmark.judge{top:1px;height:22px}
  .bmark.judge.over{background:var(--grn)} .bmark.judge.short{background:var(--red)}
  .bgap{position:absolute;top:5px;height:14px}
  .bgap.over{background:rgba(127,184,143,.16)} .bgap.short{background:rgba(201,123,114,.16)}
  .baxis-labels{position:relative;height:30px;margin-top:2px}
  .baxis-label{position:absolute;left:0;font-size:9px;color:var(--dim);line-height:1.4}
  .baxis-label.right{left:auto;right:0;text-align:right}
  .baxis-label.over{color:var(--grn)} .baxis-label.short{color:var(--red)}
  .vfoot{font-size:10px;color:var(--faint);line-height:1.65;margin-top:12px;border-top:1px solid rgba(255,255,255,.10);padding-top:12px}

  /* ---- the three questions (plus Housekeeping): collapsible, the answer
     line lives INSIDE <summary> so it renders even while closed. ---- */
  .qsection{border-top:1px solid var(--line)}
  .qsection summary{cursor:pointer;list-style:none;padding:16px 0}
  .qsection summary::-webkit-details-marker{display:none}
  .qhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .qtitle{font-size:16px;font-weight:600;font-family:-apple-system,'Helvetica Neue',sans-serif}
  .qanswer{font-size:10px;flex:none}
  .qanswer.good{color:var(--grn)} .qanswer.bad{color:var(--red)} .qanswer.mid{color:var(--amb)} .qanswer.dim{color:var(--dim)}
  .qsub{font-size:10px;color:var(--dim);line-height:1.6;margin-top:6px}
  .qmeta{font-size:9px;color:var(--faint);margin-top:8px}
  .qhint .cc{display:none}
  .qsection[open] .qhint .oc{display:none}
  .qsection[open] .qhint .cc{display:inline}
  .qbody{padding:2px 0 20px}
</style></head><body>
  <h1>AtomBets <span>· Calibration</span></h1>
  <div class="sub">Vilifiant only — the standing default (docs/judge-measurement.md) &nbsp;<a href="/api/calibration?format=json">json ↗</a></div>
  <div class="qmeta" style="margin-top:-16px">${fmt(n)} graded${a.pendingGradeable ? ` · ${fmt(a.pendingGradeable)} pending` : ''}</div>

  ${verdictBlock}
  ${stateNote}

  <details class="qsection">
    <summary>
      <div class="qhead"><div class="qtitle">Are its numbers honest?</div><div class="qanswer ${honestyCls}">${honestyAnswer}</div></div>
      <div class="qsub">${honestySub}</div>
      <div class="qmeta">calibration by band · over rate · Brier &nbsp;&nbsp;<span class="mut qhint"><span class="oc">open ↓</span><span class="cc">close ↑</span></span></div>
    </summary>
    <div class="qbody">
      <div class="qdef"><b>Over rate</b> is the share of graded picks whose result landed over the line. <b>Brier</b> is
        the honest scoreboard — right AND not overclaiming: saying 90% on legs that hit 70% scores <i>worse</i>
        (0.250) than saying 70% (0.210).</div>

      <h3>By engine <a href="/api/calibration?format=json" style="float:right;font-size:9px;color:var(--faint);text-decoration:none">json ↗</a></h3>
      <div class="wrap"><table><thead><tr><th>source</th><th>n</th><th>over rate</th><th>brier ↓</th></tr></thead><tbody>${engineRows}</tbody></table></div>
      <div class="callout">Compare engines on Brier, never on whose percentages look bigger.</div>

      <h3>Calibration by predicted band</h3>
      <div class="wrap"><table><thead><tr><th>P(over) band</th><th>n</th><th>predicted</th><th>actual</th><th>diff (pts)</th></tr></thead><tbody>${bandRows}</tbody></table></div>

      <h3>How close, not just whether</h3>
      <div class="wrap"><table><thead><tr><th>league :: stat</th><th>n</th><th>mean margin</th><th>spread</th><th>losses</th><th>near miss</th><th>not close</th><th>saved by −1</th></tr></thead><tbody>${marginRows}</tbody></table></div>
      <div class="wrap" style="margin-top:12px"><table><thead><tr><th>tier</th><th>n</th><th>mean margin (σ)</th></tr></thead><tbody>${mtRows}</tbody></table></div>
      <div class="callout">Grading is binary and stays that way — PrizePicks pays the same nothing for missing over 3.5
        with 3 as for missing over 6.5 with 1. But those two misses say completely different things about the
        <i>judge</i>, and a Brier score cannot tell them apart. <b>Near miss</b> is the share of losses within half a
        spread of flipping; <b>not close</b> is the share that were never in it; <b>saved by −1</b> is how many losses
        a line one whole unit lower would have won. Margins are z-scored per stat before the tier table pools them —
        a miss of 0.5 means everything on a home-run line and nothing on a Fantasy Score line of 25.</div>
    </div>
  </details>

  <details class="qsection">
    <summary>
      <div class="qhead"><div class="qtitle">Does it make money?</div><div class="qanswer ${moneyCls}">${moneyAnswer}</div></div>
      <div class="qsub">${moneySub}</div>
      <div class="qmeta">by tier · the edge guardrail · verdict performance &nbsp;&nbsp;<span class="mut qhint"><span class="oc">open ↓</span><span class="cc">close ↑</span></span></div>
    </summary>
    <div class="qbody">
      <div class="qdef">Each tier pays differently, so each needs a different hit rate just to return the stake —
        <b>break-even</b>. The tick on every meter below is that rate; short of it loses money however good the raw
        number looks.</div>

      <h3>By tier</h3>
      ${tierMeters}

      <h3>The edge guardrail</h3>
      <div class="callout">Since v4.34.0 the auto-slip refuses a leg whose own <b>edge</b> is negative: a bet that
        loses money even if the judge is exactly right. Of everything the engine has ever called a play or a lean,
        this is the <b>counterfactual</b> — how did the legs it now <b>keeps</b> do against the ones it now
        <b>refuses</b>? If refused doesn't lose badly, the guardrail is throwing away money and should come out.</div>
      ${guardMeters}

      <h3>Edge verdict — the live field</h3>
      <div class="callout">The same split on the field itself rather than reconstructed — what the app actually
        badged and the auto-slip actually selected on. Kept separate from the counterfactual above: a reconstruction
        is evidence about a decision, not a measurement of one.</div>
      ${edgeVerdictMeters}

      <h3>Verdict performance</h3>
      <div class="qdef"><b>Play</b> and <b>lean</b> are the two verdicts strong enough to reach a slip; a raw win
        rate here can't be read across tiers — 67% is a disaster on a goblin and a fortune on a demon.</div>
      <div class="wrap"><table><thead><tr><th>verdict</th><th>n</th><th>win rate</th></tr></thead><tbody>
        <tr><td>play</td><td>${a.plays.n}</td><td>${a.plays.n ? pct(a.plays.hits / a.plays.n) : '—'}</td></tr>
        <tr><td>play + lean</td><td>${a.playsLeans.n}</td><td>${a.playsLeans.n ? pct(plWin) : '—'}</td></tr>
      </tbody></table></div>
    </div>
  </details>

  <details class="qsection">
    <summary>
      <div class="qhead"><div class="qtitle">Is it getting better?</div><div class="qanswer ${gbCls}">${gettingBetterAnswer}</div></div>
      <div class="qsub">${gettingBetterSub}</div>
      <div class="qmeta">judge behaviour · judge versions · models · deep dive · form coverage &nbsp;&nbsp;<span class="mut qhint"><span class="oc">open ↓</span><span class="cc">close ↑</span></span></div>
    </summary>
    <div class="qbody">
      <h3>Judge behaviour — readable the same day</h3>
      <div class="wrap"><table><thead><tr><th>judge · model</th><th>picks</th><th>tier gap</th><th>spread</th><th>round numbers</th><th>form coverage</th><th>values used</th><th>count agrees</th></tr></thead><tbody>${behRows}</tbody></table></div>
      <div class="callout">Everything else on this page waits for games to settle. This does not: it reads every
        logged pick, graded or not, so a run can be checked the hour it finishes. <b>Tier gap</b> is the headline,
        and the direct test of whether the judge follows the tier-anchoring instruction at all; <b>round numbers</b> is what verdict-first
        reasoning looks like. <b>Filled "cleared"</b> is a COVERAGE metric, not an obedience one — the floor is set by
        how often recent form reaches the payload, not by the judge's choice. <b>Count agrees</b> is compliance with
        the supplied count once it's covered, with the mean signed drift beside it — a positive drift is the
        expensive direction, since it inflates the over — and a same-input replay found it unreliable run to run
        even when everything it needed was present (see docs/judge-measurement.md).</div>

      <h3>Judge version — head to head</h3>
      <div class="wrap"><table><thead><tr><th>judge</th><th>n</th><th>claimed</th><th>actual</th><th>overstated</th><th>brier ↓</th><th>baseline</th><th>vs baseline</th><th></th></tr></thead><tbody>${promptRows}</tbody></table></div>
      <div class="callout"><b>Psyche</b> is the original judge; <b>Aphrodite</b> is the refinement. "Overstated" is
        claimed minus actual — the honest measure of whether the percentages mean anything, comparable across
        nights in a way a raw win rate is not.</div>

      <h3>Model — head to head</h3>
      <div class="wrap"><table><thead><tr><th>model</th><th>n</th><th>claimed</th><th>actual</th><th>overstated</th><th>brier ↓</th><th>baseline</th><th>vs baseline</th><th></th></tr></thead><tbody>${modelRows}</tbody></table></div>
      <div class="callout">Everything above <b>Legacy engines</b> (bottom of page) is Vilifiant-only, so this table
        normally has one row. A model experiment run deliberately from the dev console tags its own picks and lands
        in Legacy engines instead, never pooled into this row.</div>

      <h3>Deep dive — is the second look worth it?</h3>
      <div class="callout">The deep dive re-judges the best-edge picks one at a time instead of in a batch, at real
        cost per run. The claim it rests on is that an undivided look produces a better probability than the screen
        does — deep-dive rows are a deliberately biased sample (the picks the screen already liked most), so
        read the Brier gap, not the hit rate, and give it a few hundred rows before believing either.</div>
      ${deepMeters}
      <div class="callout${(a.deepPaired?.n || 0) === 0 ? ' amber' : ''}">${(a.deepPaired?.n || 0) === 0
        ? `<b>The paired test has no rows yet.</b> Comparing deep rows to shallow rows compares two different sets of
           picks, and the deep set exists <i>because</i> the screen liked it most — confounded with that selection.
           Since v4.35.1 every deep-dive row also logs the stage-1 probability for the same pick, turning this into a
           paired question that selection cannot bias. It fills in as deep-dive runs grade.`
        : `<b>Paired — same picks, both numbers.</b> On ${a.deepPaired.n} deep-dive picks the stage-1 screen scored
           <b>${a.deepPaired.shallowBrier.toFixed(4)}</b>, the second look scored
           <b>${a.deepPaired.deepBrier.toFixed(4)}</b> (${a.deepPaired.brierDelta <= 0 ? 'better' : 'WORSE'} by
           ${Math.abs(a.deepPaired.brierDelta).toFixed(4)}). Beside it, a sign test: the second look landed closer to
           the truth on <b>${a.deepPaired.closer} of ${a.deepPaired.decided}</b> picks it moved
           (${a.deepPaired.sigma == null ? '—' : `${a.deepPaired.sigma.toFixed(1)}σ`} vs a coin flip). These two
           answer different questions and can honestly disagree: trimming an overconfident number improves Brier
           while tying the sign test at 50%. Brier says <i>better calibrated</i>; the sign test says
           <i>right more often</i> — only the second is evidence of extra knowledge rather than just being
           less overconfident.`}</div>

      <h3>Did the judge have anything to work with?</h3>
      <div class="wrap"><table><thead><tr><th>rows</th><th>n</th><th>brier ↓</th><th>baseline</th><th>vs baseline</th><th></th><th>within-tier lift</th></tr></thead><tbody>${formRows}</tbody></table></div>
      <div class="callout">${a.byFormCoverage?.formCoverage == null ? '' :
          `<b>${pct(a.byFormCoverage.formCoverage)}</b> of graded picks reached the judge carrying recent form; the
           rest arrived with none. `}Without form the prompt falls back to the tier — exactly what the baseline
        already is — so beating the baseline on <b>has form</b> and losing on <b>NO form</b> means the deficit is
        data coverage, not the prompt. Each lift carries its own interval: a −2.0pt lift on 402 picks has a standard
        error of ±4.6 and bare, it reads as an inversion that the data does not support. <b>AUC</b> beside each lift
        is the better-powered read: the chance a randomly chosen hit ranks above a randomly chosen miss.
        ${(() => { const d = a.byFormCoverage?.noFormMinusHasForm; if (!d?.lift) return '';
          const f = (x, s = 100, dp = 1) => x == null ? '—'
            : `${(x.estimate * s >= 0 ? '+' : '') + (x.estimate * s).toFixed(dp)} ± ${(x.se * s).toFixed(dp)} (z ${x.z.toFixed(2)})`;
          return `<br><br><b>No-form minus has-form</b>, pooled by inverse variance: all tiers <b>${f(d.lift)}</b>,
          goblin+standard only <b>${f(d.liftGoblinStandard)}</b>. AUC: all tiers <b>${f(d.auc, 1, 3)}</b>,
          goblin+standard <b>${f(d.aucGoblinStandard, 1, 3)}</b>. Where AUC and lift disagree, believe AUC.`; })()}</div>

      <h3>What arrives without form</h3>
      <div class="wrap"><table><thead><tr><th>league :: stat</th><th>graded picks</th></tr></thead><tbody>${noFormRows}</tbody></table></div>

      <h3>Does the judge beat the tier?</h3>
      <div class="wrap"><table><thead><tr><th>tier</th><th>n</th><th>top 50%</th><th>top 25%</th><th>top 10%</th><th>top 5%</th><th>top 3<br><span class="mut">/run</span></th><th>top 5<br><span class="mut">/run</span></th><th>top 10<br><span class="mut">/run</span></th><th>lift (pts)</th><th>AUC</th><th>break-even</th></tr></thead><tbody>${skillRows}</tbody></table></div>
      <div class="callout">Calibration asks whether the percentages are <i>honest</i>; this asks whether they are
        <i>useful</i> — inside a single tier, the judge's own top-rated half against its bottom-rated half. A judge
        can be perfectly calibrated and still have nothing bettable — being honest about a bad number does not make it a
        good one. <b>Top N per run</b> is the cut the engine actually makes — its best few from one slate — not
        the median split, which averages away exactly the tail that gets wagered. Cells under ${MIN_SLICE_N} picks
        show only the count.</div>
    </div>
  </details>

  <details class="qsection">
    <summary>
      <div class="qhead"><div class="qtitle" style="color:var(--dim)">Housekeeping</div><div class="qanswer dim">${housekeepingAnswer}</div></div>
      <div class="qmeta">by prop type · by league · pending by day · spend &nbsp;&nbsp;<span class="mut qhint"><span class="oc">open ↓</span><span class="cc">close ↑</span></span></div>
    </summary>
    <div class="qbody">
      <h3>By prop type</h3>
      <div class="wrap"><table><thead><tr><th>league :: stat</th><th>n</th><th>claimed</th><th>actual</th><th>gap (pts)</th><th>tiers</th></tr></thead><tbody>${statRows}</tbody></table></div>
      <div class="callout">Ranked by total error contributed. Rarity alone should not show up here — PrizePicks
        already prices it into the tier — so what shows up is what the tier doesn't capture.</div>

      <h3>By league</h3>
      <div class="wrap"><table><thead><tr><th>league</th><th>graded</th><th>record</th><th>win rate</th><th>brier</th><th></th></tr></thead><tbody>${leagueRows}</tbody></table></div>
      <div class="callout">Each league scored on its own — a rater can be sharp on baseball and hopeless on tennis,
        and one blended number says neither. Every league needs its own ~50 graded picks before it means anything.</div>

      <h3>Pending (gradeable) by day</h3>
      <div class="wrap"><table><thead><tr><th>date</th><th>pending</th></tr></thead><tbody>${pendRows}</tbody></table></div>
      <div class="callout">Most pending is tonight's slate — the daily grader clears each day the morning after.
        Combos can't be graded this way; "given up" (${a.givenUp}) tried 3× with no result; combos skipped: ${a.combos}.</div>

      <h3>API spend (30 days)</h3>
      <div class="cards">
        ${card('$' + (a.spend?.today ?? 0).toFixed(2), 'today', '')}
        ${card('$' + (a.spend?.week ?? 0).toFixed(2), '7 days', '')}
        ${card('$' + (a.spend?.month ?? 0).toFixed(2), '30 days', '')}
      </div>
      <div class="wrap" style="margin-top:12px"><table><thead><tr><th>call</th><th>runs</th><th>$ / run</th><th>in</th><th>out</th><th>searches</th><th>input share</th></tr></thead><tbody>${runRows}</tbody></table></div>
      <div class="callout">Input tokens are nearly always the driver — web search RESULTS bill as input — so when
        <b>input share</b> is high the lever is the search budget, not the model's verbosity.</div>
      <div class="wrap" style="margin-top:12px"><table><thead><tr><th>feature</th><th>spend (30d)</th></tr></thead><tbody>
        ${Object.entries(a.spend?.byFeature || {}).sort((x, y) => y[1] - x[1]).map(([f, v]) => `<tr><td>${esc(f)}</td><td>$${v.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">no metered calls yet</td></tr>'}
      </tbody></table></div>
    </div>
  </details>

  <details style="margin:34px 0 12px;border:1px solid var(--line);border-radius:6px;padding:2px 14px 14px">
    <summary style="cursor:pointer;padding:12px 0;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim)">Legacy engines
      <span style="text-transform:none;letter-spacing:normal;color:var(--faint);font-size:11px">— Psyche/Opus/Sonnet, n=${legacyN} graded, collapsed by default</span></summary>
    <div class="callout amber" style="margin-top:0">Everything above this point is <b>Vilifiant only</b>. These rows
      predate it, or are one-off experiments run deliberately on a different model from the dev console — they
      differ in <b>both</b> prompt version and model from the numbers above, at once, so there is no clean
      single-variable contrast to draw. This is a historical record, never pooled into anything above and never
      presented as a comparison.</div>
    ${legacyBlock}
  </details>

  <div class="sub" style="margin-top:30px">generated ${new Date().toISOString()} · <a href="/" style="color:var(--dim)">← terminal</a></div>
</body></html>`;
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

    let keys = [];
    try { keys = (await store.list()).blobs.map((b) => b.key); } catch { keys = []; }

    // optional ?days=N filter on the date-keyed log
    if (q.days) {
      const cutoff = new Date(Date.now() - Number(q.days) * 86400000).toISOString().slice(0, 10);
      keys = keys.filter((k) => k >= cutoff);
    }

    const days = await mapLimit(keys, 12, async (k) => {
      try { const day = await store.get(k, { type: 'json' }); return Array.isArray(day) ? day : []; }
      catch { return []; }
    });
    let picks = days.flat();
    if (q.league) picks = picks.filter((p) => p.league === q.league);

    // Vilifiant-only is the default scope for every figure below — see
    // CURRENT_ENGINE above. Legacy rows get their own, separate aggregate so
    // their numbers can be shown (collapsed, clearly labelled) without ever
    // pooling into anything above them.
    const legacyPicks = picks.filter(isLegacyRow);
    const currentPicks = picks.filter((p) => !isLegacyRow(p));
    const agg = aggregate(currentPicks);
    agg.legacy = aggregate(legacyPicks, { perLeague: false });

    // ---- API spend (from cost-log, written by judge/ask/reevaluate) --------
    // perRun breaks a judge call into its parts. The month's bill is a single
    // number that cannot be acted on; "each run reads 150k tokens because it
    // runs 8 web searches" can be. Input tokens are almost always the driver —
    // search RESULTS bill as input, and at Opus rates a handful of searches
    // costs more than everything the model writes.
    const spend = { today: 0, week: 0, month: 0, byFeature: {}, byModel: {}, perRun: {} };
    try {
      const costStore = getStore({ name: 'cost-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      let ckeys = [];
      try { ckeys = (await costStore.list()).blobs.map((b) => b.key); } catch { ckeys = []; }
      const today = new Date().toISOString().slice(0, 10);
      const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const recent = ckeys.filter((k) => k >= d30);
      const costDays = await mapLimit(recent, 12, async (k) => {
        try { return { k, entries: (await costStore.get(k, { type: 'json' })) || [] }; }
        catch { return { k, entries: [] }; }
      });
      for (const { k, entries } of costDays) {
        for (const e of entries) {
          const usd = e.usd || 0;
          spend.month += usd;
          if (k >= d7) spend.week += usd;
          if (k === today) spend.today += usd;
          spend.byFeature[e.feature] = (spend.byFeature[e.feature] || 0) + usd;
          spend.byModel[e.model] = (spend.byModel[e.model] || 0) + usd;
          const r = (spend.perRun[`${e.feature} · ${e.model}`] ||= { runs: 0, usd: 0, inTok: 0, outTok: 0, searches: 0 });
          r.runs++; r.usd += usd; r.inTok += e.inTok || 0; r.outTok += e.outTok || 0; r.searches += e.searches || 0;
        }
      }
    } catch { /* spend section is best-effort */ }
    for (const r of Object.values(spend.perRun)) {
      r.usdPerRun = r.usd / r.runs;
      r.inPerRun = Math.round(r.inTok / r.runs);
      r.outPerRun = Math.round(r.outTok / r.runs);
      r.searchesPerRun = Math.round((r.searches / r.runs) * 10) / 10;
      // What share of the bill the input side is. Above ~80% the lever is the
      // search budget and the payload, not the model's verbosity.
      r.inputShare = r.usd > 0 ? 1 - (r.outTok / 1e6 * 25) / r.usd : null;
    }
    agg.spend = spend;
    // ------------------------------------------------------------------------

    if (q.format === 'json') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(agg, null, 2) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: renderHTML(agg) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

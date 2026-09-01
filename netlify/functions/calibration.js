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
function dedupe(picks) {
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
      byTier: {},
    });
    b.n++; b.sum += prob; b.sumSq += prob * prob;
    // A probability landing exactly on a multiple of 0.05 is weak evidence on
    // its own and strong in aggregate: it is what a model produces when it picks
    // a verdict first and writes a number to match.
    if (Math.abs(prob * 20 - Math.round(prob * 20)) < 1e-9) b.round++;
    if (p.cleared != null) b.cleared++;
    b.distinct.set(prob.toFixed(2), (b.distinct.get(prob.toFixed(2)) || 0) + 1);
    const t = (b.byTier[p.oddsType || 'unknown'] ||= { n: 0, sum: 0 });
    t.n++; t.sum += prob;
  }
  for (const b of Object.values(out.behaviour)) {
    b.meanProb = b.sum / b.n;
    b.spread = Math.sqrt(Math.max(0, b.sumSq / b.n - b.meanProb ** 2));
    b.roundShare = b.round / b.n;
    b.clearedShare = b.cleared / b.n;
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
  }

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

  const breakdown = (obj) => Object.entries(obj).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.hits / v.n)}</td></tr>`).join('') ||
    '<tr><td colspan="3" class="mut">—</td></tr>';

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
      <td>${pct(v.clearedShare)}</td><td>${v.effectiveValues} <span class="mut">of ${v.distinctValues}</span></td></tr>`;
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

  const plWin = a.playsLeans.n ? a.playsLeans.hits / a.playsLeans.n : null;
  const record = a.playsLeans.n ? `${a.playsLeans.hits}–${a.playsLeans.n - a.playsLeans.hits}` : '—';

  const stateNote = n === 0
    ? `<div class="callout">No graded picks yet. The grader runs every morning and fills in results once games settle — this page starts meaning something a day or two after your first logged slate.</div>`
    : early
      ? `<div class="callout amber"><b>EARLY — n=${n}.</b> Below ~50 graded picks these numbers are mostly noise: a hot or cold week can swing them wildly. Don't draw conclusions (or settle arguments) yet.</div>`
      : `<div class="callout">Calibration scores every logged pick — plays, leans and passes alike — so the numbers can't be flattered by only counting winners. "Diff" is actual minus predicted; green is honest (±4pts), red is off by 10+.</div>`;

  const card = (v, l, sub) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

  // Vilifiant only — the headline above is pooled across every model this app
  // has ever run (Psyche/Opus and Sonnet included), which is the right number
  // for comparing configs but the wrong one for "how good is it right now":
  // Vilifiant is the only model still in use, and old Opus/Sonnet runs sitting
  // in the same average make current performance look better or worse than it
  // is depending on how those compared. Pulled straight from `byModel` — same
  // rows the per-model table further down uses, just surfaced where it doesn't
  // require scrolling past a comparison against retired models to find it.
  const vil = a.byModel?.Vilifiant;
  const vilEarly = vil && vil.n > 0 && vil.n < 50;
  const vilBlock = !vil || !vil.n
    ? `<div class="callout">No Vilifiant-judged picks are graded yet.</div>`
    : `<div class="cards">
        ${card(vil.n, 'graded', vilEarly ? 'early — under 50' : '')}
        ${card(pct(vil.actual), 'over rate', 'predicted ' + pct(vil.predicted))}
        ${card(vil.brier.toFixed(3) + (vilEarly ? ' <span style="font-size:11px;color:var(--amb)">n=' + vil.n + '</span>' : ''),
          'brier ↓', vilEarly ? 'early — mostly noise' : 'lower is better')}
        ${card(
          vil.baseline == null ? '—' : `<span style="color:${vil.beatsBaseline ? 'var(--grn)' : 'var(--red)'}">${vil.baseline.toFixed(4)}</span>`,
          'tier-only baseline',
          vil.baselineDelta == null ? 'not enough graded picks'
            : vil.beatsBaseline ? `ahead by ${Math.abs(vil.baselineDelta).toFixed(4)}`
              : `BEHIND by ${vil.baselineDelta.toFixed(4)}`)}
      </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#000000"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>AtomBets · Calibration</title><style>
  :root{color-scheme:dark;--bg:#000;--ink:#fff;--dim:#8f8f8f;--faint:#4a4a4a;--line:#1c1c1c;
    --grn:#7ee2a8;--amb:#e2c97e;--red:#e28c7e;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}
  body{font:13px/1.6 var(--mono);background:var(--bg);color:var(--ink);margin:0;padding:26px 18px 60px;max-width:720px;margin-inline:auto}
  h1{font:800 22px/1.2 -apple-system,'Helvetica Neue',sans-serif;letter-spacing:-.02em;margin:0}
  h1 span{color:var(--dim);font-weight:600}
  .sub{color:var(--dim);font-size:11px;margin:6px 0 22px}
  h2{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim);font-weight:600;
    margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline}
  h2 a{color:var(--faint);text-decoration:none;letter-spacing:.04em;margin-left:auto}
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
</style></head><body>
  <h1>AtomBets <span>· Calibration</span></h1>
  <div class="sub">when the engine says 65%, does it hit 65%? — every logged pick counts, passes included</div>

  <div class="cards">
    ${card(n, 'graded', a.pendingGradeable ? a.pendingGradeable + ' pending' : '')}
    ${card(record, 'plays+leans W–L', plWin != null ? pct(plWin) + ' win rate' : '')}
    ${card(pct(a.overall), 'over rate', 'all graded picks')}
    ${card(a.brier == null ? '—' : a.brier.toFixed(3) + (early ? ' <span style="font-size:11px;color:var(--amb)">n=' + n + '</span>' : ''), 'brier ↓', early ? 'early — mostly noise' : 'lower is better')}
    ${card(
      a.baseline == null ? '—'
        : `<span style="color:${a.beatsBaseline ? 'var(--grn)' : 'var(--red)'}">${a.baseline.toFixed(4)}</span>`,
      'tier-only baseline',
      a.baselineDelta == null ? 'not enough graded picks'
        : a.beatsBaseline
          ? `judge ahead by ${Math.abs(a.baselineDelta).toFixed(4)}`
          : `judge BEHIND by ${a.baselineDelta.toFixed(4)}`)}
  </div>
  <div class="callout${a.beatsBaseline === false ? ' amber' : ''}">The <b>tier-only baseline</b> is what a three-row
    lookup table would have scored on these exact picks — output the tier's own base rate for every pick in that
    tier, and use nothing else. No player, no matchup, no model. It is the cheapest thing that could possibly
    work, and it is the bar the judge has to clear to justify existing.
    ${a.beatsBaseline === false
      ? '<b>The judge is currently behind it.</b> Every point of the model\'s reasoning is, so far, costing accuracy rather than adding it — so the first job of any change is to close that gap, not to look clever.'
      : a.beatsBaseline === true
        ? 'The judge is ahead of it, which is the minimum condition for the model earning its cost.'
        : ''}
    Fitted on the rows it is scored against, which hands it hindsight and makes it harder to beat — the right
    direction for a bar.</div>

  <h2>VILIFIANT ONLY <span style="text-transform:none;letter-spacing:normal;font-weight:400">— the standing default; Psyche/Opus/Sonnet runs above are excluded</span></h2>
  ${vilBlock}

  ${stateNote}

  <h2>By engine <a href="/api/calibration?format=json">json ↗</a></h2>
  <div class="wrap"><table><thead><tr><th>source</th><th>n</th><th>over rate</th><th>brier ↓</th></tr></thead><tbody>${engineRows}</tbody></table></div>
  <div class="callout">Brier is the honest scoreboard: right AND not overclaiming. A rater saying 90% on legs that hit 70% scores <i>worse</i> (0.250) than one saying 70% (0.210). Compare engines on this, never on whose percentages look bigger.</div>

  <h2>Calibration by predicted band</h2>
  <div class="wrap"><table><thead><tr><th>P(over) band</th><th>n</th><th>predicted</th><th>actual</th><th>diff (pts)</th></tr></thead><tbody>${bandRows}</tbody></table></div>

  <h2>Verdict performance</h2>
  <div class="wrap"><table><thead><tr><th>verdict</th><th>n</th><th>win rate</th></tr></thead><tbody>
    <tr><td>play</td><td>${a.plays.n}</td><td>${a.plays.n ? pct(a.plays.hits / a.plays.n) : '—'}</td></tr>
    <tr><td>play + lean</td><td>${a.playsLeans.n}</td><td>${a.playsLeans.n ? pct(plWin) : '—'}</td></tr>
  </tbody></table></div>

  <h2>Judge version — head to head</h2>
  <div class="wrap"><table><thead><tr><th>judge</th><th>n</th><th>claimed</th><th>actual</th><th>overstated</th><th>brier ↓</th><th>baseline</th><th>vs baseline</th><th></th></tr></thead><tbody>${promptRows}</tbody></table></div>
  <div class="callout"><b>Psyche</b> is the original judge; <b>Aphrodite</b> is the refinement. "Claimed" is the
    average probability the version put on its picks, "actual" is how often they hit. The gap between them is the
    honest measure of whether the percentages mean anything — a judge claiming 68% on legs that hit 52% is
    overstating by 16 points, and no win rate on its own shows that. Rows before versioning read as
    <i>psyche (untagged)</i>. Both need ~50 graded picks each before the comparison is worth acting on, and the
    cleanest test is running the two on the SAME slate — different nights differ more than the prompts do.</div>

  <h2>Judge behaviour — readable the same day</h2>
  <div class="wrap"><table><thead><tr><th>judge · model</th><th>picks</th><th>tier gap</th><th>spread</th><th>round numbers</th><th>form coverage</th><th>values used</th></tr></thead><tbody>${behRows}</tbody></table></div>
  <div class="callout">Everything else on this page waits for games to settle — weeks before a prompt or model
    change can be judged. This does not: it reads every logged pick, graded or not, so a run can be checked the
    hour it finishes.
    <br><br><b>Tier gap</b> is the headline, and the direct test of whether a cheaper model still follows a
    demanding prompt. Aphrodite's central instruction is that a goblin line is priced as likely (~70%) and a
    demon as unlikely (~20%), so a judge that actually read it puts a wide gap between the two. Psyche was never
    told the tier and averaged ~52% on everything — a gap near zero is what that looks like. <b>Spread</b> and
    <b>values used</b> say whether the judge uses the full range or hedges toward the middle. The latter is a
    perplexity — 2^H over how often each distinct probability appears, i.e. how many values the judge is
    <i>effectively</i> using, with the raw count beside it. A plain distinct/n ratio was not comparable between
    configs: it falls as n grows, so the judge with more picks looked less granular for free; a high share of
    <b>round numbers</b> (multiples of 0.05) is what you get when a model picks a verdict first and writes a
    number to justify it. <b>Filled "cleared"</b> is a COVERAGE metric, not an obedience one. It was first read as
    instruction-following until the log settled it: of the props that reached the judge carrying recent5, every
    one came back with the count filled, and of those without it, none did — so the floor on this number is set
    by how often recent form reaches the payload at all (currently ~60%), not by whether the judge chose to fill
    it in. A low value is a data-sourcing gap, not a judge defect on its own.
    <br><br>But that is not the whole story. A same-input replay (see docs/judge-measurement.md, "cleared" fill
    is not run-to-run stable) held one slate's payload fixed — same props, same recent5 availability on every
    single one, five independent replays — and the fill count still moved from 16 to 26 out of the same ~56-60
    eligible props each time. Recent5 coverage cannot explain that: it does not change between replays of the
    same snapshot. So above its data-sourcing floor, filling "cleared" is unreliable run to run — the judge does
    not consistently report the count even when it has everything it needs to.</div>

  <h2>Model — head to head</h2>
  <div class="wrap"><table><thead><tr><th>model</th><th>n</th><th>claimed</th><th>actual</th><th>overstated</th><th>brier ↓</th><th>baseline</th><th>vs baseline</th><th></th></tr></thead><tbody>${modelRows}</tbody></table></div>
  <div class="callout">Scored exactly like the judge versions, and for the same reason: the judge runs on Opus
    because it always has, not because anything cheaper was tried and lost. Sonnet costs 2.5x less per run and
    Haiku 5x, so a cheaper model that scores the same is not a small saving — it is several times more graded
    data for the same budget, which is the thing this whole page is short of. Rows before model tagging read as
    <i>untagged</i>.</div>

  <h2>By tier</h2>
  <div class="wrap"><table><thead><tr><th>tier</th><th>n</th><th>win rate</th></tr></thead><tbody>${breakdown(a.byTier)}</tbody></table></div>

  <h2>Did the judge have anything to work with?</h2>
  <div class="wrap"><table><thead><tr><th>rows</th><th>n</th><th>brier ↓</th><th>baseline</th><th>vs baseline</th><th></th><th>within-tier lift</th></tr></thead><tbody>${formRows}</tbody></table></div>
  <div class="callout">${a.byFormCoverage?.formCoverage == null ? '' :
      `<b>${pct(a.byFormCoverage.formCoverage)}</b> of graded picks reached the judge carrying recent form; the
       rest arrived with none. `}The prompt's own fallback without form is to lean on the payout tier — which is
    exactly what the baseline already is — so on the uncovered rows the judge may be structurally unable to beat
    the floor, and a pooled Brier would hide that behind the rows where it could actually reason.
    <b>recentAvg</b> is written only when the payload carried recent5, so this splits on a record of what the
    judge was fed rather than a guess at it.
    <br><br>Beating the baseline on <b>has form</b> and losing on <b>NO form</b> would mean the deficit is data
    coverage, and the fix is wiring form sources for the stats below rather than touching a prompt. Losing on
    both means the judge is not adding signal even when fully fed.
    <br><br><b>Read the lifts with their intervals.</b> Each is a difference of two proportions on half a tier,
    so a -2.0pt lift on 402 picks carries ±4.6 and cannot be told from zero; bare, it reads as an inversion that
    the data does not support. <b>AUC</b> beside it is the better measure — the chance a randomly chosen hit is
    ranked above a randomly chosen miss, using every pairwise comparison rather than only which side of the
    median a pick fell on, which at these sample sizes is a large gain in power.
    ${(() => { const d = a.byFormCoverage?.noFormMinusHasForm; if (!d?.lift) return '';
      const f = (x, s = 100, dp = 1) => x == null ? '—'
        : `${(x.estimate * s >= 0 ? '+' : '') + (x.estimate * s).toFixed(dp)} ± ${(x.se * s).toFixed(dp)} (z ${x.z.toFixed(2)})`;
      return `<br><br><b>No-form minus has-form</b>, paired on tier and pooled by inverse variance — the only
      well-powered statement available here, since no single bucket is:
      <br>&nbsp;&nbsp;lift, all tiers: <b>${f(d.lift)}</b> &nbsp;·&nbsp; goblin+standard only:
      <b>${f(d.liftGoblinStandard)}</b>
      <br>&nbsp;&nbsp;AUC, all tiers: <b>${f(d.auc, 1, 3)}</b> &nbsp;·&nbsp; goblin+standard only:
      <b>${f(d.aucGoblinStandard, 1, 3)}</b>
      <br>Both poolings are shown because the narrower set could only be chosen after seeing which tier diluted
      the estimate, and picking it on that basis is selecting on the outcome. Where AUC and lift disagree,
      believe AUC — it is the better powered. Treat |z| near 2 as suggestive, never settled.`; })()}</div>

  <h2>What arrives without form</h2>
  <div class="wrap"><table><thead><tr><th>league :: stat</th><th>graded picks</th></tr></thead><tbody>${noFormRows}</tbody></table></div>

  <h2>Does the judge beat the tier?</h2>
  <div class="wrap"><table><thead><tr><th>tier</th><th>n</th><th>top 50%</th><th>top 25%</th><th>top 10%</th><th>top 5%</th><th>top 3<br><span class="mut">/run</span></th><th>top 5<br><span class="mut">/run</span></th><th>top 10<br><span class="mut">/run</span></th><th>lift (pts)</th><th>AUC</th><th>break-even</th></tr></thead><tbody>${skillRows}</tbody></table></div>
  <div class="callout">The question calibration cannot answer. Calibration asks whether the percentages are
    <i>honest</i>; this asks whether they are <i>useful</i>. Inside a single tier, the judge's own top-rated half
    is compared against its bottom-rated half. <b>Lift</b> is the gap — if it is near zero the judge is only
    reading the tier back to us, and a one-line rule would do the same job for free. The split is deliberately
    kept inside one tier: across all picks the judge looks skilled, but nearly all of that is goblins outscoring
    demons, which the tier already told us. <b>Break-even</b> is the per-leg rate a pure-tier 3-pick Power needs
    just to return the stake, and <b>bettable</b> asks whether even the judge's best half clears it. A judge can
    be perfectly calibrated and still have nothing bettable — being honest about a bad number does not make it a
    good one.
    <br><br><b>The selection curve is the decision, and the median split is not.</b> "Best half" asks about the
    top 50% of a tier, which is not a cut anyone bets — selection takes the top few of ~44 props, so a median
    split on a genuinely skilled ranker averages the tail that gets wagered together with the middle that never
    does, and can return "does not clear break-even" as a false negative.
    <br><br>The <b>percentage</b> columns narrow over the pooled tier. The <b>top N per run</b> columns are the
    cut the engine actually makes: its best few from ONE slate, pooled across runs, because the top 3 of a whole
    season's log is not a bet either. Green means that cell clears its own break-even. Every cell carries the
    count behind it, and any under ${MIN_SLICE_N} picks shows only that count — a hit rate on a dozen picks is
    not evidence, and printed beside a break-even it invites exactly the conclusion it cannot support.
    <br><br><b>Lift</b> and <b>bestHalfClears</b> are kept for continuity but are no longer the verdict. Lift
    carries its own interval for the reason given above; AUC beside it uses every pairwise comparison instead of
    only which side of the median a pick fell on, and is the better powered of the two.</div>

  <h2>How close, not just whether</h2>
  <div class="wrap"><table><thead><tr><th>league :: stat</th><th>n</th><th>mean margin</th><th>spread</th><th>losses</th><th>near miss</th><th>not close</th><th>saved by −1</th></tr></thead><tbody>${marginRows}</tbody></table></div>
  <div class="wrap" style="margin-top:12px"><table><thead><tr><th>tier</th><th>n</th><th>mean margin (σ)</th></tr></thead><tbody>${mtRows}</tbody></table></div>
  <div class="callout">Grading is binary and stays that way — PrizePicks pays the same nothing for missing over 3.5
    with 3 as for missing over 6.5 with 1, so scoring closeness would be scoring something nobody pays for. But
    those two misses say completely different things about the <i>judge</i>, and a Brier score cannot tell them
    apart.
    <br><br><b>Mean margin</b> is how far the real result lands from the line, in that stat's own units: positive
    means the overs are live and the line is set low. <b>Near miss</b> is the share of losses that came within
    half a spread of flipping — high means variance, and the read was basically right. <b>Not close</b> is the
    share that were never in it, which is the signature of a prop the engine does not understand rather than one
    that broke badly. <b>Saved by −1</b> is the directly actionable column: of the overs that lost, how many
    would have won a whole unit lower, which is roughly where the goblin alt line sits on the same prop.
    <br><br>Margins are never pooled raw — a miss of 0.5 is everything on a home-run line and nothing on a
    Fantasy Score line of 25 — so each stat is z-scored against its own spread before the tier table combines
    them. Stats with fewer than 12 graded picks are left out rather than given a spread computed from noise.</div>

  <h2>By prop type</h2>
  <div class="wrap"><table><thead><tr><th>league :: stat</th><th>n</th><th>claimed</th><th>actual</th><th>gap (pts)</th><th>tiers</th></tr></thead><tbody>${statRows}</tbody></table></div>
  <div class="callout">Ranked by total error contributed — the gap times the number of picks — so the rows at the
    top are where the Brier score actually goes, not the largest percentage misses on six picks. <b>Gap</b> is
    claimed minus actual: positive means the engine talks that prop type up, negative means it talks it down.
    Rarity alone should NOT show up here: a home run "over 0.5" is unlikely, but that is exactly why PrizePicks
    prices it as standard or demon, so the tier already carries it. What shows up here is what the tier
    <i>doesn't</i> capture — a stat the engine misreads on its own terms. Rows under 20 graded are greyed.
    The <b>tiers</b> column gives each tier's own over-rate where it has 25+ graded picks: a prop type's blended
    rate mixes goblin lines going over ~70% with demon lines going over ~20%, so only the per-tier number is
    safe to quote at an individual prop.</div>

  <h2>By league</h2>
  <div class="wrap"><table><thead><tr><th>league</th><th>graded</th><th>record</th><th>win rate</th><th>brier</th><th></th></tr></thead><tbody>${leagueRows}</tbody></table></div>
  <div class="callout">Each league is scored on its own. A rater can be sharp on baseball and hopeless on
    tennis, and one blended number says neither — but splitting the sample means every league needs its own
    ~50 graded picks before it means anything, so most will read EARLY for a while. Lower Brier is better;
    0.25 is what you'd score by guessing 50% on everything.</div>

  <h2>Pending (gradeable) by day</h2>
  <div class="wrap"><table><thead><tr><th>date</th><th>pending</th></tr></thead><tbody>${pendRows}</tbody></table></div>
  <div class="callout">Most pending is tonight's slate — the daily grader clears each day the morning after. Combos can't be graded this way; "given up" (${a.givenUp}) tried 3× with no result; combos skipped: ${a.combos}.</div>

  <h2>API spend (30 days)</h2>
  <div class="cards">
    ${card('$' + (a.spend?.today ?? 0).toFixed(2), 'today', '')}
    ${card('$' + (a.spend?.week ?? 0).toFixed(2), '7 days', '')}
    ${card('$' + (a.spend?.month ?? 0).toFixed(2), '30 days', '')}
  </div>
  <div class="wrap" style="margin-top:12px"><table><thead><tr><th>call</th><th>runs</th><th>$ / run</th><th>in</th><th>out</th><th>searches</th><th>input share</th></tr></thead><tbody>${runRows}</tbody></table></div>
  <div class="callout">What one run actually costs, and where it goes. Input tokens are nearly always the driver:
    web search RESULTS bill as input, so a run doing 8 searches reads far more than it writes. When <b>input
    share</b> is high the lever is the search budget and the size of the shortlist, not the model's verbosity —
    and note that the searches largely go looking for confirmed lineups, which the MLB and ESPN feeds already
    supply for free elsewhere in the same run.</div>

  <div class="wrap" style="margin-top:12px"><table><thead><tr><th>feature</th><th>spend (30d)</th></tr></thead><tbody>
    ${Object.entries(a.spend?.byFeature || {}).sort((x, y) => y[1] - x[1]).map(([f, v]) => `<tr><td>${esc(f)}</td><td>$${v.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">no metered calls yet</td></tr>'}
  </tbody></table></div>

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

    const agg = aggregate(picks);

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

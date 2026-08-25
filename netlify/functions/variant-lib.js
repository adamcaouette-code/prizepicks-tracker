// netlify/functions/variant-lib.js
//
// Phase 1 of a tail-only prompt variant test (THEMIS, and any future one): run
// k independent calls of a DIFFERENT system prompt against a snapshot's FIXED
// payload and search context, then analyse the k runs among THEMSELVES.
//
// HOW THIS DIFFERS FROM replay-lib.js
// replay-lib.js is an A/A harness: one real ORIGINAL response plus k replays of
// the SAME prompt, asking whether the harness reproduces a call that actually
// happened. A variant was never run live — there is no "original" THEMIS
// response to replay against — so there is nothing privileged about any one of
// the k runs. Every pairwise comparison among them is the same kind of
// comparison, which is why this file computes all C(k,2) pairs symmetrically
// rather than splitting them into "vs original" and "vs each other".
//
// What stays FIXED, exactly as the snapshot recorded it: userContent (the
// payload), search (the prefilled turn), maxSearches, model. What changes:
// system — built fresh from the variant's own promptFor(league), never taken
// from the snapshot. That is what makes this a TAIL-only test: the payload a
// tail-only variant receives is identical to the one the original head/payload
// combination produced, because entryFor is shared (see judge-prompts.js).

import { buildRequest, searchesIssued, comparePair, behaviour, keyOf, mean, pearson } from './replay-lib.js';
import { parsePicks } from './bet-finder-background.js';

/**
 * Make k independent calls of `variant`'s prompt against a snapshot's fixed
 * payload and search context. Returns k runs, none of them privileged.
 */
export async function runVariant(snap, variant, { k = 5, key = process.env.ANTHROPIC_API_KEY, call } = {}) {
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const system = variant.promptFor(snap.league);
  const req = buildRequest({ ...snap, system });
  const runs = [];
  const warnings = [];
  const excluded = [];
  for (let i = 0; i < k; i++) {
    const data = await call(req, key);
    const issued = searchesIssued(data.content);
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const run = { label: `run-${i + 1}`, picks: parsePicks(text), usage: data.usage || null };
    if (issued) {
      // A run that searched live read text the snapshot never carried — a
      // fidelity break in that run, not a data point about THIS variant.
      // Excluded from the analysis rather than folded in with only a warning:
      // this is exactly how a THEMIS run once quietly widened the churn/
      // Jaccard numbers it was never supposed to be part of.
      const reason = `issued ${issued} live search(es) — not an offline replay`;
      warnings.push(`${run.label} ${reason}`);
      excluded.push({ label: run.label, reason });
      continue;
    }
    runs.push(run);
  }
  return { variant: variant.name, system, runs, warnings, excluded, kRequested: k };
}

// ---------------------------------------------------------------------------
// Symmetric pairwise comparison — every pair of k runs is the same kind of
// comparison, so there is no "original" to split out.
// ---------------------------------------------------------------------------

export function pairwiseAll(runs) {
  const pairs = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) pairs.push(comparePair(runs[i], runs[j]));
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Standout replication — the headline number for a variant whose whole design
// is "move a few props decisively, leave the rest at the tier rate".
// ---------------------------------------------------------------------------

const standoutSet = (run) => new Set(run.picks.filter((p) => p.standout === true).map(keyOf));

/** |A∩B| / |A∪B|. Both empty is reported as null — "identical" would overstate
 * an agreement that consists of nothing being flagged by either run. */
function jaccard(a, b) {
  const inter = [...a].filter((k) => b.has(k)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : null;
}

/**
 * How often the SAME prop gets flagged standout across k runs, and whether
 * that is more consistent than flagging n props at random each time.
 *
 * The random baseline is an approximation, disclosed as one: for two runs that
 * each flag n props independently at random out of N candidates, the expected
 * intersection size is n²/N (hypergeometric mean), which gives an expected
 * Jaccard of (n²/N) / (2n − n²/N). This is the ratio of EXPECTATIONS, not the
 * expectation of the ratio (a subtly different, more complex quantity) — close
 * enough to sanity-check "did the judge do better than chance", not tight
 * enough to hang a p-value on.
 */
export function standoutReplication(runs, universe) {
  const sets = runs.map(standoutSet);
  const sizes = sets.map((s) => s.size);
  const pairJaccard = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) pairJaccard.push(jaccard(sets[i], sets[j]));
  }
  const N = universe ?? Math.max(1, ...runs.map((r) => r.picks.length));
  const counts = new Map();
  for (const s of sets) for (const key of s) counts.set(key, (counts.get(key) || 0) + 1);
  const histogram = {};
  for (let j = 0; j <= runs.length; j++) histogram[j] = 0;
  for (const n of counts.values()) histogram[n] = (histogram[n] || 0) + 1;
  const meanSize = mean(sizes);
  // Expected pairwise Jaccard under independent random flagging of the mean
  // set size, as the "what chance alone would give you" comparison point.
  const n = meanSize || 0;
  const expInter = (n * n) / N;
  const expUnion = 2 * n - expInter;
  const expectedRandomJaccard = expUnion > 0 ? expInter / expUnion : null;
  return {
    setSizes: sizes,
    meanSetSize: meanSize,
    pairJaccard,
    meanPairJaccard: mean(pairJaccard.filter((x) => x != null)),
    // histogram[j] = number of DISTINCT props flagged standout in exactly j of
    // the k runs. histogram[0] is not populated (props never flagged are never
    // added to `counts`) — reported as "not counted" rather than a fabricated 0
    // over an ill-defined universe (every prop no run touched would count too).
    histogram,
    expectedRandomJaccard,
    verdict: mean(pairJaccard.filter((x) => x != null)) == null ? 'no standouts flagged in any run — nothing to replicate'
      : mean(pairJaccard.filter((x) => x != null)) > (expectedRandomJaccard ?? 0) * 2
        ? 'replicates well above the chance baseline'
        : 'near the chance baseline — flagged standouts do not repeat reliably',
  };
}

/**
 * For flagged standouts only: how far from the tier's measured rate.
 *
 * `tiers` is required, not optional. The judge's OWN output never carries a
 * tier — it is not in the requested schema, so a real response has only
 * player/stat/line/prob/cleared/standout/key_risk/reasoning. The pipeline
 * normally re-attaches tier from the payload side (attachSource, keyed by
 * player+stat+line); this is the same lookup, done here because runVariant's
 * raw picks never go through attachSource.
 */
export function standoutMoveDistribution(runs, tierRates, tiers = {}) {
  const moves = [];
  for (const run of runs) {
    for (const p of run.picks) {
      if (p.standout !== true) continue;
      const rate = tierRates[String(p.oddsType || p.tier || tiers[keyOf(p)] || '').toLowerCase()];
      if (rate == null || !isFinite(Number(p.prob))) continue;
      moves.push(Math.abs(Number(p.prob) - rate));
    }
  }
  return {
    n: moves.length,
    mean: mean(moves),
    min: moves.length ? Math.min(...moves) : null,
    max: moves.length ? Math.max(...moves) : null,
  };
}

// ---------------------------------------------------------------------------
// Calibration survival — a variant that breaks tier discrimination is not
// viable regardless of what its standouts do.
// ---------------------------------------------------------------------------

export function tierCalibration(runs, tierRates, tiers = {}) {
  return runs.map((run) => {
    const b = behaviour(run.picks, tiers);
    const byTier = {};
    for (const t of Object.keys(tierRates)) {
      const probs = run.picks
        .filter((p) => String(p.oddsType || p.tier || tiers[keyOf(p)] || '').toLowerCase() === t)
        .map((p) => Number(p.prob)).filter((x) => isFinite(x));
      byTier[t] = { n: probs.length, meanProb: mean(probs), measuredRate: tierRates[t],
        diff: probs.length ? mean(probs) - tierRates[t] : null };
    }
    return { label: run.label, tierGap: b.tierGap, byTier };
  });
}

// ---------------------------------------------------------------------------
// Rank correlation against the real, live original — the one comparison here
// that needs the snapshot's actual response, not just the k new runs.
// ---------------------------------------------------------------------------

/** Average rank, so a tie doesn't arbitrarily favour whichever came first. */
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation on props both runs answered. */
export function rankCorrelation(runA, runB) {
  const A = new Map(runA.picks.map((p) => [keyOf(p), Number(p.prob)]));
  const B = new Map(runB.picks.map((p) => [keyOf(p), Number(p.prob)]));
  const shared = [...A.keys()].filter((k) => B.has(k));
  const xs = shared.map((k) => A.get(k)), ys = shared.map((k) => B.get(k));
  return { n: shared.length, spearman: pearson(ranks(xs), ranks(ys)) };
}

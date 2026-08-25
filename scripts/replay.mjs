#!/usr/bin/env node
// Offline replay of a judge run against its own stored context.  (Task 3)
//
//   node scripts/replay.mjs --run <runId> --k 3 [--base https://atombets.netlify.app]
//   node scripts/replay.mjs --snapshot ./snap.json --k 3 --dry
//
// WHY THIS EXISTS
// Testing a prompt variant by shipping it costs two weeks: the slate has to run,
// then settle, then grade. judge-context stores what the judge was actually
// shown — the system prompt, the exact payload bytes, and the live search text,
// which is the part that cannot be reconstructed tomorrow. Replaying against
// that turns two weeks into one API call.
//
// WHAT THIS FILE DOES NOT DO YET, DELIBERATELY
// It does not compare variants. The first thing a replay harness has to prove is
// that it reproduces the ORIGINAL, and the second is how much two identical runs
// differ from each other. Until both are known, a variant comparison is a
// difference of unknown size measured against a ruler of unknown length.
//
// So this is an A/A harness: same prompt, same model, same snapshot, k times.
//
//   FIDELITY  replay-vs-original must look like replay-vs-replay. If the
//             replays agree with each other and disagree with the original, the
//             harness is not reproducing the original conditions and nothing
//             downstream of it means anything.
//   NOISE     replay-vs-replay IS the judge's run-to-run variance. It bounds
//             what a single-run A/B can detect, which is why k is a parameter
//             from the start rather than something retrofitted later.
//
// The judge runs at the API's default temperature — no temperature is set in
// bet-finder-background — so this variance is expected to be real rather than a
// rounding artefact. The replay does not pin temperature either: a noise floor
// measured at temperature 0 would describe a judge this app does not run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReplayable } from '../netlify/functions/judge-context.js';
import { parsePicks } from '../netlify/functions/bet-finder-background.js';

const API = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------------
// Building the call
// ---------------------------------------------------------------------------

/**
 * Rebuild the exact request that produced a snapshot, with search REPLAYED
 * rather than re-issued.
 *
 * The search turn is sent back as a prefilled assistant message — the queries
 * the model issued and the results it got — so it continues from the same point
 * with the same information. Re-running the searches live would be a different
 * call: search is live, the text moves, and the whole reason the snapshot exists
 * is that tomorrow's answer is not today's.
 *
 * The tool stays DECLARED even though it should never fire. Its block types have
 * to validate for the prefilled turn to be accepted, and dropping it would also
 * change the system-side tool definitions the original call carried.
 */
export function buildRequest(snap) {
  const messages = [{ role: 'user', content: snap.userContent }];
  if (snap.search?.length) messages.push({ role: 'assistant', content: snap.search });
  return {
    model: snap.model,
    max_tokens: 16000,
    system: snap.system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: snap.maxSearches || 1 }],
    messages,
  };
}

/** Whether a replay actually stayed offline. A new search means it is not a replay. */
export const searchesIssued = (content) =>
  (content || []).filter((b) => b?.type === 'server_tool_use' && b.name === 'web_search').length;

// ---------------------------------------------------------------------------
// Comparing runs
// ---------------------------------------------------------------------------

// The same identity the pipeline uses. Two lines of one prop are different
// props, so the line is part of the key.
const keyOf = (p) => `${p.player}|${p.stat}|${Number(p.line)}`;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};

function pearson(xs, ys) {
  if (xs.length < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2;
  }
  // A run that answered one number for everything has no variance to correlate.
  // That is a real and reportable state, not a zero correlation.
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Behaviour metrics, defined exactly as calibration.js defines them so a replay
 * and a live run can be read on the same axis. Diverging definitions here would
 * make the harness's numbers incomparable to every number already published.
 */
export function behaviour(picks, tiers = {}) {
  const probs = picks.map((p) => Number(p.prob)).filter((x) => isFinite(x));
  if (!probs.length) return { n: 0 };
  const m = mean(probs);
  const round = probs.filter((x) => Math.abs(x * 20 - Math.round(x * 20)) < 1e-9).length;
  const byTier = {};
  for (const p of picks) {
    const t = tiers[keyOf(p)] || p.oddsType || 'unknown';
    const prob = Number(p.prob);
    if (!isFinite(prob)) continue;
    (byTier[t] ||= []).push(prob);
  }
  const g = byTier.goblin ? mean(byTier.goblin) : null;
  const d = byTier.demon ? mean(byTier.demon) : null;
  return {
    n: probs.length,
    meanProb: m,
    // Population spread, matching calibration.js — this describes the run's own
    // answers, not an estimate of some wider distribution.
    spread: Math.sqrt(Math.max(0, mean(probs.map((x) => x * x)) - m * m)),
    roundShare: round / probs.length,
    tierGap: g != null && d != null ? g - d : null,
  };
}

/** The N props a run would actually have put on a slip, by its own ranking. */
export const topN = (picks, n) => picks.slice()
  .sort((a, b) => (Number(b.prob) || 0) - (Number(a.prob) || 0))
  .slice(0, n).map(keyOf);

const overlap = (a, b) => a.filter((k) => b.includes(k)).length;

/**
 * Compare one run against another, per pick.
 *
 * Only props BOTH runs answered are compared. A prop one run dropped is a
 * different failure — it is reported as a count rather than folded into the
 * spread, because a missing answer is not a distant one.
 */
export function comparePair(a, b) {
  const A = new Map(a.picks.map((p) => [keyOf(p), Number(p.prob)]));
  const B = new Map(b.picks.map((p) => [keyOf(p), Number(p.prob)]));
  const shared = [...A.keys()].filter((k) => B.has(k));
  const xs = shared.map((k) => A.get(k)), ys = shared.map((k) => B.get(k));
  const diffs = shared.map((k) => B.get(k) - A.get(k));
  const abs = diffs.map(Math.abs);
  return {
    a: a.label, b: b.label,
    shared: shared.length,
    onlyInA: A.size - shared.length,
    onlyInB: B.size - shared.length,
    r: pearson(xs, ys),
    meanAbsDiff: mean(abs),
    maxAbsDiff: abs.length ? Math.max(...abs) : null,
    // The signed mean says whether one run sits systematically above the other.
    // Between two identical runs it should be indistinguishable from zero; a
    // persistent offset between replay and original is a fidelity problem, not
    // noise.
    meanSignedDiff: mean(diffs),
    sdDiff: sd(diffs),
    topN: [3, 5, 10].map((n) => {
      const ta = topN(a.picks, n), tb = topN(b.picks, n);
      const k = Math.min(n, ta.length, tb.length);
      return { n, shared: overlap(ta, tb), of: k, churn: k ? 1 - overlap(ta, tb) / k : null };
    }),
  };
}

/**
 * The full A/A report.
 *
 * `runs[0]` must be the original. Everything after it is a replay.
 */
export function analyse(runs, tiers = {}) {
  const [original, ...replays] = runs;
  const vsOriginal = replays.map((r) => comparePair(original, r));
  const vsEachOther = [];
  for (let i = 0; i < replays.length; i++) {
    for (let j = i + 1; j < replays.length; j++) vsEachOther.push(comparePair(replays[i], replays[j]));
  }
  const floor = vsEachOther.length ? mean(vsEachOther.map((c) => c.meanAbsDiff)) : null;
  const toOriginal = vsOriginal.length ? mean(vsOriginal.map((c) => c.meanAbsDiff)) : null;

  // FIDELITY. Two replays differ by pure sampling noise. A replay and the
  // original differ by that same noise PLUS anything the harness failed to
  // reproduce. If the second is materially larger than the first, the extra is
  // the harness, and no variant result measured through it can be believed.
  //
  // The threshold is deliberately loose: with k=3 the noise floor itself is
  // estimated from three pairs, so a tight gate here would fire on its own
  // error. It flags a harness that is clearly wrong, not one that is subtly so.
  const fidelity = (floor == null || toOriginal == null) ? null : {
    replayVsReplay: floor,
    replayVsOriginal: toOriginal,
    ratio: floor > 0 ? toOriginal / floor : null,
    // A replay carrying a systematic offset from the original is the clearest
    // symptom of context that did not make it back into the call.
    meanSignedToOriginal: mean(vsOriginal.map((c) => c.meanSignedDiff)),
    verdict: floor > 0 && toOriginal / floor > 2
      ? 'SUSPECT — replays agree with each other far better than with the original; find out why before comparing anything'
      : 'consistent with sampling noise',
  };

  return {
    k: replays.length,
    behaviour: runs.map((r) => ({ label: r.label, ...behaviour(r.picks, tiers) })),
    vsOriginal,
    vsEachOther,
    fidelity,
    noiseFloor: floor == null ? null : {
      meanAbsDiffPerPick: floor,
      sdOfDiff: mean(vsEachOther.map((c) => c.sdDiff).filter((x) => x != null)),
      topNChurn: [3, 5, 10].map((n, i) => ({
        n, churn: mean(vsEachOther.map((c) => c.topN[i].churn).filter((x) => x != null)),
      })),
    },
  };
}

/**
 * How many runs a variant needs, given the measured noise.
 *
 * The target is the smallest per-pick effect worth calling real. A single run's
 * difference from another carries the run-to-run sd; averaging k runs divides
 * that by sqrt(k), and two averaged arms combine to sqrt(2/k). Requiring the
 * target to be at least two of those:
 *
 *   target >= 2 * sd * sqrt(2 / k)   ->   k >= 8 * (sd / target)^2
 */
export function recommendK(sdOfDiff, target) {
  if (!(sdOfDiff > 0) || !(target > 0)) return null;
  return Math.max(1, Math.ceil(8 * (sdOfDiff / target) ** 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function callOnce(req, key) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  return data;
}

export async function replay(snap, { k = 3, key = process.env.ANTHROPIC_API_KEY, call = callOnce } = {}) {
  // ITEM H. A snapshot that hit the search cap holds less context than the call
  // it is standing in for. Replaying it would send the model a smaller world and
  // report the difference as an effect. Refused, not degraded.
  if (!isReplayable(snap)) {
    throw new Error(`snapshot ${snap?.runId || '?'} is not replayable`
      + (snap?.searchTruncated ? ` — ${snap.searchTruncated} search blocks were dropped to fit the cap` : '')
      + '; a replay with less context than the original is not a replay');
  }
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const req = buildRequest(snap);
  const runs = [{ label: 'original', picks: parsePicks(snap.responseText || '') }];
  if (!runs[0].picks.length) {
    throw new Error(`snapshot ${snap.runId} carries no parseable responseText — nothing to compare a replay against`);
  }
  const warnings = [];
  for (let i = 0; i < k; i++) {
    const data = await call(req, key);
    const issued = searchesIssued(data.content);
    // A replay that goes and searches again has read text the original never
    // saw. Reported rather than silently averaged in.
    if (issued) warnings.push(`replay-${i + 1} issued ${issued} live search(es) — not an offline replay`);
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    runs.push({ label: `replay-${i + 1}`, picks: parsePicks(text), usage: data.usage || null });
  }
  const tiers = {};
  for (const e of Object.values(snap.props || {})) {
    const p = e.entry || e;
    if (p?.player) tiers[`${p.player}|${p.stat}|${Number(p.line)}`] = p.tier || p.oddsType || 'unknown';
  }
  const report = analyse(runs, tiers);
  report.runId = snap.runId;
  report.model = snap.model;
  report.promptVersion = snap.promptVersion;
  report.warnings = warnings;
  report.recommendedK = report.noiseFloor?.sdOfDiff
    ? { target: 0.02, k: recommendK(report.noiseFloor.sdOfDiff, 0.02) } : null;
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const snapFile = arg('snapshot');
  const runId = arg('run');
  const base = arg('base', process.env.ATOMBETS_BASE || 'https://atombets.netlify.app');
  const k = Number(arg('k', 3));

  let snap;
  if (snapFile) snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  else if (runId) {
    const res = await fetch(`${base}/api/judge-context?runId=${encodeURIComponent(runId)}`);
    snap = await res.json();
    if (snap.error) throw new Error(`${snap.error} (runId ${runId})`);
  } else {
    console.error('usage: replay.mjs (--run <runId> | --snapshot <file>) [--k 3] [--base <url>] [--out <file>]');
    process.exit(2);
  }

  const report = await replay(snap, { k });
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const w of report.warnings) console.error(`WARNING: ${w}`);
  if (report.fidelity?.verdict?.startsWith('SUSPECT')) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
}

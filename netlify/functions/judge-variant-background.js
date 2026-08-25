// netlify/functions/judge-variant-background.js
//
// Phase 1 of a tail-only prompt variant test: run k independent calls of a
// named judge version's prompt against a snapshot's fixed payload and search
// context, then report standout replication, calibration survival, top-N
// churn, and rank correlation against the original live response.
//
// PLATFORM BEHAVIOUR: same as judge-replay-background.js. Netlify answers the
// caller with an empty 202 the instant the invocation is accepted and discards
// whatever this handler returns — the job store is the only channel a polling
// caller can observe, so every exit path, including a bad variant name, writes
// to it. See judge-replay-background.js for why this shape is not optional.
//
// POST /api/judge-variant-background   { jobId, runId, variant, k, model }
// GET  /api/judge-variant-status?jobId=...
//
// `model` is a SEPARATE axis from `variant`: pass it to hold the prompt fixed
// and change only which model answers — item K's "Aphrodite on Opus" arm.
// Omit it and the snapshot's own model is used, exactly as before.

import { getStore } from '@netlify/blobs';
import { findByRunId, isReplayable } from './judge-context.js';
import { PROMPTS } from './judge-prompts.js';
import { ODDS_PRIOR, JUDGE_MODELS, parsePicks } from './bet-finder-background.js';
import {
  runVariant, pairwiseAll, standoutReplication, standoutMoveDistribution,
  tierCalibration, rankCorrelation,
} from './variant-lib.js';
import { costOf } from './replay-lib.js';

async function callAnthropic(req, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  return data;
}

export const handler = async (event) => {
  let jobId;
  const jobs = getStore({ name: 'replay-jobs', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  try {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    jobId = body.jobId || `variant-${Date.now()}`;
    const runId = body.runId;
    const variantName = String(body.variant || '').toLowerCase();
    if (!runId) throw new Error('runId is required');
    const variant = PROMPTS[variantName];
    if (!variant) throw new Error(`unknown variant "${body.variant}" — known: ${Object.keys(PROMPTS).join(', ')}`);
    const k = Math.max(2, Math.min(10, Number(body.k) || 5));
    // A model override is a SEPARATE axis from variant, not a fallback chain —
    // an unpriced name fails the job rather than silently substituting the
    // default and misattributing which model actually answered.
    let modelOverride = null;
    if (body.model) {
      if (!JUDGE_MODELS.includes(String(body.model))) {
        throw new Error(`unknown model "${body.model}" — known: ${JUDGE_MODELS.join(', ')}`);
      }
      modelOverride = String(body.model);
    }

    await jobs.setJSON(jobId, { status: 'running', step: 'loading snapshot' });
    const snap = await findByRunId(runId);
    if (!snap) throw new Error(`no snapshot for runId ${runId}`);
    if (!isReplayable(snap)) {
      throw new Error(`snapshot ${runId} is not replayable`
        + (snap.searchTruncated ? ` — ${snap.searchTruncated} search blocks were dropped to fit the cap` : ''));
    }

    await jobs.setJSON(jobId, { status: 'running', step: `running ${variant.name} (k=${k})${modelOverride ? ` on ${modelOverride}` : ''}` });
    const { runs, model: modelUsed, warnings, excluded, kRequested } = await runVariant(
      snap, variant, { k, key: process.env.ANTHROPIC_API_KEY, call: callAnthropic, model: modelOverride });

    const tiers = {};
    for (const e of Object.values(snap.props || {})) {
      const p = e.entry || e;
      if (p?.player) tiers[`${p.player}|${p.stat}|${Number(p.line)}`] = p.tier || p.oddsType || 'unknown';
    }
    // The original's REAL response — the one comparison that needs the live
    // call that actually produced this snapshot, not the k new runs.
    const original = { label: snap.promptVersion || 'original', picks: parsePicks(snap.responseText || '') };

    const pairs = pairwiseAll(runs);
    const report = {
      // k is the CLEAN run count every stat below is actually computed from —
      // kRequested is what was asked for, and excluded says why they differ.
      runId, variant: variant.name, baselinePromptVersion: snap.promptVersion, model: modelUsed,
      k: runs.length, kRequested, excluded,
      pairwise: pairs,
      topNChurn: [3, 5, 10].map((n) => ({
        n, churn: pairs.length ? pairs.reduce((a, c) => a + (c.topN.find((x) => x.n === n)?.churn || 0), 0) / pairs.length : null,
      })),
      standoutReplication: standoutReplication(runs, 60),
      standoutMoveDistribution: standoutMoveDistribution(runs, ODDS_PRIOR, tiers),
      tierCalibration: tierCalibration(runs, ODDS_PRIOR, tiers),
      vsOriginal: original.picks.length ? runs.map((r) => ({ run: r.label, ...rankCorrelation(original, r) })) : null,
      warnings,
      // Every call this job made was billed, clean or excluded — the original
      // is not: its call already happened live and was logged then.
      costUsd: costOf([...runs.map((r) => r.usage), ...excluded.map((e) => e.usage)], modelUsed),
      // Same reasoning as replay-lib.js's replay(): the aggregates above throw
      // away which prop each number belonged to, which is exactly what a
      // per-prop residual analysis (item K) needs back. Kept small.
      rawRuns: [...(original.picks.length ? [original] : []), ...runs].map((r) => ({
        label: r.label,
        picks: r.picks.map((p) => ({
          player: p.player, stat: p.stat, line: p.line, prob: Number(p.prob),
          tier: tiers[`${p.player}|${p.stat}|${Number(p.line)}`] || p.oddsType || p.tier || 'unknown',
          standout: p.standout ?? null,
        })),
      })),
    };
    await jobs.setJSON(jobId, { status: 'done', result: report });
  } catch (err) {
    if (jobId) await jobs.setJSON(jobId, { status: 'error', message: String(err.message || err) });
  }
  return { statusCode: 202 };
};

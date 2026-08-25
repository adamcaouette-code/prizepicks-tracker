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
// POST /api/judge-variant-background   { jobId, runId, variant, k }
// GET  /api/judge-variant-status?jobId=...

import { getStore } from '@netlify/blobs';
import { findByRunId, isReplayable } from './judge-context.js';
import { PROMPTS } from './judge-prompts.js';
import { ODDS_PRIOR } from './bet-finder-background.js';
import {
  runVariant, pairwiseAll, standoutReplication, standoutMoveDistribution,
  tierCalibration, rankCorrelation,
} from './variant-lib.js';
import { parsePicks } from './bet-finder-background.js';

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

    await jobs.setJSON(jobId, { status: 'running', step: 'loading snapshot' });
    const snap = await findByRunId(runId);
    if (!snap) throw new Error(`no snapshot for runId ${runId}`);
    if (!isReplayable(snap)) {
      throw new Error(`snapshot ${runId} is not replayable`
        + (snap.searchTruncated ? ` — ${snap.searchTruncated} search blocks were dropped to fit the cap` : ''));
    }

    await jobs.setJSON(jobId, { status: 'running', step: `running ${variant.name} (k=${k})` });
    const { runs, warnings } = await runVariant(snap, variant, { k, key: process.env.ANTHROPIC_API_KEY, call: callAnthropic });

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
      runId, variant: variant.name, baselinePromptVersion: snap.promptVersion, model: snap.model, k,
      pairwise: pairs,
      topNChurn: [3, 5, 10].map((n) => ({
        n, churn: pairs.length ? pairs.reduce((a, c) => a + (c.topN.find((x) => x.n === n)?.churn || 0), 0) / pairs.length : null,
      })),
      standoutReplication: standoutReplication(runs, 60),
      standoutMoveDistribution: standoutMoveDistribution(runs, ODDS_PRIOR, tiers),
      tierCalibration: tierCalibration(runs, ODDS_PRIOR, tiers),
      vsOriginal: original.picks.length ? runs.map((r) => ({ run: r.label, ...rankCorrelation(original, r) })) : null,
      warnings,
    };
    await jobs.setJSON(jobId, { status: 'done', result: report });
  } catch (err) {
    if (jobId) await jobs.setJSON(jobId, { status: 'error', message: String(err.message || err) });
  }
  return { statusCode: 202 };
};

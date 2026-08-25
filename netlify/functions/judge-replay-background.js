// netlify/functions/judge-replay-background.js
//
// Runs Task 3's A/A replay (scripts/replay.mjs) server-side, against a stored
// judge-context snapshot.
//
// WHY THIS EXISTS
// The harness needs ANTHROPIC_API_KEY to make its k replay calls, and that key
// lives only on the server — it is never handed out, the same discipline as
// every other call in this app. Wrapping the harness in a background function
// means it can be run without distributing the key: POST a runId and k, poll
// for the report, exactly the job pattern bet-finder-background already uses.
//
// This function calls NO prompt, model, selection, or shrinkage logic of its
// own — it is a thin transport around scripts/replay.mjs, which is the actual
// harness and is unit-tested on its own (tests/unit/replay.test.mjs).
//
// POST /api/judge-replay-background   { jobId, runId, k }
// GET  /api/judge-replay-status?jobId=...

import { getStore } from '@netlify/blobs';
import { findByRunId } from './judge-context.js';
import { replay } from './replay-lib.js';

const JOBS = () => getStore({ name: 'replay-jobs', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

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
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const jobId = body.jobId || `replay-${Date.now()}`;
  const runId = body.runId;
  const k = Math.max(1, Math.min(10, Number(body.k) || 5));   // 10 is a sanity cap, not a design choice
  const jobs = JOBS();

  if (!runId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'runId is required' }) };
  }

  await jobs.setJSON(jobId, { status: 'running', step: 'loading snapshot' });

  (async () => {
    try {
      const snap = await findByRunId(runId);
      if (!snap) throw new Error(`no snapshot for runId ${runId}`);
      // Item H is enforced inside replay() itself, not duplicated here — one
      // place owns "is this snapshot replayable", so there is one message to
      // keep accurate rather than two that can drift apart.
      await jobs.setJSON(jobId, { status: 'running', step: `replaying (k=${k})` });
      const report = await replay(snap, { k, key: process.env.ANTHROPIC_API_KEY, call: callAnthropic });
      await jobs.setJSON(jobId, { status: 'done', result: report });
    } catch (err) {
      await jobs.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    }
  })();

  return { statusCode: 202, body: JSON.stringify({ jobId }) };
};

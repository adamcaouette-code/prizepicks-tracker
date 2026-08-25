// netlify/functions/judge-replay-background.js
//
// Runs Task 3's A/A replay (replay-lib.js) server-side, against a stored
// judge-context snapshot.
//
// WHY THIS EXISTS
// The harness needs ANTHROPIC_API_KEY to make its k replay calls, and that key
// lives only on the server — it is never handed out, the same discipline as
// every other call in this app. Wrapping the harness in a background function
// means it can be run without distributing the key: POST a runId and k, poll
// for the report, exactly the job pattern bet-finder-background already uses.
//
// PLATFORM BEHAVIOUR THAT SHAPES THIS FILE
// Netlify treats any *-background.js function as fire-and-forget: the caller
// gets an empty 202 the instant the invocation is accepted, and the platform
// discards whatever this handler eventually returns — status code, body, all
// of it. bet-finder-background.js already relies on this (its own handler
// always `return`s `{ statusCode: 202 }`, success or failure) and this file
// follows the identical shape: ONE top-level try/catch around everything,
// jobId assigned before any validation, and every exit path — including a
// missing runId — writes to the job store, because that store is the ONLY
// channel a polling caller can actually observe. An early `return` before the
// store write, or a second detached async block, silently strands that path:
// the caller never sees the 400, and polling status.js finds nothing to read,
// forever.
//
// This function calls NO prompt, model, selection, or shrinkage logic of its
// own — it is a thin transport around replay-lib.js, which is the actual
// harness and is unit-tested on its own (tests/unit/replay.test.mjs).
//
// POST /api/judge-replay-background   { jobId, runId, k }
// GET  /api/judge-replay-status?jobId=...

import { getStore } from '@netlify/blobs';
import { findByRunId } from './judge-context.js';
import { replay } from './replay-lib.js';

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
    jobId = body.jobId || `replay-${Date.now()}`;
    const runId = body.runId;
    // Thrown, not returned — the platform discards a synchronous 400 for a
    // background function, so the store write in the catch block below is
    // what actually tells a polling caller this request was rejected.
    if (!runId) throw new Error('runId is required');
    const k = Math.max(1, Math.min(10, Number(body.k) || 5));   // 10 is a sanity cap, not a design choice

    await jobs.setJSON(jobId, { status: 'running', step: 'loading snapshot' });
    const snap = await findByRunId(runId);
    if (!snap) throw new Error(`no snapshot for runId ${runId}`);
    // Item H is enforced inside replay() itself, not duplicated here — one
    // place owns "is this snapshot replayable", so there is one message to
    // keep accurate rather than two that can drift apart.
    await jobs.setJSON(jobId, { status: 'running', step: `replaying (k=${k})` });
    const report = await replay(snap, { k, key: process.env.ANTHROPIC_API_KEY, call: callAnthropic });
    await jobs.setJSON(jobId, { status: 'done', result: report });
  } catch (err) {
    if (jobId) await jobs.setJSON(jobId, { status: 'error', message: String(err.message || err) });
  }
  return { statusCode: 202 };
};

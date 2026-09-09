// netlify/functions/snapshot-heartbeat.js
//
// A record that the snapshot cron ran, kept apart from the archive itself.
//
// In its own module rather than inside snapshot-background.js so the scheduled
// shim can import it without pulling in the whole capture graph — the shim has
// a 30-second budget and must not spend it loading a module tree it will not
// use. The grading cron pays exactly this cost today.
//
// Deliberately NOT append-only, and deliberately NOT in the ledger stores. It
// is operational telemetry about the archive, not a row of it; a ring buffer of
// the last 60 firings is what makes "did the capture run at 14:10?" answerable
// without listing tens of thousands of blobs.

import { getStore } from '@netlify/blobs';

export async function heartbeat(payload) {
  try {
    const store = getStore({
      name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    let log = [];
    try { log = (await store.get('snapshot-heartbeat', { type: 'json' })) || []; } catch { /* first run */ }
    log.push({ at: new Date().toISOString(), ...payload });
    await store.setJSON('snapshot-heartbeat', log.slice(-60));
  } catch { /* bookkeeping must never break the job */ }
}

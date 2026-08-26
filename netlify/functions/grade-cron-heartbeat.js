// netlify/functions/grade-cron-heartbeat.js
//
// Read-only heartbeat log from grade-cron scheduled runs. Disambiguates
// whether grading comes from the schedule or manual triggers.
//
// Each entry records:
//   at: wall-clock timestamp (ISO) when this run completed
//   trigger: "schedule" (cron) or "local" (dev/manual)
//   picks: array of {date, graded, pending, error} for each day processed
//   slipLegsGraded, slipsSettled: slip processing results

import { getStore } from '@netlify/blobs';

export const handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  try {
    const store = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let log = [];
    try { log = (await store.get('cron-heartbeat', { type: 'json' })) || []; } catch {}

    // Most recent first
    const entries = log.slice().reverse();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        count: entries.length,
        entries,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

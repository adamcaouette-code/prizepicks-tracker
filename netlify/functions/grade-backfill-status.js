// netlify/functions/grade-backfill-status.js
//
// Progress for the backfill sweep. Read-only.

import { getStore } from '@netlify/blobs';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler = async () => {
  try {
    const store = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let state = null;
    try { state = await store.get('backfill', { type: 'json' }); } catch {}
    if (!state) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
        state: 'never run', hint: 'Start one with /api/grade-backfill-background',
      }, null, 2) };
    }
    const pct = state.days ? Math.round((state.done / state.days) * 100) : null;
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ...state, percent: pct }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

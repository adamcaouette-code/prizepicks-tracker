// netlify/functions/multi-league-bet-finder-status.js
//
// The browser polls this with ?jobId=XYZ every few seconds until status is
// "done" or "error". Reads the result multi-league-bet-finder-background wrote
// to the same 'bet-jobs' store bet-finder-background uses — identical shape,
// so this is bet-finder-status.js verbatim under the multi-league name the
// front end's runJob('multi-league-bet-finder', ...) polls.

import { getStore } from '@netlify/blobs';

export const handler = async (event) => {
  const jobId = (event.queryStringParameters || {}).jobId;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };
  if (!jobId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing jobId' }) };
  }
  try {
    const store = getStore({
      name: 'bet-jobs',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const data = await store.get(jobId, { type: 'json' });
    if (!data) return { statusCode: 200, headers, body: JSON.stringify({ status: 'running', step: 'starting' }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', message: String(err.message || err) }) };
  }
};

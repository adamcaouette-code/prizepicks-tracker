// netlify/functions/judge-slip-status.js
//
// The browser polls this with ?jobId=XYZ every couple of seconds until status is
// "done" or "error". Reads the result judge-slip-background.js wrote to Blobs.
// Mirrors bet-finder-status.js — same contract, different job store.

import { getStore } from '@netlify/blobs';

export const handler = async (event) => {
  const jobId = (event.queryStringParameters || {}).jobId;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };
  if (!jobId) {
    return { statusCode: 400, headers, body: JSON.stringify({ status: 'error', message: 'Missing jobId' }) };
  }
  try {
    const store = getStore({
      name: 'slip-jobs',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const data = await store.get(jobId, { type: 'json' });
    // Not written yet → the job just started; tell the browser to keep waiting.
    if (!data) return { statusCode: 200, headers, body: JSON.stringify({ status: 'running', step: 'starting' }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', message: String(err.message || err) }) };
  }
};

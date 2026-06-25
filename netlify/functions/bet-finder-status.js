// netlify/functions/bet-finder-status.js
//
// The browser polls this with ?jobId=XYZ every few seconds until status is
// "done" or "error". Reads the result the background function wrote to Blobs.

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
    const store = getStore('bet-jobs');
    const data = await store.get(jobId, { type: 'json' });
    // Not written yet → the job just started; tell the browser to keep waiting.
    if (!data) return { statusCode: 200, headers, body: JSON.stringify({ status: 'running', step: 'starting' }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', message: String(err.message || err) }) };
  }
};

// netlify/functions/judge-variant-status.js
//
// Poll target for judge-variant-background. Same shape as bet-finder-status /
// judge-replay-status: reads the job the background function wrote.

import { getStore } from '@netlify/blobs';

export const handler = async (event) => {
  const jobId = (event.queryStringParameters || {}).jobId;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing jobId' }) };
  try {
    const store = getStore({ name: 'replay-jobs', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const data = await store.get(jobId, { type: 'json' });
    if (!data) return { statusCode: 200, headers, body: JSON.stringify({ status: 'running', step: 'starting' }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error', message: String(err.message || err) }) };
  }
};

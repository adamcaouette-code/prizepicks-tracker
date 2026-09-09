// netlify/functions/bet-results.js
//
// Grading, in its own store, keyed by LEG id.
//
//   POST /api/bet-results     { leg_id, slip_id, outcome, actual? }   -> 201
//   GET  /api/bet-results     every graded leg
//
// Separate from /api/bets so that settling a leg cannot rewrite the bet. That
// separation is structural, not procedural: this handler imports appendResult
// and nothing else that can write, so even a bug here has nowhere to put a
// grade except the results store.
//
// Like bets, a leg is graded ONCE. A leg whose grade turns out to be wrong gets
// a new row appended under a superseding id rather than an edit, so the record
// shows that the correction happened.

import { appendResult, allResults, getResult, AppendOnlyViolation } from './ledger-store.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body, null, 2) });

export const handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const q = event.queryStringParameters || {};

  if (method === 'GET') {
    try {
      if (q.leg) {
        const r = await getResult(q.leg);
        return r ? json(200, r) : json(404, { error: `no result for leg ${q.leg}` });
      }
      return json(200, { results: await allResults() });
    } catch (err) {
      return json(500, { error: String(err.message || err) });
    }
  }

  if (method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'body must be JSON' }); }
    try {
      return json(201, await appendResult(body));
    } catch (err) {
      if (err instanceof AppendOnlyViolation) {
        return json(409, { error: err.message, leg_id: body?.leg_id, append_only: true });
      }
      return json(400, { error: String(err.message || err) });
    }
  }

  return json(405, {
    error: `${method} is not available. Grades are appended, never edited — `
      + 'a corrected grade is a new row that supersedes the old one.',
    allowed: ['GET', 'POST'],
  });
};

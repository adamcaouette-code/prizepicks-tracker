// netlify/functions/bets.js
//
// The append-only bet ledger's HTTP surface. No UI in this task by design —
// this is the API a UI would later sit on, and the seed/migration scripts use
// the same module the endpoint does.
//
//   POST /api/bets              append one slip            -> 201
//   GET  /api/bets              list slip ids
//   GET  /api/bets?slip=<id>    one slip
//   GET  /api/bets?verify=1     integrity report
//
// There is NO PUT, PATCH or DELETE, and their absence is the point rather than
// an omission: a route that could edit a bet would make the append-only
// guarantee a matter of who calls what. Any method other than GET or POST is
// refused with 405 and a sentence saying why.
//
// Correcting a slip means appending a new one that supersedes it. That keeps
// the mistake in the record, which is the whole reason for a ledger — a bet
// history you can quietly fix is a bet history that will flatter you.

import { appendBet, getBet, listBets, verifyIntegrity, AppendOnlyViolation, captureCurrentAt } from './ledger-store.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body, null, 2) });

export const handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const q = event.queryStringParameters || {};

  if (method === 'GET') {
    try {
      if (q.verify) return json(200, await verifyIntegrity());
      if (q.slip) {
        const bet = await getBet(q.slip);
        return bet ? json(200, bet) : json(404, { error: `no slip ${q.slip}` });
      }
      // The capture that was current at an instant, so a caller building a slip
      // can resolve its own foreign keys before posting.
      if (q.currentAt) return json(200, { at: q.currentAt, capture: await captureCurrentAt(q.currentAt) });
      return json(200, { slips: await listBets() });
    } catch (err) {
      return json(500, { error: String(err.message || err) });
    }
  }

  if (method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'body must be JSON' }); }
    try {
      return json(201, await appendBet(body));
    } catch (err) {
      // A duplicate slip_id is a 409, not a 500. It usually means a retry of a
      // request that already succeeded, and the correct response is to say the
      // row exists rather than to look like a server fault worth retrying again.
      if (err instanceof AppendOnlyViolation) {
        return json(409, { error: err.message, slip_id: body?.slip_id, append_only: true });
      }
      return json(400, { error: String(err.message || err) });
    }
  }

  return json(405, {
    error: `${method} is not available on an append-only ledger. `
      + 'Bets are written once and never edited; to correct one, POST a new slip that supersedes it.',
    allowed: ['GET', 'POST'],
  });
};

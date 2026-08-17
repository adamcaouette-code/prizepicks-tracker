// netlify/functions/slips.js
//
// Saved slips — the slips you actually built, kept so their results can be
// checked later. This is a RECORD, not a prediction log: the calibration
// pipeline (pick-log) already scores the engine's own probabilities, and mixing
// the two would let a slip you saved twice count twice against the Brier score.
// These stay separate on purpose.
//
//   GET  /api/slips                 -> { slips: [...] }  newest first
//   POST /api/slips                 -> save     body: { name, legs, stake, entry, league, sizing }
//   POST /api/slips?action=rename   -> body: { id, name }
//   POST /api/slips?action=delete   -> body: { id }
//
// One blob per slip so a save or a grade updates just that slip — a single
// shared list would make two concurrent writes clobber each other.

import { getStore } from '@netlify/blobs';

const store = () => getStore({ name: 'saved-slips', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const MAX_SLIPS = 200;
const MAX_NAME = 60;

// Runs `fn` over `items` with at most `limit` in flight. Listing every slip is N
// blob reads; serially that's seconds of latency for no reason.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The date the legs PLAY — what grading keys off. Prefer the earliest leg's own
// start time (PrizePicks stamps it with the game's local offset, so slicing the
// date off it gives the right slate day).
//
// The fallback must NOT be toISOString(): that's UTC, and a slip saved at 9pm ET
// is already tomorrow in UTC. Such a slip claims a slate a day ahead of its own
// games, never matches them, and sits "pending" forever. US slates are keyed to
// the US day, so fall back to the Eastern date.
function slateDateFor(legs, now = new Date()) {
  const starts = legs.map((l) => l.start).filter(Boolean).sort();
  if (starts.length) return String(starts[0]).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);   // en-CA formats as YYYY-MM-DD
}

// Keep only the fields a saved slip needs. Whatever the page happens to be
// holding (judge prose, research blobs, images) does not belong in storage.
function normalizeLeg(l = {}) {
  const line = Number(l.line);
  return {
    projectionId: l.projectionId || l.id || null,   // null = can never be graded
    player: clean(l.player, 80),
    stat: clean(l.stat, 60),
    line: isFinite(line) ? line : null,
    pick: String(l.pick || 'over').toLowerCase() === 'under' ? 'under' : 'over',
    oddsType: ['goblin', 'demon', 'standard'].includes(String(l.oddsType || '').toLowerCase())
      ? String(l.oddsType).toLowerCase() : 'standard',
    team: clean(l.team, 20) || null,
    matchup: clean(l.matchup, 60) || null,
    start: l.start || null,
    prob: isFinite(Number(l.prob)) ? Number(l.prob) : null,   // the engine's read AT SAVE TIME
    mlbId: Number.isInteger(l.mlbId) ? l.mlbId : null,        // for the MLB fallback grader
    image: typeof l.image === 'string' && /^https?:\/\//.test(l.image) ? l.image : null,
    // filled by grade-slips.js once the game settles
    result: null, hit: null, gradedAt: null, gradeAttempts: 0,
  };
}

export { slateDateFor };

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { ...HEADERS, 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  const s = store();
  const action = (event.queryStringParameters || {}).action || '';

  try {
    if (event.httpMethod === 'GET') {
      let keys = [];
      try { keys = (await s.list()).blobs.map((b) => b.key); } catch { keys = []; }
      const slips = (await mapLimit(keys, 12, async (k) => {
        try { return await s.get(k, { type: 'json' }); } catch { return null; }
      })).filter(Boolean);
      slips.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slips }) };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Use GET or POST' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Body must be JSON' }) };
    }

    if (action === 'delete') {
      if (!body.id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
      await s.delete(String(body.id));
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, deleted: body.id }) };
    }

    if (action === 'rename') {
      const name = clean(body.name, MAX_NAME);
      if (!body.id || !name) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id or name' }) };
      let slip = null;
      try { slip = await s.get(String(body.id), { type: 'json' }); } catch {}
      if (!slip) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'No such slip' }) };
      slip.name = name;
      await s.setJSON(String(body.id), slip);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, slip }) };
    }

    // ---- save ----
    const legs = Array.isArray(body.legs) ? body.legs.map(normalizeLeg) : [];
    if (legs.length < 2) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'A slip needs at least 2 legs.' }) };
    if (legs.length > 6) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'PrizePicks caps a slip at 6 legs.' }) };

    let keys = [];
    try { keys = (await s.list()).blobs.map((b) => b.key); } catch { keys = []; }
    if (keys.length >= MAX_SLIPS) {
      return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: `Saved-slip limit reached (${MAX_SLIPS}). Delete a few first.` }) };
    }

    const now = new Date();
    const id = `${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
    const stake = Math.max(0, Number(body.stake));
    const slip = {
      id,
      name: clean(body.name, MAX_NAME) || `Slip ${now.toISOString().slice(0, 10)}`,
      createdAt: now.toISOString(),
      // The date the legs PLAY, which is what grading keys off — not the date you
      // saved it. Saving at 11pm for tomorrow's slate must not grade against today.
      slateDate: slateDateFor(legs, now),
      league: clean(body.league, 20) || null,
      entry: String(body.entry || '').toLowerCase() === 'flex' ? 'flex' : 'power',
      stake: isFinite(stake) ? stake : 10,
      legs,
      sizing: body.sizing && typeof body.sizing === 'object' ? body.sizing : null,  // multipliers as shown at save time
      status: 'pending',    // pending | won | lost | partial (flex) | ungradeable
      payout: null,
      gradedAt: null,
    };
    await s.setJSON(id, slip);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, slip }) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

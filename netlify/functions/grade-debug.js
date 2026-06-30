// netlify/functions/grade-debug.js
//
// READ-ONLY diagnostic. Does NOT write anything. For a given date it takes a few
// ungraded picks, fetches their PrizePicks history, and dumps the raw shape so we
// can see exactly why grading fails: does the endpoint return data, is there a
// games array, what dates/values are in it, and what the matcher would pick.
//
// Usage: /api/grade-debug?date=2026-06-29&limit=6

import { getStore } from '@netlify/blobs';

async function fetchHistory(projectionId) {
  const url = `https://api.prizepicks.com/projections/${projectionId}/history`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://app.prizepicks.com/',
      },
    });
    return { status: res.status, ok: res.ok, json: res.ok ? await res.json() : null };
  } catch (e) {
    return { status: 0, ok: false, error: String(e.message || e) };
  }
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const date = q.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const limit = Math.min(Number(q.limit) || 6, 10);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks;
    try { picks = await store.get(date, { type: 'json' }); } catch { picks = null; }
    if (!picks || !picks.length) return { statusCode: 200, headers, body: JSON.stringify({ date, message: 'no picks' }) };

    const ungraded = (p) => p.hit === null || p.hit === undefined;
    const sample = picks.filter((p) => ungraded(p) && p.projectionId).slice(0, limit);

    const out = [];
    for (const p of sample) {
      const h = await fetchHistory(p.projectionId);
      const hist = h.json;
      // history could be { games: [...] } or { data: [...] } or something else — show the truth
      const topKeys = hist && typeof hist === 'object' ? Object.keys(hist) : null;
      const games = hist && Array.isArray(hist.games) ? hist.games
                  : hist && Array.isArray(hist.data) ? hist.data : null;
      const gameSample = Array.isArray(games) ? games.slice(0, 8).map((g) => ({
        keys: Object.keys(g).slice(0, 12),
        start: g.game_start_time || g.start_time || g.date || null,
        startDate: String(g.game_start_time || g.start_time || g.date || '').slice(0, 10),
        stat_value: g.stat_value ?? g.value ?? g.score ?? null,
        opp: g.opponent_abbreviation || g.opponent || null,
      })) : null;

      out.push({
        player: p.player, stat: p.stat, line: p.line, date: p.date, loggedAt: p.loggedAt || null,
        projectionId: p.projectionId, gradeAttempts: p.gradeAttempts || 0,
        http: { status: h.status, ok: h.ok, error: h.error || null },
        historyType: hist === null ? 'null' : Array.isArray(hist) ? 'array' : typeof hist,
        topKeys, gamesFound: Array.isArray(games) ? games.length : 0, gameSample,
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ date, sampled: out.length, picks: out }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

// netlify/functions/grade-debug.js
//
// READ-ONLY diagnostic. Skips combos (they 404 and tell us nothing) and dumps the
// RAW history for a few PENDING SINGLE picks: the full games array with every date
// field, so we can see whether the just-played game is present and what field holds
// its date. Also shows what the current matcher would select.
//
// Usage: /api/grade-debug?date=2026-06-29&limit=5

import { getStore } from '@netlify/blobs';

const isCombo = (p) => /combo/i.test(p.stat || '') || /\s\+\s/.test(p.player || '');

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

// mirror of the grader's matcher so we can see what it picks
function pickGame(pick, games) {
  if (!Array.isArray(games)) return null;
  const D = pick.date;
  const Dplus = new Date(Date.parse(`${D}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const cands = games.filter((g) => {
    const d = String(g.game_start_time || g.start_time || '').slice(0, 10);
    return d === D || d === Dplus;
  });
  if (!cands.length) return null;
  return cands[0];
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const date = q.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const limit = Math.min(Number(q.limit) || 5, 8);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks;
    try { picks = await store.get(date, { type: 'json' }); } catch { picks = null; }
    if (!picks || !picks.length) return { statusCode: 200, headers, body: JSON.stringify({ date, message: 'no picks' }) };

    const ungraded = (p) => p.hit === null || p.hit === undefined;
    // SINGLES only — skip combos
    const sample = picks.filter((p) => ungraded(p) && p.projectionId && !isCombo(p)).slice(0, limit);
    if (!sample.length) return { statusCode: 200, headers, body: JSON.stringify({ date, message: 'no pending single picks (all graded, combos, or no id)' }) };

    const out = [];
    for (const p of sample) {
      const h = await fetchHistory(p.projectionId);
      const hist = h.json;
      const games = hist && (Array.isArray(hist.games) ? hist.games : Array.isArray(hist.data) ? hist.data : null);
      const firstKeys = Array.isArray(games) && games[0] ? Object.keys(games[0]) : null;
      const gameRows = Array.isArray(games) ? games.slice(0, 10).map((g) => ({
        // show EVERY plausible date field so we learn the real name
        game_start_time: g.game_start_time ?? null,
        start_time: g.start_time ?? null,
        date: g.date ?? null,
        metadata_date: g.metadata?.game_date ?? null,
        stat_value: g.stat_value ?? g.value ?? null,
        opp: g.opponent_abbreviation ?? g.opponent ?? null,
      })) : null;
      const matched = Array.isArray(games) ? pickGame(p, games) : null;

      out.push({
        player: p.player, stat: p.stat, line: p.line, date: p.date, loggedAt: p.loggedAt || null,
        gradeAttempts: p.gradeAttempts || 0,
        http: { status: h.status, ok: h.ok, error: h.error || null },
        topKeys: hist && typeof hist === 'object' ? Object.keys(hist) : null,
        gamesCount: Array.isArray(games) ? games.length : 0,
        firstGameKeys: firstKeys,
        games: gameRows,
        matcherPicks: matched ? { stat_value: matched.stat_value ?? matched.value ?? null, start: matched.game_start_time ?? matched.start_time ?? null } : null,
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ date, sampledSingles: out.length, picks: out }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

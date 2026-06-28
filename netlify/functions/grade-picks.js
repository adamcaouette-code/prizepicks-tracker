// netlify/functions/grade-picks.js
//
// Grades logged picks: for each ungraded pick, look up the actual result via the
// PrizePicks history endpoint and fill in hit/miss. Run it a day or two AFTER the
// games (results need to have posted).
//
// Usage: /api/grade-picks?date=2026-06-28   (defaults to yesterday)
//        /api/grade-picks?date=2026-06-28&dry=1   (preview, don't save)

import { getStore } from '@netlify/blobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull a projection's history (same endpoint the engine uses), with 429 retry.
async function fetchHistory(projectionId, attempt = 0) {
  const url = `https://api.prizepicks.com/projections/${projectionId}/history`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://app.prizepicks.com/',
      },
    });
    if (res.status === 429) {
      if (attempt >= 3) return null;
      await sleep(800 * (attempt + 1));
      return fetchHistory(projectionId, attempt + 1);
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Find the game on the pick's date and decide hit/miss vs the line.
function gradeOne(pick, history) {
  if (!history || !Array.isArray(history.games)) return null;
  // match the game played on the pick's date
  const game = history.games.find((g) => String(g.game_start_time || '').slice(0, 10) === pick.date);
  if (!game) return null;                       // result not posted yet
  const actual = Number(game.stat_value);
  if (!isFinite(actual)) return null;
  // PrizePicks lines are .5, so over = actual > line. (Exact-push rare with .5 lines.)
  const hit = actual > Number(pick.line);
  return { result: actual, hit, opponent: game.opponent_abbreviation, away: game.is_away };
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const dry = q.dry === '1';
  // default to yesterday (results usually posted by then)
  const date = q.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks;
    try { picks = await store.get(date, { type: 'json' }); } catch { picks = null; }
    if (!picks || !picks.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ date, message: `No logged picks for ${date}.` }) };
    }

    let graded = 0, stillPending = 0, alreadyDone = 0;
    for (const pick of picks) {
      if (pick.hit !== null && pick.hit !== undefined) { alreadyDone++; continue; }
      if (!pick.projectionId) { stillPending++; continue; }
      const hist = await fetchHistory(pick.projectionId);
      const g = gradeOne(pick, hist);
      if (g) {
        pick.result = g.result; pick.hit = g.hit; pick.gradedAt = new Date().toISOString();
        graded++;
      } else {
        stillPending++;
      }
      await sleep(250); // gentle on PrizePicks
    }

    if (!dry && graded > 0) await store.setJSON(date, picks);

    // quick summary of what's graded so far for this date
    const done = picks.filter((p) => p.hit === true || p.hit === false);
    const hits = done.filter((p) => p.hit === true).length;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date, dry,
        newlyGraded: graded, stillPending, alreadyGraded: alreadyDone,
        totalGraded: done.length, hits, misses: done.length - hits,
        hitRate: done.length ? Math.round((hits / done.length) * 100) / 100 : null,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

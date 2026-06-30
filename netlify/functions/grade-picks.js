// netlify/functions/grade-picks.js
//
// Grades logged picks: for each ungraded pick, look up the actual result via the
// PrizePicks history endpoint and fill in hit/miss. Run it a day or two AFTER the
// games (results need to have posted).
//
// Usage: /api/grade-picks?date=2026-06-28   (defaults to yesterday)
//        /api/grade-picks?date=2026-06-28&dry=1   (preview, don't save)
//
// This function is time-budgeted so it returns before Netlify's 10s sync-function
// limit. If a slate is large it may grade in a couple of passes — just hit the URL
// again and it picks up where it left off (graded picks are skipped). The response
// tells you exactly what happened: newlyGraded / stillPending / noProjectionId /
// remaining, so you can see at a glance whether grading is working.

import { getStore } from '@netlify/blobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUDGET_MS = 8000;   // stop before Netlify's ~10s kill
const CONCURRENCY = 3;    // a few lookups at once; retry covers the odd 429

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
  const game = history.games.find((g) => String(g.game_start_time || '').slice(0, 10) === pick.date);
  if (!game) return null;                       // result not posted / projection gone
  const actual = Number(game.stat_value);
  if (!isFinite(actual)) return null;
  const hit = actual > Number(pick.line);       // PP lines are .5, so over = actual > line
  return { result: actual, hit, opponent: game.opponent_abbreviation, away: game.is_away };
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const dry = q.dry === '1';
  const date = q.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks;
    try { picks = await store.get(date, { type: 'json' }); } catch { picks = null; }
    if (!picks || !picks.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ date, message: `No logged picks for ${date}.` }) };
    }

    const ungraded = (p) => p.hit === null || p.hit === undefined;
    const alreadyGraded = picks.filter((p) => !ungraded(p)).length;
    const noProjectionId = picks.filter((p) => ungraded(p) && !p.projectionId).length;
    const todo = picks.filter((p) => ungraded(p) && p.projectionId);

    const start = Date.now();
    let graded = 0, stillPending = 0, processed = 0, timedOut = false;

    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      if (Date.now() - start > BUDGET_MS) { timedOut = true; break; }
      const chunk = todo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (pick) => ({ pick, g: gradeOne(pick, await fetchHistory(pick.projectionId)) })));
      for (const { pick, g } of results) {
        processed++;
        if (g) { pick.result = g.result; pick.hit = g.hit; pick.gradedAt = new Date().toISOString(); graded++; }
        else { stillPending++; }
      }
      await sleep(100);
    }

    const remaining = todo.length - processed; // left unprocessed because the budget ran out
    if (!dry && graded > 0) await store.setJSON(date, picks);

    const done = picks.filter((p) => p.hit === true || p.hit === false);
    const hits = done.filter((p) => p.hit === true).length;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date, dry,
        newlyGraded: graded,
        stillPending,          // had an ID but no result found (game not posted, or projection expired)
        noProjectionId,        // logged without an ID — can't be graded this way
        remaining,             // ran out of time; hit the URL again to continue
        timedOut,
        alreadyGraded,
        totalGraded: done.length, hits, misses: done.length - hits,
        hitRate: done.length ? Math.round((hits / done.length) * 100) / 100 : null,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

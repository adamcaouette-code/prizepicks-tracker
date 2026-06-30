// netlify/functions/grade-picks.js
//
// Grades logged picks: for each ungraded pick, look up the actual result via the
// PrizePicks history endpoint and fill in hit/miss. Run it a day or two AFTER the
// games (results need to have posted).
//
// Usage: /api/grade-picks?date=2026-06-28   (defaults to yesterday)
//        /api/grade-picks?date=2026-06-28&dry=1   (preview, don't save)
//
// Time-budgeted so it returns before Netlify's ~10s sync limit. Large slates may
// take a few passes — just refresh the URL; it picks up where it left off. Picks
// that can't be matched after 3 tries are tombstoned so they stop eating the budget.

import { getStore } from '@netlify/blobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUDGET_MS = 8000;   // stop before Netlify's ~10s kill
const CONCURRENCY = 3;    // a few lookups at once; retry covers the odd 429
const MAX_ATTEMPTS = 3;   // give up on a pick after this many failed lookups

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

// Choose the game that this pick was logged against. PrizePicks stamps game times
// in UTC, so a Pacific-evening game on date D shows up as D+1 in UTC. We accept the
// game dated D or D+1 (UTC) and, when both exist, pick the one closest to loggedAt.
function pickGame(pick, games) {
  if (!Array.isArray(games)) return null;
  const D = pick.date;
  const Dplus = new Date(Date.parse(`${D}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const cands = games.filter((g) => {
    const d = String(g.game_start_time || '').slice(0, 10);
    return d === D || d === Dplus;
  });
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const ref = pick.loggedAt ? Date.parse(pick.loggedAt) : Date.parse(`${D}T18:00:00Z`);
  return cands.slice().sort((a, b) =>
    Math.abs(Date.parse(a.game_start_time) - ref) - Math.abs(Date.parse(b.game_start_time) - ref))[0];
}

function gradeOne(pick, history) {
  if (!history) return null;
  const game = pickGame(pick, history.games);
  if (!game) return null;                       // result not posted / no matching game
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
    const givenUp = picks.filter((p) => ungraded(p) && p.projectionId && (p.gradeAttempts || 0) >= MAX_ATTEMPTS).length;
    const todo = picks.filter((p) => ungraded(p) && p.projectionId && (p.gradeAttempts || 0) < MAX_ATTEMPTS);

    const start = Date.now();
    let graded = 0, stillPending = 0, processed = 0, timedOut = false;

    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      if (Date.now() - start > BUDGET_MS) { timedOut = true; break; }
      const chunk = todo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (pick) => ({ pick, g: gradeOne(pick, await fetchHistory(pick.projectionId)) })));
      for (const { pick, g } of results) {
        processed++;
        if (g) {
          pick.result = g.result; pick.hit = g.hit; pick.gradedAt = new Date().toISOString();
          graded++;
        } else {
          pick.gradeAttempts = (pick.gradeAttempts || 0) + 1; // tombstone progress
          stillPending++;
        }
      }
      await sleep(100);
    }

    const remaining = todo.length - processed; // left because the budget ran out (refresh to continue)
    if (!dry && processed > 0) await store.setJSON(date, picks);

    const done = picks.filter((p) => p.hit === true || p.hit === false);
    const hits = done.filter((p) => p.hit === true).length;
    const stillUngraded = picks.filter((p) => ungraded(p)).length;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date, dry,
        newlyGraded: graded,
        stillPending,          // tried this pass, no result yet (will retry up to 3x)
        remaining,             // ran out of time; refresh to continue
        timedOut,
        noProjectionId,        // logged without an ID — can't be graded this way
        givenUp,               // tried 3x, no match — tombstoned (DNP / scratch / combo)
        alreadyGraded,
        stillUngraded,         // everything not yet graded for this date
        totalGraded: done.length, hits, misses: done.length - hits,
        hitRate: done.length ? Math.round((hits / done.length) * 100) / 100 : null,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

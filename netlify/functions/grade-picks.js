// netlify/functions/grade-picks.js
//
// Grades logged SINGLE picks via the PrizePicks history endpoint. Combos are skipped
// (no single-projection history). Run a day or two AFTER games.
//
// A pick is only "tombstoned" (given up after 3 failed lookups) once its day is
// FINAL — i.e. ~36h past the pick date, a safe buffer for late west-coast games. Days
// that aren't final yet never accumulate tombstones, and any premature ones are
// reset, so grading TODAY can't permanently bench tonight's unfinished games.
//
// Usage: /api/grade-picks?date=2026-06-28   (defaults to yesterday)
//        /api/grade-picks?date=2026-06-28&dry=1   (preview, don't save)

import { getStore } from '@netlify/blobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUDGET_MS = 8000;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;
const FINAL_AFTER_MS = 36 * 3600 * 1000; // a day is "final" 36h after its date

const isCombo = (p) => /combo/i.test(p.stat || '') || /\s\+\s/.test(p.player || '');

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

// PrizePicks stamps game times in UTC; a Pacific-evening game on date D shows up as
// D+1 in UTC. Accept the game dated D or D+1 and, when both exist, take the closest
// to loggedAt.
function pickGame(pick, games) {
  if (!Array.isArray(games)) return null;
  const D = pick.date;
  const Dplus = new Date(Date.parse(`${D}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const cands = games.filter((g) => {
    const d = String(g.game_start_time || g.start_time || '').slice(0, 10);
    return d === D || d === Dplus;
  });
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const ref = pick.loggedAt ? Date.parse(pick.loggedAt) : Date.parse(`${D}T18:00:00Z`);
  return cands.slice().sort((a, b) =>
    Math.abs(Date.parse(a.game_start_time || a.start_time) - ref) - Math.abs(Date.parse(b.game_start_time || b.start_time) - ref))[0];
}

function gradeOne(pick, history) {
  if (!history) return null;
  const game = pickGame(pick, history.games || history.data);
  if (!game) return null;
  const actual = Number(game.stat_value ?? game.value ?? game.score);
  if (!isFinite(actual)) return null;
  const hit = actual > Number(pick.line);
  return { result: actual, hit };
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const dry = q.dry === '1';
  const date = q.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dayFinal = (Date.now() - Date.parse(`${date}T00:00:00Z`)) >= FINAL_AFTER_MS;

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks;
    try { picks = await store.get(date, { type: 'json' }); } catch { picks = null; }
    if (!picks || !picks.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ date, message: `No logged picks for ${date}.` }) };
    }

    const ungraded = (p) => p.hit === null || p.hit === undefined;

    // Mark combos ungradeable once.
    let combosMarked = 0;
    for (const p of picks) {
      if (ungraded(p) && !p.ungradeable && isCombo(p)) { p.ungradeable = 'combo'; combosMarked++; }
    }

    // If the day isn't final yet, clear any premature tombstones so unfinished games
    // aren't permanently benched — they'll grade once the day is final.
    let reset = 0;
    if (!dayFinal) {
      for (const p of picks) { if (ungraded(p) && !p.ungradeable && p.gradeAttempts) { p.gradeAttempts = 0; reset++; } }
    }

    const gradeable = (p) => ungraded(p) && !p.ungradeable && p.projectionId && (dayFinal ? (p.gradeAttempts || 0) < MAX_ATTEMPTS : true);
    const todo = picks.filter(gradeable);

    const start = Date.now();
    let graded = 0, stillPending = 0, processed = 0, timedOut = false;

    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      if (Date.now() - start > BUDGET_MS) { timedOut = true; break; }
      const chunk = todo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (pick) => ({ pick, g: gradeOne(pick, await fetchHistory(pick.projectionId)) })));
      for (const { pick, g } of results) {
        processed++;
        if (g) { pick.result = g.result; pick.hit = g.hit; pick.gradedAt = new Date().toISOString(); graded++; }
        else { if (dayFinal) pick.gradeAttempts = (pick.gradeAttempts || 0) + 1; stillPending++; }
      }
      await sleep(100);
    }

    const remaining = todo.length - processed;
    if (!dry && (processed > 0 || combosMarked > 0 || reset > 0)) await store.setJSON(date, picks);

    const done = picks.filter((p) => p.hit === true || p.hit === false);
    const hits = done.filter((p) => p.hit === true).length;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date, dry, dayFinal,
        newlyGraded: graded,
        stillPending,
        remaining,
        timedOut,
        resetTombstones: reset,
        combos: picks.filter((p) => p.ungradeable === 'combo').length,
        noProjectionId: picks.filter((p) => ungraded(p) && !p.ungradeable && !p.projectionId).length,
        givenUp: picks.filter((p) => ungraded(p) && !p.ungradeable && p.projectionId && (p.gradeAttempts || 0) >= MAX_ATTEMPTS).length,
        pendingSingles: picks.filter((p) => ungraded(p) && !p.ungradeable).length,
        totalGraded: done.length, hits, misses: done.length - hits,
        hitRate: done.length ? Math.round((hits / done.length) * 100) / 100 : null,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

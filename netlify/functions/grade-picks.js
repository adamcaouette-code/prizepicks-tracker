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
// Independent second source. PrizePicks retires a projection once it leaves the
// board, so ~36h later the id can 404 forever — and an ungradeable pick doesn't
// just go missing, it quietly biases the calibration sample toward whatever was
// still reachable. MLB's game logs are permanent.
import { gradeFromMlb } from './mlb-grade.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUDGET_MS = 8000;
const CONCURRENCY = 3;
// Attempts are counted PER CALENDAR DAY, not per call — see below. Three days of
// failing is a real give-up; three calls is not.
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

// PrizePicks stamps game times in UTC; a Pacific-evening game on date D shows up
// as D+1 in UTC. We also accept D-1: a slip saved late in the US evening can carry
// a date one day AHEAD of its games, and without this an off-by-one is
// unrecoverable — the lookup never matches and the row sits pending forever.
// Where several match, the one closest to loggedAt wins, so widening the window
// costs nothing in accuracy.
function pickGame(pick, games) {
  if (!Array.isArray(games)) return null;
  const D = pick.date;
  const shift = (days) => new Date(Date.parse(`${D}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const window = new Set([shift(-1), D, shift(1)]);
  const cands = games.filter((g) => window.has(String(g.game_start_time || g.start_time || '').slice(0, 10)));
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
  // ?retry=1 clears tombstones for this date and tries again. A pick given up on
  // is excluded from calibration, so a stuck one quietly shrinks the sample the
  // Brier score is computed from.
  const retry = q.retry === '1';
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
    if (!dayFinal || retry) {
      for (const p of picks) { if (ungraded(p) && !p.ungradeable && p.gradeAttempts) { p.gradeAttempts = 0; reset++; } }
    }
    // One-time repair. Attempts used to increment on every grader CALL, and the
    // cron drains in up to 15 passes — so a pick that wasn't instantly gradeable
    // was tombstoned within seconds of its first run, having really been tried
    // once. Any counter carrying no lastAttemptDay predates the per-day fix and
    // is not evidence of anything; clear it so those picks get a fair chance.
    let repaired = 0;
    for (const p of picks) {
      if (ungraded(p) && !p.ungradeable && p.gradeAttempts && !p.lastAttemptDay) {
        p.gradeAttempts = 0; repaired++;
      }
    }

    const gradeable = (p) => ungraded(p) && !p.ungradeable && p.projectionId && (dayFinal ? (p.gradeAttempts || 0) < MAX_ATTEMPTS : true);
    const todo = picks.filter(gradeable);

    const start = Date.now();
    const attemptDay = new Date().toISOString().slice(0, 10);
    let graded = 0, stillPending = 0, processed = 0, timedOut = false;

    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      if (Date.now() - start > BUDGET_MS) { timedOut = true; break; }
      const chunk = todo.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (pick) => {
        let g = gradeOne(pick, await fetchHistory(pick.projectionId));
        // PrizePicks couldn't answer. For MLB that is usually a retired
        // projection id, which never recovers — so ask MLB's own box score
        // instead. Same convention (hit = actual > line), so nothing downstream
        // changes; the row just records which source settled it.
        if (!g && String(pick.league || '').toLowerCase() === 'mlb') {
          g = await gradeFromMlb({ player: pick.player, mlbId: pick.mlbId, date: pick.date, stat: pick.stat, line: pick.line });
        }
        return { pick, g };
      }));
      for (const { pick, g } of results) {
        processed++;
        if (g) { pick.result = g.result; pick.hit = g.hit; pick.gradedAt = new Date().toISOString(); pick.gradedVia = g.source || 'prizepicks'; graded++; }
        else {
          // ONE attempt per day, however many times the grader runs. grade-cron
          // drains with up to 15 passes per firing, and this used to increment on
          // every pass — so a pick that wasn't instantly gradeable burned all
          // three of its lives within seconds of the first cron run and was
          // tombstoned forever. "Give up after 3 attempts" was meant to mean
          // three DAYS of trying. This is the single biggest reason the graded
          // share was so far below the logged count.
          if (dayFinal && pick.lastAttemptDay !== attemptDay) {
            pick.gradeAttempts = (pick.gradeAttempts || 0) + 1;
            pick.lastAttemptDay = attemptDay;
          }
          stillPending++;
        }
      }
      await sleep(100);
    }

    const remaining = todo.length - processed;
    if (!dry && (processed > 0 || combosMarked > 0 || reset > 0 || repaired > 0)) await store.setJSON(date, picks);

    const done = picks.filter((p) => p.hit === true || p.hit === false);
    const hits = done.filter((p) => p.hit === true).length;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date, dry, retry, dayFinal,
        newlyGraded: graded,
        stillPending,
        remaining,
        timedOut,
        resetTombstones: reset,
        repairedLegacyAttempts: repaired,
        combos: picks.filter((p) => p.ungradeable === 'combo').length,
        noProjectionId: picks.filter((p) => ungraded(p) && !p.ungradeable && !p.projectionId).length,
        givenUp: picks.filter((p) => ungraded(p) && !p.ungradeable && p.projectionId && (p.gradeAttempts || 0) >= MAX_ATTEMPTS).length,
        pendingSingles: picks.filter((p) => ungraded(p) && !p.ungradeable).length,
        totalGraded: done.length, hits, misses: done.length - hits,
        gradedViaMlbFallback: done.filter((p) => p.gradedVia === 'mlb').length,
        hitRate: done.length ? Math.round((hits / done.length) * 100) / 100 : null,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

// Shared with grade-slips.js so a saved slip's legs are settled by EXACTLY the
// same rules as a logged pick — same history endpoint, same UTC-rollover game
// picker, same `hit = actual > line` convention (i.e. "did the OVER hit"; the
// caller flips it for an under). Two graders that could disagree would be worse
// than one that's occasionally wrong.
export { fetchHistory, pickGame, gradeOne, isCombo, FINAL_AFTER_MS, MAX_ATTEMPTS };

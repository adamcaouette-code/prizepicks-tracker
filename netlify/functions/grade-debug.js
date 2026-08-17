// netlify/functions/grade-debug.js
//
// READ-ONLY. Answers "why isn't this grading?" with a reason per pick and a
// tally across the day, rather than a sample you have to interpret.
//
// The grader has exactly four places it can fail, and they mean very different
// things:
//   http_error      PrizePicks wouldn't serve the projection's history at all.
//                   A 404 here usually means the projection has been retired
//                   from their API — the id is dead and no amount of retrying
//                   brings it back. This is the failure that silently shrinks
//                   the calibration sample.
//   no_games        History served, but the games array was empty.
//   date_mismatch   Games present, none on the pick's date (±1). The response
//                   lists which dates ARE there, so an off-by-one is obvious.
//   no_stat_value   The right game is there but carries no value yet.
//   ok              Would grade; if it's still pending, the grader hasn't run.
//
// Usage: /api/grade-debug?date=2026-08-14            tally + first few raw
//        /api/grade-debug?date=2026-08-14&limit=40   check more of them
//        /api/grade-debug?date=2026-08-14&raw=1      include full history bodies

import { getStore } from '@netlify/blobs';
import { pickGame } from './grade-picks.js';

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
    return { status: res.status, ok: res.ok, json: res.ok ? await res.json().catch(() => null) : null };
  } catch (e) {
    return { status: 0, ok: false, error: String(e.message || e) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const date = q.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const limit = Math.min(Number(q.limit) || 12, 60);
  const raw = q.raw === '1';

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks;
    try { picks = await store.get(date, { type: 'json' }); } catch { picks = null; }
    if (!picks || !picks.length) return { statusCode: 200, headers, body: JSON.stringify({ date, message: 'no picks logged for this date' }) };

    const ungraded = (p) => p.hit === null || p.hit === undefined;
    const pending = picks.filter(ungraded);

    // Buckets that need no network call at all.
    const combos = pending.filter(isCombo).length;
    const noId = pending.filter((p) => !isCombo(p) && !p.projectionId).length;
    const checkable = pending.filter((p) => !isCombo(p) && p.projectionId);

    const sample = checkable.slice(0, limit);
    const results = await mapLimit(sample, 4, async (p) => {
      const h = await fetchHistory(p.projectionId);
      const base = { player: p.player, stat: p.stat, line: p.line, projectionId: p.projectionId, attempts: p.gradeAttempts || 0 };
      if (!h.ok) return { ...base, reason: 'http_error', status: h.status, note: h.status === 404
        ? 'projection retired from the PrizePicks API — this id can never be graded from that source'
        : (h.error || 'upstream refused') };

      const games = h.json?.games || h.json?.data;
      if (!Array.isArray(games) || !games.length) return { ...base, reason: 'no_games', status: h.status };

      const g = pickGame({ date, line: p.line, loggedAt: p.loggedAt }, games);
      if (!g) {
        return { ...base, reason: 'date_mismatch', status: h.status,
          wanted: date,
          datesPresent: [...new Set(games.map((x) => String(x.game_start_time || x.start_time || '').slice(0, 10)))].filter(Boolean).slice(0, 8) };
      }
      const value = g.stat_value ?? g.value ?? g.score;
      if (!isFinite(Number(value))) return { ...base, reason: 'no_stat_value', status: h.status, game: g };
      return { ...base, reason: 'ok', status: h.status, value: Number(value),
        wouldHit: Number(value) > Number(p.line), ...(raw ? { game: g } : {}) };
    });

    const tally = {};
    for (const r of results) tally[r.reason] = (tally[r.reason] || 0) + 1;

    // The headline: what share of the checked sample is permanently ungradeable.
    const dead = (tally.http_error || 0) + (tally.no_games || 0);
    return { statusCode: 200, headers, body: JSON.stringify({
      date,
      totals: { logged: picks.length, graded: picks.length - pending.length, pending: pending.length,
        combos, noProjectionId: noId, checkable: checkable.length, checked: sample.length },
      tally,
      verdict: !sample.length ? 'nothing pending to check'
        : dead === sample.length ? 'EVERY checked pick failed at the source — PrizePicks is no longer serving these projections, so they can never be graded from it. This is what shrinks the calibration sample.'
        : dead > 0 ? `${dead}/${sample.length} failed at the source and cannot be recovered from PrizePicks; the rest look gradeable.`
        : (tally.ok === sample.length ? 'all checked picks are gradeable — the grader simply has not run for them yet' : 'mixed; see tally'),
      results,
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

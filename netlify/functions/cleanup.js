// netlify/functions/cleanup.js
//
// Collapses duplicate rows in the pick log. Re-running the engine on a day appends
// the whole pick list again, so a day can hold 10+ copies of each pick. This keeps
// one row per distinct pick (preferring an already-graded copy). Pure in-memory,
// no network — fast and safe to run anytime you're not mid-run.
//
// Usage: /api/cleanup?date=2026-06-29   (one day)
//        /api/cleanup                    (all days)
//        add &dry=1 to preview without writing

import { getStore } from '@netlify/blobs';

const isGraded = (p) => p.hit === true || p.hit === false;

function dedupeDay(arr) {
  const m = new Map();
  for (const p of arr) {
    const key = p.projectionId || `${p.date}|${p.player}|${p.stat}|${p.line}`;
    const prev = m.get(key);
    if (!prev) { m.set(key, p); continue; }
    if (isGraded(p) && !isGraded(prev)) m.set(key, p); // keep the graded copy
  }
  return [...m.values()];
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const dry = q.dry === '1';

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

    const doDay = async (date) => {
      let arr = [];
      try { arr = (await store.get(date, { type: 'json' })) || []; } catch { arr = []; }
      const before = arr.length;
      // ?reset=1 clears gradeAttempts on ungraded picks so wrongly "given up" picks
      // (e.g. benched while their games were still in progress) can grade again.
      let resetN = 0;
      if (q.reset === '1') {
        for (const p of arr) {
          if ((p.hit === null || p.hit === undefined) && p.gradeAttempts) { p.gradeAttempts = 0; resetN++; }
        }
      }
      const deduped = dedupeDay(arr);
      const changed = deduped.length < before || resetN > 0;
      if (!dry && changed) await store.setJSON(date, deduped);
      return { date, before, after: deduped.length, removed: before - deduped.length, resetTombstones: resetN };
    };

    if (q.date) {
      const r = await doDay(q.date);
      return { statusCode: 200, headers, body: JSON.stringify({ dry, ...r }, null, 2) };
    }

    let keys = [];
    try { keys = (await store.list()).blobs.map((b) => b.key); } catch { keys = []; }
    const report = [];
    let totalRemoved = 0, totalReset = 0;
    for (const k of keys) { const r = await doDay(k); report.push(r); totalRemoved += r.removed; totalReset += r.resetTombstones; }
    return { statusCode: 200, headers, body: JSON.stringify({ dry, days: report.length, totalRemoved, totalReset, report }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

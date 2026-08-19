// netlify/functions/fantasy-check-background.js
//
// Runs the Fantasy Score weight check with a real budget, and stores the result
// for /api/fantasy-check to read.
//
// Background because the work does not fit anywhere else: each MLB pick needs a
// season game log for a distinct player, and a sample big enough to mean
// anything is well past the ~10s a synchronous function gets. Three attempts to
// squeeze it in produced a blank page, then 15 of 40, then 6 of 40.
//
// SAMPLING IS STRATIFIED BY KIND. The previous run sampled every Nth pick
// globally, ran out of budget six picks in, and resolved nothing but MLB
// hitters — so the basketball CONTROL was null and no verdict could be reached
// at all. Each kind now gets its own quota, which guarantees the control
// resolves even if MLB dominates the log.
//
// Usage: /api/fantasy-check-background
//        ?days=120   how far back to look
//        ?per=40     picks sampled PER KIND

import { getStore } from '@netlify/blobs';
import { gradeFromMlb } from './mlb-grade.js';
import { gradeFromEspn } from './espn-grade.js';
import { fantasyKind } from './fantasy-score.js';
import { RESULT_KEY } from './fantasy-check.js';

const BUDGET_MS = 11 * 60 * 1000;   // well inside the 15-minute ceiling
const CONCURRENCY = 6;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function store(name) {
  return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

export const handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const days = Math.min(Number(q.days) || 120, 200);
  const per = Math.min(Number(q.per) || 40, 100);
  const started = Date.now();

  const save = async (state) => {
    // AWAIT the write. Without it the final 'done' state was a floating promise
    // and the invocation ended before it flushed, so the store kept the earlier
    // 'running' forever and the reader showed a job that had actually finished
    // as still in progress — for hours.
    try {
      const s = await store('run-stats');
      await s.setJSON(RESULT_KEY, { ...state, at: new Date().toISOString() });
    } catch { /* progress is best-effort; never let it stop the work */ }
  };

  try {
    const log = await store('pick-log');
    let dates = [];
    try { dates = (await log.list()).blobs.map((b) => b.key).sort().slice(-days); } catch {}

    const tierCounts = {};
    const byKindPicks = {};
    for (const d of dates) {
      let arr = [];
      try { arr = (await log.get(d, { type: 'json' })) || []; } catch {}
      for (const p of arr) {
        const kind = fantasyKind(p.league, p.stat);
        if (!kind) continue;
        const tier = String(p.oddsType || 'standard').toLowerCase();
        tierCounts[tier] = (tierCounts[tier] || 0) + 1;
        if (tier !== 'standard') continue;      // see the header: tiers cannot be mixed
        (byKindPicks[kind] ||= []).push(p);
      }
    }

    await save({ state: 'running', kinds: Object.fromEntries(Object.entries(byKindPicks).map(([k, v]) => [k, v.length])) });

    // Even spread across the window per kind, so one unusual slate cannot set a
    // verdict and the control is never starved.
    const sample = [];
    for (const [kind, picks] of Object.entries(byKindPicks)) {
      const step = Math.max(1, Math.floor(picks.length / per));
      for (const p of picks.filter((_, i) => i % step === 0).slice(0, per)) sample.push({ ...p, kind });
    }

    const byKind = {};
    const rows = [];
    let attempted = 0, timedOut = false;

    const score = async (p) => (p.kind === 'basketball'
      ? gradeFromEspn({ league: p.league, player: p.player, date: p.date, stat: p.stat, line: p.line })
      : gradeFromMlb({ player: p.player, mlbId: p.mlbId, date: p.date, stat: p.stat, line: p.line, allowUnverifiedFantasy: true, debug: true }));

    const queue = [...sample];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        if (Date.now() - started > BUDGET_MS) { timedOut = true; return; }
        const p = queue.shift();
        attempted++;
        let g = null;
        try { g = await score(p); } catch { g = null; }
        if (g == null || !isFinite(Number(g.result))) continue;
        const b = (byKind[p.kind] ||= { computed: [], lines: [], n: 0, zeros: 0 });
        b.computed.push(Number(g.result));
        b.lines.push(Number(p.line));
        b.n++;
        if (Number(g.result) === 0) b.zeros++;
        // Keep the raw box-score line on a sample of rows. A computed 0 looks the
        // same whether the player genuinely went 0-for-4 or the lookup found the
        // wrong game, and only the raw line tells them apart.
        if (rows.length < 25) {
          rows.push({ player: p.player, stat: p.stat, date: p.date, line: p.line,
            computed: g.result, matchedVia: g.matchedVia, gameDate: g.gameDate, statLine: g.statLine });
        }
      }
    }));

    const stats = (b) => {
      const mc = median(b.computed), ml = median(b.lines);
      return { n: b.n, zeros: b.zeros, medianComputed: mc, medianLine: ml, ratio: ml ? mc / ml : null };
    };
    const raw = {};
    for (const [kind, b] of Object.entries(byKind)) raw[kind] = stats(b);
    const control = raw.basketball?.n >= 8 ? raw.basketball.ratio : null;

    const verdicts = {};
    for (const [kind, r] of Object.entries(raw)) {
      const rel = control && r.ratio ? r.ratio / control : null;
      const zeroShare = r.n ? r.zeros / r.n : 0;
      verdicts[kind] = {
        n: r.n,
        zeroResults: r.zeros,
        medianComputed: r.medianComputed,
        medianLine: r.medianLine,
        lineRatio: r.ratio == null ? null : Math.round(r.ratio * 1000) / 1000,
        vsControl: rel == null ? null : Math.round(rel * 1000) / 1000,
        verdict: r.n < 10 ? `too few resolved (n=${r.n})`
          : zeroShare > 0.35 ? `SUSPECT — ${r.zeros} of ${r.n} computed to exactly 0. Some are real 0-for-4 games, but this many suggests the lookup is finding games the player did not appear in. Check statLine on the sample rows before trusting any ratio here.`
          : kind === 'basketball' ? `CONTROL — standard DFS weights, not under test. Its ratio (${r.ratio?.toFixed(2)}) is the selection-bias baseline.`
          : rel == null ? `raw ratio ${r.ratio?.toFixed(2)}, but no basketball control resolved — cannot separate a weight error from selection bias.`
          : rel > 0.8 && rel < 1.25 ? `WEIGHTS LOOK RIGHT — ${rel.toFixed(2)}x the control`
          : rel >= 1.25 ? `TOO HIGH by ~${rel.toFixed(2)}x relative to the control — a term is over-weighted`
          : `TOO LOW by ~${(1 / rel).toFixed(2)}x relative to the control — a term is missing or under-weighted`,
      };
    }

    await save({
      state: 'done',
      standardTierPicksAvailable: Object.fromEntries(Object.entries(byKindPicks).map(([k, v]) => [k, v.length])),
      allTiersInLog: tierCounts,
      sampled: sample.length,
      attempted,
      timedOut,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      controlRatio: control == null ? null : Math.round(control * 1000) / 1000,
      verdicts,
      sampleRows: rows,
      method: 'Standard tier only, stratified per kind, judged relative to the basketball control.',
    });

    return { statusCode: 200, body: JSON.stringify({ attempted, timedOut }) };
  } catch (err) {
    await save({ state: 'error', error: String(err.message || err) });
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

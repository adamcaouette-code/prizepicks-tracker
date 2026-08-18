// netlify/functions/fantasy-check.js
//
// Checks the Fantasy Score weights against reality before they are trusted to
// grade 335 picks.
//
// There is no external truth available — PrizePicks won't serve results. But the
// LINES are evidence. A bookmaker sets a line near the middle of the expected
// distribution, so across a few hundred props the median computed score should
// land close to the median line. If the weights are wrong the computed values
// sit systematically off, and the ratio shows it immediately:
//
//   ratio ~1.0    weights look right
//   ratio ~2.0    a term is double-counted, or a per-inning weight is per-out
//   ratio ~0.5    a term is missing or halved
//   ratio wild    the formula is not close
//
// This is a sanity check, not a proof. It cannot catch an error that preserves
// the median — swapping two weights of similar size, say. What it does catch is
// the kind of mistake that would grade hundreds of picks wrong, which is the
// one that matters.
//
// Usage: /api/fantasy-check              last 30 days of logged fantasy props
//        /api/fantasy-check?days=60

import { getStore } from '@netlify/blobs';
import { gradeFromMlb } from './mlb-grade.js';
import { gradeFromEspn } from './espn-grade.js';
import { fantasyKind, BASKETBALL_WEIGHTS, MLB_HITTER_WEIGHTS, MLB_PITCHER_WEIGHTS, MLB_VERIFIED } from './fantasy-score.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// A synchronous Netlify function is killed at ~10s with no response body at all.
// Stop starting new lookups well before that so there is always time to
// serialize an answer — a partial verdict is useful, a blank page is not.
const BUDGET_MS = 6500;
const CONCURRENCY = 5;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const started = Date.now();
  // Overridable so a test can drive the budget path in milliseconds instead of
  // seconds, and so a slow day can be given a deliberately short pass.
  const budgetMs = Math.min(Number(q.budget) || BUDGET_MS, BUDGET_MS);
  const days = Math.min(Number(q.days) || 30, 120);
  // Default sample cut from 40: each one is a network round trip, and the
  // verdict is a median — 15 resolved picks already pins a factor-of-two error.
  const limit = Math.min(Number(q.limit) || 15, 40);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let dates = [];
    try { dates = (await store.list()).blobs.map((b) => b.key).sort().slice(-days); } catch {}

    const fantasyPicks = [];
    for (const d of dates) {
      let arr = [];
      try { arr = (await store.get(d, { type: 'json' })) || []; } catch {}
      for (const p of arr) {
        const kind = fantasyKind(p.league, p.stat);
        if (kind) fantasyPicks.push({ ...p, kind });
      }
    }

    // Sample across the whole window rather than the newest day, so one unusual
    // slate can't set the verdict.
    const step = Math.max(1, Math.floor(fantasyPicks.length / limit));
    const sample = fantasyPicks.filter((_, i) => i % step === 0).slice(0, limit);

    const byKind = {};
    const rows = [];
    const score = async (p) => (p.kind === 'basketball'
      ? gradeFromEspn({ league: p.league, player: p.player, date: p.date, stat: p.stat, line: p.line })
      // allowUnverifiedFantasy lets this endpoint SEE the formula's output
      // while the grader itself still refuses to write it anywhere.
      : gradeFromMlb({ player: p.player, mlbId: p.mlbId, date: p.date, stat: p.stat, line: p.line, allowUnverifiedFantasy: true }));

    const keep = (p, g) => {
      if (g == null || !isFinite(Number(g.result))) return;
      const b = (byKind[p.kind] ||= { computed: [], lines: [], n: 0 });
      b.computed.push(Number(g.result));
      b.lines.push(Number(p.line));
      b.n++;
      if (rows.length < 12) rows.push({ player: p.player, stat: p.stat, date: p.date, line: p.line, computed: g.result });
    };

    // This used to run one await per pick in a plain for-loop. At ~400ms a
    // lookup that is 16s for 40 picks, well past the ~10s a synchronous Netlify
    // function gets, so it was killed mid-flight and returned an EMPTY body —
    // no JSON, no error, nothing to debug from.
    //
    // Three things fix it: prime the caches with one serial call so parallel
    // workers don't each fetch the same giant player list, run the rest with
    // real concurrency, and stop starting work before the platform's limit so
    // there is always time to answer with whatever was gathered.
    if (sample.length) keep(sample[0], await score(sample[0]).catch(() => null));

    let attempted = Math.min(1, sample.length);
    let timedOut = false;
    const queue = sample.slice(1);
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        if (Date.now() - started > budgetMs) { timedOut = true; return; }
        const p = queue.shift();
        attempted++;
        keep(p, await score(p).catch(() => null));
      }
    }));

    const verdicts = {};
    for (const [kind, b] of Object.entries(byKind)) {
      const mc = median(b.computed), ml = median(b.lines);
      const ratio = ml ? mc / ml : null;
      verdicts[kind] = {
        n: b.n,
        medianComputed: mc,
        medianLine: ml,
        lineRatio: ratio == null ? null : Math.round(ratio * 1000) / 1000,
        verdict: b.n < 10 ? `too few resolved (n=${b.n}) — widen ?days= and retry`
          : ratio == null ? 'no lines to compare'
          : ratio > 0.85 && ratio < 1.18 ? 'WEIGHTS LOOK RIGHT — computed scores track the lines'
          : ratio >= 1.18 && ratio < 2.5 ? `TOO HIGH by ~${ratio.toFixed(2)}x — a term is over-weighted or double counted`
          : ratio <= 0.85 && ratio > 0.4 ? `TOO LOW by ~${(1 / ratio).toFixed(2)}x — a term is missing or under-weighted`
          : `FAR OFF (${ratio.toFixed(2)}x) — the formula is not close; do not enable`,
      };
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      fantasyPicksInLog: fantasyPicks.length,
      sampled: sample.length,
      attempted,
      elapsedMs: Date.now() - started,
      timedOut,
      ...(timedOut ? { timeoutNote: 'Ran out of budget before finishing the sample. The verdicts below are from what DID resolve; add ?limit=8 for a faster pass, or trust them if n is already 10+.' } : {}),
      mlbCurrentlyEnabled: MLB_VERIFIED,
      verdicts,
      sampleRows: rows,
      weightsInUse: { basketball: BASKETBALL_WEIGHTS, mlbHitter: MLB_HITTER_WEIGHTS, mlbPitcher: MLB_PITCHER_WEIGHTS },
      howToEnable: 'If the MLB verdicts say the weights look right, set FANTASY_MLB_VERIFIED=1 in the Netlify environment. Basketball is already on. If a verdict says TOO HIGH or TOO LOW, send this response back and the weights get corrected before anything grades.',
      caveat: 'Median-vs-line is a sanity check, not a proof. It catches the errors that would grade hundreds of picks wrong; it cannot catch an error that leaves the median unchanged.',
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

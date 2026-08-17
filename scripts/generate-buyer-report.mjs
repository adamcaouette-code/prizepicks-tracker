#!/usr/bin/env node
// scripts/generate-buyer-report.mjs
//
// Standalone performance report over real graded data. Reads only — it imports
// nothing from netlify/functions and writes nothing back to any store.
//
//   node scripts/generate-buyer-report.mjs                     # live Netlify Blobs
//   node scripts/generate-buyer-report.mjs --snapshot data/    # save raw pulls too
//   node scripts/generate-buyer-report.mjs --from data/        # offline, from a snapshot
//   node scripts/generate-buyer-report.mjs --min-n 30 --out reports/buyer
//
// Live mode needs NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN in the environment.
//
// ---------------------------------------------------------------------------
// WHAT THIS REPORT IS BUILT ON, AND WHERE IT IS THIN
//
// Two stores hold results, and they are NOT interchangeable:
//
//   pick-log      One blob per day, each an array of individual PICKS (legs).
//                 Permanent — nothing deletes it. This is the real archive and
//                 the only source with enough history for a trend.
//                 Fields: date, loggedAt, league, projectionId, player, stat,
//                 line, prob, verdict, oddsType, recentAvg, source, result,
//                 hit, gradedAt, gradedVia, gradeAttempts.
//
//   saved-slips   One blob per SLIP, with legs[], entry (power/flex), stake,
//                 status, payout. Deleted after SLIP_RETENTION_DAYS (default 3)
//                 plus a day of grace. So this store holds roughly the last four
//                 days and cannot support a historical slip win rate.
//
// Parlay size, entry type and payout exist ONLY on saved slips, so section 3 is
// bounded by that retention window no matter how long the app has run. Sections
// keyed to leg-level data (tier, league, trend) use the permanent log instead.
//
// Three things are stated plainly in the output rather than smoothed over:
//   - `hit` means the OVER cleared. The recommended SIDE is not stored, so a
//     directional win rate has to reconstruct it from prob and is marked as
//     reconstructed wherever it appears.
//   - Every rate carries a Wilson 95% interval. A point estimate off a small
//     sample is the single easiest way to mislead a buyer, including by
//     accident.
//   - Ungraded picks are counted and shown as coverage. A win rate computed over
//     whatever happened to grade is only trustworthy if grading isn't
//     systematically missing a category.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// PrizePicks payout tables, mirrored from netlify/functions/bet-finder-size.js.
// Copied deliberately: this script must not import app logic, and a report that
// silently changed because a shared table moved would be worse than a stale one.
// Keep in sync by hand if the real payouts change.
const POWER_PURE = {
  goblin: { 3: 2.0, 4: 2.3, 5: 2.6, 6: 3.25 },
  standard: { 2: 3.0, 3: 4.75, 4: 7.0, 5: 10.0, 6: 16.0 },
  demon: { 3: 12.0, 4: 23.0, 5: 45.0, 6: 97.0 },
};

const MIN_N_DEFAULT = 30;

// ---------------------------------------------------------------------------
// stats

/**
 * Wilson score interval for a binomial proportion.
 *
 * The normal approximation is unusable at the sample sizes this app has: at
 * n=10 it happily produces bounds below 0 or above 1, and at 0 or 100 percent
 * it collapses to zero width, implying certainty from ten coin flips. Wilson
 * stays inside [0,1] and keeps a sane width at the extremes, which is exactly
 * where a buyer-facing number is most likely to be over-read.
 */
export function wilson(hits, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 1, width: 1 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lo = Math.max(0, (centre - spread) / d);
  const hi = Math.min(1, (centre + spread) / d);
  return { lo, hi, width: hi - lo };
}

/** Per-leg hit rate a pure-tier Power slip needs just to break even. */
export function breakEvenPerLeg(tier, legs) {
  const mult = POWER_PURE[tier]?.[legs];
  return mult ? Math.pow(1 / mult, 1 / legs) : null;
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x == null ? '—' : `$${Number(x).toFixed(4)}`);
const usd2 = (x) => (x == null ? '—' : `$${Number(x).toFixed(2)}`);

/** A rate plus its interval and a sample-size verdict. */
export function rate(hits, n, minN = MIN_N_DEFAULT) {
  if (!n) return { n: 0, hits: 0, rate: null, lo: null, hi: null, lowConfidence: true, note: 'no graded data' };
  const w = wilson(hits, n);
  return {
    n, hits, rate: hits / n, lo: w.lo, hi: w.hi,
    lowConfidence: n < minN,
    note: n < minN ? `low confidence — n=${n} is under the ${minN} threshold` : null,
  };
}

// ---------------------------------------------------------------------------
// loading

const isGraded = (p) => p.hit === true || p.hit === false;

/**
 * The recommended side is not stored on a logged pick, so it is reconstructed:
 * the engine takes the under when its P(over) is below a half. That matches
 * attachSides() in "both" mode, which is the default. It does NOT capture a run
 * made with the unders-only filter on, where the under is taken regardless — so
 * anything derived from this is labelled reconstructed wherever it is reported.
 */
const sideOf = (p) => (Number(p.prob) < 0.5 ? 'under' : 'over');
const wonDirectionally = (p) => (sideOf(p) === 'over' ? p.hit === true : p.hit === false);

async function loadLive() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) {
    throw new Error(
      'Live mode needs NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN in the environment.\n' +
      'Either export them, or run against a saved snapshot with --from <dir>.'
    );
  }
  const open = (name) => getStore({ name, siteID, token });

  const readAll = async (name) => {
    const s = open(name);
    let keys = [];
    try { keys = (await s.list()).blobs.map((b) => b.key); } catch { return {}; }
    const out = {};
    // Modest concurrency: this is a report, not a hot path, and hammering the
    // blob API to save two seconds is a poor trade.
    const queue = [...keys];
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length) {
        const k = queue.shift();
        try { out[k] = await s.get(k, { type: 'json' }); } catch { out[k] = null; }
      }
    }));
    return out;
  };

  return {
    pickLog: await readAll('pick-log'),
    savedSlips: await readAll('saved-slips'),
    costLog: await readAll('cost-log'),
  };
}

async function loadSnapshot(dir) {
  const one = async (name) => {
    const f = path.join(dir, `${name}.json`);
    if (!existsSync(f)) return {};
    return JSON.parse(await readFile(f, 'utf8'));
  };
  const data = {
    pickLog: await one('pick-log'),
    savedSlips: await one('saved-slips'),
    costLog: await one('cost-log'),
  };
  if (!Object.keys(data.pickLog).length && !existsSync(path.join(dir, 'pick-log.json'))) {
    const found = existsSync(dir) ? (await readdir(dir)).join(', ') : '(missing directory)';
    throw new Error(`No pick-log.json in ${dir}. Found: ${found || '(empty)'}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// shaping

/** Flatten the per-day pick log into one array, de-duplicated the way cleanup.js does. */
export function flattenPicks(pickLog) {
  const seen = new Map();
  for (const [day, arr] of Object.entries(pickLog || {})) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const key = `${p.source || 'board'}|${p.projectionId || `${p.player}|${p.stat}|${p.line}`}|${p.date || day}`;
      const prev = seen.get(key);
      // Prefer a graded copy; a day can hold several re-logs of the same pick.
      if (!prev || (isGraded(p) && !isGraded(prev))) seen.set(key, { ...p, date: p.date || day });
    }
  }
  return [...seen.values()];
}

/** ISO week key (YYYY-Www) — Monday-anchored, so weeks don't drift across months. */
export function weekKey(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d)) return null;
  const day = (d.getUTCDay() + 6) % 7;            // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3);          // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d - firstThu) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const monthKey = (dateStr) => String(dateStr).slice(0, 7);

function groupRate(rows, keyFn, minN) {
  const buckets = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    const b = (buckets[k] ||= { hits: 0, n: 0 });
    b.n++;
    if (wonDirectionally(r)) b.hits++;
  }
  const out = {};
  for (const [k, b] of Object.entries(buckets)) out[k] = rate(b.hits, b.n, minN);
  return out;
}

// ---------------------------------------------------------------------------
// analysis

export function analyse(data, { minN = MIN_N_DEFAULT, now = new Date(), dataSource = null } = {}) {
  const allPicks = flattenPicks(data.pickLog);
  const graded = allPicks.filter(isGraded);
  const slips = Object.values(data.savedSlips || {}).filter(Boolean);

  const dates = allPicks.map((p) => String(p.date || '').slice(0, 10)).filter(Boolean).sort();
  const gradedDates = graded.map((p) => String(p.date || '').slice(0, 10)).filter(Boolean).sort();

  // Recommendations only — a buyer is buying the picks the engine stands behind,
  // not every prop it scanned and passed on.
  const recommended = graded.filter((p) => p.verdict === 'play' || p.verdict === 'lean');
  const plays = graded.filter((p) => p.verdict === 'play');

  const dirHits = (rows) => rows.filter(wonDirectionally).length;

  const legLevel = {
    all: rate(dirHits(graded), graded.length, minN),
    recommended: rate(dirHits(recommended), recommended.length, minN),
    playsOnly: rate(dirHits(plays), plays.length, minN),
    // The raw over-hit rate calibration itself uses, kept beside the directional
    // figure so the two can be compared rather than conflated.
    overHitRate: rate(graded.filter((p) => p.hit === true).length, graded.length, minN),
  };

  const byTier = groupRate(recommended, (p) => String(p.oddsType || 'standard').toLowerCase(), minN);
  const byLeague = groupRate(recommended, (p) => String(p.league || 'unknown').toLowerCase(), minN);
  const byWeek = groupRate(recommended, (p) => weekKey(p.date), minN);
  const byMonth = groupRate(recommended, (p) => monthKey(p.date), minN);
  const bySource = groupRate(recommended, (p) => String(p.source || 'board').toLowerCase(), minN);

  // Grading coverage. A win rate over "whatever graded" is only meaningful if
  // grading isn't systematically missing a slice, so coverage is reported per
  // league too — that is where the gap actually lives.
  const coverageByLeague = {};
  for (const p of allPicks) {
    const lg = String(p.league || 'unknown').toLowerCase();
    const c = (coverageByLeague[lg] ||= { logged: 0, graded: 0, viaSource: {} });
    c.logged++;
    if (isGraded(p)) {
      c.graded++;
      const via = p.gradedVia || 'prizepicks';
      c.viaSource[via] = (c.viaSource[via] || 0) + 1;
    }
  }
  for (const c of Object.values(coverageByLeague)) c.coverage = c.logged ? c.graded / c.logged : 0;

  // ---- slips (bounded by retention) ----
  const settled = slips.filter((s) => s.status === 'won' || s.status === 'lost' || s.status === 'partial');
  const slipDates = slips.map((s) => s.slateDate || String(s.createdAt || '').slice(0, 10)).filter(Boolean).sort();

  const bySize = {};
  for (const s of settled) {
    const n = (s.legs || []).length;
    const b = (bySize[n] ||= { hits: 0, n: 0, staked: 0, returned: 0 });
    b.n++;
    if (s.status === 'won') b.hits++;
    b.staked += Number(s.stake) || 0;
    b.returned += Number(s.payout) || 0;
  }
  const slipBySize = {};
  for (const [size, b] of Object.entries(bySize)) {
    slipBySize[size] = {
      ...rate(b.hits, b.n, minN),
      staked: Math.round(b.staked * 100) / 100,
      returned: Math.round(b.returned * 100) / 100,
      net: Math.round((b.returned - b.staked) * 100) / 100,
      roi: b.staked ? (b.returned - b.staked) / b.staked : null,
      breakEvenPerLeg: breakEvenPerLeg('standard', Number(size)),
    };
  }

  const slipLevel = {
    total: slips.length,
    settled: settled.length,
    pending: slips.filter((s) => s.status === 'pending').length,
    ungradeable: slips.filter((s) => s.status === 'ungradeable').length,
    winRate: rate(settled.filter((s) => s.status === 'won').length, settled.length, minN),
    dateRange: slipDates.length ? { first: slipDates[0], last: slipDates[slipDates.length - 1] } : null,
    bySize: slipBySize,
    retentionDays: Number(process.env.SLIP_RETENTION_DAYS) || 3,
  };

  // ---- cost ----
  const costRows = Object.values(data.costLog || {}).flat().filter(Boolean);
  const byFeature = {};
  for (const c of costRows) {
    const f = c.feature || 'unknown';
    const b = (byFeature[f] ||= { calls: 0, usd: 0, inTok: 0, outTok: 0, searches: 0 });
    b.calls++;
    b.usd += Number(c.usd) || 0;
    b.inTok += Number(c.inTok) || 0;
    b.outTok += Number(c.outTok) || 0;
    b.searches += Number(c.searches) || 0;
  }
  for (const b of Object.values(byFeature)) {
    b.usd = Math.round(b.usd * 10000) / 10000;
    b.avgUsd = b.calls ? Math.round((b.usd / b.calls) * 10000) / 10000 : null;
  }
  const totalUsd = Math.round(costRows.reduce((a, c) => a + (Number(c.usd) || 0), 0) * 10000) / 10000;
  const costDates = Object.keys(data.costLog || {}).sort();

  // One "analysis" is one full bet-finder run. The engine makes several API calls
  // per run, so dividing total spend by call count would understate it badly —
  // group by the run instead, keyed by the day it ran.
  const runsByDay = {};
  for (const [day, rows] of Object.entries(data.costLog || {})) {
    if (!Array.isArray(rows)) continue;
    const finder = rows.filter((r) => /bet.?find|judge|research/i.test(r.feature || ''));
    if (finder.length) runsByDay[day] = finder.reduce((a, r) => a + (Number(r.usd) || 0), 0);
  }
  const runDays = Object.values(runsByDay);

  const cost = {
    totalUsd,
    calls: costRows.length,
    dateRange: costDates.length ? { first: costDates[0], last: costDates[costDates.length - 1] } : null,
    byFeature,
    avgPerCallUsd: costRows.length ? Math.round((totalUsd / costRows.length) * 10000) / 10000 : null,
    avgPerAnalysisDayUsd: runDays.length
      ? Math.round((runDays.reduce((a, b) => a + b, 0) / runDays.length) * 10000) / 10000 : null,
    analysisDays: runDays.length,
    tokens: {
      in: costRows.reduce((a, c) => a + (Number(c.inTok) || 0), 0),
      out: costRows.reduce((a, c) => a + (Number(c.outTok) || 0), 0),
      searches: costRows.reduce((a, c) => a + (Number(c.searches) || 0), 0),
    },
  };

  return {
    generatedAt: now.toISOString(),
    // Stated in the report header: a buyer-facing document should say whether it
    // was built from the live stores or from a snapshot taken at some earlier time.
    dataSource,
    minN,
    coverage: {
      daysLogged: Object.keys(data.pickLog || {}).length,
      picksLogged: allPicks.length,
      picksGraded: graded.length,
      gradingCoverage: allPicks.length ? graded.length / allPicks.length : 0,
      dateRange: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
      gradedDateRange: gradedDates.length ? { first: gradedDates[0], last: gradedDates[gradedDates.length - 1] } : null,
      byLeague: coverageByLeague,
    },
    legLevel, byTier, byLeague, byWeek, byMonth, bySource,
    slipLevel,
    cost,
  };
}

// ---------------------------------------------------------------------------
// rendering

const flag = (r) => (r.lowConfidence ? ' ⚠️' : '');
const ci = (r) => (r.n ? `${pct(r.lo)} – ${pct(r.hi)}` : '—');

function rateTable(obj, label, { breakEven } = {}) {
  const keys = Object.keys(obj).sort((a, b) => (obj[b].n || 0) - (obj[a].n || 0));
  if (!keys.length) return '_No graded data._\n';
  const head = breakEven
    ? `| ${label} | Graded | Win rate | 95% interval | Break-even (3-pick Power) | Verdict |\n|---|---:|---:|:---:|---:|---|`
    : `| ${label} | Graded | Win rate | 95% interval | Verdict |\n|---|---:|---:|:---:|---|`;
  const rows = keys.map((k) => {
    const r = obj[k];
    const verdict = !r.n ? 'no data'
      : r.lowConfidence ? `**LOW CONFIDENCE** (n=${r.n})`
      : 'usable sample';
    const be = breakEven ? ` ${pct(breakEvenPerLeg(k, 3))} |` : '';
    return `| ${k.toUpperCase()}${flag(r)} | ${r.n} | ${pct(r.rate)} | ${ci(r)} |${be} ${verdict} |`;
  });
  return [head, ...rows].join('\n') + '\n';
}

function trendTable(obj, label) {
  const keys = Object.keys(obj).sort();
  if (!keys.length) return '_No graded data._\n';
  const rows = keys.map((k) => {
    const r = obj[k];
    return `| ${k}${flag(r)} | ${r.n} | ${pct(r.rate)} | ${ci(r)} |`;
  });
  return [`| ${label} | Graded | Win rate | 95% interval |`, '|---|---:|---:|:---:|', ...rows].join('\n') + '\n';
}

export function renderMarkdown(a) {
  const c = a.coverage;
  const L = [];
  const P = (s = '') => L.push(s);

  P('# AtomBets — Performance Report');
  P('');
  P(`_Generated ${a.generatedAt.slice(0, 19).replace('T', ' ')} UTC from ${a.dataSource || 'live Netlify Blobs'}._`);
  P('');

  // Up front, not buried. A reader who stops after the first screen should still
  // know what the numbers can and cannot support.
  P('## Read this first');
  P('');
  P(`- Every rate below carries a **Wilson 95% confidence interval**. On small samples the interval, not the headline number, is the honest summary.`);
  P(`- Anything with fewer than **${a.minN} graded results** is marked ⚠️ **LOW CONFIDENCE** and should not be presented as a track record.`);
  P(`- **Grading coverage is ${pct(c.gradingCoverage)}** (${c.picksGraded} of ${c.picksLogged} logged picks). Ungraded picks are not failures — they are picks no data source could settle — but a win rate computed over a partial sample inherits whatever bias caused the gap.`);
  P(`- The recommended **side is not stored** on a logged pick, so directional win rates reconstruct it from the model's probability (under when P(over) < 0.5). Runs made with the unders-only filter are not distinguishable and may be misattributed.`);
  P(`- **Saved slips are deleted after ${a.slipLevel.retentionDays} days** (plus a day of grace). Section 3 therefore covers only the last few days and can never show a long-run slip record, regardless of how long the app has run.`);
  P('');

  P('## 1. Coverage and date range');
  P('');
  P('| | |');
  P('|---|---|');
  P(`| Days with logged picks | ${c.daysLogged} |`);
  P(`| Picks logged | ${c.picksLogged} |`);
  P(`| Picks graded | ${c.picksGraded} |`);
  P(`| Grading coverage | ${pct(c.gradingCoverage)} |`);
  P(`| Logged date range | ${c.dateRange ? `${c.dateRange.first} → ${c.dateRange.last}` : '—'} |`);
  P(`| Graded date range | ${c.gradedDateRange ? `${c.gradedDateRange.first} → ${c.gradedDateRange.last}` : '—'} |`);
  P(`| Saved slips retained | ${a.slipLevel.total} (${a.slipLevel.settled} settled) |`);
  P('');
  P('### Grading coverage by league');
  P('');
  P('Where the gaps are matters more than the overall figure — a league that rarely grades contributes little to any rate above.');
  P('');
  P('| League | Logged | Graded | Coverage | Settled by |');
  P('|---|---:|---:|---:|---|');
  for (const [lg, v] of Object.entries(c.byLeague).sort((x, y) => y[1].logged - x[1].logged)) {
    const via = Object.entries(v.viaSource).map(([k, n]) => `${k} ${n}`).join(', ') || '—';
    P(`| ${lg.toUpperCase()} | ${v.logged} | ${v.graded} | ${pct(v.coverage)} | ${via} |`);
  }
  P('');

  P('## 2. Win rate overall and by confidence tier');
  P('');
  P('Leg-level, from the permanent pick log. "Recommended" means the engine returned a verdict of *play* or *lean* — the picks it stood behind.');
  P('');
  P('| Population | Graded | Win rate | 95% interval | |');
  P('|---|---:|---:|:---:|---|');
  for (const [label, r] of [
    ['All graded picks', a.legLevel.all],
    ['Recommended (play + lean)', a.legLevel.recommended],
    ['High conviction (play only)', a.legLevel.playsOnly],
  ]) {
    P(`| ${label}${flag(r)} | ${r.n} | ${pct(r.rate)} | ${ci(r)} | ${r.lowConfidence ? '**LOW CONFIDENCE**' : ''} |`);
  }
  P('');
  P(`Raw over-hit rate (the figure the internal calibration page scores, kept here so the two are never confused): **${pct(a.legLevel.overHitRate.rate)}** over ${a.legLevel.overHitRate.n} picks.`);
  P('');
  P('### By tier');
  P('');
  P('Break-even is the per-leg hit rate a pure 3-pick Power slip of that tier needs just to return the stake. A tier beating its own break-even is the claim that matters; a raw percentage on its own is not comparable across tiers.');
  P('');
  P(rateTable(a.byTier, 'Tier', { breakEven: true }));

  P('## 3. Win rate by parlay size');
  P('');
  if (!a.slipLevel.settled) {
    P(`_No settled slips are currently retained._ Saved slips are deleted after ${a.slipLevel.retentionDays} days, so this section reflects only the last few days of activity. **It cannot be used as a historical slip record.** To build one, raise \`SLIP_RETENTION_DAYS\` or archive slips before they expire — see "Making this report stronger" below.`);
  } else {
    P(`Settled slips only, from the ${a.slipLevel.total} currently retained (${a.slipLevel.settled} settled, ${a.slipLevel.pending} pending, ${a.slipLevel.ungradeable} ungradeable).`);
    P('');
    P(`**Retention limits this section to roughly the last ${a.slipLevel.retentionDays + 1} days.** It is a snapshot, not a track record.`);
    P('');
    P('| Legs | Settled | Win rate | 95% interval | Staked | Returned | Net | ROI |');
    P('|---:|---:|---:|:---:|---:|---:|---:|---:|');
    for (const [size, r] of Object.entries(a.slipLevel.bySize).sort((x, y) => Number(x[0]) - Number(y[0]))) {
      P(`| ${size}${flag(r)} | ${r.n} | ${pct(r.rate)} | ${ci(r)} | ${usd2(r.staked)} | ${usd2(r.returned)} | ${usd2(r.net)} | ${r.roi == null ? '—' : pct(r.roi)} |`);
    }
    P('');
    P(`Overall settled slip win rate: **${pct(a.slipLevel.winRate.rate)}** (${a.slipLevel.winRate.n} slips, 95% CI ${ci(a.slipLevel.winRate)})${a.slipLevel.winRate.lowConfidence ? ' — ⚠️ **LOW CONFIDENCE**' : ''}.`);
  }
  P('');

  P('## 4. Trend over time');
  P('');
  P('Recommended picks only, by ISO week. Shown so variance is visible: a single strong or weak week on a small sample moves the headline number substantially, and that movement is information a buyer should see rather than have averaged away.');
  P('');
  P(trendTable(a.byWeek, 'Week'));
  P('### By month');
  P('');
  P(trendTable(a.byMonth, 'Month'));

  P('## 5. Win rate by league');
  P('');
  P(rateTable(a.byLeague, 'League'));
  P('### By prediction source');
  P('');
  P(rateTable(a.bySource, 'Source'));

  P('## 6. Sample-size caveats');
  P('');
  const weak = [];
  for (const [k, v] of Object.entries(a.byTier)) if (v.lowConfidence) weak.push(`tier **${k}** (n=${v.n})`);
  for (const [k, v] of Object.entries(a.byLeague)) if (v.lowConfidence) weak.push(`league **${k}** (n=${v.n})`);
  for (const [k, v] of Object.entries(a.slipLevel.bySize)) if (v.lowConfidence) weak.push(`**${k}-pick** slips (n=${v.n})`);
  if (weak.length) {
    P(`The following are below the ${a.minN}-result threshold and are **not** a track record:`);
    P('');
    for (const w of weak) P(`- ${w}`);
  } else {
    P(`Every reported breakdown meets the ${a.minN}-result threshold.`);
  }
  P('');
  P('Two limits apply to all of the above regardless of sample size:');
  P('');
  P('1. **Grading is incomplete.** PrizePicks stopped serving result history (HTTP 403 on every request), so results now come from league box scores — MLB Stats API, and ESPN for basketball, football and hockey. Leagues with no box-score source (tennis, esports, soccer) cannot be graded at all and contribute nothing here.');
  P('2. **These are model probabilities scored after the fact, not a bankroll.** Leg-level win rate is not profit. Only the slip section reflects money, and only within its retention window.');
  P('');

  P('## 7. API cost per analysis');
  P('');
  const k = a.cost;
  P('| | |');
  P('|---|---|');
  P(`| Total metered spend | ${usd(k.totalUsd)} |`);
  P(`| API calls logged | ${k.calls} |`);
  P(`| Cost date range | ${k.dateRange ? `${k.dateRange.first} → ${k.dateRange.last}` : '—'} |`);
  P(`| Average per API call | ${usd(k.avgPerCallUsd)} |`);
  P(`| Average per analysis day | ${usd(k.avgPerAnalysisDayUsd)} |`);
  P(`| Input tokens | ${k.tokens.in.toLocaleString()} |`);
  P(`| Output tokens | ${k.tokens.out.toLocaleString()} |`);
  P(`| Web searches | ${k.tokens.searches.toLocaleString()} |`);
  P('');
  if (Object.keys(k.byFeature).length) {
    P('| Feature | Calls | Total | Avg/call |');
    P('|---|---:|---:|---:|');
    for (const [f, v] of Object.entries(k.byFeature).sort((x, y) => y[1].usd - x[1].usd)) {
      P(`| ${f} | ${v.calls} | ${usd(v.usd)} | ${usd(v.avgUsd)} |`);
    }
    P('');
  }
  P('Costs are metered from the token counts each API response reports, priced with the table in `bet-finder-background.js`. That table is maintained by hand, so if Anthropic pricing has changed since it was last checked these figures drift. **Verify against the Anthropic console billing page before putting a cost-per-analysis figure in front of a buyer.**');
  P('');

  P('## Making this report stronger');
  P('');
  P('Honest gaps, and what would close each:');
  P('');
  P(`1. **Slip history is capped at ${a.slipLevel.retentionDays} days.** The retention sweep in \`grade-slips.js\` deletes settled slips. Archiving them to a separate store on settle — or raising \`SLIP_RETENTION_DAYS\` — would let parlay-size performance accumulate. Until then section 3 restarts every few days.`);
  P('2. **The recommended side is not persisted.** Adding `side` to the pick-log row at write time would make directional win rate exact instead of reconstructed. It only affects picks the engine took the under on.');
  P(`3. **Grading coverage is ${pct(c.gradingCoverage)}.** Every ungraded pick is a result that never enters any figure here. The ESPN and MLB graders raise this going forward, but they do not retroactively settle picks whose games have passed.`);
  P('4. **Leg-level rates are not returns.** A buyer evaluating revenue potential needs realised P&L across many slips, which requires (1) above.');
  P('');
  P('---');
  P('');
  P('_Generated by `scripts/generate-buyer-report.mjs`. Read-only: it reads the live stores and writes only these two output files. Re-run to refresh as more picks grade._');
  P('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// cli

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
  };
  const from = arg('from', null);
  const snapshot = arg('snapshot', null);
  const outBase = arg('out', 'reports/buyer-report');
  const minN = Number(arg('min-n', MIN_N_DEFAULT));

  console.log(from ? `Reading snapshot from ${from}` : 'Reading live Netlify Blobs…');
  const data = from ? await loadSnapshot(from) : await loadLive();

  const counts = {
    'pick-log days': Object.keys(data.pickLog || {}).length,
    'saved slips': Object.keys(data.savedSlips || {}).length,
    'cost-log days': Object.keys(data.costLog || {}).length,
  };
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  if (snapshot) {
    await mkdir(snapshot, { recursive: true });
    for (const [name, key] of [['pick-log', 'pickLog'], ['saved-slips', 'savedSlips'], ['cost-log', 'costLog']]) {
      await writeFile(path.join(snapshot, `${name}.json`), JSON.stringify(data[key], null, 2));
    }
    console.log(`Snapshot written to ${snapshot}/`);
  }

  const analysis = analyse(data, { minN, dataSource: from ? `a snapshot in ${from}` : 'live Netlify Blobs' });
  const md = renderMarkdown(analysis);

  await mkdir(path.dirname(outBase), { recursive: true });
  await writeFile(`${outBase}.md`, md);
  await writeFile(`${outBase}.json`, JSON.stringify(analysis, null, 2));

  console.log(`\nWrote ${outBase}.md and ${outBase}.json`);
  console.log(`  graded picks: ${analysis.coverage.picksGraded} / ${analysis.coverage.picksLogged} (${pct(analysis.coverage.gradingCoverage)} coverage)`);
  console.log(`  settled slips: ${analysis.slipLevel.settled}`);
  if (analysis.legLevel.recommended.lowConfidence) {
    console.log(`\n  NOTE: n=${analysis.legLevel.recommended.n} recommended picks is below the ${minN} threshold.`);
    console.log('  The report marks this, but the headline rate should not be quoted as a track record yet.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`\nError: ${e.message}`); process.exit(1); });
}

// netlify/functions/leak-report.js
//
// Where the money actually goes.
//
// ===========================================================================
// THIS REPORT LEADS WITH THE WORST NEWS
//
// The brief: "Do not soften the findings — if a category I like is losing
// money, lead with that." So slices are ranked by TOTAL PROFIT COST, not by
// ROI. A slice at -60% ROI on four slips has cost almost nothing; one at -8%
// across two hundred is what is actually draining the bankroll, and a report
// sorted by ROI puts the harmless one on top.
//
// Every slice carries its sample size and a Wilson interval on the hit rate,
// and any slice too small to conclude from is MARKED rather than dropped —
// "this category has 6 slips" is itself the finding when the category is one
// you believe in.
//
// ---------------------------------------------------------------------------
// THE TWO QUESTIONS, ANSWERED FIRST
//
//   1. Are goblins actually beating demons once the payout is accounted for?
//      A goblin hitting 75% is not beating a demon hitting 45% — the goblin
//      needs 79.4% to break even on a 3-pick and the demon needs 43.7%. The
//      only comparison that means anything is against each tier's OWN bar.
//   2. Do manual slips beat the optimizer's?
//
// Both are answered in plain language at the top, including when the honest
// answer is "not enough data to say" — which is a real answer and is given in
// those words rather than as a number with no interval.
// ===========================================================================

import { allBets, allResults } from './ledger-store.js';
import { configFor, breakEven, payoutTable } from './payout-engine.js';
import { wilson } from './scoreboard.js';

// ---------------------------------------------------------------------------
// 1. Building the rows

/**
 * One row per LEG, carrying everything any slice needs.
 *
 * Leg-level rather than slip-level because most of the dimensions the brief
 * asks for — market, line type, over/under, favourite/underdog — are
 * properties of a leg. Slip-level facts (slip type, leg count, stake) are
 * copied onto every leg of the slip, and the slip-level slices then aggregate
 * over DISTINCT slips so a 6-leg slip is not counted six times.
 */
export function buildRows(bets, results, { payoutConfigs, closingProbFor = null } = {}) {
  const byLeg = new Map((results || []).map((r) => [r.leg_id, r]));
  const rows = [];

  for (const bet of bets || []) {
    const legs = bet.legs || [];
    if (!legs.length) continue;
    const settled = legs.map((l) => byLeg.get(l.leg_id));
    if (settled.some((r) => !r)) continue;                    // unsettled slips are not scored
    const won = settled.filter((r) => r.outcome === 'won').length;
    const pushed = settled.filter((r) => r.outcome === 'push' || r.outcome === 'void').length;
    const config = configFor(payoutConfigs, String(bet.placed_at).slice(0, 10));
    const size = legs.length - pushed;
    const table = config ? payoutTable(config, bet.slip_type, size) : null;
    const mult = bet.payout_multiplier != null
      ? (won === legs.length ? Number(bet.payout_multiplier) : (table ? (table[String(won)] || 0) : 0))
      : (table ? (table[String(won)] || 0) : 0);
    const stake = Number(bet.stake) || 0;
    const ret = stake * mult;
    const bar = config ? breakEven({ config, slipType: bet.slip_type, legCount: legs.length, legs }) : null;

    for (const [i, leg] of legs.entries()) {
      const r = settled[i];
      const closing = closingProbFor ? closingProbFor(leg.leg_id) : null;
      rows.push({
        slip_id: bet.slip_id,
        leg_id: leg.leg_id,
        placed_at: bet.placed_at,
        // ---- slip-level, copied down ------------------------------------
        slipType: bet.slip_type,
        legCount: legs.length,
        stake,
        slipReturn: ret,
        slipWon: won,
        slipProfit: ret - stake,
        perLegBreakEven: bar,
        // The brief's "optimizer-proposed or manually assembled". `source` is
        // free-form on a ledger row, so this reads it rather than inventing a
        // column, and anything unlabelled is UNKNOWN rather than assumed manual.
        origin: originOf(bet),
        // ---- leg-level ---------------------------------------------------
        league: leg.league ?? bet.league ?? null,
        market: leg.market ?? null,
        tier: (leg.tier || 'standard').toLowerCase(),
        side: (leg.side || 'over').toLowerCase(),
        line: leg.line ?? null,
        player: leg.player ?? null,
        prob: leg.prob ?? null,
        hit: r.outcome === 'won' ? true : r.outcome === 'lost' ? false : null,
        outcome: r.outcome,
        clv: closing != null && leg.prob != null ? closing - Number(leg.prob) : null,
        // ---- derived dimensions ------------------------------------------
        dayOfWeek: new Date(bet.placed_at).getUTCDay(),
        hoursBeforeStart: leg.start_time
          ? (Date.parse(leg.start_time) - Date.parse(bet.placed_at)) / 3600000 : null,
        favourite: leg.prob == null ? null : Number(leg.prob) >= 0.5,
      });
    }
  }
  return rows;
}

function originOf(bet) {
  const s = String(bet.source || '').toLowerCase();
  if (/optimi[sz]er/.test(s)) return 'optimizer';
  if (/manual|hand/.test(s)) return 'manual';
  return 'unlabelled';
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const stakeBucket = (s) => (s < 10 ? '<$10' : s < 25 ? '$10-25' : s < 50 ? '$25-50' : '$50+');
const hoursBucket = (h) => (h == null ? null : h < 1 ? '<1h' : h < 3 ? '1-3h' : h < 6 ? '3-6h' : h < 24 ? '6-24h' : '24h+');

// ---------------------------------------------------------------------------
// 2. Slicing

/**
 * Score one set of leg rows.
 *
 * ROI IS COMPUTED OVER DISTINCT SLIPS, hit rate over legs. Summing a 6-leg
 * slip's stake six times would report an ROI on six times the money that was
 * ever at risk, and would make big slips look like they dominate every slice
 * they touch.
 */
export function scoreSlice(rows, { minSlips = 20, minLegs = 30 } = {}) {
  const slips = new Map();
  for (const r of rows) if (!slips.has(r.slip_id)) slips.set(r.slip_id, r);
  const slipRows = [...slips.values()];

  const staked = slipRows.reduce((a, b) => a + b.stake, 0);
  const returned = slipRows.reduce((a, b) => a + b.slipReturn, 0);
  const profit = returned - staked;

  const graded = rows.filter((r) => r.hit === true || r.hit === false);
  const hits = graded.filter((r) => r.hit).length;
  const hitRate = graded.length ? hits / graded.length : null;
  const ci = wilson(hits, graded.length);

  const bars = rows.filter((r) => r.perLegBreakEven != null);
  const requiredHitRate = bars.length ? bars.reduce((a, b) => a + b.perLegBreakEven, 0) / bars.length : null;

  const clvs = rows.map((r) => r.clv).filter((v) => v != null);

  return {
    slips: slipRows.length,
    legs: rows.length,
    gradedLegs: graded.length,
    staked: r2(staked),
    returned: r2(returned),
    profit: r2(profit),
    roi: staked > 0 ? profit / staked : null,
    hitRate,
    hitRateCI: ci,
    requiredHitRate,
    // THE ONLY COMPARISON THAT MEANS ANYTHING ACROSS TIERS.
    edgeVsBar: hitRate != null && requiredHitRate != null ? hitRate - requiredHitRate : null,
    // ...and whether that edge survives the interval, which is what decides
    // whether the slice is a finding or a shrug.
    barInsideCI: requiredHitRate != null && ci.lo != null
      ? requiredHitRate >= ci.lo && requiredHitRate <= ci.hi : null,
    clv: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
    clvCoverage: rows.length ? clvs.length / rows.length : 0,
    // MARKED, not dropped.
    tooSmall: slipRows.length < minSlips || graded.length < minLegs,
    thresholds: { minSlips, minLegs },
  };
}

/** Every slice along one dimension. */
export function sliceBy(rows, keyFn, { label, minSlips, minLegs } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [...groups.entries()].map(([key, rs]) => ({ key, ...scoreSlice(rs, { minSlips, minLegs }) }));
  // RANKED BY WHAT IT HAS COST, most expensive first — the brief's ask.
  out.sort((a, b) => a.profit - b.profit);
  return { label, slices: out };
}

export const DIMENSIONS = [
  ['sport', (r) => r.league],
  ['market', (r) => r.market],
  ['line type', (r) => r.tier],
  ['slip type', (r) => r.slipType],
  ['leg count', (r) => (r.legCount == null ? null : `${r.legCount} legs`)],
  ['day of week', (r) => DAYS[r.dayOfWeek]],
  ['hours before start', (r) => hoursBucket(r.hoursBeforeStart)],
  ['stake size', (r) => stakeBucket(r.stake)],
  ['over / under', (r) => r.side],
  ['favourite / underdog', (r) => (r.favourite == null ? null : r.favourite ? 'favourite (p>=50%)' : 'underdog (p<50%)')],
  ['origin', (r) => r.origin],
];

// ---------------------------------------------------------------------------
// 3. The two questions

/**
 * Goblins against demons, ON THEIR OWN BARS — question 1.
 *
 * A raw hit-rate comparison is meaningless here and is the likely source of the
 * belief being tested. A goblin at 75% and a demon at 45% look like a rout
 * until you notice the goblin needed 79.4% and the demon needed 43.7% — on
 * those numbers the demon is the one making money.
 */
export function goblinsVsDemons(rows, opts = {}) {
  const g = scoreSlice(rows.filter((r) => r.tier === 'goblin'), opts);
  const d = scoreSlice(rows.filter((r) => r.tier === 'demon'), opts);
  const s = scoreSlice(rows.filter((r) => r.tier === 'standard'), opts);

  if (!g.gradedLegs || !d.gradedLegs) {
    return {
      goblin: g, demon: d, standard: s, verdict: 'not enough data to say',
      answer: `There ${g.gradedLegs ? 'are no graded demon legs' : 'are no graded goblin legs'} in the log, `
        + 'so the comparison cannot be made at all. This is not a finding either way.',
    };
  }
  if (g.tooSmall || d.tooSmall) {
    return {
      goblin: g, demon: d, standard: s, verdict: 'not enough data to say',
      answer: `Goblins: ${g.gradedLegs} graded legs. Demons: ${d.gradedLegs}. At least one side is below the `
        + `${opts.minLegs ?? 30}-leg threshold, so any gap between them is inside the noise. `
        + 'The honest answer is that this cannot be answered yet.',
    };
  }

  const gEdge = g.edgeVsBar, dEdge = d.edgeVsBar;
  const winner = gEdge > dEdge ? 'goblin' : 'demon';
  return {
    goblin: g, demon: d, standard: s,
    verdict: winner,
    answer: `Goblins hit ${pc(g.hitRate)} against a ${pc(g.requiredHitRate)} bar `
      + `(${sg(gEdge)}), demons hit ${pc(d.hitRate)} against ${pc(d.requiredHitRate)} (${sg(dEdge)}). `
      + `${winner === 'goblin' ? 'Goblins' : 'DEMONS'} are ahead once the payout is accounted for`
      + `${winner === 'demon' ? ', which is the opposite of the assumption' : ''}. `
      + `In money: goblins ${money(g.profit)}, demons ${money(d.profit)}.`,
  };
}

/** Manual against optimizer — question 2. */
export function manualVsOptimizer(rows, opts = {}) {
  const m = scoreSlice(rows.filter((r) => r.origin === 'manual'), opts);
  const o = scoreSlice(rows.filter((r) => r.origin === 'optimizer'), opts);
  const u = scoreSlice(rows.filter((r) => r.origin === 'unlabelled'), opts);

  if (!m.slips || !o.slips) {
    return {
      manual: m, optimizer: o, unlabelled: u, verdict: 'not enough data to say',
      answer: `The log has ${m.slips} manual and ${o.slips} optimizer slips`
        + `${u.slips ? ` (plus ${u.slips} unlabelled, which are counted as neither)` : ''}. `
        + 'The comparison needs both, so it cannot be answered yet.',
    };
  }
  if (m.tooSmall || o.tooSmall) {
    return {
      manual: m, optimizer: o, unlabelled: u, verdict: 'not enough data to say',
      answer: `Manual ${m.slips} slips at ${pc(m.roi)} ROI, optimizer ${o.slips} at ${pc(o.roi)}. `
        + `At least one is below the ${opts.minSlips ?? 20}-slip threshold, so the gap is inside the noise. `
        + 'The honest answer is that this cannot be answered yet.',
    };
  }
  const gap = m.roi - o.roi;
  return {
    manual: m, optimizer: o, unlabelled: u,
    verdict: gap > 0 ? 'manual' : 'optimizer',
    answer: `Manual: ${m.slips} slips, ${pc(m.roi)} ROI, ${money(m.profit)}. `
      + `Optimizer: ${o.slips} slips, ${pc(o.roi)} ROI, ${money(o.profit)}. `
      + `${gap > 0 ? 'Your manual slips are ahead' : 'THE OPTIMIZER IS AHEAD'} by `
      + `${Math.abs(gap * 100).toFixed(1)} points of ROI.`
      + (u.slips ? ` ${u.slips} slips are unlabelled and counted as neither.` : ''),
  };
}

const r2 = (v) => Math.round(v * 100) / 100;
const pc = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const sg = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}pp`);
const money = (v) => (v == null ? '—' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);

// ---------------------------------------------------------------------------
// 4. The whole report

export function buildLeakReport(rows, { minSlips = 20, minLegs = 30 } = {}) {
  const opts = { minSlips, minLegs };
  const overall = scoreSlice(rows, opts);
  const dimensions = DIMENSIONS.map(([label, fn]) => sliceBy(rows, fn, { label, ...opts }));

  // Every slice that has cost money, across every dimension, ranked.
  const costliest = dimensions
    .flatMap((d) => d.slices.map((s) => ({ dimension: d.label, ...s })))
    .filter((s) => s.profit < 0)
    .sort((a, b) => a.profit - b.profit);

  return {
    overall,
    questions: {
      goblinsVsDemons: goblinsVsDemons(rows, opts),
      manualVsOptimizer: manualVsOptimizer(rows, opts),
    },
    dimensions,
    costliest,
    thresholds: opts,
  };
}

export async function loadReport({ payoutConfigs, closingProbFor = null, minSlips, minLegs } = {}) {
  const [bets, results] = await Promise.all([allBets(), allResults()]);
  const rows = buildRows(bets, results, { payoutConfigs, closingProbFor });
  return { ...buildLeakReport(rows, { minSlips, minLegs }), source: { bets: bets.length, results: results.length, legs: rows.length } };
}

// ---------------------------------------------------------------------------
// 5. Rendering

export function renderLeakReport(rep, { width = 92 } = {}) {
  const L = [];
  const wrap = (text, w) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    const out = []; let cur = '';
    for (const x of words) {
      if (!cur) cur = x; else if (cur.length + 1 + x.length <= w) cur += ` ${x}`; else { out.push(cur); cur = x; }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };

  L.push('═'.repeat(width));
  L.push('LEAK REPORT');
  L.push('═'.repeat(width));

  // ---- THE TWO QUESTIONS, FIRST -----------------------------------------
  L.push('');
  L.push('1. ARE GOBLINS BEATING DEMONS, ONCE THE PAYOUT IS ACCOUNTED FOR?');
  for (const line of wrap(rep.questions.goblinsVsDemons.answer, width - 4)) L.push(`   ${line}`);
  L.push('');
  L.push("2. DO YOUR MANUAL SLIPS BEAT THE OPTIMIZER'S?");
  for (const line of wrap(rep.questions.manualVsOptimizer.answer, width - 4)) L.push(`   ${line}`);

  // ---- WHAT IT HAS COST --------------------------------------------------
  L.push('');
  L.push('─'.repeat(width));
  L.push('WHAT HAS COST YOU THE MOST — ranked by total profit lost, not by ROI');
  L.push('─'.repeat(width));
  if (!rep.costliest.length) {
    L.push('  Nothing in the log has lost money. That is either good news or a very small log.');
  } else {
    L.push(`  ${'dimension'.padEnd(20)}${'slice'.padEnd(22)}${'cost'.padStart(11)}${'slips'.padStart(7)}`
      + `${'ROI'.padStart(9)}${'hit'.padStart(8)}${'need'.padStart(8)}`);
    for (const s of rep.costliest.slice(0, 12)) {
      L.push(`  ${(s.tooSmall ? '~' : ' ') + s.dimension.slice(0, 18).padEnd(19)}${String(s.key).slice(0, 21).padEnd(22)}`
        + `${money(s.profit).padStart(11)}${String(s.slips).padStart(7)}${pc(s.roi).padStart(9)}`
        + `${pc(s.hitRate).padStart(8)}${pc(s.requiredHitRate).padStart(8)}`);
    }
    L.push('');
    L.push(`  ~ fewer than ${rep.thresholds.minSlips} slips or ${rep.thresholds.minLegs} graded legs — shown because`);
    L.push('    "this category is too small to judge" is itself worth knowing, but it concludes nothing.');
  }

  // ---- OVERALL ------------------------------------------------------------
  const o = rep.overall;
  L.push('');
  L.push('─'.repeat(width));
  L.push('OVERALL');
  L.push('─'.repeat(width));
  L.push(`  ${o.slips} slips · ${o.gradedLegs} graded legs · staked $${o.staked} · returned $${o.returned}`);
  L.push(`  profit ${money(o.profit)} · ROI ${pc(o.roi)} · hit ${pc(o.hitRate)} `
    + `[${pc(o.hitRateCI.lo)}, ${pc(o.hitRateCI.hi)}] against a ${pc(o.requiredHitRate)} bar (${sg(o.edgeVsBar)})`);
  if (o.barInsideCI) {
    L.push('  The break-even bar is INSIDE the confidence interval on your hit rate — on this much');
    L.push('  data, nothing here distinguishes you from breaking even.');
  }

  // ---- EVERY DIMENSION ----------------------------------------------------
  for (const d of rep.dimensions) {
    L.push('');
    L.push('─'.repeat(width));
    L.push(`BY ${d.label.toUpperCase()}`);
    L.push('─'.repeat(width));
    if (!d.slices.length) { L.push('  (nothing in the log carries this dimension)'); continue; }
    L.push(`  ${'slice'.padEnd(24)}${'slips'.padStart(7)}${'legs'.padStart(7)}${'profit'.padStart(11)}`
      + `${'ROI'.padStart(9)}${'hit'.padStart(8)}${'need'.padStart(8)}${'edge'.padStart(9)}${'CLV'.padStart(8)}`);
    for (const s of d.slices) {
      L.push(`  ${(s.tooSmall ? '~' : ' ') + String(s.key).slice(0, 22).padEnd(23)}`
        + `${String(s.slips).padStart(7)}${String(s.gradedLegs).padStart(7)}${money(s.profit).padStart(11)}`
        + `${pc(s.roi).padStart(9)}${pc(s.hitRate).padStart(8)}${pc(s.requiredHitRate).padStart(8)}`
        + `${sg(s.edgeVsBar).padStart(9)}${(s.clv == null ? '—' : sg(s.clv)).padStart(8)}`);
    }
  }

  L.push('');
  L.push('═'.repeat(width));
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 6. The app page

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderHTML(rep) {
  const cell = (s) => `<tr class="${s.tooSmall ? 'thin' : ''}">
    <td>${esc(s.key)}</td><td>${s.slips}</td><td>${s.gradedLegs}</td>
    <td class="${s.profit < 0 ? 'bad' : 'good'}">${money(s.profit)}</td>
    <td>${pc(s.roi)}</td><td>${pc(s.hitRate)}</td><td>${pc(s.requiredHitRate)}</td>
    <td class="${(s.edgeVsBar ?? 0) < 0 ? 'bad' : 'good'}">${sg(s.edgeVsBar)}</td>
    <td>${s.clv == null ? '—' : sg(s.clv)}</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Leak report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b0e13;--fg:#d8dee9;--dim:#7a8699;--bad:#e06c75;--good:#98c379;--line:#1c222c}
body{background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,Menlo,monospace;margin:0;padding:20px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;color:var(--dim);margin:26px 0 6px;text-transform:uppercase;letter-spacing:.08em}
.q{border:1px solid var(--line);padding:14px;margin:12px 0;border-radius:6px}
.q b{display:block;margin-bottom:6px}
table{border-collapse:collapse;width:100%;margin-top:6px}
th,td{text-align:right;padding:3px 8px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}
th{color:var(--dim);font-weight:400}
.bad{color:var(--bad)}.good{color:var(--good)}
.thin{opacity:.42}
.note{color:var(--dim);margin-top:6px}
</style></head><body>
<h1>Leak report</h1>
<div class="note">${rep.overall.slips} slips · ${rep.overall.gradedLegs} graded legs · ranked by what each slice has COST, not by ROI.</div>

<div class="q"><b>1. Are goblins beating demons, once the payout is accounted for?</b>
${esc(rep.questions.goblinsVsDemons.answer)}</div>
<div class="q"><b>2. Do your manual slips beat the optimizer's?</b>
${esc(rep.questions.manualVsOptimizer.answer)}</div>

<h2>What has cost you the most</h2>
<table><thead><tr><th>dimension / slice</th><th>slips</th><th>legs</th><th>cost</th><th>ROI</th><th>hit</th><th>need</th><th>edge</th><th>CLV</th></tr></thead><tbody>
${rep.costliest.slice(0, 15).map((s) => cell({ ...s, key: `${s.dimension} · ${s.key}` })).join('')}
</tbody></table>
<div class="note">Greyed rows have fewer than ${rep.thresholds.minSlips} slips or ${rep.thresholds.minLegs} graded legs and conclude nothing.</div>

${rep.dimensions.map((d) => `<h2>By ${esc(d.label)}</h2>
<table><thead><tr><th>${esc(d.label)}</th><th>slips</th><th>legs</th><th>profit</th><th>ROI</th><th>hit</th><th>need</th><th>edge</th><th>CLV</th></tr></thead><tbody>
${d.slices.map(cell).join('')}</tbody></table>`).join('')}

<div class="note" style="margin-top:30px">generated ${new Date().toISOString()} · <a href="/" style="color:var(--dim)">← terminal</a></div>
</body></html>`;
}

export const handler = async (event) => {
  const q = event?.queryStringParameters || {};
  try {
    const { readFile } = await import('node:fs/promises');
    const payoutConfigs = JSON.parse(await readFile(new URL('./payout-tables.json', import.meta.url), 'utf8')).configs;
    const rep = await loadReport({
      payoutConfigs,
      minSlips: q.minSlips ? Number(q.minSlips) : undefined,
      minLegs: q.minLegs ? Number(q.minLegs) : undefined,
    });
    if (q.format === 'json') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(rep, null, 2) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: renderHTML(rep) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

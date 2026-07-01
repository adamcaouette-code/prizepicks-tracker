// netlify/functions/calibration.js
//
// Reads the graded pick log and answers the only question that matters: when the
// engine says 65%, does it actually hit ~65%? Computes calibration bands (predicted
// vs actual), a Brier score, play/lean win rate, and breakdowns by tier and league.
//
// View:  https://atombets.netlify.app/api/calibration
// JSON:  https://atombets.netlify.app/api/calibration?format=json
// Filter: ?league=mlb   ?days=30

import { getStore } from '@netlify/blobs';

const isGraded = (p) => p.hit === true || p.hit === false;
const isCombo = (p) => /combo/i.test(p.stat || '') || /\s\+\s/.test(p.player || '');

// Re-running the engine on a day appends the same picks again, so the log holds
// duplicates. Collapse by projectionId (falling back to a content key), preferring
// the graded copy, so each distinct pick is counted exactly once.
function dedupe(picks) {
  const m = new Map();
  for (const p of picks) {
    const key = p.projectionId || `${p.date}|${p.player}|${p.stat}|${p.line}`;
    const prev = m.get(key);
    if (!prev) { m.set(key, p); continue; }
    if (isGraded(p) && !isGraded(prev)) m.set(key, p); // prefer a graded copy
  }
  return [...m.values()];
}

function aggregate(rawPicks) {
  const picks = dedupe(rawPicks);
  const graded = picks.filter(isGraded);

  // Break down what is NOT graded, so a big "pending" number is honest instead of alarming.
  const ungradedPicks = picks.filter((p) => !isGraded(p));
  const combosN = ungradedPicks.filter((p) => p.ungradeable === 'combo' || isCombo(p)).length;
  const givenUpN = ungradedPicks.filter((p) => !isCombo(p) && (p.gradeAttempts || 0) >= 3).length;
  const gradeableN = ungradedPicks.length - combosN - givenUpN;
  // pending gradeable, grouped by date (the newest date is usually today's in-progress slate)
  const pendingByDate = {};
  for (const p of ungradedPicks) {
    if (p.ungradeable === 'combo' || isCombo(p) || (p.gradeAttempts || 0) >= 3) continue;
    pendingByDate[p.date] = (pendingByDate[p.date] || 0) + 1;
  }

  const out = {
    logged: picks.length,
    graded: graded.length,
    pending: picks.length - graded.length,
    pendingGradeable: gradeableN,
    combos: combosN,
    givenUp: givenUpN,
    pendingByDate,
    overall: null,
    brier: null,
    bands: [],
    byTier: {},
    byLeague: {},
    plays: { n: 0, hits: 0 },        // verdict "play"
    playsLeans: { n: 0, hits: 0 },   // verdict "play" or "lean"
  };
  if (!graded.length) return out;

  let overHits = 0, brierSum = 0;
  const bandMap = {}; // lo(0..90) -> { n, hits, predSum }
  for (const p of graded) {
    const prob = Number(p.prob) || 0;
    const hit = p.hit === true ? 1 : 0;
    overHits += hit;
    brierSum += (prob - hit) ** 2;

    const lo = Math.min(90, Math.max(0, Math.floor(prob * 10) * 10));
    const b = (bandMap[lo] ||= { lo, n: 0, hits: 0, predSum: 0 });
    b.n++; b.hits += hit; b.predSum += prob;

    const tier = p.oddsType || 'unknown';
    const t = (out.byTier[tier] ||= { n: 0, hits: 0 });
    t.n++; t.hits += hit;

    const lg = p.league || 'unknown';
    const l = (out.byLeague[lg] ||= { n: 0, hits: 0 });
    l.n++; l.hits += hit;

    if (p.verdict === 'play') { out.plays.n++; out.plays.hits += hit; }
    if (p.verdict === 'play' || p.verdict === 'lean') { out.playsLeans.n++; out.playsLeans.hits += hit; }
  }

  out.overall = overHits / graded.length;
  out.brier = brierSum / graded.length;
  out.bands = Object.values(bandMap)
    .sort((a, b) => a.lo - b.lo)
    .map((b) => ({ band: `${b.lo}-${b.lo + 10}%`, n: b.n, predicted: b.predSum / b.n, actual: b.hits / b.n }));
  return out;
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function renderHTML(a) {
  const diffColor = (d) => (Math.abs(d) <= 0.04 ? '#34d399' : Math.abs(d) <= 0.10 ? '#fbbf24' : '#f87171');

  const bandRows = a.bands.map((b) => {
    const diff = b.actual - b.predicted;
    return `<tr>
      <td>${b.band}</td><td>${b.n}</td>
      <td>${pct(b.predicted)}</td><td>${pct(b.actual)}</td>
      <td style="color:${diffColor(diff)}">${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="color:#888">No graded picks yet.</td></tr>';

  const breakdown = (obj) => Object.entries(obj).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.hits / v.n)}</td></tr>`).join('') ||
    '<tr><td colspan="3" style="color:#888">—</td></tr>';

  const note = a.graded === 0
    ? `<p class="note">No graded picks yet. The grader runs daily and fills in results a day or two after games. Once a slate has been graded, calibration shows up here.</p>`
    : `<p class="note">Calibration uses the over-probability on every logged pick (play, lean, and pass), so even passes count toward whether the numbers are honest. "Diff" is actual minus predicted — green is well-calibrated (±4pts), red is off by 10+.</p>`;

  const pendDates = Object.entries(a.pendingByDate || {}).sort((x, y) => (x[0] < y[0] ? 1 : -1));
  const pendRows = pendDates.map(([d, n], i) =>
    `<tr><td>${d}${i === 0 ? ' <span style="color:#6cf">(newest — usually today, games not final)</span>' : ''}</td><td>${n}</td></tr>`).join('')
    || '<tr><td colspan="2" style="color:#667">none — all gradeable picks are graded</td></tr>';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AtomBets · Calibration</title><style>
  :root{color-scheme:dark}
  body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0e11;color:#e6e6e6;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 4px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8aa;margin:28px 0 8px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
  .card{background:#13181d;border:1px solid #1f2730;border-radius:10px;padding:12px 16px;min-width:120px}
  .card .v{font-size:22px;font-weight:700} .card .l{font-size:11px;color:#8aa;text-transform:uppercase;letter-spacing:.06em}
  table{border-collapse:collapse;width:100%;max-width:560px;margin:4px 0}
  th,td{text-align:left;padding:6px 12px;border-bottom:1px solid #1a2128} th{color:#8aa;font-weight:600;font-size:11px;text-transform:uppercase}
  td{font-variant-numeric:tabular-nums} .note{color:#9aa;max-width:560px;font-size:12px}
  .ts{color:#667;font-size:11px;margin-top:24px}
</style></head><body>
  <h1>AtomBets · Calibration</h1>
  <div class="cards">
    <div class="card"><div class="v">${a.graded}</div><div class="l">graded</div></div>
    <div class="card"><div class="v">${a.pendingGradeable}</div><div class="l">pending (gradeable)</div></div>
    <div class="card"><div class="v">${a.combos}</div><div class="l">combos (skip)</div></div>
    <div class="card"><div class="v">${a.givenUp}</div><div class="l">given up</div></div>
    <div class="card"><div class="v">${pct(a.overall)}</div><div class="l">over rate</div></div>
    <div class="card"><div class="v">${a.brier == null ? '—' : a.brier.toFixed(3)}</div><div class="l">brier ↓</div></div>
    <div class="card"><div class="v">${a.playsLeans.n ? pct(a.playsLeans.hits / a.playsLeans.n) : '—'}</div><div class="l">play+lean win</div></div>
  </div>
  ${note}
  <h2>Pending (gradeable) by day</h2>
  <table><thead><tr><th>date</th><th>pending</th></tr></thead><tbody>${pendRows}</tbody></table>
  <p class="note">Most "pending" is the newest day's slate (games not final yet) — the daily grader clears each day the morning after. Combos can't be graded this way; "given up" tried 3× with no result.</p>
  <h2>Calibration by predicted band</h2>
  <table><thead><tr><th>P(over) band</th><th>n</th><th>predicted</th><th>actual</th><th>diff (pts)</th></tr></thead><tbody>${bandRows}</tbody></table>
  <h2>By tier</h2>
  <table><thead><tr><th>tier</th><th>n</th><th>win rate</th></tr></thead><tbody>${breakdown(a.byTier)}</tbody></table>
  <h2>By league</h2>
  <table><thead><tr><th>league</th><th>n</th><th>win rate</th></tr></thead><tbody>${breakdown(a.byLeague)}</tbody></table>
  <h2>Verdict performance</h2>
  <table><thead><tr><th>verdict</th><th>n</th><th>win rate</th></tr></thead><tbody>
    <tr><td>play</td><td>${a.plays.n}</td><td>${a.plays.n ? pct(a.plays.hits / a.plays.n) : '—'}</td></tr>
    <tr><td>play + lean</td><td>${a.playsLeans.n}</td><td>${a.playsLeans.n ? pct(a.playsLeans.hits / a.playsLeans.n) : '—'}</td></tr>
  </tbody></table>
  <p class="ts">generated ${new Date().toISOString()}</p>
</body></html>`;
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

    let keys = [];
    try { keys = (await store.list()).blobs.map((b) => b.key); } catch { keys = []; }

    // optional ?days=N filter on the date-keyed log
    if (q.days) {
      const cutoff = new Date(Date.now() - Number(q.days) * 86400000).toISOString().slice(0, 10);
      keys = keys.filter((k) => k >= cutoff);
    }

    let picks = [];
    for (const k of keys) {
      try { const day = await store.get(k, { type: 'json' }); if (Array.isArray(day)) picks.push(...day); } catch { /* skip */ }
    }
    if (q.league) picks = picks.filter((p) => p.league === q.league);

    const agg = aggregate(picks);

    if (q.format === 'json') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(agg, null, 2) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: renderHTML(agg) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

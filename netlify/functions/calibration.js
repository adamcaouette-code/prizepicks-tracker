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
    // Source is part of the identity: the same projection can be predicted once by
    // the board engine and again by the slip judge on the same day. Those are two
    // separate predictions and both deserve to be scored.
    const key = `${p.source || 'board'}|${p.projectionId || `${p.date}|${p.player}|${p.stat}|${p.line}`}`;
    const prev = m.get(key);
    if (!prev) { m.set(key, p); continue; }
    if (isGraded(p) && !isGraded(prev)) m.set(key, p); // prefer a graded copy
  }
  return [...m.values()];
}

// `perLeague` is off for the recursive call so a league's own summary doesn't
// try to split itself again.
// Leagues kept out of the record entirely.
//
// The World Cup runs once every four years. A handful of picks from one
// tournament tell you nothing about how the engine will perform on a slate you
// can actually bet, and they will not be refreshed for years — so leaving them
// in only drags the overall number around for no informational gain. That is
// different from a league performing badly: a bad league is a finding worth
// keeping, a dormant one is noise.
//
// Excluded here rather than only deleted from the log, so a future tournament
// does not silently start counting again without a decision being made.
export const EXCLUDED_LEAGUES = new Set(['world_cup', 'fifa_world_cup']);

const isExcluded = (p) => EXCLUDED_LEAGUES.has(String(p.league || '').toLowerCase());

function aggregate(rawPicks, { perLeague = true } = {}) {
  const picks = dedupe(rawPicks).filter((p) => !isExcluded(p));
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
    bySource: {},                    // board engine vs slip judge, scored apart
    // The judge version that produced each probability — 'psyche' (the original)
    // or 'aphrodite' (the refinement). This is the whole point of naming them:
    // pooled, two forecasters produce one blended calibration curve that
    // describes neither, and a prompt change becomes impossible to evaluate.
    // Rows logged before versioning read as 'psyche (untagged)'.
    byPrompt: {},
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

    // Per-source Brier too — hit rate alone can't tell a sharp engine from a lucky
    // one, and this is the number to put next to somebody else's engine.
    const src = p.source || 'board';
    const s = (out.bySource[src] ||= { n: 0, hits: 0, brierSum: 0 });
    s.n++; s.hits += hit; s.brierSum += (prob - hit) ** 2;

    // Per-version Brier AND mean predicted vs actual. The gap between those last
    // two is the number that answers "are the percentages honest?": a forecaster
    // averaging 0.68 that hits 0.52 is overstating by 16 points, and no hit rate
    // on its own shows that.
    const pv = p.promptVersion || 'psyche (untagged)';
    const v = (out.byPrompt[pv] ||= { n: 0, hits: 0, brierSum: 0, predSum: 0 });
    v.n++; v.hits += hit; v.brierSum += (prob - hit) ** 2; v.predSum += prob;

    if (p.verdict === 'play') { out.plays.n++; out.plays.hits += hit; }
    if (p.verdict === 'play' || p.verdict === 'lean') { out.playsLeans.n++; out.playsLeans.hits += hit; }
  }

  out.overall = overHits / graded.length;
  out.brier = brierSum / graded.length;
  for (const v of Object.values(out.byPrompt)) {
    v.brier = v.brierSum / v.n;
    v.predicted = v.predSum / v.n;      // what it claimed, on average
    v.actual = v.hits / v.n;            // what happened
    v.overstatement = v.predicted - v.actual;   // >0 means the numbers are too high
    delete v.brierSum; delete v.predSum;
  }
  out.bands = Object.values(bandMap)
    .sort((a, b) => a.lo - b.lo)
    .map((b) => ({ band: `${b.lo}-${b.lo + 10}%`, n: b.n, predicted: b.predSum / b.n, actual: b.hits / b.n }));

  // A FULL, independent calibration per league — its own Brier, bands, record
  // and coverage, not just a hit count. Pooling them hides the thing you most
  // want to know: a rater can be sharp on baseball and hopeless on tennis, and
  // one blended number says neither.
  //
  // The cost is honest and worth stating: splitting the sample means each league
  // needs its own ~50 graded picks before its number means anything, so most
  // leagues read EARLY for a while. That is the truth about the data, not a
  // regression.
  if (perLeague) {
    out.leagues = {};
    for (const lg of [...new Set(picks.map((p) => p.league || 'unknown'))].sort()) {
      out.leagues[lg] = aggregate(picks.filter((p) => (p.league || 'unknown') === lg), { perLeague: false });
    }
  }
  return out;
}

// Blob reads are network round trips, and this endpoint reads one per logged day —
// sequentially that grows without bound as the log fills, and it now blocks the
// scoreboard on Today's Picks. Bounded parallelism keeps it flat-ish and well
// inside the function's synchronous time budget.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function renderHTML(a) {
  const n = a.graded;
  // Below ~50 graded picks a Brier score is mostly noise. Show the numbers with n
  // beside them, but say plainly that they don't mean much yet — this page exists
  // to be honest, not encouraging.
  const early = n > 0 && n < 50;
  const diffColor = (d) => (Math.abs(d) <= 0.04 ? 'var(--grn)' : Math.abs(d) <= 0.10 ? 'var(--amb)' : 'var(--red)');

  const bandRows = a.bands.map((b) => {
    const diff = b.actual - b.predicted;
    return `<tr>
      <td>${b.band}</td><td>${b.n}</td>
      <td>${pct(b.predicted)}</td><td>${pct(b.actual)}</td>
      <td style="color:${diffColor(diff)}">${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="mut">No graded picks yet.</td></tr>';

  const breakdown = (obj) => Object.entries(obj).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.hits / v.n)}</td></tr>`).join('') ||
    '<tr><td colspan="3" class="mut">—</td></tr>';

  // Per-league, each with its own Brier and its own small-sample warning. Sorted
  // by sample size so the league you actually have data on leads.
  const leagueRows = Object.entries(a.leagues || {})
    .filter(([, v]) => v.graded > 0)
    .sort((x, y) => y[1].graded - x[1].graded)
    .map(([lg, v]) => {
      const pl = v.playsLeans || { n: 0, hits: 0 };
      const rec = pl.n ? `${pl.hits}–${pl.n - pl.hits}` : '—';
      const win = pl.n ? pct(pl.hits / pl.n) : '—';
      const br = v.brier != null ? v.brier.toFixed(3) : '—';
      const brCol = v.brier == null ? 'var(--dim)' : v.brier <= 0.21 ? 'var(--grn)' : v.brier <= 0.25 ? 'var(--amb)' : 'var(--red)';
      const flag = v.graded < 50
        ? `<span style="color:var(--amb)">early · n=${v.graded}</span>`
        : `<span style="color:var(--faint)">n=${v.graded}</span>`;
      return `<tr><td>${esc(lg.toUpperCase())}</td><td>${v.graded}</td><td>${rec}</td><td>${win}</td>
        <td style="color:${brCol}">${br}</td><td>${flag}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="mut">No league has a graded pick yet.</td></tr>';

  const engineRows = Object.entries(a.bySource || {}).map(([k, v]) =>
    `<tr><td>${esc(k === 'slip' ? 'slip judge' : k + ' engine')}</td><td>${v.n}</td><td>${pct(v.hits / v.n)}</td><td>${(v.brierSum / v.n).toFixed(3)}</td></tr>`).join('') ||
    '<tr><td colspan="4" class="mut">—</td></tr>';

  // Judge head-to-head. The column that matters is "overstated": mean predicted
  // minus actual. A version can win on hit rate purely by being handed easier
  // slates, but overstatement is about its OWN claims and is comparable across
  // nights. Positive means the percentages are too high.
  const promptRows = Object.entries(a.byPrompt || {})
    .sort((x, y) => y[1].n - x[1].n)
    .map(([k, v]) => {
      const over = v.overstatement;
      const col = v.n < 50 ? 'var(--dim)'
        : Math.abs(over) <= 0.04 ? 'var(--grn)' : Math.abs(over) <= 0.10 ? 'var(--amb)' : 'var(--red)';
      const sign = over >= 0 ? '+' : '';
      return `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.predicted)}</td><td>${pct(v.actual)}</td>
        <td style="color:${col}">${sign}${(over * 100).toFixed(1)}pts</td><td>${v.brier.toFixed(3)}</td>
        <td>${v.n < 50 ? '<span style="color:var(--amb)">early</span>' : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="mut">No graded picks yet.</td></tr>';

  const pendDates = Object.entries(a.pendingByDate || {}).sort((x, y) => (x[0] < y[0] ? 1 : -1));
  const pendRows = pendDates.map(([d, c], i) =>
    `<tr><td>${d}${i === 0 ? ' <span class="mut">(newest — usually tonight, games not final)</span>' : ''}</td><td>${c}</td></tr>`).join('')
    || '<tr><td colspan="2" class="mut">none — everything gradeable is graded</td></tr>';

  const plWin = a.playsLeans.n ? a.playsLeans.hits / a.playsLeans.n : null;
  const record = a.playsLeans.n ? `${a.playsLeans.hits}–${a.playsLeans.n - a.playsLeans.hits}` : '—';

  const stateNote = n === 0
    ? `<div class="callout">No graded picks yet. The grader runs every morning and fills in results once games settle — this page starts meaning something a day or two after your first logged slate.</div>`
    : early
      ? `<div class="callout amber"><b>EARLY — n=${n}.</b> Below ~50 graded picks these numbers are mostly noise: a hot or cold week can swing them wildly. Don't draw conclusions (or settle arguments) yet.</div>`
      : `<div class="callout">Calibration scores every logged pick — plays, leans and passes alike — so the numbers can't be flattered by only counting winners. "Diff" is actual minus predicted; green is honest (±4pts), red is off by 10+.</div>`;

  const card = (v, l, sub) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#000000"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>AtomBets · Calibration</title><style>
  :root{color-scheme:dark;--bg:#000;--ink:#fff;--dim:#8f8f8f;--faint:#4a4a4a;--line:#1c1c1c;
    --grn:#7ee2a8;--amb:#e2c97e;--red:#e28c7e;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}
  body{font:13px/1.6 var(--mono);background:var(--bg);color:var(--ink);margin:0;padding:26px 18px 60px;max-width:720px;margin-inline:auto}
  h1{font:800 22px/1.2 -apple-system,'Helvetica Neue',sans-serif;letter-spacing:-.02em;margin:0}
  h1 span{color:var(--dim);font-weight:600}
  .sub{color:var(--dim);font-size:11px;margin:6px 0 22px}
  h2{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim);font-weight:600;
    margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline}
  h2 a{color:var(--faint);text-decoration:none;letter-spacing:.04em;margin-left:auto}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}
  .card{border:1px solid var(--line);border-radius:6px;padding:13px 14px}
  .card .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .card .l{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-top:5px}
  .card .s{font-size:10px;color:var(--faint);margin-top:3px}
  .callout{border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:11px;color:var(--dim);margin:16px 0;line-height:1.7}
  .callout.amber{border-color:var(--amb);color:var(--amb)}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  th{color:var(--faint);font-size:9px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
  tr:last-child td{border-bottom:none}
  .mut{color:var(--faint)}
  .wrap{overflow-x:auto}
</style></head><body>
  <h1>AtomBets <span>· Calibration</span></h1>
  <div class="sub">when the engine says 65%, does it hit 65%? — every logged pick counts, passes included</div>

  <div class="cards">
    ${card(n, 'graded', a.pendingGradeable ? a.pendingGradeable + ' pending' : '')}
    ${card(record, 'plays+leans W–L', plWin != null ? pct(plWin) + ' win rate' : '')}
    ${card(pct(a.overall), 'over rate', 'all graded picks')}
    ${card(a.brier == null ? '—' : a.brier.toFixed(3) + (early ? ' <span style="font-size:11px;color:var(--amb)">n=' + n + '</span>' : ''), 'brier ↓', early ? 'early — mostly noise' : 'lower is better')}
  </div>
  ${stateNote}

  <h2>By engine <a href="/api/calibration?format=json">json ↗</a></h2>
  <div class="wrap"><table><thead><tr><th>source</th><th>n</th><th>over rate</th><th>brier ↓</th></tr></thead><tbody>${engineRows}</tbody></table></div>
  <div class="callout">Brier is the honest scoreboard: right AND not overclaiming. A rater saying 90% on legs that hit 70% scores <i>worse</i> (0.250) than one saying 70% (0.210). Compare engines on this, never on whose percentages look bigger.</div>

  <h2>Calibration by predicted band</h2>
  <div class="wrap"><table><thead><tr><th>P(over) band</th><th>n</th><th>predicted</th><th>actual</th><th>diff (pts)</th></tr></thead><tbody>${bandRows}</tbody></table></div>

  <h2>Verdict performance</h2>
  <div class="wrap"><table><thead><tr><th>verdict</th><th>n</th><th>win rate</th></tr></thead><tbody>
    <tr><td>play</td><td>${a.plays.n}</td><td>${a.plays.n ? pct(a.plays.hits / a.plays.n) : '—'}</td></tr>
    <tr><td>play + lean</td><td>${a.playsLeans.n}</td><td>${a.playsLeans.n ? pct(plWin) : '—'}</td></tr>
  </tbody></table></div>

  <h2>Judge version — head to head</h2>
  <div class="wrap"><table><thead><tr><th>judge</th><th>n</th><th>claimed</th><th>actual</th><th>overstated</th><th>brier ↓</th><th></th></tr></thead><tbody>${promptRows}</tbody></table></div>
  <div class="callout"><b>Psyche</b> is the original judge; <b>Aphrodite</b> is the refinement. "Claimed" is the
    average probability the version put on its picks, "actual" is how often they hit. The gap between them is the
    honest measure of whether the percentages mean anything — a judge claiming 68% on legs that hit 52% is
    overstating by 16 points, and no win rate on its own shows that. Rows before versioning read as
    <i>psyche (untagged)</i>. Both need ~50 graded picks each before the comparison is worth acting on, and the
    cleanest test is running the two on the SAME slate — different nights differ more than the prompts do.</div>

  <h2>By tier</h2>
  <div class="wrap"><table><thead><tr><th>tier</th><th>n</th><th>win rate</th></tr></thead><tbody>${breakdown(a.byTier)}</tbody></table></div>

  <h2>By league</h2>
  <div class="wrap"><table><thead><tr><th>league</th><th>graded</th><th>record</th><th>win rate</th><th>brier</th><th></th></tr></thead><tbody>${leagueRows}</tbody></table></div>
  <div class="callout">Each league is scored on its own. A rater can be sharp on baseball and hopeless on
    tennis, and one blended number says neither — but splitting the sample means every league needs its own
    ~50 graded picks before it means anything, so most will read EARLY for a while. Lower Brier is better;
    0.25 is what you'd score by guessing 50% on everything.</div>

  <h2>Pending (gradeable) by day</h2>
  <div class="wrap"><table><thead><tr><th>date</th><th>pending</th></tr></thead><tbody>${pendRows}</tbody></table></div>
  <div class="callout">Most pending is tonight's slate — the daily grader clears each day the morning after. Combos can't be graded this way; "given up" (${a.givenUp}) tried 3× with no result; combos skipped: ${a.combos}.</div>

  <h2>API spend (30 days)</h2>
  <div class="cards">
    ${card('$' + (a.spend?.today ?? 0).toFixed(2), 'today', '')}
    ${card('$' + (a.spend?.week ?? 0).toFixed(2), '7 days', '')}
    ${card('$' + (a.spend?.month ?? 0).toFixed(2), '30 days', '')}
  </div>
  <div class="wrap" style="margin-top:12px"><table><thead><tr><th>feature</th><th>spend (30d)</th></tr></thead><tbody>
    ${Object.entries(a.spend?.byFeature || {}).sort((x, y) => y[1] - x[1]).map(([f, v]) => `<tr><td>${esc(f)}</td><td>$${v.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">no metered calls yet</td></tr>'}
  </tbody></table></div>

  <div class="sub" style="margin-top:30px">generated ${new Date().toISOString()} · <a href="/" style="color:var(--dim)">← terminal</a></div>
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

    const days = await mapLimit(keys, 12, async (k) => {
      try { const day = await store.get(k, { type: 'json' }); return Array.isArray(day) ? day : []; }
      catch { return []; }
    });
    let picks = days.flat();
    if (q.league) picks = picks.filter((p) => p.league === q.league);

    const agg = aggregate(picks);

    // ---- API spend (from cost-log, written by judge/ask/reevaluate) --------
    const spend = { today: 0, week: 0, month: 0, byFeature: {}, byModel: {} };
    try {
      const costStore = getStore({ name: 'cost-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      let ckeys = [];
      try { ckeys = (await costStore.list()).blobs.map((b) => b.key); } catch { ckeys = []; }
      const today = new Date().toISOString().slice(0, 10);
      const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const recent = ckeys.filter((k) => k >= d30);
      const costDays = await mapLimit(recent, 12, async (k) => {
        try { return { k, entries: (await costStore.get(k, { type: 'json' })) || [] }; }
        catch { return { k, entries: [] }; }
      });
      for (const { k, entries } of costDays) {
        for (const e of entries) {
          const usd = e.usd || 0;
          spend.month += usd;
          if (k >= d7) spend.week += usd;
          if (k === today) spend.today += usd;
          spend.byFeature[e.feature] = (spend.byFeature[e.feature] || 0) + usd;
          spend.byModel[e.model] = (spend.byModel[e.model] || 0) + usd;
        }
      }
    } catch { /* spend section is best-effort */ }
    agg.spend = spend;
    // ------------------------------------------------------------------------

    if (q.format === 'json') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(agg, null, 2) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: renderHTML(agg) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

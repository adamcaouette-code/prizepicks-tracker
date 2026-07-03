// netlify/functions/top-picks.js
//
// "Today's top picks" feed. Reads the pick-log (already written by every engine
// run) and returns the day's plays/leans sorted by probability — so you can run
// each league once and browse the accumulated board without re-running searches.
//
// Honesty built in: each pick carries loggedAt (so the UI can show its age) and,
// once the grader has filled in a result, the actual outcome replaces "live".
// Latest version of each pick wins if it was re-judged across runs.
//
// View (HTML):  /api/top-picks
// JSON:         /api/top-picks?format=json
// Filters:      ?date=2026-07-01  ?league=mlb  ?verdict=play  (default play+lean)

import { getStore } from '@netlify/blobs';

const isCombo = (p) => /combo/i.test(p.stat || '') || /\s\+\s/.test(p.player || '');

function latestByPick(picks) {
  const m = new Map();
  for (const p of picks) {
    const key = p.projectionId || `${p.player}|${p.stat}|${p.line}`;
    const prev = m.get(key);
    if (!prev) { m.set(key, p); continue; }
    // prefer a graded copy; otherwise the most recently logged judgment
    const pG = p.hit === true || p.hit === false;
    const prevG = prev.hit === true || prev.hit === false;
    if (pG && !prevG) { m.set(key, p); continue; }
    if (!pG && prevG) continue;
    if (String(p.loggedAt || '') > String(prev.loggedAt || '')) m.set(key, p);
  }
  return [...m.values()];
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ago = (iso) => {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
};

function renderHTML(date, rows) {
  const trs = rows.map((p) => {
    const outcome = p.hit === true ? '<span style="color:#34d399">✓ HIT</span>'
                  : p.hit === false ? '<span style="color:#f87171">✗ MISS</span>'
                  : `<span style="color:#8aa">live · ${ago(p.loggedAt)}</span>`;
    const pic = p.image
      ? `<img src="${esc(p.image)}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px" onerror="this.style.display='none'">`
      : '';
    return `<tr>
      <td>${pic}${esc(p.player)}</td>
      <td>${esc(p.stat)} <span style="color:#8aa">o${esc(p.line)}</span></td>
      <td>${Math.round((p.prob || 0) * 100)}%</td>
      <td>${esc(p.verdict)}</td>
      <td>${esc(p.oddsType || '')}</td>
      <td>${esc((p.league || '').toUpperCase())}</td>
      <td>${outcome}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="color:#888">No plays logged yet today — run a league to populate the feed.</td></tr>';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AtomBets · Top Picks</title><style>
  :root{color-scheme:dark}
  body{font:14px/1.5 ui-monospace,Menlo,monospace;background:#0b0e11;color:#e6e6e6;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 2px} .sub{color:#8aa;font-size:12px;margin-bottom:14px}
  table{border-collapse:collapse;width:100%;max-width:760px}
  th,td{text-align:left;padding:6px 12px;border-bottom:1px solid #1a2128}
  th{color:#8aa;font-weight:600;font-size:11px;text-transform:uppercase}
  td{font-variant-numeric:tabular-nums}
</style></head><body>
  <h1>AtomBets · Top Picks</h1>
  <div class="sub">${date} — latest judgment per pick, sorted by probability. Age shown for live picks; graded picks show their outcome.</div>
  <table><thead><tr><th>player</th><th>prop</th><th>prob</th><th>verdict</th><th>tier</th><th>league</th><th>status</th></tr></thead>
  <tbody>${trs}</tbody></table>
</body></html>`;
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const date = q.date || new Date().toISOString().slice(0, 10);
  const wantVerdicts = q.verdict ? q.verdict.split(',') : ['play']; // plays only by default; ?verdict=play,lean to include leans

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks = [];
    try { picks = (await store.get(date, { type: 'json' })) || []; } catch { picks = []; }

    let rows = latestByPick(picks)
      .filter((p) => wantVerdicts.includes(p.verdict))
      .filter((p) => !isCombo(p));
    if (q.league) rows = rows.filter((p) => p.league === q.league);
    rows.sort((a, b) => (b.prob || 0) - (a.prob || 0));

    if (q.format === 'json') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ date, count: rows.length, picks: rows }, null, 2) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: renderHTML(date, rows) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

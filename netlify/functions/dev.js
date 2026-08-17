// netlify/functions/dev.js
//
// Private developer console for AtomBets. Read-only page (except the action buttons
// you tap). Shows honest, deduped per-day counts and gives one-tap grade / drain /
// debug / clean plus endpoint tests. Just for you.
//
// View: https://atombets.netlify.app/api/dev

import { getStore } from '@netlify/blobs';

const isGraded = (p) => p.hit === true || p.hit === false;
const isCombo = (p) => /combo/i.test(p.stat || '') || /\s\+\s/.test(p.player || '');

// Counts on a DEDUPED basis so re-runs don't inflate the numbers.
function dayCounts(arr) {
  const m = new Map();
  for (const p of arr) {
    const key = p.projectionId || `${p.player}|${p.stat}|${p.line}`;
    const prev = m.get(key);
    if (!prev || (isGraded(p) && !isGraded(prev))) m.set(key, p);
  }
  const uniq = [...m.values()];
  let graded = 0, pending = 0, combos = 0;
  for (const p of uniq) {
    if (isGraded(p)) graded++;
    else if (p.ungradeable === 'combo' || isCombo(p)) combos++;
    else pending++;
  }
  return { total: arr.length, unique: uniq.length, graded, pending, combos };
}

// Run timings, newest first. bet-finder-background writes one row per completed
// run to the run-stats blob (last 20 per league) with per-phase durations, so a
// "why was that slow" question has an answer that isn't a guess.
function timingTable(runs) {
  if (!runs.length) return '<tr><td colspan="5" style="color:#888">no completed runs yet — run Find Bets once</td></tr>';
  const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');
  return runs.map((r) => {
    // Slowest phase first: that's the one worth attacking.
    const phases = (r.phases || []).slice().sort((a, b) => b.ms - a.ms)
      .map((p) => `${p.phase} ${secs(p.ms)}`).join(' · ');
    const slow = r.totalMs > 90000 ? '#f87171' : r.totalMs > 45000 ? '#fbbf24' : '#34d399';
    return `<tr>
      <td>${new Date(r.at).toLocaleString()}</td>
      <td>${r.league || '—'}</td>
      <td style="color:${slow}">${secs(r.totalMs)}</td>
      <td style="color:#889">${r.model || '—'}</td>
      <td style="color:#889">${phases || '—'}</td>
    </tr>`;
  }).join('');
}

export const handler = async () => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
  let rows = '';
  let keys = [];
  let runRows = '';
  let beatRows = '';
  try {
    const hs = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const log = (await hs.get('cron-heartbeat', { type: 'json' })) || [];
    beatRows = log.slice().reverse().slice(0, 12).map((b) => `<tr>
      <td>${new Date(b.at).toLocaleString()}</td>
      <td style="color:#889">${(b.picks || []).map((p) => `${p.date}: ${p.graded ?? '—'}`).join(' · ') || '—'}</td>
      <td style="color:${b.slipLegsGraded ? '#34d399' : '#667'}">${b.slipLegsGraded ?? 0}</td>
      <td style="color:${b.slipsSettled ? '#34d399' : '#667'}">${b.slipsSettled ?? 0}</td>
    </tr>`).join('');
    if (!beatRows) beatRows = '<tr><td colspan="4" style="color:#fbbf24">The grading cron has never recorded a run. If this stays empty past the next 10:00/11:00/14:00 UTC, scheduled functions are not firing for this site.</td></tr>';
  } catch (e) {
    beatRows = `<tr><td colspan="4" style="color:#f87171">error: ${String(e.message || e)}</td></tr>`;
  }
  try {
    const rs = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const leagues = (await rs.list()).blobs.map((b) => b.key);
    const all = [];
    for (const lg of leagues) {
      let hist = [];
      try { hist = (await rs.get(lg, { type: 'json' })) || []; } catch { hist = []; }
      for (const h of hist) all.push({ ...h, league: lg });
    }
    all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    runRows = timingTable(all.slice(0, 25));
  } catch (e) {
    runRows = `<tr><td colspan="5" style="color:#f87171">error: ${String(e.message || e)}</td></tr>`;
  }
  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    try { keys = (await store.list()).blobs.map((b) => b.key); } catch { keys = []; }
    keys.sort().reverse();
    keys = keys.slice(0, 21);

    for (const date of keys) {
      let arr = [];
      try { arr = (await store.get(date, { type: 'json' })) || []; } catch { arr = []; }
      const c = dayCounts(arr);
      const dupes = c.total - c.unique;
      rows += `<tr>
        <td>${date}</td>
        <td>${c.unique}${dupes ? ` <span style="color:#667">(+${dupes})</span>` : ''}</td>
        <td style="color:#34d399">${c.graded}</td>
        <td style="color:${c.pending ? '#fbbf24' : '#667'}">${c.pending}</td>
        <td style="color:#889">${c.combos}</td>
        <td>
          <button onclick="drain('${date}')">drain</button>
          <button onclick="debug('${date}')">debug</button>
          <button onclick="clean('${date}')">clean</button>
        </td>
      </tr>`;
    }
    if (!rows) rows = '<tr><td colspan="6" style="color:#888">no logged days</td></tr>';
  } catch (e) {
    rows = `<tr><td colspan="6" style="color:#f87171">error: ${String(e.message || e)}</td></tr>`;
  }

  const script = [
    `var ALL_DATES=${JSON.stringify(keys)};`,
    "var out=document.getElementById('out');",
    "function show(label,data){out.textContent='// '+label+'  ('+new Date().toLocaleTimeString()+')\\n'+(typeof data==='string'?data:JSON.stringify(data,null,2));}",
    "async function call(url,opts){try{var r=await fetch(url,opts);var t=await r.text();try{return{ok:r.ok,status:r.status,json:JSON.parse(t)};}catch(e){return{ok:r.ok,status:r.status,text:t.slice(0,160)};}}catch(e){return{ok:false,error:String(e)};}}",
    "function mlbDate(){var v=document.getElementById('mlbDate').value.trim();return v?'&date='+encodeURIComponent(v):'';}",
    "async function mlbProbe(){show('MLB raw shapes ...','working');var r=await call('/api/mlb-stats?mode=probe'+mlbDate());show('MLB probe',r.json||r);}",
    "async function mlbSlate(){show('MLB slate ...','working');var r=await call('/api/mlb-stats?mode=slate'+mlbDate());show('MLB slate',r.json||r);}",
    "async function mlbPlayer(){var id=document.getElementById('mlbPlayer').value.trim();if(!id)return show('MLB player','enter a personId');show('MLB player '+id+' ...','working');var r=await call('/api/mlb-stats?mode=player&id='+encodeURIComponent(id));show('MLB player '+id,r.json||r);}",
    "async function runCron(){show('running grade-cron ...','this drains yesterday + the day before, then settles slips');var r=await call('/api/grade-cron');show('grade-cron',r.json||r);}",
    "async function retrySlips(){show('retrying given-up slip legs ...','clears tombstones, then regrades');var r=await call('/api/grade-slips?retry=1');show('grade-slips retry',r.json||r);}",
    "async function gradeSlips(){show('grading saved slips ...','working');var r=await call('/api/grade-slips');show('grade-slips',r.json||r);}",
    "async function grade(d){show('grading '+d+' ...','working');var res=await call('/api/grade-picks?date='+d);show('grade '+d,res.json||res);}",
    "async function debug(d){show('debug '+d+' ...','working');var res=await call('/api/grade-debug?date='+d+'&limit=6');show('debug '+d,res.json||res);}",
    "async function clean(d){show('cleaning '+d+' ...','working');var res=await call('/api/cleanup?date='+d);show('clean '+d+' (refresh page to update counts)',res.json||res);}",
    "async function cleanAll(){show('cleaning all days ...','working');var res=await call('/api/cleanup');show('clean all (refresh page to update counts)',res.json||res);}",
    "async function drain(d){var calls=0,last=null,dead=0;while(calls<25){calls++;var res=await call('/api/grade-picks?date='+d);last=res.json||res;show('drain '+d+' — pass '+calls,last);if(!res.json){dead++;if(dead>=3)break;}else{dead=0;if(typeof last.pendingSingles==='number'&&last.pendingSingles===0){show('drain '+d+' DONE',last);return;}if(typeof last.remaining==='number'&&last.remaining===0&&last.newlyGraded===0){show('drain '+d+' DONE',last);return;}}await new Promise(function(r){setTimeout(r,400);});}show('drain '+d+' stopped',last);}",
    "function gd(fn){var d=document.getElementById('dateInput').value;if(!d){show('pick a date first','');return;}fn(d);}",
    "async function drainAll(){var today=new Date().toISOString().slice(0,10);var past=ALL_DATES.filter(function(d){return d<today;});if(!past.length){show('drain all','no past days to grade (today can\\'t be graded yet)');return;}for(var i=0;i<past.length;i++){await drain(past[i]);}show('DRAIN ALL DONE',{drained:past});}",
    "async function testAsk(){show('testing /api/ask ...','working');var body={pick:{player:'Junior Caminero',stat:'Hits+Runs+RBIs',line:2.5,matchup:'KC vs TB',recent5:[6,3,5,12,1],recentAvg:5.4},question:'is he in the starting lineup tonight'};var res=await call('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});show('test /api/ask',res.json||res);}",
    "async function testStats(){var p=document.getElementById('statsPlayer').value||'Junior Caminero';show('testing /api/player-stats ('+p+') ...','working');var res=await call('/api/player-stats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({player:p,league:'mlb'})});show('test /api/player-stats',res.json||res);}",
    // PrizePicks probe. Paging a full slate takes a few seconds, so say so up front.
    "async function probe(withRaw){var l=document.getElementById('probeLeague').value.trim();var u='/api/pp-probe'+(l?('?league='+encodeURIComponent(l)):'')+(withRaw?((l?'&':'?')+'raw=3'):'');show('probing PrizePicks'+(l?(' · '+l):' · leagues only')+' ...','paging the live board, this can take a few seconds');var res=await call(u);show('pp-probe'+(l?(' · '+l):''),res.json||res);}",
    "async function probeDeep(){var l=document.getElementById('probeLeague').value.trim()||'mlb';show('deep probe · '+l+' ...','walking up to 8 pages with backoff, give it a while');var res=await call('/api/pp-probe?league='+encodeURIComponent(l)+'&pages=8&raw=2');show('pp-probe deep · '+l,res.json||res);}",
    // Copy must NOT call show() — that would overwrite the very text being copied.
    "function copyMsg(m){var e=document.getElementById('copyMsg');e.textContent=m;setTimeout(function(){e.textContent='';},4000);}",
    "async function copyOut(){var t=out.textContent||'';if(!t.trim()){copyMsg('nothing to copy yet');return;}try{await navigator.clipboard.writeText(t);copyMsg('copied '+t.length.toLocaleString()+' chars');}catch(e){var r=document.createRange();r.selectNodeContents(out);var s=window.getSelection();s.removeAllRanges();s.addRange(r);copyMsg('clipboard blocked — text selected, use your browser Copy');}}",
  ].join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AtomBets · Dev</title><style>
  :root{color-scheme:dark}
  body{font:13px/1.5 ui-monospace,Menlo,monospace;background:#0b0e11;color:#e6e6e6;margin:0;padding:20px}
  h1{font-size:17px;margin:0 0 2px} h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8aa;margin:22px 0 8px}
  a{color:#6cf;text-decoration:none} a:hover{text-decoration:underline}
  table{border-collapse:collapse;width:100%;max-width:680px} th,td{text-align:left;padding:5px 10px;border-bottom:1px solid #1a2128}
  th{color:#8aa;font-size:10px;text-transform:uppercase} td{font-variant-numeric:tabular-nums}
  button{background:#1b2730;color:#cde;border:1px solid #2a3a47;border-radius:6px;padding:3px 9px;font:inherit;cursor:pointer;margin-right:4px}
  button:hover{background:#243440}
  input{background:#13181d;color:#e6e6e6;border:1px solid #2a3a47;border-radius:6px;padding:5px 8px;font:inherit}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
  pre{background:#0e1318;border:1px solid #1f2730;border-radius:8px;padding:12px;max-width:680px;white-space:pre-wrap;word-break:break-word;min-height:60px;margin-top:8px}
  .links a{margin-right:14px}
</style></head><body>
  <h1>AtomBets · Dev Console</h1>
  <div class="links" style="margin:8px 0 4px">
    <a href="/api/calibration" target="_blank">calibration ↗</a>
    <a href="/api/calibration?league=mlb" target="_blank">calibration · mlb ↗</a>
    <a href="/api/calibration?format=json" target="_blank">calibration · json ↗</a>
  </div>

  <h2>Grading cron</h2>
  <p style="color:#667;max-width:680px;margin:0 0 8px">
    Every firing of grade-cron records a heartbeat, so "did it run at 3am?" has an
    answer. Schedule is <b>0 10,11,14 UTC</b> — 10:00 is 3am PDT, 11:00 is 3am PST,
    14:00 is the late backstop. A slip only settles once its games are FINAL, so a
    slip whose slate is tonight will still read pending in the morning.
  </p>
  <table><thead><tr><th>fired</th><th>picks graded</th><th>slip legs</th><th>slips settled</th></tr></thead>
  <tbody>${beatRows}</tbody></table>
  <div class="row"><button onclick="runCron()">run grading now</button><button onclick="gradeSlips()">grade saved slips only</button><button onclick="retrySlips()">retry given-up slip legs</button></div>
  <p style="color:#667;max-width:680px;margin:8px 0 0">
    <b>retry</b> clears every recoverable "gave up" tombstone and tries again. Legs are
    only ever tombstoned once a slate is FINAL (36h); before that a failed lookup just
    means the box score isn't posted yet. Use <b>drain</b> per date below for the pick log.
  </p>

  <h2>Run timings (newest first)</h2>
  <p style="color:#667;max-width:680px;margin:0 0 8px">
    Every completed Find Bets run records its own wall time and per-phase durations.
    Phases are listed <b>slowest first</b> — that's the one worth attacking. Green under
    45s, amber under 90s, red past that. The board page also prints a live per-piece
    breakdown to its own console on every run, and shows it under
    <b>◇ Last Run Timing</b> at the bottom of the page.
  </p>
  <table><thead><tr><th>when</th><th>league</th><th>wall</th><th>model</th><th>phases (slowest first)</th></tr></thead>
  <tbody>${runRows}</tbody></table>

  <h2>Pick log by day (deduped)</h2>
  <table><thead><tr><th>date</th><th>unique</th><th>graded</th><th>pending</th><th>combos</th><th>actions</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p style="color:#667;max-width:680px">unique = distinct picks (+N = duplicate rows from re-runs). graded/pending/combos are per distinct pick. <b>drain</b> grades until pending is 0; <b>clean</b> removes duplicate rows; combos can't be graded and are skipped.</p>

  <div class="row"><button onclick="drainAll()">grade everything (all past days)</button><button onclick="cleanAll()">clean all days</button></div>

  <h2>Grade / debug any date</h2>
  <div class="row">
    <input type="date" id="dateInput">
    <button onclick="gd(grade)">grade</button>
    <button onclick="gd(drain)">drain</button>
    <button onclick="gd(debug)">debug</button>
    <button onclick="gd(clean)">clean</button>
  </div>

  <h2>Endpoint tests</h2>
  <div class="row"><button onclick="testAsk()">test /api/ask</button></div>
  <div class="row">
    <input id="statsPlayer" placeholder="player name" value="Junior Caminero">
    <button onclick="testStats()">test /api/player-stats</button>
  </div>

  <h2>MLB Stats API</h2>
  <p style="color:#667;max-width:680px;margin:0 0 8px">
    The board's injury flags, headshots and cap logos come from statsapi.mlb.com.
    <b>probe</b> dumps the raw upstream shapes (including every distinct roster status
    code it saw) so the parsers can be checked against reality; <b>slate</b> shows what
    the app actually derives from them. No model is called by either.
  </p>
  <div class="row">
    <input id="mlbDate" placeholder="YYYY-MM-DD (blank = today)" style="width:200px">
    <button onclick="mlbProbe()">probe raw shapes</button>
    <button onclick="mlbSlate()">slate + injuries</button>
    <input id="mlbPlayer" placeholder="personId" style="width:120px">
    <button onclick="mlbPlayer()">player</button>
  </div>

  <h2>PrizePicks probe</h2>
  <p style="color:#667;max-width:680px;margin:0 0 8px">
    Dumps what PrizePicks actually returns — every league with the tag this app derives
    from it, and per league the real stat_type strings, tiers, positions and raw rows.
    Run it, hit <b>copy output</b>, paste it wherever it's useful.
  </p>
  <div class="row">
    <input id="probeLeague" placeholder="league (blank = leagues only)" value="mlb" style="width:200px">
    <button onclick="probe()">look up PrizePicks</button>
    <button onclick="probe(true)">+ raw rows</button>
    <button onclick="probeDeep()">deep (8 pages)</button>
  </div>

  <h2>Output</h2>
  <div class="row">
    <button onclick="copyOut()">copy output</button>
    <span id="copyMsg" style="color:#667"></span>
  </div>
  <pre id="out">// results show here</pre>

  <script>${script}</script>
</body></html>`;

  return { statusCode: 200, headers, body: html };
};

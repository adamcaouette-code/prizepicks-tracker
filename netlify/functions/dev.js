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

export const handler = async () => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
  let rows = '';
  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let keys = [];
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
    "async function grade(d){show('grading '+d+' ...','working');var res=await call('/api/grade-picks?date='+d);show('grade '+d,res.json||res);}",
    "async function debug(d){show('debug '+d+' ...','working');var res=await call('/api/grade-debug?date='+d+'&limit=6');show('debug '+d,res.json||res);}",
    "async function clean(d){show('cleaning '+d+' ...','working');var res=await call('/api/cleanup?date='+d);show('clean '+d+' (refresh page to update counts)',res.json||res);}",
    "async function cleanAll(){show('cleaning all days ...','working');var res=await call('/api/cleanup');show('clean all (refresh page to update counts)',res.json||res);}",
    "async function drain(d){var calls=0,last=null,dead=0;while(calls<25){calls++;var res=await call('/api/grade-picks?date='+d);last=res.json||res;show('drain '+d+' — pass '+calls,last);if(!res.json){dead++;if(dead>=3)break;}else{dead=0;if(typeof last.pendingSingles==='number'&&last.pendingSingles===0){show('drain '+d+' DONE',last);return;}if(typeof last.remaining==='number'&&last.remaining===0&&last.newlyGraded===0){show('drain '+d+' DONE',last);return;}}await new Promise(function(r){setTimeout(r,400);});}show('drain '+d+' stopped',last);}",
    "function gd(fn){var d=document.getElementById('dateInput').value;if(!d){show('pick a date first','');return;}fn(d);}",
    "async function drainAll(){var today=new Date().toISOString().slice(0,10);var past=ALL_DATES.filter(function(d){return d<today;});if(!past.length){show('drain all','no past days to grade (today can\\'t be graded yet)');return;}for(var i=0;i<past.length;i++){await drain(past[i]);}show('DRAIN ALL DONE',{drained:past});}",
    "async function testAsk(){show('testing /api/ask ...','working');var body={pick:{player:'Junior Caminero',stat:'Hits+Runs+RBIs',line:2.5,matchup:'KC vs TB',recent5:[6,3,5,12,1],recentAvg:5.4},question:'is he in the starting lineup tonight'};var res=await call('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});show('test /api/ask',res.json||res);}",
    "async function testStats(){var p=document.getElementById('statsPlayer').value||'Junior Caminero';show('testing /api/player-stats ('+p+') ...','working');var res=await call('/api/player-stats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({player:p,league:'mlb'})});show('test /api/player-stats',res.json||res);}",
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

  <h2>Output</h2>
  <pre id="out">// results show here</pre>

  <script>${script}</script>
</body></html>`;

  return { statusCode: 200, headers, body: html };
};

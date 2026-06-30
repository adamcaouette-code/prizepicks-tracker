// netlify/functions/espn-stats-probe.js
//
// READ-ONLY probe. Does NOT write anything. Tries a few ESPN endpoints for a player
// and dumps the raw shape so we can see exactly what season-stat fields ESPN exposes
// (games, IP, ERA, AVG, etc.) and how to resolve a name -> athlete. Throwaway: delete
// once we've built the real ESPN-direct player-stats.
//
// Usage: /api/espn-stats-probe?name=JP%20Sears
//        /api/espn-stats-probe?name=Junior%20Caminero

async function getJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    return { url, status: res.status, ok: res.ok, json: res.ok ? await res.json() : null };
  } catch (e) {
    return { url, status: 0, ok: false, error: String(e.message || e) };
  }
}

function trim(obj, depth = 2) {
  // shallow-trim a big object so the dump is readable
  if (obj == null || typeof obj !== 'object') return obj;
  if (depth <= 0) return Array.isArray(obj) ? `[${obj.length} items]` : '{...}';
  const out = Array.isArray(obj) ? [] : {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n++ > 25) { out['...'] = 'truncated'; break; }
    out[k] = trim(obj[k], depth - 1);
  }
  return out;
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const name = q.name || 'JP Sears';

  const out = { name, steps: [] };

  // 1) Search ESPN for the athlete to get an id.
  const search = await getJSON(`https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(name)}&limit=8`);
  out.steps.push({ step: 'search', status: search.status, sample: search.json ? trim(search.json, 3) : search.error });

  // Try to dig an athlete id + ref out of the search payload.
  let athleteId = null, athleteRef = null;
  try {
    const results = search.json?.results || [];
    for (const group of results) {
      for (const item of (group.contents || group.items || [])) {
        const t = (item.type || item.sport || '').toString().toLowerCase();
        if ((t.includes('player') || t.includes('athlete')) && (item.id || item.uid || item.link)) {
          athleteId = item.id || (item.uid && item.uid.split(':').pop());
          athleteRef = item.link?.href || item.ref || null;
          if (athleteId) break;
        }
      }
      if (athleteId) break;
    }
  } catch (e) { out.parseError = String(e.message || e); }
  out.athleteId = athleteId;
  out.athleteRef = athleteRef;

  // 2) If we got an id, try the common stats endpoints and show their shape.
  if (athleteId) {
    const a = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}`);
    out.steps.push({ step: 'athlete', status: a.status, topKeys: a.json ? Object.keys(a.json) : null, sample: a.json ? trim(a.json, 2) : a.error });

    const s = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/stats`);
    out.steps.push({ step: 'stats', status: s.status, topKeys: s.json ? Object.keys(s.json) : null, sample: s.json ? trim(s.json, 3) : s.error });
  }

  return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
};

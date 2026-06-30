// netlify/functions/player-stats.js
//
// Season statline for a player, fetched DIRECTLY from ESPN (fast, free, no Claude,
// no web search, no API key). Resolves the name -> ESPN numeric athlete id, pulls
// the stats endpoint, and returns the latest season's combined line in a stable
// JSON shape the frontend stats menu renders.
//
// POST /api/player-stats
// body: { player: "JP Sears", league?: "mlb" }
//
// returns: { stats: { kind:"pitcher"|"hitter", name, team, season, games, ... },
//            source: "espn", asOf }

const UA = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

async function getJSON(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`ESPN ${res.status} on ${url}`);
  return res.json();
}

// name -> { id, team, headshot }
async function resolveAthlete(name) {
  const data = await getJSON(`https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(name)}&limit=8`);
  let item = null;
  for (const group of (data?.results || [])) {
    if ((group.type || '').toLowerCase() === 'player') {
      item = (group.contents || group.items || [])[0];
      break;
    }
  }
  if (!item) return null;
  const uid = item.uid || '';
  const web = (item.link && (item.link.web || item.link.href)) || '';
  let id = (uid.match(/a:(\d+)/) || [])[1] || (String(web).match(/\/id\/(\d+)/) || [])[1] || null;
  return id ? { id, team: item.subtitle || null, headshot: item.image?.default || null } : null;
}

// pick the most recent season's combined ("Totals") row from a category
function latestSeasonRow(category) {
  const rows = category?.statistics || [];
  if (!rows.length) return null;
  const maxYear = Math.max(...rows.map((r) => r?.season?.year || 0));
  const yearRows = rows.filter((r) => (r?.season?.year || 0) === maxYear);
  // prefer the "{year} Totals" combined row (present when traded mid-season)
  const totals = yearRows.find((r) => /total/i.test(r.teamSlug || r.displayName || ''));
  const row = totals || yearRows[yearRows.length - 1];
  return { row, year: maxYear };
}

function rowMap(names, values) {
  const m = {};
  (names || []).forEach((n, i) => { m[n] = values[i]; });
  return m;
}

const num = (v) => { const n = Number(v); return isFinite(n) ? n : (v ?? null); };
const pick = (m, ...keys) => { for (const k of keys) if (m[k] !== undefined) return m[k]; return null; };

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON body' }) }; }
  if (!payload.player) return { statusCode: 400, headers, body: JSON.stringify({ error: 'provide player' }) };
  const league = (payload.league || 'mlb').toLowerCase();
  if (league !== 'mlb') return { statusCode: 200, headers, body: JSON.stringify({ error: `ESPN-direct stats currently support mlb only (got ${league})` }) };

  try {
    const athlete = await resolveAthlete(payload.player);
    if (!athlete) return { statusCode: 404, headers, body: JSON.stringify({ error: 'player not found on ESPN' }) };

    const data = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athlete.id}/stats`);
    const cats = data?.categories || [];
    const primary = (data?.filters?.[0]?.value || '').toLowerCase(); // "pitching" or "batting"
    const isPitcher = primary === 'pitching' || (!cats.some((c) => c.name === 'batting') && cats.some((c) => c.name === 'pitching'));
    const catName = isPitcher ? 'pitching' : 'batting';
    const cat = cats.find((c) => c.name === catName) || cats[0];
    if (!cat) return { statusCode: 404, headers, body: JSON.stringify({ error: 'no stat categories for player' }) };

    const sel = latestSeasonRow(cat);
    if (!sel?.row) return { statusCode: 404, headers, body: JSON.stringify({ error: 'no season rows' }) };
    const m = rowMap(cat.names, sel.row.stats || sel.row.values);

    let stats;
    if (isPitcher) {
      stats = {
        kind: 'pitcher',
        name: payload.player, team: athlete.team, season: String(sel.year), position: sel.row.position || 'P',
        games: num(pick(m, 'gamesPlayed')), gs: num(pick(m, 'gamesStarted')),
        ip: num(pick(m, 'innings')),
        w: num(pick(m, 'wins')), l: num(pick(m, 'losses')),
        era: num(pick(m, 'ERA')), whip: num(pick(m, 'WHIP')),
        k: num(pick(m, 'strikeouts')), bb_allowed: num(pick(m, 'walks')), saves: num(pick(m, 'saves')),
      };
    } else {
      stats = {
        kind: 'hitter',
        name: payload.player, team: athlete.team, season: String(sel.year), position: sel.row.position || null,
        games: num(pick(m, 'gamesPlayed')), atBats: num(pick(m, 'atBats')),
        avg: num(pick(m, 'avg', 'battingAverage', 'AVG')),
        obp: num(pick(m, 'onBasePct', 'OBP')),
        slg: num(pick(m, 'slugAvg', 'SLG')),
        ops: num(pick(m, 'OPS')),
        hr: num(pick(m, 'homeRuns')), rbi: num(pick(m, 'RBIs', 'rbi')), runs: num(pick(m, 'runs')),
        sb: num(pick(m, 'stolenBases')), bb: num(pick(m, 'walks')), so: num(pick(m, 'strikeouts')),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ stats, headshot: athlete.headshot, source: 'espn', asOf: new Date().toISOString() }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

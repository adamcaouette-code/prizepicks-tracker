// def-probe.js — one-time diagnostic. Deploy, hit the URL, paste me the JSON.
// Goal: find which ESPN endpoint exposes OPPONENT-ALLOWED (defensive) team stats in a
// rankable form, and what the exact category/stat labels are — so fetchOppDefense in
// bet-finder-background.js can be written against the real shape (no guessing).
//
// Usage after deploy:
//   /api/def-probe                 -> WNBA, current year
//   /api/def-probe?league=mlb      -> MLB
//   /api/def-probe?year=2026&seasontype=2
//
// Safe: read-only, no keys, no writes. Just fetches ESPN and reports structure.

const SLUG = {
  wnba: { sport: 'basketball', league: 'wnba' },
  nba:  { sport: 'basketball', league: 'nba' },
  mlb:  { sport: 'baseball',   league: 'mlb' },
};

async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return { url, ok: false, status: r.status };
    return { url, ok: true, status: r.status, data: await r.json() };
  } catch (e) {
    return { url, ok: false, error: String(e.message || e) };
  }
}

// Trim a big JSON node down to its shape: keys, and for arrays a sample element.
function shape(node, depth = 0) {
  if (depth > 4 || node == null) return typeof node;
  if (Array.isArray(node)) return node.length ? [`(${node.length}) `, shape(node[0], depth + 1)] : [];
  if (typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node).slice(0, 40)) out[k] = shape(node[k], depth + 1);
    return out;
  }
  return node; // primitive: show the actual value
}

// Pull every category/stat label we can find, flag anything defensive/opponent-ish.
function labels(data) {
  const cats = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.categories)) {
      for (const c of n.categories) {
        const statNames = (c.stats || c.leaders || []).map((s) => s.name || s.abbreviation || s.displayName).filter(Boolean);
        cats.push({ category: c.name || c.displayName || '?', stats: statNames.slice(0, 30) });
      }
    }
    for (const k of Object.keys(n)) if (typeof n[k] === 'object') walk(n[k]);
  };
  walk(data);
  const defensive = cats.filter((c) => /def|opp|against|allowed/i.test(c.category));
  return { totalCategories: cats.length, defensiveLike: defensive, allCategories: cats.map((c) => c.category) };
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const league = (q.league || 'wnba').toLowerCase();
  const year = q.year || String(new Date().getFullYear());
  const seasontype = q.seasontype || '2'; // 2 = regular season
  const s = SLUG[league] || SLUG.wnba;

  // 1) Team list — gives us ids + names to key the eventual map on.
  const teams = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${s.sport}/${s.league}/teams`);
  let firstTeam = null;
  try {
    firstTeam = teams.data.sports[0].leagues[0].teams[0].team; // { id, displayName, abbreviation }
  } catch {}

  // 2) Candidate endpoints most likely to carry rankable opponent-allowed stats.
  const candidates = {
    // league-wide "byteam" — best case: all teams + team/opponent splits in one call
    byteam: `https://site.web.api.espn.com/apis/common/v3/sports/${s.sport}/${s.league}/statistics/byteam?season=${year}&seasontype=${seasontype}&region=us&lang=en&contentorigin=espn`,
    // per-team core statistics — usually has an "opponent"/"defensive" category
    coreTeam: firstTeam ? `https://sports.core.api.espn.com/v2/sports/${s.sport}/leagues/${s.league}/seasons/${year}/types/${seasontype}/teams/${firstTeam.id}/statistics` : null,
    // site team statistics (fallback)
    siteTeam: firstTeam ? `https://site.web.api.espn.com/apis/site/v2/sports/${s.sport}/${s.league}/teams/${firstTeam.id}/statistics` : null,
  };

  const results = {};
  for (const [name, url] of Object.entries(candidates)) {
    if (!url) { results[name] = { skipped: 'no team id' }; continue; }
    const r = await getJSON(url);
    results[name] = r.ok
      ? { url, status: r.status, labels: labels(r.data), shape: shape(r.data) }
      : r;
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      probe: { league, year, seasontype },
      firstTeam: firstTeam ? { id: firstTeam.id, name: firstTeam.displayName, abbr: firstTeam.abbreviation } : 'team list failed',
      teamCount: (() => { try { return teams.data.sports[0].leagues[0].teams.length; } catch { return 0; } })(),
      results,
    }, null, 2),
  };
};

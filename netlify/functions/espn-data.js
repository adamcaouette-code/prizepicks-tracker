// netlify/functions/espn-data.js
//
// ESPN DATA ENGINE (proof-of-concept: MLB first).
// Job: take player names -> search ESPN -> return matched id + season avgs + last-5.
// Free, public ESPN API, no key. The background function calls this BEFORE Claude
// and hands Claude a finished data sheet, so Claude reads numbers instead of searching.
//
// POST body: { league: "mlb", players: ["Mookie Betts", "Aaron Judge", ...] }
// Returns:   { matched: [...], unmatched: [...], matchRate: 0.0-1.0 }
//
// This PoC focuses on the hard part — does ESPN actually match PrizePicks names?

const ESPN = {
  mlb: { sport: 'baseball', league: 'mlb' },
  nba: { sport: 'basketball', league: 'nba' },
  wnba: { sport: 'basketball', league: 'wnba' },
  nfl: { sport: 'football', league: 'nfl' },
  world_cup: { sport: 'soccer', league: 'fifa.world' },
};

// --- name normalization: strip accents, punctuation, suffixes, lowercase ---
function normName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents: Gyökeres -> Gyokeres
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')              // drop suffixes
    .replace(/[^a-z\s]/g, ' ')                          // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// last name only, for looser fallback matching
function lastName(name) {
  const parts = normName(name).split(' ');
  return parts[parts.length - 1] || '';
}

// --- ESPN player search ---
async function searchPlayer(sport, league, name) {
  const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=8&sport=${sport}&league=${league}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const items = [];
    for (const group of data.results || []) {
      for (const c of group.contents || []) {
        if (c.type === 'player' || c.uid?.includes('athlete') || c.id) {
          items.push({
            id: c.id || (c.uid || '').split(':').pop(),
            name: c.displayName || c.title || c.name || '',
            subtitle: c.subtitle || '',
          });
        }
      }
    }
    return items;
  } catch {
    return [];
  }
}

// pick the best ESPN candidate for a PrizePicks name
function bestMatch(ppName, candidates) {
  const target = normName(ppName);
  const targetLast = lastName(ppName);
  // 1) exact normalized full-name match
  for (const c of candidates) if (normName(c.name) === target) return { ...c, confidence: 'exact' };
  // 2) last name matches AND first initial matches
  const ti = target.charAt(0);
  for (const c of candidates) {
    if (lastName(c.name) === targetLast && normName(c.name).charAt(0) === ti) {
      return { ...c, confidence: 'strong' };
    }
  }
  // 3) last name only (weak — flag it)
  for (const c of candidates) if (lastName(c.name) === targetLast) return { ...c, confidence: 'weak' };
  return null;
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const body = JSON.parse(event.body || '{}');
    const league = body.league || 'mlb';
    const players = Array.isArray(body.players) ? body.players : [];
    const slug = ESPN[league];
    if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown league '${league}'` }) };
    if (!players.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No players supplied' }) };

    const matched = [], unmatched = [];
    // limit to 25 for the PoC so we don't hammer ESPN
    for (const name of players.slice(0, 25)) {
      const candidates = await searchPlayer(slug.sport, slug.league, name);
      const hit = bestMatch(name, candidates);
      if (hit) matched.push({ pp: name, espn: hit.name, id: hit.id, confidence: hit.confidence });
      else unmatched.push({ pp: name, sawCandidates: candidates.slice(0, 3).map((c) => c.name) });
    }

    const matchRate = players.length ? matched.length / Math.min(players.length, 25) : 0;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        league,
        tested: Math.min(players.length, 25),
        matchRate: Math.round(matchRate * 100) / 100,
        matched,
        unmatched,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

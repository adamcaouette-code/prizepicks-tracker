// pp-leagues.js — one-time helper. Deploy, hit /api/pp-leagues, read the list.
// Returns every league PrizePicks is showing RIGHT NOW with its id + live projection
// count, so you know exactly what to add to PP_LEAGUE_IDS (and which are worth adding —
// a league with 0 projections today has no slate). Read-only, no keys.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
  Referer: 'https://app.prizepicks.com/',
};

export const handler = async () => {
  try {
    // The leagues endpoint lists every active league. include=… is optional; the
    // core data[] carries id + name, and usually a projections/props count.
    const res = await fetch('https://partner-api.prizepicks.com/leagues?per_page=250', { headers: HEADERS });
    if (!res.ok) {
      return json(502, { error: `PrizePicks /leagues returned ${res.status}`, hint: 'If it 403/429s, retry in a minute — same throttling as the projections call.' });
    }
    const full = await res.json();

    const leagues = (full.data || []).map((d) => {
      const a = d.attributes || {};
      return {
        id: d.id,                                   // <-- this is the PP_LEAGUE_IDS value
        name: a.name || a.display_name || '(unnamed)',
        projections: a.projections_count ?? a.props_count ?? null, // live slate size if provided
        active: a.active ?? null,
      };
    });

    // Sort by live slate size (biggest first); nulls last. A big count = a real board today.
    leagues.sort((x, y) => (y.projections ?? -1) - (x.projections ?? -1));

    // Flag the ones you already wired so it's obvious what's new.
    const HAVE = { '241': 'world_cup', '2': 'mlb', '3': 'wnba', '7': 'nba', '9': 'nfl' };
    for (const l of leagues) l.alreadyAdded = HAVE[l.id] || false;

    return json(200, {
      count: leagues.length,
      note: 'id = the value for PP_LEAGUE_IDS. projections = live count now (0 or null = no slate today).',
      leagues,
    });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, null, 2) };
}

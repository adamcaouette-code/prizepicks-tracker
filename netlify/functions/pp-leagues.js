// netlify/functions/pp-leagues.js
//
// Every league PrizePicks is posting right now, so the league selector reflects the
// real board instead of a hardcoded list. That list had gone stale in both
// directions: the World Cup was still showing after the tournament ended, and no
// other sport PrizePicks offers could be selected at all.
//
//   GET /api/pp-leagues            -> leagues with a live slate, biggest first
//   GET /api/pp-leagues?all=1      -> everything, including empty slates (debugging)
//
// Each entry carries `research`, which is the honest bit:
//   "full"  — standings + win% + DraftKings line comparison are wired for this league
//   "props" — props load and Claude still judges them, but with no research attached,
//             so the judge is told to widen toward 50%. Worth knowing before you
//             read a grade as gospel.

import { fetchLeagueCatalog, ESPN_SLUGS, ODDS_SPORT_KEYS } from './bet-finder-background.js';

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  try {
    const catalog = await fetchLeagueCatalog();

    let leagues = catalog.map((l) => ({
      ...l,
      // "full" needs BOTH sides: standings context and a market to price against.
      research: (ESPN_SLUGS[l.tag] && ODDS_SPORT_KEYS[l.tag]) ? 'full' : 'props',
    }));

    // Default view is what you can actually bet today. A league with no projections
    // is a dead button — that's exactly how the World Cup lingered.
    if (q.all !== '1') leagues = leagues.filter((l) => (l.projections ?? 0) > 0);

    leagues.sort((a, b) => (b.projections ?? -1) - (a.projections ?? -1) || a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        count: leagues.length,
        note: 'research:"full" = standings + win% + book lines wired; "props" = props only, grades are thinner.',
        leagues,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

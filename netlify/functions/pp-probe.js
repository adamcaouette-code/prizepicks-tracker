// netlify/functions/pp-probe.js
//
// THROWAWAY DIAGNOSTIC. Dumps the FULL untrimmed fields PrizePicks sends, so we
// can see whether the feed includes a recent average / last-5 (or if that's
// front-end only). Delete this file after we've looked.
//
// Usage (browser): /api/pp-probe?league=mlb   (or world_cup, nba, wnba, nfl)

const PP_LEAGUE_IDS = { world_cup: '241', mlb: '2', wnba: '3', nba: '7', nfl: '9' };

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const league = (event.queryStringParameters || {}).league || 'mlb';
  const lid = PP_LEAGUE_IDS[league];
  if (!lid) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown league '${league}'` }) };

  const url = `https://partner-api.prizepicks.com/projections?per_page=50&single_stat=true&league_id=${lid}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://app.prizepicks.com/',
      },
    });
    if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: `PrizePicks returned ${res.status}` }) };
    const full = await res.json();

    const projections = full.data || [];
    const included = full.included || [];

    // collect every distinct attribute key seen across ALL projections
    const projKeys = new Set();
    for (const p of projections) for (const k in (p.attributes || {})) projKeys.add(k);

    // distinct included types (new_player, league, stat_average, etc.) + their keys
    const includedTypes = {};
    for (const i of included) {
      if (!includedTypes[i.type]) includedTypes[i.type] = new Set();
      for (const k in (i.attributes || {})) includedTypes[i.type].add(k);
    }
    const includedSummary = {};
    for (const t in includedTypes) includedSummary[t] = [...includedTypes[t]];

    // full dump of the FIRST projection + its linked player + any linked stat objects
    const first = projections[0] || {};
    const firstRelationships = first.relationships || {};
    const playerId = firstRelationships.new_player?.data?.id;
    const player = included.find((i) => i.type === 'new_player' && i.id === playerId);

    // grab one example of every OTHER included type too (in case averages live there)
    const exampleByType = {};
    for (const i of included) {
      if (!exampleByType[i.type]) exampleByType[i.type] = { id: i.id, attributes: i.attributes };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        league,
        counts: { projections: projections.length, included: included.length },
        ALL_projection_attribute_keys: [...projKeys],
        included_types_and_their_keys: includedSummary,
        FIRST_projection_full: { id: first.id, attributes: first.attributes, relationships: Object.keys(firstRelationships) },
        FIRST_projection_player: player ? { id: player.id, attributes: player.attributes } : null,
        one_example_of_each_included_type: exampleByType,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

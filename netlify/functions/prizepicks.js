export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const wantLeagues = params.list === 'leagues';
  const leagueId = params.league_id || '';

  const base = 'https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true';
  // list mode: fetch unscoped so we can see every league in the feed.
  // normal mode: scope to one league (default World Cup guess 82) to stay small.
  const url = wantLeagues ? base : `${base}&league_id=${leagueId || '82'}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://app.prizepicks.com/',
      },
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: `PrizePicks API returned ${response.status}` }),
      };
    }

    const full = await response.json();
    const included = Array.isArray(full.included) ? full.included : [];
    const data = Array.isArray(full.data) ? full.data : [];

    // ---- DISCOVERY MODE: just list the leagues + how many props each has ----
    if (wantLeagues) {
      const counts = {};
      data.forEach((d) => {
        const lid = d.relationships?.league?.data?.id;
        if (lid) counts[lid] = (counts[lid] || 0) + 1;
      });
      const leagues = included
        .filter((i) => i.type === 'league')
        .map((i) => ({
          id: i.id,
          name: i.attributes?.name,
          props_in_sample: counts[i.id] || 0,
        }))
        .sort((a, b) => b.props_in_sample - a.props_in_sample);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ leagues }),
      };
    }

    // ---- NORMAL MODE: trimmed projections for one league ----
    const slimIncluded = included
      .filter((i) => i.type === 'new_player' || i.type === 'league' || i.type === 'stat_type')
      .map((i) => ({
        id: i.id,
        type: i.type,
        attributes: i.attributes
          ? {
              name: i.attributes.name,
              display_name: i.attributes.display_name,
              market: i.attributes.market,
              team: i.attributes.team,
              position: i.attributes.position,
            }
          : undefined,
      }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ data, included: slimIncluded }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

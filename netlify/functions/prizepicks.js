export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const leagueId = params.league_id || '';

  // Pull one league at a time. Fetching ALL leagues returns ~6MB+ and blows
  // past Netlify's function response cap. Default to World Cup (82) if none given.
  const league = leagueId || '82';

  const url = `https://partner-api.prizepicks.com/projections`
            + `?per_page=250&single_stat=true&league_id=${league}`;

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

    // Trim to just what the app uses. The raw payload carries large "included"
    // arrays (teams, leagues, stat types, etc.); we keep projections + the
    // new_player entries needed to resolve names, and drop the rest.
    const included = Array.isArray(full.included) ? full.included : [];
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

    const slim = { data: full.data || [], included: slimIncluded };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(slim),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

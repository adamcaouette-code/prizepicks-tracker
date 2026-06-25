export const handler = async (event) => {
  const apiKey = process.env.ODDS_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'ODDS_API_KEY env var not set — add it in Netlify Site Settings → Environment Variables' }),
    };
  }

  const { sport, markets, event_id } = event.queryStringParameters || {};

  if (!sport) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing required param: sport' }),
    };
  }

  // Two modes:
  //   /api/dk-lines?sport=basketball_nba               → list today's events
  //   /api/dk-lines?sport=basketball_nba&event_id=X&markets=player_points,player_rebounds → props for one event
  let url;
  if (event_id && markets) {
    url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${event_id}/odds`
        + `?regions=us&markets=${markets}&bookmakers=draftkings,fanduel&oddsFormat=american&apiKey=${apiKey}`;
  } else {
    url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${apiKey}`;
  }

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const remaining = res.headers.get('x-requests-remaining');
    const used      = res.headers.get('x-requests-used');

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data?.message || `Odds API error ${res.status}`, data }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ data, remaining: remaining ? parseInt(remaining) : null, used: used ? parseInt(used) : null }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

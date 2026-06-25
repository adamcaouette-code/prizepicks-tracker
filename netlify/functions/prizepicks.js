export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const wantLeagues = params.list === 'leagues';
  const leagueId = params.league_id || '';

  const base = 'https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true';
  const url = wantLeagues ? base : `${base}&league_id=${leagueId || '241'}`;

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

    // ---- DISCOVERY MODE: list leagues + prop counts ----
    if (wantLeagues) {
      const counts = {};
      data.forEach((d) => {
        const lid = d.relationships?.league?.data?.id;
        if (lid) counts[lid] = (counts[lid] || 0) + 1;
      });
      const leagues = included
        .filter((i) => i.type === 'league')
        .map((i) => ({ id: i.id, name: i.attributes?.name, props_in_sample: counts[i.id] || 0 }))
        .sort((a, b) => b.props_in_sample - a.props_in_sample);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ leagues }),
      };
    }

    // ---- NORMAL MODE: trim EACH projection to just what the engine uses ----
    const slimData = data.map((d) => {
      const a = d.attributes || {};
      return {
        id: d.id,
        type: d.type,
        line_score: a.line_score,
        stat_type: a.stat_type,
        stat_display_name: a.stat_display_name,
        description: a.description,        // usually the matchup/opponent
        start_time: a.start_time,
        odds_type: a.odds_type,            // standard | demon | goblin
        player_id: d.relationships?.new_player?.data?.id,
        league_id: d.relationships?.league?.data?.id,
      };
    });

    // players: just id -> name/team/position
    const slimIncluded = included
      .filter((i) => i.type === 'new_player')
      .map((i) => ({
        id: i.id,
        type: i.type,
        attributes: {
          name: i.attributes?.name,
          display_name: i.attributes?.display_name,
          team: i.attributes?.team,
          position: i.attributes?.position,
        },
      }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ data: slimData, included: slimIncluded }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

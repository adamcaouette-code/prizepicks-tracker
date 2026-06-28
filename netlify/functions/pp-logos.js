// netlify/functions/pp-logos.js
//
// THROWAWAY HELPER. Dumps each league's logo URLs from the PrizePicks feed so we
// can hardcode them into the league-picker buttons. Delete after grabbing them.
//
// Usage: /api/pp-logos   (returns logos for all five leagues in one shot)

const PP_LEAGUE_IDS = { world_cup: '241', mlb: '2', wnba: '3', nba: '7', nfl: '9' };

async function leagueLogos(tag, lid) {
  const url = `https://partner-api.prizepicks.com/projections?per_page=10&single_stat=true&league_id=${lid}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://app.prizepicks.com/',
      },
    });
    if (!res.ok) return { tag, error: `HTTP ${res.status}` };
    const full = await res.json();
    const league = (full.included || []).find((i) => i.type === 'league');
    const a = league?.attributes || {};
    return {
      tag,
      name: a.name || tag,
      image_url: a.image_url || null,
      full_logo: a.full_logo || null,
      logo: a.logo || null,
      icon: a.icon || null,
    };
  } catch (e) {
    return { tag, error: String(e.message || e) };
  }
}

export const handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  try {
    const out = {};
    for (const [tag, lid] of Object.entries(PP_LEAGUE_IDS)) {
      out[tag] = await leagueLogos(tag, lid);
    }
    return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

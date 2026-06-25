export const handler = async (event) => {
  const { type, sport, league, name, athlete_id } = event.queryStringParameters || {};

  let url;

  if (type === 'search') {
    if (!sport || !league || !name) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing: sport, league, name' }) };
    url = `https://site.api.espn.com/apis/common/v3/sports/${sport}/${league}/athletes?searchTerm=${encodeURIComponent(name)}&limit=5&active=true`;

  } else if (type === 'stats') {
    if (!sport || !league || !athlete_id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing: sport, league, athlete_id' }) };
    url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/athletes/${athlete_id}/statistics`;

  } else if (type === 'gamelog') {
    if (!sport || !league || !athlete_id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing: sport, league, athlete_id' }) };
    url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/athletes/${athlete_id}/gamelog`;

  } else if (type === 'detail') {
    if (!sport || !league || !athlete_id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing: sport, league, athlete_id' }) };
    url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/athletes/${athlete_id}`;

  } else {
    return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'type must be search | stats | gamelog | detail' }) };
  }

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { statusCode: res.status, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: `ESPN ${res.status}` }) };
    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': type === 'gamelog' ? 'max-age=300' : type === 'detail' ? 'max-age=120' : 'max-age=300' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};

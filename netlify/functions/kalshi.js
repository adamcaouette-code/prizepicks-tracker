export const handler = async (event) => {
  const { limit = '200', series_ticker = '' } = event.queryStringParameters || {};

  let url = `https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=${limit}`;
  if (series_ticker) url += `&series_ticker=${series_ticker}`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: `Kalshi returned ${res.status}` }),
      };
    }
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=60',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

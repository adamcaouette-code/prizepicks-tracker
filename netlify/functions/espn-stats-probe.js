// netlify/functions/espn-stats-probe.js
//
// READ-ONLY probe v2. Dumps the RAW player search result so we can see the real
// numeric athlete id / profile link (the v1 ID was a UUID, wrong type for the stats
// endpoint). Also tries stats with a numeric id pulled from the link if found.
//
// Usage: /api/espn-stats-probe?name=JP%20Sears

async function getJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    return { status: res.status, ok: res.ok, json: res.ok ? await res.json() : null };
  } catch (e) {
    return { status: 0, ok: false, error: String(e.message || e) };
  }
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const q = event.queryStringParameters || {};
  const name = q.name || 'JP Sears';
  const out = { name };

  // 1) Search and dump the RAW player content items (no trimming).
  const search = await getJSON(`https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(name)}&limit=8`);
  let playerItems = [];
  try {
    for (const group of (search.json?.results || [])) {
      if ((group.type || '').toLowerCase() === 'player') {
        playerItems = group.contents || group.items || [];
        break;
      }
    }
  } catch (e) { out.parseError = String(e.message || e); }
  out.rawPlayerResults = playerItems; // <-- the full shape: id, uid, link, image, etc.

  // 2) Try to pull a NUMERIC id from uid (a:NNNN) or the profile link (/id/NNNN/).
  let numericId = null, fromLink = null;
  try {
    const it = playerItems[0] || {};
    const uid = it.uid || '';
    const mUid = uid.match(/a:(\d+)/);
    if (mUid) numericId = mUid[1];
    const href = (it.link && (it.link.href || it.link.web)) || it.link || (it.links && it.links[0] && it.links[0].href) || '';
    fromLink = href;
    const mLink = String(href).match(/\/id\/(\d+)/);
    if (!numericId && mLink) numericId = mLink[1];
  } catch (e) { out.idParseError = String(e.message || e); }
  out.numericId = numericId;
  out.linkSeen = fromLink;

  // 3) If we found a numeric id, hit the stats endpoint and show its shape.
  if (numericId) {
    const s = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${numericId}/stats`);
    out.statsTry = { status: s.status, topKeys: s.json ? Object.keys(s.json) : null, json: s.json || s.error };
  }

  return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
};

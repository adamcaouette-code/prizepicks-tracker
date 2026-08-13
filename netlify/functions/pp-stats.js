// netlify/functions/pp-stats.js
//
// Returns the distinct stat types PrizePicks is posting for a league RIGHT NOW,
// with how many props each has. The prop filter in the UI used to be a hardcoded
// per-league list, which silently went stale — MLB was missing every pitching prop
// (pitcher strikeouts, earned runs, hits allowed, outs) because nobody had added
// them by hand. Sourcing the list from the live board means it can't drift.
//
//   GET /api/pp-stats?league=mlb
//   -> { league, cached, statTypes: [ { stat: "Pitcher Strikeouts", count: 24 }, ... ] }
//
// Reuses bet-finder-background's fetchProps so the parsing, pagination and
// throttle-retry behaviour are identical to what a real run sees. That call pages
// the whole slate, so results are cached briefly — this is hit on page load and
// PrizePicks rate-limits aggressively.

import { getStore } from '@netlify/blobs';
import { fetchProps, PP_LEAGUE_IDS } from './bet-finder-background.js';

const CACHE_MS = 15 * 60 * 1000;

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };
  const league = String((event.queryStringParameters || {}).league || 'mlb').toLowerCase();
  if (!PP_LEAGUE_IDS[league]) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown league '${league}'` }) };
  }

  const cacheKey = `stats:${league}`;
  let store = null;
  try {
    store = getStore({ name: 'pp-stats-cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const cached = await store.get(cacheKey, { type: 'json' });
    if (cached && cached.at && Date.now() - cached.at < CACHE_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ league, cached: true, statTypes: cached.statTypes }) };
    }
  } catch { /* cache is best-effort */ }

  try {
    const rows = await fetchProps(league);
    const counts = {};
    for (const r of rows) {
      const s = String(r.stat || '').trim();
      if (s) counts[s] = (counts[s] || 0) + 1;
    }
    // Busiest props first: a stat with 40 lines posted is far more useful to filter
    // to than one with a single straggler.
    const statTypes = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([stat, count]) => ({ stat, count }));

    if (store) { try { await store.setJSON(cacheKey, { at: Date.now(), statTypes }); } catch {} }
    return { statusCode: 200, headers, body: JSON.stringify({ league, cached: false, statTypes }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

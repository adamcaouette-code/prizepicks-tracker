// netlify/functions/demon-board.js
//
// READ-ONLY demon board: display every demon from today's log, sorted by
// probability descending. Shows the judge's only measured discrimination
// (residual ICC 0.427, AUC 0.64-0.69), which is invisible in the normal board
// because selectLegs filters them all out at the verdict gate.
//
// Source: picks already logged. Does not trigger judging.
// No slip integration — display only.

import { getStore } from '@netlify/blobs';

const DEMON_BASE_RATE = 0.193;
const DEMON_BREAK_EVEN = 0.437;  // 3-pick power break-even
const DEMON_ICC = 0.427;          // residual ICC: ~57% is noise
const DEMON_ICC_NOISE = 1 - DEMON_ICC;

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  const q = event.queryStringParameters || {};
  const date = q.date || new Date().toISOString().slice(0, 10);
  const league = q.league || 'mlb';

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let picks = [];
    try { picks = (await store.get(date, { type: 'json' })) || []; } catch {}

    // Filter to demons only
    const demons = picks
      .filter(p => p.oddsType === 'demon' && p.league === league)
      .sort((a, b) => (b.prob || 0) - (a.prob || 0))
      .map(p => ({
        id: p.projectionId || `${p.player}|${p.stat}|${p.line}`,
        player: p.player,
        stat: p.stat,
        line: p.line,
        prob: p.prob ?? null,
        delta: p.prob != null ? Math.round((p.prob - DEMON_BASE_RATE) * 10000) / 10000 : null,
        cleared: p.cleared ?? null,
        keyRisk: p.key_risk || null,
        reasoning: p.reasoning || null,
        recent5: p.recent5 || null,
        verdict: p.verdict || 'pass',
        hit: p.hit,  // null = ungraded, true = hit, false = miss
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date,
        league,
        demons,
        stats: {
          count: demons.length,
          baseRate: DEMON_BASE_RATE,
          breakEven: DEMON_BREAK_EVEN,
          icc: DEMON_ICC,
          iccNoise: Math.round(DEMON_ICC_NOISE * 100) + '%',
          bestHalf: demons.length > 0 ? demons.slice(0, Math.ceil(demons.length / 2)).filter(d => d.hit === true).length : 0,
          bestHalfCount: Math.ceil(demons.length / 2),
        },
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

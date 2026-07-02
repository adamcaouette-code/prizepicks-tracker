// netlify/functions/reevaluate.js
//
// Re-judge ONE pick with fresh information — the surgical alternative to re-running
// a whole slate. Takes the pick (with its original reasoning), has Claude search for
// current lineup/injury/scratch news, and returns an updated verdict + prob with
// what changed. Also updates the pick's entry in today's pick-log so the top-picks
// feed reflects the fresh judgment.
//
// POST /api/reevaluate
// body: { pick: { player, stat, line, prob, verdict, matchup, team, league,
//                 recent5, recentAvg, oppSP, parkIndex, reasoning, key_risk,
//                 projectionId?, date? } }
//
// returns: { updated: { verdict, prob, key_risk, reasoning, changed, changeNote },
//            previous: { verdict, prob }, logUpdated: bool }

import { getStore } from '@netlify/blobs';

const MODEL = 'claude-sonnet-5';    // fast — this is a single-pick spot check
const MAX_TOKENS = 700;
const SEARCH_MAX_USES = 3;

// Spend metering (best-effort). Sonnet 5: $2/$10 per MTok intro until Aug 31 2026
// (then $3/$15). Web search ~$0.01/search.
async function recordCost(feature, apiResponse) {
  try {
    const u = apiResponse?.usage || {};
    const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
    const searches = u.server_tool_use?.web_search_requests || 0;
    const usd = (inTok / 1e6) * 2 + (outTok / 1e6) * 10 + searches * 0.01;
    const store = getStore({ name: 'cost-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const day = new Date().toISOString().slice(0, 10);
    let arr = [];
    try { arr = (await store.get(day, { type: 'json' })) || []; } catch {}
    arr.push({ at: new Date().toISOString(), feature, model: MODEL, inTok, outTok, searches, usd: Math.round(usd * 10000) / 10000 });
    await store.setJSON(day, arr);
  } catch { /* never break the re-eval */ }
}

function buildSystem(pick) {
  return [
    'You are re-evaluating ONE sports prop pick that was judged earlier today. Your job: check whether it still holds RIGHT NOW.',
    '',
    'The pick and its ORIGINAL judgment:',
    JSON.stringify({
      player: pick.player, team: pick.team, matchup: pick.matchup, league: pick.league,
      stat: pick.stat, line: pick.line,
      originalVerdict: pick.verdict, originalProb: pick.prob,
      originalReasoning: pick.reasoning, originalKeyRisk: pick.key_risk,
      recent5: pick.recent5, recentAvg: pick.recentAvg,
      oppSP: pick.oppSP, parkIndex: pick.parkIndex,
    }, null, 2),
    '',
    'Use web search (up to 3) for CURRENT news only: confirmed lineup, late scratches, injury updates, pitching changes, weather delays. Do not re-litigate the stats — they have not changed. Only news since the original judgment matters.',
    '',
    'Return ONLY a JSON object, no prose, no fences:',
    '{',
    '  "verdict": "play" | "lean" | "pass",',
    '  "prob": number,              // updated P(over), 0-1',
    '  "key_risk": string,',
    '  "reasoning": string,         // 1-2 sentences, note what you checked',
    '  "changed": boolean,          // did verdict or prob move meaningfully?',
    '  "changeNote": string         // if changed: what news moved it; else ""',
    '}',
  ].join('\n');
}

function extractJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* nope */ } }
  return null;
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON body' }) }; }
  const pick = payload.pick;
  if (!pick || !pick.player || !pick.stat) return { statusCode: 400, headers, body: JSON.stringify({ error: 'provide pick with player and stat' }) };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystem(pick),
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES }],
        messages: [{ role: 'user', content: `Re-evaluate ${pick.player} ${pick.stat} o${pick.line} now. JSON only.` }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data?.error?.message || 'Anthropic API error' }) };
    recordCost('reevaluate', data).catch(() => {});

    const text = (Array.isArray(data.content) ? data.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const updated = extractJSON(text);
    if (!updated || !updated.verdict) return { statusCode: 502, headers, body: JSON.stringify({ error: 'could not parse re-evaluation', raw: text.slice(0, 300) }) };

    // Update the pick-log entry so top-picks reflects the fresh judgment.
    let logUpdated = false;
    try {
      const date = pick.date || new Date().toISOString().slice(0, 10);
      const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      const arr = (await store.get(date, { type: 'json' })) || [];
      const keyOf = (p) => p.projectionId || `${p.player}|${p.stat}|${p.line}`;
      const target = pick.projectionId || `${pick.player}|${pick.stat}|${pick.line}`;
      for (const p of arr) {
        if (keyOf(p) === target && (p.hit === null || p.hit === undefined)) {
          p.verdict = updated.verdict; p.prob = updated.prob;
          p.loggedAt = new Date().toISOString();
          p.reevaluatedAt = p.loggedAt;
          logUpdated = true;
        }
      }
      if (logUpdated) await store.setJSON(date, arr);
    } catch { /* log update is best-effort */ }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        updated,
        previous: { verdict: pick.verdict, prob: pick.prob },
        logUpdated,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

// netlify/functions/player-stats.js
//
// Season stat line for a player, returned as structured JSON so a frontend stats
// menu can render predictable fields. Sourced via Claude + web search for now —
// the endpoint contract (the JSON shape below) stays the same if we later swap the
// source to a deterministic feed like ESPN. Key stays server-side.
//
// POST /api/player-stats
// body: { player: 'Junior Caminero', team?: 'TB', league?: 'mlb', position?: 'IF' }
//
// returns: { stats: { kind, name, season, team, ... }, asOf, source: 'claude+search' }
// hitter shape:  { kind:'hitter',  games, avg, obp, slg, ops, hr, rbi, runs, sb, bb, so }
// pitcher shape: { kind:'pitcher', games, w, l, era, whip, ip, k, bb, hr, saves }

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 800;
const SEARCH_MAX_USES = 4;

function buildSystem({ player, team, league, position }) {
  return [
    `You look up a player's CURRENT season statline and return it as strict JSON. Player: ${player}${team ? ` (${team})` : ''}${position ? `, position ${position}` : ''}${league ? `, league ${league}` : ''}.`,
    'Use web search to get current-season numbers. Decide whether the player is a hitter or a pitcher and fill the matching shape.',
    '',
    'Return ONLY a JSON object — no prose, no markdown fences. Use this exact structure (omit fields you cannot find, use null for unknown numerics):',
    '{',
    '  "kind": "hitter" | "pitcher",',
    '  "name": string,',
    '  "team": string,',
    '  "season": string,            // e.g. "2026"',
    '  "games": number,',
    '  // hitter fields:',
    '  "avg": number, "obp": number, "slg": number, "ops": number,',
    '  "hr": number, "rbi": number, "runs": number, "sb": number, "bb": number, "so": number,',
    '  // pitcher fields:',
    '  "w": number, "l": number, "era": number, "whip": number, "ip": number,',
    '  "k": number, "bb_allowed": number, "saves": number,',
    '  "notes": string              // one short line: caveats, IL status, or "" if none',
    '}',
    'If you genuinely cannot identify the player, return {"error":"player not found"}.',
  ].join('\n');
}

function extractJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); // salvage a JSON object embedded in prose
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
  if (!payload.player) return { statusCode: 400, headers, body: JSON.stringify({ error: 'provide player' }) };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystem(payload),
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES }],
        messages: [{ role: 'user', content: `Season stats for ${payload.player}. Return JSON only.` }],
      }),
    });

    const data = await res.json();
    if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data?.error?.message || 'Anthropic API error', detail: data }) };

    const text = (Array.isArray(data.content) ? data.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const stats = extractJSON(text);
    if (!stats) return { statusCode: 502, headers, body: JSON.stringify({ error: 'could not parse stats', raw: text }) };
    if (stats.error) return { statusCode: 404, headers, body: JSON.stringify({ error: stats.error }) };

    return { statusCode: 200, headers, body: JSON.stringify({ stats, asOf: new Date().toISOString(), source: 'claude+search' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

// netlify/functions/ask.js
//
// Per-pick follow-up chat. The frontend posts the pick's context plus the user's
// question (and prior turns for a back-and-forth); this calls Claude server-side
// with web search enabled and returns the answer. The ANTHROPIC_API_KEY never
// leaves the server.
//
// POST /api/ask
// body: {
//   pick: { player, team, position, matchup, stat, line, verdict, prob, oddsType,
//           recent5, recentAvg, oppSP, selfSP, parkIndex, opponent, key_risk, reasoning },
//   messages: [ { role: 'user'|'assistant', content: '...' }, ... ]   // running thread
//   // (or) question: 'single question string'
// }

const MODEL = 'claude-sonnet-4-6';   // fast + cheap for chat; swap to match your engine if needed
const MAX_TOKENS = 1024;
const SEARCH_MAX_USES = 3;           // cap searches so a question can't run away on time/cost

function buildSystem(pick = {}) {
  const f = [];
  const add = (label, val) => { if (val !== undefined && val !== null && val !== '') f.push(`- ${label}: ${val}`); };

  add('Player', pick.player);
  add('Team', pick.team);
  add('Position', pick.position);
  add('Matchup', pick.matchup);
  add('Prop', pick.stat && `${pick.stat} ${pick.line != null ? `(line ${pick.line})` : ''}`);
  add('Engine verdict', pick.verdict && `${pick.verdict}${pick.prob != null ? ` @ ${Math.round(pick.prob * 100)}% over` : ''}`);
  add('Tier', pick.oddsType);
  if (Array.isArray(pick.recent5)) add('Last 5 games', `${pick.recent5.join(', ')} (avg ${pick.recentAvg ?? '—'})`);
  if (pick.oppSP && pick.oppSP.name) add('Opposing starter', `${pick.oppSP.name} (${pick.oppSP.throws}HP, ${pick.oppSP.era} ERA, ${pick.oppSP.whip} WHIP, ${pick.oppSP.k} K)`);
  if (pick.selfSP && pick.selfSP.name) add('Opposing starter (this pitcher faces)', `${pick.selfSP.name} (${pick.selfSP.throws}HP, ${pick.selfSP.era} ERA)`);
  add('Park index', pick.parkIndex && `${pick.parkIndex} (100 = neutral)`);
  add('Opponent', pick.opponent);
  add('Engine key risk', pick.key_risk);
  add('Engine reasoning', pick.reasoning);

  return [
    "You are AtomBets' research assistant. The user is looking at one specific PrizePicks prop and wants to dig into it.",
    'Here is everything the engine already knows about this pick:',
    f.join('\n') || '(no structured context was provided)',
    '',
    'Guidance:',
    '- Answer the user\'s question about THIS prop directly and concisely.',
    '- The structured numbers above (recent form, opposing starter, park) are reliable as of this morning. Use web search for anything live or time-sensitive: confirmed lineups, late scratches, injury news, weather, or head-to-head history.',
    '- If a starter you find via search differs from the one listed above, trust the fresher search result and say so.',
    '- Be honest about uncertainty. Give the reasoning, not just a yes/no. Keep it tight — a few sentences unless asked for more.',
    '- This is research for the user\'s own decisions, not financial advice.',
  ].join('\n');
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const pick = payload.pick || {};
  let messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages) {
    if (!payload.question) return { statusCode: 400, headers, body: JSON.stringify({ error: 'provide messages[] or question' }) };
    messages = [{ role: 'user', content: String(payload.question) }];
  }
  // keep only well-formed turns
  messages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12); // cap history length
  if (!messages.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'no valid messages' }) };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystem(pick),
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES }],
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data?.error?.message || 'Anthropic API error', detail: data }) };
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const answer = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const usedSearch = blocks.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');

    return { statusCode: 200, headers, body: JSON.stringify({ answer: answer || '(no answer returned)', usedSearch, stopReason: data.stop_reason || null }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

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
// returns { answer, revisedProb, usedSearch, stopReason }
//
// revisedProb: the model MAY end its answer with a REVISED_PROB marker (see
// buildSystem below) if something in the conversation genuinely changes its read
// on the prop — a confirmed scratch, a lineup change, whatever the user surfaced.
// Parsed out here and stripped from the displayed answer. null when the model's
// view hasn't moved, which is the common case — most questions are informational
// and don't warrant a new number. This NEVER touches the engine's own logged
// prob/verdict (calibration integrity) or the board's sort/edge/slip math — it is
// shown to the user as their own follow-up read, not fed back into the app.

// The dated id, not the `claude-haiku-4-5` alias — same reasoning as VILIFIANT in
// bet-finder-background.js: an id that fails to resolve fails the whole request,
// and the alias has never been exercised here.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const SEARCH_MAX_USES = 3;           // cap searches so a question can't run away on time/cost

// Spend metering (best-effort). Haiku 4.5: $1/$5 per MTok, same table
// bet-finder-background.js prices VILIFIANT at. Web search ~$0.01/search.
// Update if pricing changes.
import { getStore } from '@netlify/blobs';
async function recordCost(feature, apiResponse) {
  try {
    const u = apiResponse?.usage || {};
    const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
    const searches = u.server_tool_use?.web_search_requests || 0;
    const usd = (inTok / 1e6) * 1 + (outTok / 1e6) * 5 + searches * 0.01;
    const store = getStore({ name: 'cost-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const day = new Date().toISOString().slice(0, 10);
    let arr = [];
    try { arr = (await store.get(day, { type: 'json' })) || []; } catch {}
    arr.push({ at: new Date().toISOString(), feature, model: MODEL, inTok, outTok, searches, usd: Math.round(usd * 10000) / 10000 });
    await store.setJSON(day, arr);
  } catch { /* never break the chat */ }
}

// Parses a trailing "REVISED_PROB: 0.62" line off the model's answer, if present.
// A plain regex over free text rather than forcing JSON output, because this
// endpoint also runs web search — tool calls interleave with text blocks, and a
// strict JSON-output contract fights that. Clamped to [0,1]; anything malformed
// is treated as no revision rather than guessed at.
const REVISED_RE = /\n?REVISED_PROB:\s*([\d.]+)\s*$/i;
function extractRevision(answer) {
  const m = REVISED_RE.exec(answer || '');
  if (!m) return { text: answer, revisedProb: null };
  const v = Number(m[1]);
  const revisedProb = isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 1000) / 1000 : null;
  return { text: answer.slice(0, m.index).trim(), revisedProb };
}

// How many of the last 5 games actually cleared THIS line — computed here, not
// left for the model to count.
//
// Same bug class already caught once in bet-finder-background.js: the judge was
// asked to count 5 numbers against a line and got it wrong ("5/5 recent
// cleared" on data that actually cleared 3/5) — arithmetic, not judgment, and a
// cheap model drops it under load. That fix computed `cleared` server-side
// instead of trusting the model's count. This endpoint carries the exact same
// risk with the exact same fix available (recent5 + line are both already in
// the payload) but never got it — buildSystem used to hand over the raw array
// and let the model do the arithmetic itself, live, while ALSO weighing
// whatever count a web search turned up. That is how "cleared 4 of 5" logged
// data produced an answer arguing from "hasn't exceeded five strikeouts in six
// starts" — a real fact, about the wrong number, because nothing anchored the
// model to compute against the 2.5 line actually in play.
function clearedFact(recent5, line) {
  if (!Array.isArray(recent5) || !recent5.length || line == null || !isFinite(Number(line))) return null;
  const n = Number(line);
  const cleared = recent5.filter((v) => isFinite(Number(v)) && Number(v) > n).length;
  return `cleared this exact line (${line}) in ${cleared} of ${recent5.length}`;
}

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
  if (Array.isArray(pick.recent5)) {
    const fact = clearedFact(pick.recent5, pick.line);
    add('Last 5 games', `${pick.recent5.join(', ')} (avg ${pick.recentAvg ?? '—'})`
      + (fact ? ` — ${fact}` : ''));
  }
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
    '- "Last 5 games" already states how many cleared THIS prop\'s line — use that number, don\'t recount it yourself. If you cite a different count from search (a season total, "hasn\'t hit 5+ in six starts", any round number a source framed it around), that is a DIFFERENT question than this line asks. Say explicitly what threshold that count is checking before using it as evidence for or against this specific line.',
    '- Be honest about uncertainty. Give the reasoning, not just a yes/no. Keep it tight — a few sentences unless asked for more.',
    '- This is research for the user\'s own decisions, not financial advice.',
    '',
    'REVISED PROBABILITY. The engine\'s number above is already logged and scored —',
    'you are not correcting it. But if something YOU surfaced in this conversation',
    '(a confirmed scratch, a lineup change, weather, a fact the engine did not have)',
    'genuinely changes your own read on this prop, end your reply with a new line in',
    'exactly this form: REVISED_PROB: 0.62 — your updated P(over), one number, 0 to 1.',
    'Omit that line entirely on every other turn — most questions are informational',
    'and do not warrant a new number. Never include it just because the user asked',
    'for one; only when your own view has actually moved and you can say why.',
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
    recordCost('ask', data).catch(() => {});

    const blocks = Array.isArray(data.content) ? data.content : [];
    const raw = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const { text: answer, revisedProb } = extractRevision(raw);
    const usedSearch = blocks.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');

    return { statusCode: 200, headers, body: JSON.stringify({ answer: answer || '(no answer returned)', revisedProb, usedSearch, stopReason: data.stop_reason || null }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

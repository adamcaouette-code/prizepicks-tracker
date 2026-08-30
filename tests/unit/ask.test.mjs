// Per-pick follow-up chat (/api/ask). Two things worth locking down:
//   1. It runs on Haiku (cheap, matches the "ask haiku" request), not Sonnet.
//   2. A revised probability is opt-in and parsed safely — the model can end
//      its answer with "REVISED_PROB: 0.62" when its own view has genuinely
//      moved, and that's stripped from the displayed text and returned
//      separately. No marker, a malformed one, or an out-of-range one must
//      all read as "no revision", never a guess.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const PICK = {
  player: 'Trea Turner', team: 'PHI', position: 'IF', matchup: 'LAA vs PHI',
  stat: 'Plate Appearances', line: 4.5, verdict: 'play', prob: 0.75, oddsType: 'goblin',
  recent5: [4, 4, 5, 5, 5], recentAvg: 4.6,
};

async function ask(body, answerText, usage = { input_tokens: 500, output_tokens: 80 }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let sentBody = null;
  const mock = mockFetch([
    ['api.anthropic.com', async (_u, init) => {
      sentBody = JSON.parse(init.body);
      return { content: [{ type: 'text', text: answerText }], stop_reason: 'end_turn', usage };
    }],
  ]);
  let res;
  try {
    const { handler } = await loadFn('ask.js');
    res = await handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  } finally { mock.restore(); }
  return { res, sentBody, json: JSON.parse(res.body) };
}

export default async function ({ t }) {
  // ---- runs on Haiku, not Sonnet -------------------------------------------
  const { sentBody } = await ask({ pick: PICK, question: 'is he starting tonight' }, 'Yes, confirmed in the lineup.');
  t.eq('the chat runs on Haiku 4.5 (the dated id, same reasoning as VILIFIANT)',
    sentBody.model, 'claude-haiku-4-5-20251001');
  t.ok('web search is available to the chat', sentBody.tools.some((t) => t.name === 'web_search'));
  t.ok('the pick context reaches the system prompt', sentBody.system.includes('Trea Turner'));
  t.ok('...including the engine\'s own number, framed as already-scored',
    /75% over/.test(sentBody.system) && /already logged and scored/.test(sentBody.system));

  // ---- no marker: no revision, answer passes through untouched -------------
  const plain = await ask({ pick: PICK, question: 'why goblin tier' }, 'Goblin means the line was moved down to make the over easy.');
  t.eq('a plain informational answer has no revision', plain.json.revisedProb, null);
  t.eq('...and the text is unchanged', plain.json.answer, 'Goblin means the line was moved down to make the over easy.');

  // ---- a real revision: parsed out and stripped from the displayed text ----
  const revised = await ask(
    { pick: PICK, question: 'is he still in the lineup, saw a scratch rumor' },
    'Confirmed scratched with a hamstring tweak per the beat writer’s live update — that changes my read here.\nREVISED_PROB: 0.15'
  );
  t.eq('the revised probability is parsed out', revised.json.revisedProb, 0.15);
  t.ok('...and stripped from the displayed answer, not left dangling in the prose',
    !/REVISED_PROB/.test(revised.json.answer));
  t.ok('...leaving the actual explanation intact',
    /scratched/.test(revised.json.answer));

  // ---- malformed or out-of-range markers are refused, not guessed at -------
  const tooHigh = await ask({ pick: PICK, question: 'q' }, 'Something changed.\nREVISED_PROB: 1.4');
  t.eq('a probability above 1 is refused, not clamped or guessed', tooHigh.json.revisedProb, null);

  const negative = await ask({ pick: PICK, question: 'q' }, 'Something changed.\nREVISED_PROB: -0.2');
  t.eq('a negative probability is refused too', negative.json.revisedProb, null);

  // Non-numeric text after the marker means it never matches the expected
  // shape at all — the regex requires digits, so this is not "parsed and
  // rejected", it is "never recognized as a marker in the first place", and
  // the line is left visible rather than silently swallowed.
  const garbled = await ask({ pick: PICK, question: 'q' }, 'Something changed.\nREVISED_PROB: high');
  t.eq('non-numeric text after the marker is refused', garbled.json.revisedProb, null);
  t.ok('...left visible in the answer rather than silently dropped, since it was never recognized as a real marker',
    /REVISED_PROB/.test(garbled.json.answer));

  // ---- cost is metered at Haiku rates, not Sonnet's ------------------------
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, server_tool_use: { web_search_requests: 2 } } })],
  ]);
  try {
    const { handler } = await loadFn('ask.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ pick: PICK, question: 'q' }) });
  } finally { mock.restore(); }
  await new Promise((r) => setTimeout(r, 0));   // recordCost is fire-and-forget
  const today = new Date().toISOString().slice(0, 10);
  const cost = (read('cost-log', today) || []).find((c) => c.feature === 'ask');
  t.ok('spend is metered for the ask feature', !!cost);
  t.eq('at Haiku rates — $1 in + $5 out per 1M tokens + $0.01/search = $6.02 here, not Sonnet’s $12.02',
    cost?.usd, 6.02);
}

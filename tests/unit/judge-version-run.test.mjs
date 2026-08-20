// The judge version, end to end through a real bet-finder run.
//
// judge-prompts.test.mjs checks the two versions in isolation. This checks the
// wiring, which is where a versioning scheme usually dies: the prompt is
// selected but the payload is built the old way, or the run works and nothing
// records which version produced it — leaving a log that mixes two forecasters
// and a calibration curve that describes neither.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const props = (rows) => ({
  data: rows.map((r, i) => ({
    id: `pp-${i}`, type: 'projection',
    attributes: { stat_type: r.stat || 'Hits', stat_display_name: r.stat || 'Hits', line_score: r.line,
      odds_type: r.tier || 'standard', description: r.opp || 'OPP',
      start_time: new Date().toISOString(), today: true },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team, position: 'OF', market: r.team } })),
  meta: { total_pages: 1 },
});

// One goblin and one standard, so the tier the judge is (or is not) told about
// is actually distinguishable in the payload.
const ROWS = [
  { player: 'Goblin Guy',   team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' },
  { player: 'Standard Guy', team: 'PIT', line: 1.5, opp: 'CIN', tier: 'standard' },
];
// The judge no longer returns a verdict — Aphrodite does not ask for one and the
// code derives it. This mock therefore omits it, which also proves the pipeline
// does not depend on the model supplying one.
const PICKS = [
  { player: 'Goblin Guy',   stat: 'Hits', line: 0.5, prob: 0.77, cleared: 4, key_risk: 'none', reasoning: 'r' },
  { player: 'Standard Guy', stat: 'Hits', line: 1.5, prob: 0.58, cleared: 3, key_risk: 'none', reasoning: 'r' },
];

async function run(body = {}) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: {} })],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'jv', league: 'mlb', legs: 2, ...body }) });
  } finally { mock.restore(); }
  const call = mock.calls.find((c) => c.url.includes('api.anthropic.com'));
  const sent = call ? JSON.parse(call.init.body) : null;
  return {
    sentModel: sent?.model,
    result: read('bet-jobs', 'jv')?.result || {},
    log: read('pick-log', new Date().toISOString().slice(0, 10)) || [],
    system: sent?.system || '',
    payload: sent?.messages?.[0]?.content || '',
  };
}

export default async function ({ t }) {
  const saved = process.env.JUDGE_PROMPT;
  delete process.env.JUDGE_PROMPT;

  // ---- default: aphrodite -------------------------------------------------
  const aph = await run();
  t.ok('the default run sends the Aphrodite prompt', /You are a forecaster/.test(aph.system));
  t.ok('...which is not the Psyche prompt',
    !/sports-betting research assistant/.test(aph.system));

  // THE payload change: the model is told the payout tier, because the tier is
  // PrizePicks' own price and the prompt reasons about it explicitly.
  const sent = JSON.parse(aph.payload.slice(aph.payload.indexOf('{')));
  const entries = Object.values(sent).flat();
  t.eq('every prop reaches the model with its tier',
    entries.map((e) => `${e.player}:${e.tier}`).sort(),
    ['Goblin Guy:goblin', 'Standard Guy:standard']);

  // ---- the tag, which is what makes the change measurable -----------------
  t.eq('the run records which judge produced it', aph.result.params.prompt, 'aphrodite');
  t.eq('every logged pick is tagged with the judge version',
    [...new Set(aph.log.map((p) => p.promptVersion))], ['aphrodite']);
  t.eq('...and keeps the count the judge anchored on',
    aph.log.map((p) => p.cleared).sort(), [3, 4]);

  // Verdict is derived from the probability, not read from the model — the mock
  // never sent one.
  const byName = (l, n) => l.find((p) => p.player === n);
  t.eq('a 0.77 is a play', byName(aph.log, 'Goblin Guy').verdict, 'play');
  t.eq('a 0.58 is a lean', byName(aph.log, 'Standard Guy').verdict, 'lean');

  // ---- the model is a measured dimension too ------------------------------
  // Same discipline as the prompt version: switchable, and recorded on every
  // pick. Opus is the default because it always has been, not because anything
  // cheaper was tried and lost — and at 2.5-5x less per run, a cheaper model
  // that scores the same buys several times more graded data on a fixed budget.
  t.eq('the default model is Opus', aph.sentModel, 'claude-opus-4-8');
  t.eq('every logged pick records the model that produced it',
    [...new Set(aph.log.map((p) => p.judgeModel))], ['claude-opus-4-8']);

  const cheap = await run({ model: 'claude-haiku-4-5' });
  t.eq('a cheaper model is actually used', cheap.sentModel, 'claude-haiku-4-5');
  t.eq('...and recorded, so the two can be scored apart',
    [...new Set(cheap.log.map((p) => p.judgeModel))], ['claude-haiku-4-5']);

  // An unpriced model would meter as Opus and misreport the bill, which is the
  // one thing a budget tool must never do — so the price table is the allowlist.
  const bogus = await run({ model: 'gpt-9-turbo' });
  t.eq('an unknown model falls back rather than reaching the API',
    bogus.sentModel, 'claude-opus-4-8');

  // ---- psyche is still reachable, unchanged -------------------------------
  const psy = await run({ prompt: 'psyche' });
  t.ok('asking for psyche sends the original prompt',
    /sports-betting research assistant/.test(psy.system));
  t.ok('...and it still asks for a verdict, as it always did',
    /"verdict":"play\|lean\|pass"/.test(psy.system));
  const psySent = JSON.parse(psy.payload.slice(psy.payload.indexOf('{')));
  t.eq('psyche is not told the tier — it never was',
    Object.values(psySent).flat().every((e) => e.tier === undefined), true);
  t.eq('psyche picks are tagged as psyche', [...new Set(psy.log.map((p) => p.promptVersion))], ['psyche']);

  // Same slate, same judged numbers, so the boards must match. Anything else
  // means a version is changing something other than the ask.
  t.eq('the two versions produce the same board from the same answers',
    psy.result.board.map((p) => `${p.player}|${p.side}|${p.sideProb}`).sort(),
    aph.result.board.map((p) => `${p.player}|${p.side}|${p.sideProb}`).sort());

  // ---- the projectionId collision, fixed in the log too -------------------
  t.eq('each logged pick carries the id of its OWN line',
    aph.log.map((p) => p.projectionId).sort(), ['pp-0', 'pp-1']);

  if (saved == null) delete process.env.JUDGE_PROMPT; else process.env.JUDGE_PROMPT = saved;
}

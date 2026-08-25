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
// TWO games. The search-budget test needs them: one matchup whose lineup gets
// posted and one whose does not, so "a search per game" and "a search only where
// the lineup is unknown" give different answers.
const ROWS = [
  { player: 'Goblin Guy',   team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' },
  { player: 'Standard Guy', team: 'PIT', line: 1.5, opp: 'CIN', tier: 'standard' },
  { player: 'Late Slate Guy', team: 'LAD', line: 1.5, opp: 'SFG', tier: 'goblin' },
];
// The judge no longer returns a verdict — Aphrodite does not ask for one and the
// code derives it. This mock therefore omits it, which also proves the pipeline
// does not depend on the model supplying one.
const PICKS = [
  { player: 'Goblin Guy',   stat: 'Hits', line: 0.5, prob: 0.77, cleared: 4, key_risk: 'none', reasoning: 'r' },
  { player: 'Standard Guy', stat: 'Hits', line: 1.5, prob: 0.58, cleared: 3, key_risk: 'none', reasoning: 'r' },
  { player: 'Late Slate Guy', stat: 'Hits', line: 1.5, prob: 0.66, cleared: 2, key_risk: 'none', reasoning: 'r' },
];

// A posted MLB lineup for both teams, shaped exactly as the schedule endpoint
// hydrates it. This is what turns "not voided" into "checked and confirmed" —
// and therefore what makes a web search for that game redundant.
const SCHEDULE = {
  dates: [{ games: [{
    gamePk: 1, teams: {
      home: { team: { id: 1, name: 'Reds', abbreviation: 'CIN' },
        probablePitcher: { id: 9, fullName: 'Some Starter' } },
      away: { team: { id: 2, name: 'Pirates', abbreviation: 'PIT' },
        probablePitcher: { id: 8, fullName: 'Other Starter' } },
    },
    lineups: {
      homePlayers: [{ id: 11, fullName: 'Goblin Guy' }],
      awayPlayers: [{ id: 12, fullName: 'Standard Guy' }],
    },
  }] }],
};

async function run(body = {}, { lineups = false } = {}) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    ['statsapi.mlb.com/api/v1/schedule', async () => (lineups ? SCHEDULE : {})],
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
    maxSearches: sent?.tools?.[0]?.max_uses,
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
    ['Goblin Guy:goblin', 'Late Slate Guy:goblin', 'Standard Guy:standard']);

  // ---- the tag, which is what makes the change measurable -----------------
  t.eq('the run records which judge produced it', aph.result.params.prompt, 'aphrodite');
  t.eq('every logged pick is tagged with the judge version',
    [...new Set(aph.log.map((p) => p.promptVersion))], ['aphrodite']);
  t.eq('...and keeps the count the judge anchored on',
    aph.log.map((p) => p.cleared).sort(), [2, 3, 4]);

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
  // Vilifiant (Haiku) is the default. The DATED id, not the alias: an id that
  // fails to resolve fails the entire run, and the alias has never been
  // exercised against the real API here.
  t.eq('the default model is Vilifiant', aph.sentModel, 'claude-haiku-4-5-20251001');
  t.eq('every logged pick records the model that produced it',
    [...new Set(aph.log.map((p) => p.judgeModel))], ['claude-haiku-4-5-20251001']);

  const dear = await run({ model: 'claude-opus-4-8' });
  t.eq('the expensive model is still reachable', dear.sentModel, 'claude-opus-4-8');
  t.eq('...and recorded, so the two can be scored apart',
    [...new Set(dear.log.map((p) => p.judgeModel))], ['claude-opus-4-8']);

  // An unpriced model would meter at the wrong rate and misreport the bill,
  // which is the one thing a budget tool must never do — so the price table is
  // the allowlist, and both Haiku ids are in it.
  const bogus = await run({ model: 'gpt-9-turbo' });
  t.eq('an unknown model falls back rather than reaching the API',
    bogus.sentModel, 'claude-haiku-4-5-20251001');
  t.eq('the alias is priced too, so an explicit one still meters right',
    (await run({ model: 'claude-haiku-4-5' })).sentModel, 'claude-haiku-4-5');

  // ---- searches are bought only where the lineup is still unknown ---------
  // Web searches are 80% of what a run costs: a measured run read 98k input
  // tokens against 5.5k written, driven by ~6 searches whose stated job is
  // confirming lineups. Where the official feed already posted the lineup that
  // work is done — and every candidate that FAILED the check was voided before
  // the judge ever saw the list, so a confirmed player is in the posted lineup,
  // not merely probable.
  t.eq('a slate with no confirmed lineups keeps a search per game',
    aph.maxSearches, 2);   // two matchups in the fixture, neither confirmed

  const withLineups = await run({}, { lineups: true });
  t.eq('...and one confirmed game means one fewer search bought',
    withLineups.maxSearches, 1);
  const conf = Object.values(JSON.parse(withLineups.payload.slice(withLineups.payload.indexOf('{')))).flat();
  t.eq('the judge is told exactly which players were already confirmed',
    conf.filter((e) => e.lineupConfirmed).map((e) => e.player).sort(),
    ['Goblin Guy', 'Standard Guy']);
  t.eq('...and the game with no posted lineup is NOT marked, so it keeps its search',
    conf.find((e) => e.player === 'Late Slate Guy').lineupConfirmed, undefined);
  t.ok('...and Aphrodite tells it not to spend a search on those',
    /Do not spend a search confirming one/.test(withLineups.system));

  // The floor of 1 is deliberate. Lineups are not the only thing a search finds
  // — a late scratch, weather, a bullpen game — so dropping to zero would change
  // what the judge can KNOW rather than only what it costs.
  t.ok('the budget never reaches zero', withLineups.maxSearches >= 1);

  // Kept switchable so the saving is measured against the old behaviour rather
  // than assumed to be free.
  const always = await run({ searchPolicy: 'always' }, { lineups: true });
  t.eq('searchPolicy=always restores a search for every game', always.maxSearches, 2);

  // ---- two configs on one slate must both survive -------------------------
  // The whole point of naming the versions is running them against each other,
  // and the cleanest comparison is the SAME slate — different nights differ more
  // than the prompts do. That only works if the log keeps both.
  //
  // It nearly did not. A logged pick's identity was source + projectionId, so a
  // second run over the same props overwrote the first: same projection, same
  // source, last write wins. The experiment would have quietly ended up with
  // half of itself in the log and no error anywhere.
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  {
    const { handler } = await loadFn('bet-finder-background.js');
    const post = async (body) => {
      const mock = mockFetch([
        ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
        [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
        ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: {} })],
      ]);
      try { await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'ab', league: 'mlb', legs: 2, ...body }) }); }
      finally { mock.restore(); }
    };
    await post({ model: 'claude-opus-4-8' });
    await post({ model: 'claude-haiku-4-5-20251001' });
    const log = read('pick-log', new Date().toISOString().slice(0, 10)) || [];
    t.eq('both judge configs survive a shared slate', log.length, PICKS.length * 2);
    t.eq('...tagged apart, so calibration can score them separately',
      [...new Set(log.map((p) => p.judgeModel))].sort(),
      ['claude-haiku-4-5-20251001', 'claude-opus-4-8']);

    // Re-running the SAME config must still dedupe — that was the original
    // reason for merging rather than appending, and it has to keep working.
    await post({ model: 'claude-opus-4-8' });
    const again = read('pick-log', new Date().toISOString().slice(0, 10)) || [];
    t.eq('...but re-running one config does not duplicate it', again.length, PICKS.length * 2);
  }

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
  // The side is logged, not just P(over). Without it nothing downstream can tell
  // a weak over from a strong under — Today's Ledger rendered a blank direction
  // for exactly this reason, and a slip cannot be built from a leg whose
  // direction is unknown.
  t.eq('the recommended side is recorded',
    [...new Set(aph.log.map((p) => p.side))].sort(), ['over']);
  t.ok('...with the probability of THAT side',
    aph.log.every((p) => p.sideProb != null));
  t.ok('...while prob stays P(over) for calibration',
    aph.log.every((p) => p.prob === p.sideProb));   // all overs here, so they agree

  t.eq('each logged pick carries the id of its OWN line',
    aph.log.map((p) => p.projectionId).sort(), ['pp-0', 'pp-1', 'pp-2']);

  if (saved == null) delete process.env.JUDGE_PROMPT; else process.env.JUDGE_PROMPT = saved;
}

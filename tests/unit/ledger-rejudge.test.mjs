// Re-judging today's ledger.
//
// The point of the feature is TIME, not a different judge: a morning run scores
// props before lineups are posted, so the evening re-run sees confirmed starters
// and scratches. That only holds if three things are true, and each has a
// plausible way of quietly not being true:
//
//   1. the re-judge covers the props on the ledger and nothing else — otherwise
//      it is a full board scan wearing a cheaper name, at full price;
//   2. it covers ALL of them, including the ones a per-game cap would drop
//      (fairProb is a per-tier constant, so a truncation drops by TIER, which
//      would silently make every re-judge goblin-heavy);
//   3. the new judgment lands beside the original rather than over it, so the
//      two stay scoreable against each other.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

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

// Five props in ONE game — deliberately more than the per-game cap of 4 that a
// normal board run applies. Plus a sixth in another game that is NOT on the
// ledger, to prove the filter is doing something.
const ROWS = [
  { player: 'Ledger One',   team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' },
  { player: 'Ledger Two',   team: 'CIN', line: 1.5, opp: 'PIT', tier: 'standard' },
  { player: 'Ledger Three', team: 'PIT', line: 2.5, opp: 'CIN', tier: 'demon' },
  { player: 'Ledger Four',  team: 'PIT', line: 0.5, opp: 'CIN', tier: 'standard' },
  { player: 'Ledger Five',  team: 'PIT', line: 1.5, opp: 'CIN', tier: 'goblin' },
  { player: 'Off Ledger',   team: 'LAD', line: 1.5, opp: 'SFG', tier: 'goblin' },
];

// The judge answers for whatever it is asked about; the mock echoes the request
// so a candidate that never reaches the model simply never comes back.
const answer = async (init) => {
  const body = JSON.parse(init.body);
  const payload = String(body.messages[0].content);
  const sent = JSON.parse(payload.slice(payload.indexOf('{')));
  const picks = Object.values(sent).flat().map((e) => ({
    player: e.player, stat: e.stat, line: e.line, prob: 0.62, cleared: 3, key_risk: 'none', reasoning: 'r',
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {} };
};

async function run(body, { ledger = null } = {}) {
  reset();
  if (ledger) seed('pick-log', TODAY, ledger);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (url, init) => answer(init)],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST',
      body: JSON.stringify({ jobId: 'lj', league: 'mlb', legs: 3, tiers: ['goblin', 'standard', 'demon'], ...body }) });
  } finally { mock.restore(); }
  return { result: read('bet-jobs', 'lj')?.result || {}, log: read('pick-log', TODAY) || [] };
}

// A logged pick as the morning run wrote it.
const logged = (player, line, extra = {}) => ({
  date: TODAY, loggedAt: '2026-08-25T13:00:00.000Z', league: 'mlb', projectionId: null,
  player, stat: 'Hits', line, prob: 0.71, verdict: 'play', oddsType: 'standard',
  result: null, hit: null, gradedAt: null, ...extra,
});

export default async function ({ t }) {
  const LEDGER = [
    logged('Ledger One', 0.5), logged('Ledger Two', 1.5), logged('Ledger Three', 2.5),
    logged('Ledger Four', 0.5), logged('Ledger Five', 1.5),
  ];

  // ---- 1 + 2: exactly the ledger, all of it -------------------------------
  const re = await run({ fromLedger: true }, { ledger: LEDGER });
  t.eq('a ledger re-judge covers every prop on the ledger',
    re.result.board.map((p) => p.player).sort(),
    ['Ledger Five', 'Ledger Four', 'Ledger One', 'Ledger Three', 'Ledger Two']);
  t.ok('...and nothing that is not on it',
    !re.result.board.some((p) => p.player === 'Off Ledger'));
  // Five props in one game is past the normal per-game cap of 4. If the cap
  // applied, the demon would be the one dropped.
  t.ok('the per-game cap does not truncate a re-judge',
    re.result.board.some((p) => p.player === 'Ledger Three'));

  // ---- 3: a second forecast, not an overwrite -----------------------------
  const rejudged = re.log.filter((p) => p.source === 'ledger');
  t.eq('every re-judged pick is tagged as coming from the ledger', rejudged.length, 5);
  t.ok('the morning judgments all survive',
    LEDGER.every((m) => re.log.some((p) => p.player === m.player && p.source === undefined)));
  t.eq('so the same prop now carries two forecasts',
    re.log.filter((p) => p.player === 'Ledger One').length, 2);
  t.ok('...which differ, or there was nothing to re-judge',
    re.log.find((p) => p.player === 'Ledger One' && p.source === 'ledger').prob !== 0.71);

  // ---- the filter mirrors what the ledger tab actually shows ---------------
  // /api/top-picks serves the tab with verdict=play,lean and drops graded rows.
  // A re-judge that ignored either would be spending searches on rows nobody is
  // looking at — a settled game cannot be re-forecast at all.
  const MIXED = [
    logged('Ledger One', 0.5),
    logged('Ledger Two', 1.5, { verdict: 'fade', prob: 0.31 }),
    logged('Ledger Three', 2.5, { hit: true, result: 3, gradedAt: '2026-08-25T22:00:00.000Z' }),
    logged('Ledger Four', 0.5, { league: 'wnba' }),
  ];
  const mixed = await run({ fromLedger: true }, { ledger: MIXED });
  t.eq('a re-judge skips fades, settled picks and other leagues',
    mixed.result.board.map((p) => p.player), ['Ledger One']);

  // ---- an empty ledger is not an invitation to scan the board -------------
  const empty = await run({ fromLedger: true }, { ledger: [] });
  t.eq('an empty ledger re-judges nothing', empty.result.board.length, 0);
  t.ok('...and says why in words that fit what happened',
    /ledger is empty/i.test(empty.result.parlay?.error || ''));

  // ---- and the ordinary run is untouched ----------------------------------
  const board = await run({}, { ledger: LEDGER });
  t.ok('an ordinary run still scans the whole board',
    board.result.board.some((p) => p.player === 'Off Ledger'));
  t.ok('...and is not tagged as a re-judge',
    !board.log.some((p) => p.source === 'ledger'));
}

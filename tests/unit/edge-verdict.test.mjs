// The edge guardrail: a verdict may never call a known-losing bet a play.
//
// sideVerdictFor is a flat probability cutoff (0.62 / 0.54) applied to three
// tiers that need 79.4% / 59.5% / 43.7% to break even. So "play" fires 17.4
// points too early on a goblin and 18.3 points too late on a demon, and the
// board could render "Play" and "-11.4pp" on the same card.
//
// Measured over 2,874 graded over-side picks (2026-06-20 -> 08-28), what the
// engine recommended as play/lean:
//   goblin   n=1269 (80% of all recommendations)  hit 66.9% vs 79.4% needed  -12.5pp  9.4 sigma
//   standard n= 231                               hit 43.7% vs 59.5% needed  -15.8pp  4.8 sigma
//   demon    n=  89                               hit 29.2% vs 43.7% needed  -14.5pp  3.0 sigma
// Volume-weighted: -45% per dollar, stable across all three months.
//
// What is guarded here is ONLY the negative side of that — refusing to call a
// known-losing bet a play. Where the positive threshold should sit is a
// separate question resting on far less data, and is deliberately not answered.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const BE = { goblin: 2 ** (-1 / 3), standard: 4.75 ** (-1 / 3), demon: 12 ** (-1 / 3) };

const props = (rows) => ({
  data: rows.map((r, i) => ({
    id: `pp-${i}`, type: 'projection',
    attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: r.line,
      odds_type: r.tier, description: r.opp, allowed_wager_types: 'over',
      start_time: new Date().toISOString(), today: true },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team, position: 'OF', market: r.team } })),
  meta: { total_pages: 1 },
});

// One prop per tier, each at a probability the OLD rule calls a "play" (>=0.62).
// Only the standard one actually clears its own break-even.
const ROWS = [
  { player: 'Doomed Goblin', team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' },    // 0.65 vs 79.4% needed
  { player: 'Good Standard', team: 'PIT', line: 1.5, opp: 'CIN', tier: 'standard' },  // 0.65 vs 59.5% needed
  { player: 'Fine Demon',    team: 'LAD', line: 2.5, opp: 'SFG', tier: 'demon' },     // 0.65 vs 43.7% needed
];
const PROB = { 'Doomed Goblin': 0.65, 'Good Standard': 0.65, 'Fine Demon': 0.65 };

const answer = async (init) => {
  const payload = String(JSON.parse(init.body).messages[0].content);
  const sent = JSON.parse(payload.slice(payload.indexOf('{')));
  const picks = Object.values(sent).flat().map((e) => ({
    player: e.player, stat: e.stat, line: e.line, prob: PROB[e.player] ?? 0.5,
    key_risk: 'k', reasoning: 'r',
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {} };
};

async function run() {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => answer(init)],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({
      jobId: 'ev', league: 'mlb', legs: 3, tiers: ['goblin', 'standard', 'demon'] }) });
  } finally { mock.restore(); }
  const day = new Date().toISOString().slice(0, 10);
  return { result: read('bet-jobs', 'ev')?.result || {}, log: read('pick-log', day) || [] };
}

export default async function ({ t }) {
  const { edgeVerdictFor } = await loadFn('bet-finder-background.js');

  // ---- the rule itself ----------------------------------------------------
  t.eq('a negative edge can never be a play', edgeVerdictFor('play', -0.001), 'pass');
  t.eq('...nor a lean', edgeVerdictFor('lean', -0.12), 'pass');
  t.eq('a positive edge is left exactly as the probability called it',
    edgeVerdictFor('play', 0.05), 'play');
  t.eq('...including a lean', edgeVerdictFor('lean', 0.01), 'lean');
  t.eq('exactly break-even is not negative, so it is not demoted',
    edgeVerdictFor('play', 0), 'play');
  // An unpriced side (goblin/demon under) has no known payout. Demoting it
  // would assert it is bad, which is exactly as unfounded as calling it good.
  t.eq('an unpriced side is left alone rather than guessed at',
    edgeVerdictFor('play', null), 'play');
  t.eq('...and a non-finite edge is treated the same way',
    edgeVerdictFor('play', NaN), 'play');
  t.eq('a pass stays a pass', edgeVerdictFor('pass', 0.2), 'pass');

  // ---- end to end through a real run --------------------------------------
  const { result, log } = await run();
  const board = Object.fromEntries((result.board || []).map((p) => [p.player, p]));

  // All three are 0.65, which the OLD flat cutoff called a play across the board.
  t.eq('all three still carry the raw probability verdict they always did',
    ['Doomed Goblin', 'Good Standard', 'Fine Demon'].map((n) => board[n]?.sideVerdict),
    ['play', 'play', 'play']);

  t.eq('a goblin at 65% needing 79.4% is no longer called a play',
    board['Doomed Goblin'].edgeVerdict, 'pass');
  t.ok('...because its own edge is negative, and the card says so',
    board['Doomed Goblin'].edge < 0, String(board['Doomed Goblin'].edge));
  t.eq('a standard at 65% needing 59.5% still is one',
    board['Good Standard'].edgeVerdict, 'play');
  t.eq('a demon at 65% needing 43.7% still is one',
    board['Fine Demon'].edgeVerdict, 'play');

  // The board still SHOWS all three — browsing stays as wide as it was, only
  // the claim narrows. This is the half that keeps the app usable.
  t.eq('the board still lists every pick, including the demoted one',
    (result.board || []).length, 3);

  // ---- the slip the app builds FOR you ------------------------------------
  // This is the surface where a bad recommendation costs money.
  const legs = (result.parlayLegs || []).map((l) => l.player);
  t.ok('the auto-built slip refuses the negative-edge leg', !legs.includes('Doomed Goblin'), legs.join(', '));
  t.ok('...while still taking the two that clear their break-even',
    legs.includes('Good Standard') && legs.includes('Fine Demon'), legs.join(', '));
  t.ok('...and says it could not fill the 3 legs asked for, rather than padding',
    (result.parlayNote?.built ?? 0) < 3, JSON.stringify(result.parlayNote));

  // ---- the log keeps both, so calibration history stays comparable --------
  const logged = Object.fromEntries(log.map((p) => [p.player, p]));
  t.eq('the pick log still records the raw probability verdict unchanged',
    logged['Doomed Goblin'].verdict, 'play');
  t.eq('...and the guarded one beside it, not instead of it',
    logged['Doomed Goblin'].edgeVerdict, 'pass');
  t.eq('a genuinely positive pick logs the same value in both',
    [logged['Good Standard'].verdict, logged['Good Standard'].edgeVerdict], ['play', 'play']);
}

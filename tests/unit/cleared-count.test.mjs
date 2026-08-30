// The judge is told to COUNT how many of the last 5 games cleared the line and
// anchor its probability on that count (see the "ANCHOR ON A COUNT" section of
// judge-prompts.js) — the whole point being a real number instead of a vibe.
// Caught live: for a 4.5-line prop with recent5 [4,4,5,5,5] (3 clear), the model
// wrote "5/5 recent cleared" in its own reasoning and built its probability off
// that wrong count.
//
// Trusting an LLM to do arithmetic on 5 numbers when the code already has those
// same 5 numbers is unnecessary risk. The logged `cleared` field is now always
// recomputed from the pick's own recent5 + line — ground truth, not a claim —
// and the model's original number is kept separately as judgeClearedClaim so
// disagreement is measurable instead of silently overwritten.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

export default async function ({ t }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { handler } = await loadFn('bet-finder-background.js');

  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => ({
      data: [{ id: '2', type: 'league', attributes: { name: 'MLB', projections_count: 1 } }] })],
    ['partner-api.prizepicks.com/projections', async () => ({
      data: [{ id: 'pp1', type: 'projection', attributes: { stat_type: 'Plate Appearances', stat_display_name: 'PA',
        line_score: 4.5, odds_type: 'goblin', description: 'LAA', start_time: new Date().toISOString(), today: true },
        relationships: { new_player: { data: { id: 'n1' } } } }],
      included: [{ id: 'n1', type: 'new_player', attributes: { display_name: 'Trea Turner', team: 'PHI', position: 'IF', market: 'PHI' } }],
      meta: { total_pages: 1 } })],
    // The real last-5 that triggered this: two 4s (don't clear a 4.5 line),
    // three 5s (do). 3 of 5 clear, average 4.6 — matching what PrizePicks'
    // own app showed for this exact player and stat.
    ['/history', async () => ({ games: [
      { stat_value: 4, opponent_abbreviation: 'SEA', is_away: true },
      { stat_value: 4, opponent_abbreviation: 'SEA', is_away: true },
      { stat_value: 5, opponent_abbreviation: 'SEA', is_away: true },
      { stat_value: 5, opponent_abbreviation: 'LAA', is_away: false },
      { stat_value: 5, opponent_abbreviation: 'LAA', is_away: false },
    ] })],
    ['statsapi.mlb.com/api/v1/teams?sportId=1', async () => ({ teams: [] })],
    ['statsapi.mlb.com/api/v1/schedule', async () => ({ dates: [] })],
    [/statsapi\.mlb\.com.*roster/, async () => ({ roster: [] })],
    [/espn|the-odds-api/, async () => ({})],
    // The model's own miscounted claim — this is what actually happened live.
    ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: JSON.stringify({ picks: [
      { player: 'Trea Turner', stat: 'Plate Appearances', line: 4.5, verdict: 'play', prob: 0.75,
        cleared: 5, key_risk: 'k', reasoning: '5/5 recent cleared, recentAvg 4.6. Elite recent form.' },
    ] }) }], usage: {} }) ],
  ]);

  try {
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'cc1', league: 'mlb', legs: 2 }) });
  } finally { mock.restore(); }

  const job = read('bet-jobs', 'cc1');
  const boardPick = (job?.result?.board || []).find((p) => p.player === 'Trea Turner');
  t.ok('the pick reached the board', !!boardPick, JSON.stringify(job?.result?.board));
  // The board object itself still carries whatever the model said — only the
  // LOGGED (pick-log) copy is corrected, which is what the UI's own inline
  // mismatch warning compares against.
  t.eq('the board pick still carries the raw recent5 the model was given',
    boardPick?.recent5, [4, 4, 5, 5, 5]);

  const today = new Date().toISOString().slice(0, 10);
  const logged = read('pick-log', today) || [];
  const row = logged.find((p) => p.player === 'Trea Turner');
  t.ok('the pick was logged', !!row);
  t.eq('cleared is recomputed as ground truth (3 of 5 clear a 4.5 line), not the model’s claim of 5',
    row?.cleared, 3);
  t.eq('the model’s original (wrong) claim is preserved separately, not lost',
    row?.judgeClearedClaim, 5);

  // ---- when recent5 is absent, both fields must stay null, not guess ------
  reset();
  const mock2 = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => ({
      data: [{ id: '2', type: 'league', attributes: { name: 'MLB', projections_count: 1 } }] })],
    ['partner-api.prizepicks.com/projections', async () => ({
      data: [{ id: 'pp2', type: 'projection', attributes: { stat_type: 'Hits', stat_display_name: 'Hits',
        line_score: 0.5, odds_type: 'goblin', description: 'LAA', start_time: new Date().toISOString(), today: true },
        relationships: { new_player: { data: { id: 'n2' } } } }],
      included: [{ id: 'n2', type: 'new_player', attributes: { display_name: 'No History Guy', team: 'PHI', position: 'IF', market: 'PHI' } }],
      meta: { total_pages: 1 } })],
    ['/history', async () => ({ games: [] })],   // no history available
    ['statsapi.mlb.com/api/v1/teams?sportId=1', async () => ({ teams: [] })],
    ['statsapi.mlb.com/api/v1/schedule', async () => ({ dates: [] })],
    [/statsapi\.mlb\.com.*roster/, async () => ({ roster: [] })],
    [/espn|the-odds-api/, async () => ({})],
    ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: JSON.stringify({ picks: [
      { player: 'No History Guy', stat: 'Hits', line: 0.5, verdict: 'lean', prob: 0.58,
        cleared: null, key_risk: 'k', reasoning: 'No recent5 available; leaning on tier.' },
    ] }) }], usage: {} }) ],
  ]);
  try {
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'cc2', league: 'mlb', legs: 2 }) });
  } finally { mock2.restore(); }
  const logged2 = read('pick-log', today) || [];
  const row2 = logged2.find((p) => p.player === 'No History Guy');
  t.eq('no recent5 -> cleared stays null, never a guessed 0', row2?.cleared, null);
  t.eq('...and the claim field stays null too, since the judge correctly reported null',
    row2?.judgeClearedClaim, null);
}

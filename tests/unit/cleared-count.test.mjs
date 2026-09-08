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
  let sentPayload = '', sentSystem = '';
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
    ['api.anthropic.com', async (_u, init) => {
      sentPayload = String(JSON.parse(init.body).messages[0].content);
      sentSystem = String(JSON.parse(init.body).system || '');
      return { content: [{ type: 'text', text: JSON.stringify({ picks: [
        { player: 'Trea Turner', stat: 'Plate Appearances', line: 4.5, verdict: 'play', prob: 0.75,
          cleared: 5, key_risk: 'k', reasoning: '5/5 recent cleared, recentAvg 4.6. Elite recent form.' },
      ] }) }], usage: {} };
    }],
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

  // ---- the count is SENT, not asked for -----------------------------------
  // The app knew the answer when it built the payload and didn't put it in. It
  // recomputed it afterwards to CHECK the model — catching the error one step
  // after it had already priced the bet.
  //
  // Measured on one live board, 74 picks carrying both numbers: the model
  // agreed 35 times (47%), and where it disagreed it OVERCOUNTED 34 times to 5
  // undercounts. The prompt says to START THE PROBABILITY FROM THAT COUNT, so
  // an inflated count anchored high, in the over's favour, on half the board.
  t.ok('the judge is handed the count as a fact',
    /"cleared":\s*3/.test(sentPayload), sentPayload.slice(0, 400));
  t.ok('...with the denominator beside it, so "3" is never read as "3 of 3"',
    /"clearedOf":\s*5/.test(sentPayload), sentPayload.slice(0, 400));
  t.ok('...and the raw array too, so the reasoning can still cite the games',
    /"recent5":\s*\[4,4,5,5,5\]/.test(sentPayload.replace(/\s/g, '')), '');

  // The prompt must stop asking for arithmetic it has been given, and must say
  // which way a push falls — "5 or more" is not "over 5", and reading it that
  // way overstates the count on every whole-number line.
  const jp = await loadFn('judge-prompts.js');
  for (const v of ['aphrodite', 'themis', 'psyche']) {
    const prompt = jp.promptSet(v).promptFor('mlb');
    t.ok(`${v}: told to use the supplied count rather than recount`,
      /(USE IT|Use that number rather than counting)/.test(prompt), '');
    t.ok(`${v}: told that landing exactly on the line is a push, not a clear`,
      /(STRICTLY ABOVE|strictly above)/i.test(prompt) && /push/i.test(prompt), '');
  }
  t.ok('the old "COUNT it yourself" instruction is gone',
    !/first COUNT how many of the five/.test(jp.promptSet('aphrodite').promptFor('mlb')), '');

  // ---- one definition, not three -----------------------------------------
  // This arithmetic lived in three places: ask.js for the chat, bet-finder for
  // the log, and the judge's own head. Duplicated arithmetic drifts and the
  // flattering copy is the one nobody questions — see one-source-of-truth.
  const { clearedCount } = await loadFn('top-picks.js');
  t.eq('a push does not count as a clear', clearedCount([5, 5, 6, 3, 2], 5), 1);
  t.eq('...which is exactly the Bibee case that read as 3', clearedCount([3, 4, 4, 5, 6], 5), 1);
  t.eq('the same values against a half-point line', clearedCount([3, 4, 4, 5, 6], 4.5), 2);
  t.eq('...and a lower one', clearedCount([3, 4, 4, 5, 6], 3.5), 4);
  t.eq('no form is null, never 0 — "no data" and "never cleared" are opposite facts',
    clearedCount([], 4.5), null);
  t.eq('...and so is a missing line', clearedCount([1, 2, 3], null), null);
  t.eq('non-numeric junk is skipped rather than counted', clearedCount([5, null, 'x', 7], 4.5), 2);

  // ---- and it is measured, which it never was ----------------------------
  // Both numbers have been logged since the mismatch was first noticed,
  // expressly so disagreement would be "measurable rather than silently
  // overwritten". Nothing ever measured it — clearedShare is coverage, not
  // agreement — so a 47% arithmetic failure sat in the log unnoticed.
  {
    const { reset, seed } = await import('../helpers/blobs.mjs');
    reset();
    const D = new Date().toISOString().slice(0, 10);
    const row = (claimed, truth, i) => ({
      date: D, loggedAt: `${D}T18:00:00Z`, league: 'mlb', player: `P${i}`, stat: 'Hits', line: 4.5,
      prob: 0.6, verdict: 'play', oddsType: 'standard', promptVersion: 'aphrodite', judgeModel: 'Vilifiant',
      cleared: truth, judgeClearedClaim: claimed, hit: true, result: 1, gradedAt: `${D}T23:00:00Z`,
    });
    // 5 agree, 4 overcount, 1 undercount — the live shape in miniature.
    seed('pick-log', D, [
      ...[0, 1, 2, 3, 4].map((i) => row(2, 2, i)),
      ...[5, 6, 7, 8].map((i) => row(4, 2, i)),
      row(1, 2, 9),
    ]);
    const cal = await loadFn('calibration.js');
    const out = JSON.parse((await cal.handler({ queryStringParameters: { format: 'json' } })).body);
    const b = out.behaviour['aphrodite · Vilifiant'];
    t.eq('only rows carrying BOTH numbers are checked', b.countChecked, 10);
    t.eq('agreement is reported as a rate', b.countAgreeShare, 0.5);
    // Signed, because the direction is the finding: scatter would be noise,
    // a one-way drift is a bias pointed at the over.
    t.eq('...with the signed drift, so overcounting cannot hide as scatter',
      Math.round(b.countMeanDrift * 100) / 100, 0.7);
    t.eq('...and the share that went the expensive way', b.countOverShare, 0.4);
    const html = (await cal.handler({ queryStringParameters: {} })).body;
    t.ok('the page shows it', /count agrees/.test(html), '');
    t.ok('...and says which direction costs money', /inflates the over/.test(html), '');
  }

  // ask.js states the same number from the same helper.
  const ask = await loadFn('ask.js');
  const sys = ask.buildSystem
    ? ask.buildSystem({ player: 'P', stat: 'S', line: 5, recent5: [3, 4, 4, 5, 6], recentAvg: 4.4 })
    : null;
  if (sys) t.ok('the ask chat quotes the identical count', /in 1 of 5/.test(sys), sys.slice(0, 400));
}

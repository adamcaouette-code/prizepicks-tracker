// A 99% on a game that hasn't been played.
//
// The next-slate scan let the app judge Friday's board on a Tuesday. What it did
// not do was TELL the judge that. The payload carried player, stat, line,
// position, team, opponent and tier — and no date at all. While every scan was a
// scan of today, the model's unstated assumption that the game was today was
// simply correct, so nobody noticed the field was missing.
//
// Handed a Friday CFB prop on a Tuesday, the judge searched the matchup, found a
// completed box score for a game between the same two teams, and returned:
//
//   Donovan Olugbode · Receiving Yards over 49.5 · 99% · +19.6pp edge
//   "Game already played. ESPN box score shows Olugbode had 107 receiving
//    yards; prop outcome determined."
//
// It went straight onto the recommended slip, because a 99% goblin clears its
// 79.4% break-even by 19.6 points and the edge guardrail — correctly, on the
// number it was given — waved it through. The guardrail checks whether a
// probability beats its payout. It cannot check whether the probability is real.
//
// For scale: across 4,411 graded picks the judge has returned 0.90 or higher
// exactly THREE times, and has never once reached 0.97. That 99% was not
// confidence. It was a false premise.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

// RELATIVE to now, never fixed. A literal date here is a test that passes until
// the clock reaches it and then quietly starts asserting the opposite thing —
// "has not been played yet" is only true of a date that is still ahead.
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const NOW = Date.now();
const TODAY = day(0);
const FRIDAY = `${day(3)}T17:00:00.000-04:00`;        // not played
const SATURDAY_PAST = `${day(-2)}T17:00:00.000-04:00`;

export default async function ({ t }) {
  const { settledReadReason, slateNote } = await loadFn('bet-finder-background.js');
  const jp = await loadFn('judge-prompts.js');
  const note = (rows) => jp.slateNote(rows);

  // ---- the judge is told when the game is --------------------------------
  const future = note([{ start: FRIDAY }, { start: `${day(4)}T20:00:00.000-04:00` }]);
  t.ok('the prompt states today\'s date',
    new RegExp(`TODAY.S DATE IS ${TODAY}`).test(future), future.slice(0, 120));
  t.ok('...and the range the slate covers',
    new RegExp(`${day(3)} to ${day(4)}`).test(future), future);
  t.ok('...and says plainly that these games have not been played',
    /HAVE NOT BEEN PLAYED YET/.test(future), '');
  t.ok('...and that a box score it finds is a DIFFERENT game, which is the exact mistake made',
    /DIFFERENT, EARLIER game/.test(future), '');
  t.ok('...and that a 0.90+ on an unplayed prop is almost never justified',
    /above\s+0\.90/.test(future), '');

  // A today-only slate must not carry the future warning — it would be false,
  // and a prompt that cries wolf on every ordinary run stops being read.
  const today = note([{ start: `${new Date().toISOString().slice(0, 10)}T20:00:00.000-04:00` }]);
  t.ok('an ordinary same-day slate still gets the date', /TODAY.S DATE IS/.test(today), today);
  t.ok('...but not a warning about games that have not happened',
    !/HAVE NOT BEEN PLAYED/.test(today), today);
  t.eq('a slate with no usable dates says nothing rather than guessing', note([{ start: null }]), '');

  // ---- the backstop -------------------------------------------------------
  // The date is the fix. This catches the case where the judge gets it wrong
  // anyway, and it rests on something the app KNOWS and the model only infers:
  // the game has not started.
  const claim = {
    prob: 0.99,
    reasoning: 'Game already played. ESPN box score shows Olugbode had 107 receiving yards; prop outcome determined.',
  };
  t.ok('the real failure is caught', !!settledReadReason(claim, FRIDAY, NOW));
  t.ok('...and says which fact makes it false, not just that it looks odd',
    /has not started/.test(settledReadReason(claim, FRIDAY, NOW)), settledReadReason(claim, FRIDAY, NOW));

  // Either signal alone is enough: the claim without the number...
  t.ok('a settled-outcome claim at an ordinary probability is still caught',
    !!settledReadReason({ prob: 0.62, reasoning: 'This game has already concluded.' }, FRIDAY, NOW));
  // ...and the number without the claim.
  t.ok('a 97% with perfectly normal reasoning is caught on the number alone',
    !!settledReadReason({ prob: 0.97, reasoning: 'Cleared this line in 5 of 5 and the matchup is soft.' }, FRIDAY, NOW));

  // ---- what must NOT be caught -------------------------------------------
  // A rule that fires on ordinary form talk would quietly delete good picks,
  // which is a worse failure than the one it is preventing.
  t.eq('"in games already played this season" is form talk, not a claim about this game',
    settledReadReason({ prob: 0.7, reasoning: 'In games already played this season he averaged 62 yards.' }, FRIDAY, NOW), null);
  t.eq('an ordinary confident pick is untouched',
    settledReadReason({ prob: 0.68, reasoning: 'Cleared in 4 of 5; soft secondary.' }, FRIDAY, NOW), null);
  t.eq('96% is left alone — the line is drawn where the judge has never actually gone',
    settledReadReason({ prob: 0.96, reasoning: 'ok' }, FRIDAY, NOW), null);

  // The check is about games that have NOT started, which is the only case the
  // app can be certain about. A game already under way is a different question
  // and is deliberately not answered here.
  t.eq('a game that has already started is not this rule\'s business',
    settledReadReason(claim, SATURDAY_PAST, NOW), null);
  t.eq('...and neither is a prop with no start time, where nothing is known',
    settledReadReason(claim, null, NOW), null);

  // ---- end to end: it never reaches the board or the slip -----------------
  const FRI = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const rows = [
    { player: 'Donovan Olugbode', stat: 'Receiving Yards', line: 49.5, tier: 'goblin', prob: 0.99,
      reasoning: 'Game already played. ESPN box score shows Olugbode had 107 receiving yards; prop outcome determined.' },
    { player: 'Honest Guy', stat: 'Rush Yards', line: 55.5, tier: 'standard', prob: 0.66,
      reasoning: 'Cleared in 4 of 5 against a soft front.' },
  ];
  const props = {
    data: rows.map((r, i) => ({
      id: `pp-${i}`, type: 'projection',
      attributes: { stat_type: r.stat, stat_display_name: r.stat, line_score: r.line,
        odds_type: r.tier, description: 'OPP', allowed_wager_types: 'over',
        start_time: `${FRI}T17:00:00.000-04:00`, today: false },
      relationships: { new_player: { data: { id: `n${i}` } } },
    })),
    included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
      attributes: { display_name: r.player, team: 'KU', position: 'WR', market: 'KU' } })),
    meta: { total_pages: 1 },
  };
  const byName = Object.fromEntries(rows.map((r) => [r.player, r]));

  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => ({
      data: [{ id: '15', type: 'league', attributes: { name: 'CFB', projections_count: 2, active: true } }] })],
    ['partner-api.prizepicks.com/projections', async () => props],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => {
      const payload = String(JSON.parse(init.body).messages[0].content);
      const sent = JSON.parse(payload.slice(payload.indexOf('{')));
      const picks = Object.values(sent).flat().map((e) => {
        const r = byName[e.player];
        return { player: e.player, stat: e.stat, line: e.line, prob: r.prob, key_risk: 'k', reasoning: r.reasoning };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {} };
    }],
  ]);
  let out;
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({
      jobId: 'sr', league: 'cfb', legs: 3, today: true, slate: 'next',
      tiers: ['goblin', 'standard', 'demon'] }) });
    out = read('bet-jobs', 'sr')?.result || {};
  } finally { mock.restore(); }

  const board = (out.board || []).map((p) => p.player);
  t.eq('the fabricated pick never reaches the board', board, ['Honest Guy']);
  t.ok('...and cannot reach the slip it was heading for',
    !(out.parlayLegs || []).some((l) => l.player === 'Donovan Olugbode'),
    JSON.stringify((out.parlayLegs || []).map((l) => l.player)));

  // Dropping it silently would leave a board one pick shorter with no reason —
  // the same dishonesty the DNP void box exists to avoid.
  t.eq('the run reports exactly what it threw away', (out.staleReads || []).length, 1);
  t.eq('...naming the pick', out.staleReads[0].player, 'Donovan Olugbode');
  t.eq('...and the number that gave it away', out.staleReads[0].prob, 0.99);

  // A pick built on a result that does not exist is not a forecast, so it must
  // not enter the calibration sample either — scoring it would be scoring a
  // malfunction as though it were a judgement.
  const log = read('pick-log', FRI) || [];
  t.eq('it is not logged as a forecast', log.map((p) => p.player), ['Honest Guy']);
}

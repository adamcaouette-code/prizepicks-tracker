// findCandidates' stat filter, on the real function.
//
// The trap this guards: PrizePicks' MLB board carries "Hits", "Hits Allowed" and
// "Hits+Runs+RBIs" at once. A plain substring filter for "Hits" would quietly
// sweep in a pitching prop and a combo. Exact match must win when the board
// carries the exact value; substring stays as the fallback for partial values.

import { loadFn } from '../helpers/fn.mjs';

export default async function ({ t }) {
  const { findCandidates, filterToday } = await loadFn('bet-finder-background.js');

  // Positions are real: the live position gate (mlbAllows) runs inside
  // findCandidates and drops a pitching stat on a non-pitcher as a trap, so a
  // pitcher prop here must actually belong to a pitcher.
  const mk = (player, stat, position) => ({ player, stat, position, line: 1.5, oddsType: 'standard', matchup: 'CIN vs CWS', league: 'mlb' });
  const ROWS = [
    mk('Batter A', 'Hits', 'IF'),
    mk('Batter B', 'Hits', 'OF'),
    mk('Pitcher C', 'Hits Allowed', 'P'),
    mk('Batter D', 'Hits+Runs+RBIs', 'IF'),
    mk('Pitcher E', 'Pitcher Strikeouts', 'P'),
    mk('Batter F', 'Hitter Ks', 'OF'),
    mk('Pitcher G', 'Earned Runs Allowed', 'P'),
  ];
  const statsOf = (out) => out.map((r) => r.stat).sort();

  t.eq('"Hits" returns ONLY Hits — not Hits Allowed, not the combo',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'Hits')), ['Hits', 'Hits']);
  t.eq('"Pitcher Strikeouts" returns only that',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'Pitcher Strikeouts')), ['Pitcher Strikeouts']);
  t.eq('"Hitter Ks" stays distinct from pitcher Ks',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'Hitter Ks')), ['Hitter Ks']);
  t.eq('"Hits Allowed" returns only the pitching prop',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'Hits Allowed')), ['Hits Allowed']);

  // partial values: the fallback for older saved filters and hand-typed values
  t.eq('"Earned Runs" still finds "Earned Runs Allowed"',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'Earned Runs')), ['Earned Runs Allowed']);
  t.eq('"strikeouts" with no exact match falls back to substring',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'strikeouts')), ['Pitcher Strikeouts']);
  t.eq('filter is case-insensitive',
    statsOf(findCandidates(ROWS, ['standard'], 4, 44, 'hits')), ['Hits', 'Hits']);

  // unfiltered behaviour is unchanged by the filter machinery
  t.eq('unfiltered still caps at perGame per matchup',
    findCandidates(ROWS, ['standard'], 4, 44, null).length, 4);
  t.eq('unfiltered with room returns everything',
    findCandidates(ROWS, ['standard'], 10, 44, null).length, 7);

  // ---- filterToday: trust PrizePicks' own boolean over UTC date math -------
  // start_time carries a local offset, so a 10pm ET first pitch is already
  // "tomorrow" in UTC — a date-prefix compare drops every late game.
  const lateGame = { player: 'Late', stat: 'Hits', today: true, start: '2026-08-14T22:05:00.000-04:00' };
  const tomorrow = { player: 'Tmrw', stat: 'Hits', today: false, start: '2026-08-15T13:05:00.000-04:00' };
  const noFlag = { player: 'NoFlag', stat: 'Hits', today: null, start: new Date().toISOString() };
  t.eq('today=true is kept regardless of UTC rollover',
    filterToday([lateGame, tomorrow], true).map((r) => r.player), ['Late']);
  t.eq('missing boolean falls back to the date compare',
    filterToday([noFlag], true).map((r) => r.player), ['NoFlag']);
  t.eq('todayOnly=false keeps everything',
    filterToday([lateGame, tomorrow], false).length, 2);
}

// The dual-name stat matcher in judge-slip.
//
// PrizePicks carries TWO names per stat and they differ for most MLB props:
// the projection feed's stat_type ("Hitter Strikeouts") vs the display name the
// app — and therefore a screenshot, and therefore parse-slip's OCR — shows
// ("Hitter Ks"). Matching on stat_type alone made every such leg fail to bind
// to a live projection: matchedLegs 0/4 in production, every slip "graded on
// profile alone". These pairs are real, straight from the live-board probe.

import { loadFn } from '../helpers/fn.mjs';

export default async function ({ t }) {
  const { rowMatchesStat, matchProjection } = await loadFn('judge-slip-background.js');

  const PAIRS = [
    ['Hitter Strikeouts', 'Hitter Ks'],
    ['Pitcher Strikeouts', 'Ks'],
    ['Total Bases', 'TB'],
    ['Hitter Fantasy Score', 'Hitter FS'],
    ['Stolen Bases', 'SB'],
    ['Pitching Outs', 'PO'],
    ['Pitcher Fantasy Score', 'Pitcher FS'],
    ['Hits+Runs+RBIs', 'Hits+Runs+RBIs'],   // identical — must still work
    ['Home Runs', 'Home Runs'],
  ];
  for (const [statType, display] of PAIRS) {
    t.ok(`OCR "${display}" binds to feed "${statType}"`,
      rowMatchesStat(display, { stat: statType, statDisplay: display }));
  }

  // end to end on the shape of a real slip
  const ROWS = [
    { id: 'PP1', player: 'Elly De La Cruz', stat: 'Hitter Strikeouts', statDisplay: 'Hitter Ks', line: 0.5, team: 'CIN' },
    { id: 'PP2', player: 'Eugenio Suárez',  stat: 'Hitter Strikeouts', statDisplay: 'Hitter Ks', line: 0.5, team: 'CIN' },
    { id: 'PP3', player: 'Seiya Suzuki',    stat: 'Home Runs',          statDisplay: 'Home Runs', line: 0.5, team: 'CHC' },
    { id: 'PP4', player: 'Max Scherzer',    stat: 'Pitcher Strikeouts', statDisplay: 'Ks',        line: 4,   team: 'TOR' },
  ];
  const LEGS = [
    { player: 'Elly De La Cruz', stat: 'Hitter Ks', line: 0.5, team: 'CIN' },
    { player: 'Eugenio Suárez',  stat: 'Hitter Ks', line: 0.5, team: 'CIN' },
    { player: 'Seiya Suzuki',    stat: 'Home Runs', line: 0.5, team: 'CHC' },
    { player: 'Max Scherzer',    stat: 'Ks',        line: 4,   team: 'TOR' },
  ];
  const matched = LEGS.filter((leg) => matchProjection(leg, ROWS)).length;
  t.eq('all four legs of the real slip bind (was 0/4 before the fix)', matched, 4);

  // Over-matching is the opposite failure: "Hitter Ks" contains "Ks", so a naive
  // contains-check would bind a hitter leg to a PITCHER'S strikeout line.
  t.ok('hitter Ks does NOT bind to a pitcher Ks row',
    !matchProjection({ player: 'Elly De La Cruz', stat: 'Hitter Ks', line: 0.5 },
      [{ id: 'X', player: 'Elly De La Cruz', stat: 'Pitcher Strikeouts', statDisplay: 'Ks', line: 0.5 }]));
  t.ok('an unrelated stat still misses',
    !matchProjection({ player: 'Elly De La Cruz', stat: 'Stolen Bases' },
      [{ id: 'X', player: 'Elly De La Cruz', stat: 'Home Runs', statDisplay: 'Home Runs' }]));
}

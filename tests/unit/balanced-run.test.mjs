// The balanced calibration run.
//
// Ordinary candidate selection ranks by fairProb, which is ODDS_PRIOR[tier] — a
// CONSTANT per tier (0.62 / 0.55 / 0.45). So it is not a ranking of props at
// all, it is a ranking of tiers, and the cap takes goblins until they run out.
// For betting that is harmless and arguably right: goblins sit closest to
// break-even. For MEASURING it is fatal, because the headline diagnostic is the
// tier gap — mean P(over) on goblins minus demons — and a sample containing no
// demons cannot produce one at any sample size.

import { findCandidates } from '../../netlify/functions/bet-finder-background.js';

const row = (i, tier, matchup) => ({
  player: `P${i}`, stat: 'Hits', line: 0.5, oddsType: tier, position: 'OF',
  team: 'CIN', opp: 'PIT', matchup, league: 'mlb',
});
// A realistic slate: goblins outnumber everything, spread over several games so
// the per-matchup cap does not do the balancing by accident.
const SLATE = [];
let n = 0;
for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
  for (let i = 0; i < 6; i++) SLATE.push(row(n++, 'goblin', g));
  for (let i = 0; i < 3; i++) SLATE.push(row(n++, 'standard', g));
  for (let i = 0; i < 3; i++) SLATE.push(row(n++, 'demon', g));
}
const TIERS = ['goblin', 'standard', 'demon'];
const count = (rows) => rows.reduce((a, r) => ({ ...a, [r.oddsType]: (a[r.oddsType] || 0) + 1 }), {});

export default async function ({ t }) {
  // ---- the bias, stated as a test so it cannot come back silently ---------
  const plain = findCandidates(SLATE, TIERS, 4, 12, null, false);
  const pc = count(plain);
  t.eq('an ordinary run fills the board with the cheapest-priced tier first',
    pc.goblin, 12);
  t.eq('...and can return no demons at all, even with demons selected',
    pc.demon, undefined);

  // ---- balanced: every tier represented ----------------------------------
  const bal = findCandidates(SLATE, TIERS, 4, 12, null, true);
  const bc = count(bal);
  t.eq('a balanced run splits the cap evenly across the three tiers',
    [bc.goblin, bc.standard, bc.demon], [4, 4, 4]);
  t.eq('...and returns the same total, so it costs the same', bal.length, plain.length);

  // The point of balancing is the measurement, and the measurement needs BOTH
  // ends of the price range. One end missing and the tier gap is undefined.
  t.ok('both ends of the price range are present, which is what the tier gap needs',
    bc.goblin > 0 && bc.demon > 0);

  // ---- it must not invent props that are not there -----------------------
  // A slate with no demons posted stays a slate with no demons. Balancing
  // redistributes what exists; it cannot manufacture a tier.
  const noDemons = SLATE.filter((r) => r.oddsType !== 'demon');
  const nd = count(findCandidates(noDemons, TIERS, 4, 12, null, true));
  t.eq('a tier with nothing posted simply does not appear', nd.demon, undefined);
  t.eq('...and the others take up the slack rather than the board coming up short',
    (nd.goblin || 0) + (nd.standard || 0), 12);

  // An odd cap cannot divide evenly; the round-robin must still fill it exactly
  // rather than stopping short or overshooting.
  const odd = findCandidates(SLATE, TIERS, 4, 11, null, true);
  t.eq('an uneven cap is still filled exactly', odd.length, 11);
  t.eq('...as evenly as 11 allows', Object.values(count(odd)).sort(), [3, 4, 4]);

  // Only the tiers asked for. Balancing must not smuggle in a tier the user
  // deselected — it changes the split, never the permission.
  const twoTiers = findCandidates(SLATE, ['goblin', 'standard'], 4, 12, null, true);
  t.eq('a deselected tier stays out of a balanced run',
    Object.keys(count(twoTiers)).sort(), ['goblin', 'standard']);

  // ---- a balanced run should be WIDE -------------------------------------
  // Sample size is the entire point, and props are the one thing here that is
  // nearly free: web searches are ~76% of a run's cost and fixed per run, while
  // all 44 candidates together come to about a penny. A narrow measurement run
  // costs the same as a wide one and buys a third less data, so the balanced
  // path takes the widest board allowed unless the caller asked for less.
  const wide = findCandidates(SLATE, TIERS, 4, 60, null, true);
  t.eq('a wide balanced board is evenly split across all three tiers',
    Object.values(count(wide)).sort(), [18, 18, 18]);
  t.eq('...and takes every prop the slate had to offer', wide.length, 54);

  // The per-GAME cap has to widen too, or it becomes the binding constraint and
  // the board comes in far under the size asked for: at the betting default of
  // 4 slots a game, a round-robin yields 2 goblins and 1 of each other tier, so
  // six games cap out at 24 however large the board cap is.
  const narrowPerGame = findCandidates(SLATE, TIERS, 4, 60, null, false);
  t.ok('an unbalanced run keeps the narrow per-game spread',
    narrowPerGame.length === 24, `${narrowPerGame.length}`);

  // ---- within a tier, still the best props -------------------------------
  // Balancing decides HOW MANY of each tier, never WHICH. Inside a tier the
  // per-matchup spread and ranking are untouched.
  // Measured on the wide board, which is what a balanced run actually takes.
  // A cap of 12 against 9 slots a game can only reach two games by arithmetic,
  // so asserting spread there would be testing the fixture, not the code.
  const games = new Set(wide.map((r) => r.matchup));
  t.eq('a balanced board still spreads across every game rather than stacking one',
    games.size, 6);
}

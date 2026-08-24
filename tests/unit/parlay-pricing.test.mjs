// What the recommended slip on the board says it pays.
//
// This is the number the whole app exists to get right, and it was wrong by
// more than a hundred percentage points on the most common slip it builds.
//
// bet-finder-background carried its own payout tables, untiered: 5.0x on any
// 3-pick, 20x on any 5-pick. PrizePicks pays a PURE GOBLIN 3-pick 2.0x. Since
// the engine's candidate ranking favours goblins — fairProb is the tier prior,
// so goblins fill the board — the slip it most often recommends is exactly the
// one that was most overpriced. The box reported +70% EV per dollar on a slip
// that really returns -32%, and +231% on a goblin 5-pick that returns -57%.
//
// A second copy of a payout table is a second answer, and the wrong one is
// always the flattering one. There is now exactly one, in bet-finder-size.js.

import { sizeParlay } from '../../netlify/functions/bet-finder-background.js';

const leg = (i, tier, prob) => ({
  player: `P${i}`, stat: 'Hits', line: 0.5, prob, oddsType: tier, pick: 'over',
});
const SIZING = { bankroll: 1000, floor: 0, maxStake: null };
const evOf = (r) => r.entries.power.evPerDollar;
const multOf = (r, n) => r.entries.power.payouts.find((p) => p.hits === n);

export default async function ({ t }) {
  // ---- a pure goblin slip is priced as a goblin slip ---------------------
  // 0.698 is this board's MEASURED goblin over-rate across 1162 graded picks,
  // so this is the real recommended-slip case, not a hypothetical.
  const gob3 = sizeParlay([0, 1, 2].map((i) => leg(i, 'goblin', 0.698)), SIZING);
  t.ok('a pure goblin 3-pick is priced at the goblin table, not a flat 5x',
    Math.abs(evOf(gob3) - (2.0 * 0.698 ** 3 - 1)) < 0.01, `EV ${evOf(gob3)}`);
  t.ok('...which is NEGATIVE, as the measured rates say it must be',
    evOf(gob3) < 0, `EV ${evOf(gob3)}`);
  // The old table would have made this +0.70. That sign flip is the bug.
  t.ok('...and nowhere near the +70% the old untiered table reported',
    evOf(gob3) < 0.1, `EV ${evOf(gob3)}`);

  const gob5 = sizeParlay([0, 1, 2, 3, 4].map((i) => leg(i, 'goblin', 0.698)), SIZING);
  t.ok('a goblin 5-pick pays 2.6x, not 20x — so EV is deeply negative',
    Math.abs(evOf(gob5) - (2.6 * 0.698 ** 5 - 1)) < 0.01, `EV ${evOf(gob5)}`);

  // ---- the tier genuinely changes the price ------------------------------
  // Same leg count, same probabilities, different tier. Under the old table
  // these three were identical, which is the plainest statement of the bug.
  const at = (tier) => sizeParlay([0, 1, 2].map((i) => leg(i, tier, 0.6)), SIZING);
  const [g, s, d] = ['goblin', 'standard', 'demon'].map(at);
  t.ok('identical legs price differently by tier',
    new Set([evOf(g), evOf(s), evOf(d)]).size === 3,
    [evOf(g), evOf(s), evOf(d)].join(' / '));
  t.ok('...in the right order: a demon pays most for the same hit rate',
    evOf(d) > evOf(s) && evOf(s) > evOf(g));
  t.eq('a standard 3-pick all-hit multiplier is 4.75, the real table',
    multOf(g, 3) && Math.round(multOf(s, 3).pays / s.entries.power.stake * 100) / 100, 4.75);

  // ---- a mixed slip is not priced as any single tier ---------------------
  const mixed = sizeParlay(
    [leg(0, 'goblin', 0.6), leg(1, 'standard', 0.6), leg(2, 'demon', 0.6)], SIZING);
  t.eq('a mixed slip says so, rather than silently picking a tier', mixed.mixed, true);
  t.ok('...and prices between the pure extremes',
    evOf(mixed) > evOf(g) && evOf(mixed) < evOf(d),
    `${evOf(g)} < ${evOf(mixed)} < ${evOf(d)}`);
  t.eq('a pure slip is not flagged mixed', g.mixed, false);

  // ---- guards -------------------------------------------------------------
  t.ok('fewer than two legs is refused', !!sizeParlay([leg(0, 'goblin', 0.7)], SIZING).error);
  t.ok('more than six is refused',
    !!sizeParlay(Array.from({ length: 7 }, (_, i) => leg(i, 'goblin', 0.7)), SIZING).error);
  // A pure goblin PAIR has no published table; the tier factors estimate it, and
  // it must not silently fall through to the standard 2-pick's flat 3.0x.
  const pair = sizeParlay([leg(0, 'goblin', 0.7), leg(1, 'goblin', 0.7)], SIZING);
  t.eq('a goblin pair is flagged as an estimate, not quoted as standard', pair.mixed, true);
  t.ok('...and priced near the goblin per-leg factor, well under 3x',
    multOf(pair, 2) === undefined || pair.entries.power.payouts[0].pays / (pair.entries.power.stake || 1) < 2.5,
    JSON.stringify(pair.entries.power.payouts));
}

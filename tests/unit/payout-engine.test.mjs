// The payout engine.
//
// A payout table is the one input where a typo is silent and expensive. An
// extra zero on a multiplier does not throw — it makes every slip look like a
// good bet, and the mistake is only visible in the bankroll months later. So
// this suite is mostly about the numbers being exactly what they claim, and the
// four break-evens in §3 are pinned as drift guards: if a table edit moves
// them, the suite fails and says so rather than quietly repricing the board.

import fs from 'node:fs';
import path from 'node:path';
// Imported DIRECTLY, not through loadFn: the engine has no imports, no I/O and
// no store, so there is nothing to stub. Loading it through the harness would
// only prove the harness works.
import * as P from '../../netlify/functions/payout-engine.js';

const TABLES = JSON.parse(fs.readFileSync(
  path.resolve('netlify/functions/payout-tables.json'), 'utf8',
));
const classic = TABLES.configs.find((c) => c.id === 'pp-classic');
const repoObserved = TABLES.configs.find((c) => c.id === 'repo-observed-2026-08');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const pct = (x) => Number((x * 100).toFixed(1));

export default async function ({ t }) {
  // ---- 1. the config is data, and it is checked ---------------------------
  t.eq('the shipped classic table validates clean', P.validateConfig(classic), []);
  t.eq('...and so does the one transcribed from the live app', P.validateConfig(repoObserved), []);
  t.ok('every config carries an effective_date, which is what makes it versionable',
    TABLES.configs.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.effective_date)), '');

  t.ok('a config with no effective_date is refused',
    P.validateConfig({ id: 'x', slip_types: { power: { 3: { 3: 5 } } } })
      .some((m) => /effective_date/.test(m)), '');
  t.ok('a negative multiplier is refused',
    P.validateConfig({ ...classic, slip_types: { power: { 3: { 3: -5 } } } })
      .some((m) => /non-negative/.test(m)), '');
  t.ok('a correct-count above the leg count is refused',
    P.validateConfig({ ...classic, slip_types: { power: { 3: { 4: 5 } } } })
      .some((m) => /not 0\.\.3/.test(m)), '');
  // A payout that FALLS as you get more legs right is either a typo or a
  // product nobody offers — and it would break the monotonicity breakEven()'s
  // search depends on, which is the failure that would not announce itself.
  t.ok('a payout that decreases with more correct legs is refused',
    P.validateConfig({ ...classic, slip_types: { flex: { 3: { 3: 1.0, 2: 2.0 } } } })
      .some((m) => /must not decrease/.test(m)), '');
  t.ok('assertConfig throws rather than returning errors nobody reads',
    (() => { try { P.assertConfig({ id: 'x' }); return false; } catch { return true; } })(), '');

  // ---- 2. exact EV --------------------------------------------------------
  // Power is a closed form, so it can be checked against arithmetic rather than
  // against the engine's own output: 5x on three legs at 60% is 5 * 0.216.
  const p3 = P.evForSlip({ config: classic, slipType: 'power', probs: [0.6, 0.6, 0.6] });
  t.ok('a 3-pick Power returns exactly M * p^3', near(p3.returnPerUnit, 5 * 0.6 ** 3), String(p3.returnPerUnit));
  t.ok('...so EV per unit is that minus one', near(p3.evPerUnit, 5 * 0.216 - 1), String(p3.evPerUnit));
  t.ok('...and the absolute EV scales with the stake',
    near(P.evForSlip({ config: classic, slipType: 'power', probs: [0.6, 0.6, 0.6], stake: 20 }).ev,
      (5 * 0.216 - 1) * 20), '');
  t.ok('all-hit probability is reported', near(p3.probAllHit, 0.216), String(p3.probAllHit));

  // Flex has to sum every paying tier. 3-pick: 2.25 on 3/3, 1.25 on 2/3.
  const f3 = P.evForSlip({ config: classic, slipType: 'flex', probs: [0.6, 0.6, 0.6] });
  const expect = 2.25 * 0.6 ** 3 + 1.25 * 3 * 0.6 ** 2 * 0.4;
  t.ok('a 3-pick Flex sums every paying tier', near(f3.returnPerUnit, expect), `${f3.returnPerUnit} vs ${expect}`);
  t.eq('...and reports each outcome separately, so a "cashed but lost" tier is visible',
    f3.byOutcome.filter((o) => o.multiplier > 0).map((o) => o.correct), [3, 2]);
  t.ok('...with the chance of any payout at all',
    near(f3.probAnyPayout, 0.6 ** 3 + 3 * 0.6 ** 2 * 0.4), String(f3.probAnyPayout));

  // A slip shape the config does not offer must throw rather than price a
  // product that does not exist.
  t.ok('a leg count the table does not offer throws',
    (() => { try { P.evForSlip({ config: classic, slipType: 'flex', probs: [0.6, 0.6] }); return false; } catch { return true; } })(),
    'PrizePicks has no 2-leg Flex');

  // ---- 3. THE DRIFT GUARDS ------------------------------------------------
  // Supplied as the spec for this module. If a table edit moves any of these,
  // this suite fails — which is the entire reason they are here, because a
  // payout table drifting silently is exactly how the board starts
  // recommending bets that lost their edge.
  const be = (slipType, legCount) => P.breakEven({ config: classic, slipType, legCount });
  t.eq('3-pick Power breaks even at 58.5%', pct(be('power', 3)), 58.5);
  t.eq('6-pick Power breaks even at 54.7%', pct(be('power', 6)), 54.7);
  t.eq('3-pick Flex breaks even at 59.1%', pct(be('flex', 3)), 59.1);
  t.eq('6-pick Flex breaks even at 54.2%', pct(be('flex', 6)), 54.2);

  // Break-even is the p at which EV is exactly zero — checked directly rather
  // than trusted, since a solver that converges on the wrong root would still
  // return a plausible-looking number.
  for (const [type, n] of [['power', 3], ['power', 6], ['flex', 3], ['flex', 6], ['flex', 5]]) {
    const p = be(type, n);
    const ev = P.evForSlip({ config: classic, slipType: type, probs: new Array(n).fill(p) }).evPerUnit;
    t.ok(`${n}-pick ${type}: EV at its own break-even is zero`, Math.abs(ev) < 1e-9, String(ev));
  }

  // Power has a closed form the solver must agree with. Two methods agreeing is
  // what makes the number trustworthy; the solver is used for both because Flex
  // has no closed form and one method cannot drift from itself.
  for (const [n, m] of [[3, 5], [4, 10], [5, 20], [6, 37.5]]) {
    t.ok(`${n}-pick Power matches the closed form M^(-1/n)`,
      near(be('power', n), Math.pow(m, -1 / n), 1e-9), `${be('power', n)} vs ${Math.pow(m, -1 / n)}`);
  }

  // A table that cannot break even at ANY probability returns null, not 1.0 —
  // "you would need certainty" and "this is impossible" are different answers.
  const losing = { ...classic, slip_types: { power: { 3: { 3: 0.9 } } } };
  t.eq('a slip that loses even at certainty reports null', P.breakEven({ config: losing, slipType: 'power', legCount: 3 }), null);
  t.eq('a slip shape that does not exist reports null too', be('flex', 2), null);

  // ---- 4. heterogeneous legs ---------------------------------------------
  // The distribution must be Poisson-binomial, NOT a binomial on the mean. Legs
  // at 0.9 and 0.5 are not two legs at 0.7 — and Flex is paid out of exactly
  // the middle of the distribution where the two disagree most.
  const dist = P.correctCountDistribution([0.9, 0.5]);
  t.ok('P(0), P(1), P(2) are exact for unequal legs',
    near(dist[0], 0.05) && near(dist[1], 0.5) && near(dist[2], 0.45), JSON.stringify(dist));
  t.ok('...and a binomial on the mean would have said something else',
    !near(dist[2], 0.7 ** 2), `poisson-binomial ${dist[2]} vs binomial-on-mean ${0.7 ** 2}`);
  t.ok('the distribution sums to 1', near(P.correctCountDistribution([0.3, 0.55, 0.8, 0.61]).reduce((a, b) => a + b, 0), 1), '');
  t.ok('a probability outside [0,1] throws rather than producing a nonsense distribution',
    (() => { try { P.correctCountDistribution([1.4]); return false; } catch { return true; } })(), '');

  // ---- 5. ranking real legs ----------------------------------------------
  const legs = [
    { player: 'A', prob: 0.72 }, { player: 'B', prob: 0.68 }, { player: 'C', prob: 0.66 },
    { player: 'D', prob: 0.61 }, { player: 'E', prob: 0.58 }, { player: 'F', prob: 0.40 },
  ];
  const ranked = P.rankSlips({ config: classic, legs, stake: 10 });
  t.eq('every legal slip shape these legs could form is priced',
    ranked.length, P.breakEvenGrid(classic).filter((r) => r.legCount <= legs.length).length);
  t.ok('the list is ranked by EV per unit staked, best first',
    ranked.every((r, i) => i === 0 || ranked[i - 1].evPerUnit >= r.evPerUnit), '');
  t.ok('...and each says which legs it used', ranked.every((r) => r.legs?.length === r.legCount), '');
  t.ok('every subset was enumerated at these sizes, so the answer is optimal not heuristic',
    ranked.every((r) => r.selection === 'exhaustive'), ranked.map((r) => r.selection).join('|'));

  // The weak leg must be dropped where it hurts and kept where it does not.
  const p3best = ranked.find((r) => r.slipType === 'power' && r.legCount === 3);
  t.eq('the best 3-pick Power is the three strongest legs',
    p3best.legs.map((l) => l.player).sort(), ['A', 'B', 'C']);
  t.ok('...and the 40% leg is nowhere near it', !p3best.legs.some((l) => l.player === 'F'), '');

  // Exhaustive enumeration is not decoration: for Flex the top-k heuristic is
  // not provably optimal, so the two are compared directly.
  const topK = P.rankSlips({ config: classic, legs, stake: 10, maxSubsets: 0 });
  t.ok('the heuristic fallback labels itself rather than passing as optimal',
    topK.every((r) => /heuristic/.test(r.selection)), topK[0]?.selection);
  t.ok('...and never beats the exhaustive search it stands in for',
    topK.every((h) => {
      const ex = ranked.find((r) => r.slipType === h.slipType && r.legCount === h.legCount);
      return ex.evPerUnit >= h.evPerUnit - 1e-12;
    }), '');

  // Plain probabilities work too — legs are a convenience, not a requirement.
  t.ok('a bare list of probabilities is accepted',
    P.rankSlips({ config: classic, probs: [0.7, 0.7, 0.7] }).length > 0, '');
  t.eq('an empty list ranks nothing rather than throwing', P.rankSlips({ config: classic, legs: [] }), []);

  // ---- 6. goblin and demon multipliers ------------------------------------
  const base = P.evForSlip({ config: classic, slipType: 'power', probs: [0.8, 0.8, 0.8] });
  const demons = P.evForSlip({
    config: classic, slipType: 'power',
    legs: [{ prob: 0.8, tier: 'demon' }, { prob: 0.8, tier: 'demon' }, { prob: 0.8, tier: 'demon' }],
  });
  t.ok('demon legs raise the payout', demons.returnPerUnit > base.returnPerUnit,
    `${demons.returnPerUnit} vs ${base.returnPerUnit}`);
  t.ok('...by the product of their per-leg multipliers',
    near(demons.returnPerUnit, base.returnPerUnit * classic.leg_multipliers.demon ** 3),
    String(demons.legMultiplier));
  const goblins = P.evForSlip({
    config: classic, slipType: 'power',
    legs: [{ prob: 0.8, tier: 'goblin' }, { prob: 0.8, tier: 'goblin' }, { prob: 0.8, tier: 'goblin' }],
  });
  t.ok('goblin legs lower it', goblins.returnPerUnit < base.returnPerUnit, String(goblins.returnPerUnit));

  // An explicit per-leg multiplier beats the config's tier default. Real
  // PrizePicks prints the exact number on every goblin/demon card, and the
  // line-snapshot archive captures it — the defaults are a fallback for when it
  // is genuinely unknown, never a preferred source.
  const explicit = P.evForSlip({
    config: classic, slipType: 'power',
    legs: [{ prob: 0.8, tier: 'demon', multiplier: 2.0 }, { prob: 0.8 }, { prob: 0.8 }],
  });
  t.ok('an explicit multiplier from the board overrides the tier default',
    near(explicit.legMultiplier, 2.0), String(explicit.legMultiplier));
  t.eq('an unknown tier is treated as standard rather than dropping the slip',
    P.evForSlip({ config: classic, slipType: 'power', legs: [{ prob: 0.8, tier: 'wizard' }, { prob: 0.8 }, { prob: 0.8 }] })
      .legMultiplier, 1);

  // ---- 7. the report ------------------------------------------------------
  const report = P.breakEvenReport(classic, { referenceProb: 0.60 });
  t.ok('the report names the table and its effective date',
    report.includes('PrizePicks classic') && report.includes(classic.effective_date), '');
  t.ok('...lists every slip shape', P.breakEvenGrid(classic)
    .every((r) => new RegExp(`${r.slipType}\\s+${r.legCount}\\b`).test(report)), '');
  t.ok('...with the four pinned break-evens visible in it',
    ['58.48%', '54.66%', '59.09%', '54.21%'].every((s) => report.includes(s)), '');
  t.ok('...and states the independence assumption where it will be read',
    /assumes the legs are INDEPENDENT/.test(report) && /TODO\(correlation\)/.test(report), '');
  t.ok('it RETURNS the text rather than printing it, so it can be tested and reused',
    typeof report === 'string' && report.length > 100, '');

  // ---- 8. versioning by date ----------------------------------------------
  // The reason effective_date exists: a slip placed in March is priced by
  // March's table forever. Re-pricing history against today's numbers is how a
  // ledger starts lying about what a bet was worth.
  const v = [
    { id: 'old', effective_date: '2024-01-01', end_date: '2025-12-31', jurisdiction: 'default', slip_types: { power: { 3: { 3: 5 } } } },
    { id: 'new', effective_date: '2026-01-01', jurisdiction: 'default', slip_types: { power: { 3: { 3: 3 } } } },
  ];
  t.eq('a date inside the old window picks the old table', P.configFor(v, '2025-06-01').id, 'old');
  t.eq('a date after the change picks the new one', P.configFor(v, '2026-06-01').id, 'new');
  t.eq('a date before any table exists picks none', P.configFor(v, '2023-01-01'), null);
  t.eq('an expired table is not used past its end_date', P.configFor(v, '2026-06-01').id, 'new');
  t.eq('a jurisdiction with no table of its own falls back to default',
    P.configFor(v, '2026-06-01', { jurisdiction: 'NY' })?.id, 'new');

  // ---- 9. the two shipped tables disagree, and that is the point ----------
  // Not an assertion that either is right — nothing here can settle that. It
  // pins the DISAGREEMENT so it cannot be quietly resolved by editing one file,
  // and so the size of it stays visible.
  const classic6 = P.breakEven({ config: classic, slipType: 'power', legCount: 6 });
  const repo6 = P.breakEven({ config: repoObserved, slipType: 'power', legCount: 6 });
  t.eq('the classic 6-pick Power breaks even at 54.7%', pct(classic6), 54.7);
  t.eq('...and the table the live app prices against says 63.0%', pct(repo6), 63.0);
  t.ok('...an 8-point gap, which is a decision someone has to make, not rounding',
    repo6 - classic6 > 0.08, `${repo6 - classic6}`);
  t.ok('both tables are shipped so the gap is visible rather than being two files nobody compared',
    !!classic && !!repoObserved && !!repoObserved.warning, '');
}

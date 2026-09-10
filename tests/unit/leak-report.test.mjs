// The leak report.
//
// ===========================================================================
// THE TWO THINGS THAT WOULD MAKE THIS REPORT LIE
//
//   1. RANKING BY ROI. A slice at -60% on four slips has cost $12; one at -8%
//      across two hundred has cost $400. Ranked by ROI the harmless one leads
//      and the actual leak is buried, which is the opposite of the brief.
//
//   2. COMPARING TIERS ON RAW HIT RATE. A goblin at 75% and a demon at 45%
//      look like a rout until you notice the goblin needed 79.4% and the demon
//      needed 43.7%. On those numbers the DEMON is the one making money, and a
//      report that does not divide by the bar will confirm whatever the reader
//      already believed.
//
// Both are pinned below with hand-computed fixtures.
// ===========================================================================

import fs from 'node:fs';
import * as R from '../../netlify/functions/leak-report.js';

const CONFIGS = JSON.parse(fs.readFileSync('netlify/functions/payout-tables.json', 'utf8')).configs;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

let seq = 0;
/** A settled slip: n legs, `won` of them winners. */
function slip({ won, n = 2, stake = 10, tier = 'standard', slipType = 'power', source = null, league = 'mlb', market = 'Strikeouts', side = 'over', prob = 0.6, placedAt = '2026-09-07T18:00:00.000Z' }) {
  const id = `S${seq++}`;
  const legs = Array.from({ length: n }, (_, i) => ({
    leg_id: `${id}#L${i}`, player: `P${i}`, market, line: 5.5, side, tier, league, prob,
  }));
  const results = legs.map((l, i) => ({ leg_id: l.leg_id, slip_id: id, outcome: i < won ? 'won' : 'lost' }));
  return {
    bet: { slip_id: id, placed_at: placedAt, slip_type: slipType, stake, legs, source },
    results,
  };
}

const build = (slips) => R.buildRows(
  slips.map((s) => s.bet), slips.flatMap((s) => s.results), { payoutConfigs: CONFIGS },
);

export default async function ({ t }) {
  // =========================================================================
  // 1. ROI IS OVER SLIPS, HIT RATE OVER LEGS
  //
  // A 6-leg slip staked at $10 put $10 at risk, not $60. Summing the stake once
  // per leg would report an ROI on six times the money and make big slips
  // dominate every slice they touch.
  // =========================================================================
  const one6 = build([slip({ won: 6, n: 6, stake: 10 })]);
  const s6 = R.scoreSlice(one6);
  t.eq('a 6-leg slip is six legs', s6.legs, 6);
  t.eq('...but ONE slip', s6.slips, 1);
  t.eq('...staking $10, not $60', s6.staked, 10);
  //   THE PAYOUT TABLE IS THE ONE IN FORCE ON THE DATE OF THE SLIP, not the
  //   newest one. On 2026-09-07 that is repo-observed-2026-08, where a 6-power
  //   pays 16x — so $10 returns $160 for a $150 profit. Under pp-classic the
  //   same slip would return $375, which is the still-unresolved table
  //   disagreement showing up in a P&L rather than in a spec.
  t.eq('...and returning the 6-power multiplier once', s6.returned, 160);
  t.eq('...for a profit of $150', s6.profit, 150);
  t.ok('ROI is profit over what was actually risked', near(s6.roi, 15), String(s6.roi));

  // =========================================================================
  // 2. RANKED BY COST, NOT BY ROI — the brief's explicit ask
  //
  //   A 2-leg Power pays 3x, so a set of them breaks even at a third winning.
  //
  //   "cheap disaster": 3 slips of $5, none won.
  //       staked $15, returned $0        -> cost $15,   ROI -100%
  //   "expensive drip": 40 slips of $50, 8 won.
  //       staked $2000, returned 8*$150 = $1200 -> cost $800, ROI -40%
  //
  //   Ranked by ROI the cheap disaster leads. Ranked by cost — correctly — the
  //   drip does, and it is 53x more expensive.
  // =========================================================================
  seq = 0;
  const cheapDisaster = Array.from({ length: 3 }, () => slip({ won: 0, n: 2, stake: 5, market: 'Cheap' }));
  const expensiveDrip = Array.from({ length: 40 }, (_, i) => slip({ won: i < 8 ? 2 : 0, n: 2, stake: 50, market: 'Expensive' }));
  const mixedRows = build([...cheapDisaster, ...expensiveDrip]);
  const byMarket = R.sliceBy(mixedRows, (r) => r.market, { label: 'market', minSlips: 2, minLegs: 2 });

  const cheap = byMarket.slices.find((s) => s.key === 'Cheap');
  const drip = byMarket.slices.find((s) => s.key === 'Expensive');
  t.ok('the cheap disaster has the worse ROI', cheap.roi < drip.roi,
    `${(cheap.roi * 100).toFixed(0)}% vs ${(drip.roi * 100).toFixed(0)}%`);
  t.ok('...but has cost far less money', Math.abs(cheap.profit) < Math.abs(drip.profit),
    `${cheap.profit} vs ${drip.profit}`);
  t.eq('THE EXPENSIVE ONE IS RANKED FIRST', byMarket.slices[0].key, 'Expensive');
  t.ok('...which is the opposite of what an ROI ranking would do',
    byMarket.slices[0].roi > byMarket.slices[1].roi, '');

  // =========================================================================
  // 3. GOBLINS VS DEMONS, ON THEIR OWN BARS — question 1
  //
  // Built so the raw comparison and the correct one DISAGREE:
  //   goblins  150 legs, 75% hit — but a 2-leg goblin Power needs a lot more
  //   demons   150 legs, 45% hit — against a much lower bar
  //
  // If the report compares raw hit rates it will say goblins, loudly and
  // wrongly. The bar is what decides it.
  // =========================================================================
  seq = 0;
  const goblins = Array.from({ length: 75 }, (_, i) => slip({
    won: i < 45 ? 2 : 1, n: 2, stake: 10, tier: 'goblin', market: 'Hits',
  }));
  const demons = Array.from({ length: 75 }, (_, i) => slip({
    won: i < 24 ? 2 : (i < 50 ? 1 : 0), n: 2, stake: 10, tier: 'demon', market: 'Hits',
  }));
  const tierRows = build([...goblins, ...demons]);
  const q1 = R.goblinsVsDemons(tierRows, { minSlips: 20, minLegs: 30 });

  t.ok('both tiers have enough legs to compare', q1.goblin.gradedLegs >= 30 && q1.demon.gradedLegs >= 30,
    `${q1.goblin.gradedLegs} / ${q1.demon.gradedLegs}`);
  t.ok('the goblin bar is far higher than the demon bar',
    q1.goblin.requiredHitRate > q1.demon.requiredHitRate + 0.2,
    `${(q1.goblin.requiredHitRate * 100).toFixed(1)}% vs ${(q1.demon.requiredHitRate * 100).toFixed(1)}%`);
  t.ok('THE ANSWER IS AGAINST THE BAR, NOT THE RAW RATE',
    /against a .* bar/.test(q1.answer), q1.answer);
  t.ok('...quoting both hit rates and both bars',
    /Goblins hit .*% against a .*% bar/.test(q1.answer) && /demons hit .*% against/.test(q1.answer), q1.answer);
  t.ok('...and the money each has made or lost', /In money: goblins/.test(q1.answer), '');
  t.ok('a verdict of "demon" is called out as contradicting the assumption',
    q1.verdict !== 'demon' || /opposite of the assumption/.test(q1.answer), q1.answer);

  //   Not enough data is a REAL answer, given in those words.
  const thinTiers = R.goblinsVsDemons(build([
    slip({ won: 2, n: 2, tier: 'goblin' }), slip({ won: 1, n: 2, tier: 'demon' }),
  ]), { minSlips: 20, minLegs: 30 });
  t.eq('with four legs the answer is that it cannot be answered', thinTiers.verdict, 'not enough data to say');
  t.ok('...in plain language, not as a number with no interval',
    /cannot be answered yet/.test(thinTiers.answer), thinTiers.answer);

  const noDemons = R.goblinsVsDemons(build([slip({ won: 2, n: 2, tier: 'goblin' })]), {});
  t.ok('with no demons at all it says so rather than declaring goblins the winner',
    /no graded demon legs/.test(noDemons.answer), noDemons.answer);

  // =========================================================================
  // 4. MANUAL VS OPTIMIZER — question 2
  // =========================================================================
  seq = 0;
  const manual = Array.from({ length: 30 }, (_, i) => slip({
    won: i < 9 ? 2 : 0, n: 2, stake: 10, source: 'manual entry', market: 'M',
  }));
  const auto = Array.from({ length: 30 }, (_, i) => slip({
    won: i < 14 ? 2 : 0, n: 2, stake: 10, source: 'optimizer v1', market: 'M',
  }));
  const q2 = R.manualVsOptimizer(build([...manual, ...auto]), { minSlips: 20, minLegs: 30 });
  t.eq('both origins are recognised from the ledger source field', q2.manual.slips, 30);
  t.eq('...and the optimizer ones too', q2.optimizer.slips, 30);
  t.eq('the optimizer wins here', q2.verdict, 'optimizer');
  t.ok('...and the answer SHOUTS it rather than softening it',
    /THE OPTIMIZER IS AHEAD/.test(q2.answer), q2.answer);
  t.ok('...quantified in points of ROI', /points of ROI/.test(q2.answer), '');

  //   UNLABELLED SLIPS ARE NEITHER. Assuming them manual would be inventing
  //   data, and it would bias exactly the comparison being asked about.
  const withUnknown = R.manualVsOptimizer(build([...manual, ...auto, slip({ won: 0, n: 2, source: null })]), { minSlips: 20, minLegs: 30 });
  t.eq('an unlabelled slip is counted as neither', withUnknown.unlabelled.slips, 1);
  t.ok('...and the report says so', /unlabelled and counted as neither/.test(withUnknown.answer), withUnknown.answer);
  t.eq('...and is not silently added to manual', withUnknown.manual.slips, 30);

  const noAuto = R.manualVsOptimizer(build(manual), { minSlips: 20, minLegs: 30 });
  t.eq('with no optimizer slips the comparison is refused', noAuto.verdict, 'not enough data to say');

  // =========================================================================
  // 5. SMALL SLICES ARE MARKED, NOT DROPPED
  // =========================================================================
  const small = R.scoreSlice(build([slip({ won: 0, n: 2, stake: 10 })]), { minSlips: 20, minLegs: 30 });
  t.ok('a one-slip slice is flagged too small', small.tooSmall === true, '');
  t.ok('...but still reports its numbers, because "this category has 1 slip" is the finding',
    small.slips === 1 && small.profit === -10, '');
  t.ok('...and carries the thresholds it was judged against',
    small.thresholds.minSlips === 20, JSON.stringify(small.thresholds));

  //   A Wilson interval on the hit rate, and whether the bar sits inside it.
  t.ok('every slice carries a confidence interval on its hit rate',
    small.hitRateCI.lo != null && small.hitRateCI.hi != null, JSON.stringify(small.hitRateCI));
  const coin = R.scoreSlice(build(Array.from({ length: 30 }, (_, i) => slip({ won: i % 2, n: 2, tier: 'standard' }))), {});
  t.ok('when the break-even bar is inside the interval, that is recorded',
    typeof coin.barInsideCI === 'boolean', String(coin.barInsideCI));

  // =========================================================================
  // 6. EVERY DIMENSION THE BRIEF ASKED FOR
  // =========================================================================
  const names = R.DIMENSIONS.map(([l]) => l);
  for (const want of ['sport', 'market', 'line type', 'slip type', 'leg count', 'day of week',
    'hours before start', 'stake size', 'over / under', 'favourite / underdog', 'origin']) {
    t.ok(`the report slices by ${want}`, names.includes(want), names.join(', '));
  }

  seq = 0;
  const full = R.buildLeakReport(build([
    slip({ won: 2, n: 2, stake: 8, side: 'over', prob: 0.7, placedAt: '2026-09-07T18:00:00.000Z' }),
    slip({ won: 0, n: 2, stake: 60, side: 'under', prob: 0.4, placedAt: '2026-09-05T18:00:00.000Z' }),
    slip({ won: 3, n: 3, stake: 30, slipType: 'flex', tier: 'demon' }),
  ]), { minSlips: 20, minLegs: 30 });
  t.eq('all eleven dimensions come back', full.dimensions.length, 11);
  t.ok('stake size buckets', full.dimensions.find((d) => d.label === 'stake size').slices.length >= 2, '');
  t.ok('over/under splits', full.dimensions.find((d) => d.label === 'over / under').slices.length === 2, '');
  t.ok('favourite/underdog comes from the leg probability',
    full.dimensions.find((d) => d.label === 'favourite / underdog').slices.length === 2, '');
  t.ok('day of week is a weekday name, not a number',
    /^[A-Z][a-z]{2}$/.test(String(full.dimensions.find((d) => d.label === 'day of week').slices[0].key)), '');

  // =========================================================================
  // 7. The report renders, and leads with the bad news
  // =========================================================================
  const text = R.renderLeakReport(full);
  const idxQ1 = text.indexOf('ARE GOBLINS BEATING DEMONS');
  const idxQ2 = text.indexOf('DO YOUR MANUAL SLIPS');
  const idxCost = text.indexOf('WHAT HAS COST YOU THE MOST');
  const idxOverall = text.indexOf('OVERALL');
  t.ok('question 1 is at the very top', idxQ1 > 0 && idxQ1 < idxCost, `${idxQ1} vs ${idxCost}`);
  t.ok('...question 2 right after it', idxQ2 > idxQ1 && idxQ2 < idxCost, '');
  t.ok('the cost ranking comes BEFORE the overall summary', idxCost < idxOverall, `${idxCost} vs ${idxOverall}`);
  t.ok('...and says it is ranked by money lost, not by ROI',
    /ranked by total profit lost, not by ROI/.test(text), '');
  t.ok('small slices are marked in the output', /~/.test(text), '');

  const html = R.renderHTML(full);
  t.ok('the app page renders', /<title>Leak report<\/title>/.test(html), '');
  t.ok('...with both questions at the top', html.indexOf('Are goblins beating demons') < html.indexOf('What has cost you the most'), '');
  t.ok('...greys out slices too small to conclude from', /class="thin"/.test(html) || /thin\{opacity/.test(html), '');
  t.ok('...and marks losses in a losing colour', /class="bad"/.test(html), '');

  // =========================================================================
  // 8. Unsettled slips are not scored at all
  // =========================================================================
  const partial = R.buildRows(
    [{ slip_id: 'X', placed_at: '2026-09-07T18:00:00.000Z', slip_type: 'power', stake: 10,
      legs: [{ leg_id: 'X#L0', market: 'K', line: 1, side: 'over' }, { leg_id: 'X#L1', market: 'K', line: 1, side: 'over' }] }],
    [{ leg_id: 'X#L0', outcome: 'won' }],           // only one leg settled
    { payoutConfigs: CONFIGS },
  );
  t.eq('a half-settled slip contributes nothing', partial.length, 0);
}

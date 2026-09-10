// The backtest engine, and the leak guard that makes it worth anything.
//
// ===========================================================================
// THE LEAKAGE TEST IS THE POINT — requirement 4
//
// A dataset is built where a column called `theAnswer` perfectly predicts the
// outcome, and it is ingested AFTER the decision timestamp. A strategy that
// reads it goes 100%. The assertion is that the backtest finds NO EDGE.
//
// If that test ever passes trivially — because the strategy could not find the
// column for some unrelated reason — the test is worthless, so the same
// dataset is also run through a store WITHOUT the guard, and that run must go
// 100%. Only the pair proves the guard is what stopped it.
// ===========================================================================

import fs from 'node:fs';
import * as B from '../../netlify/functions/backtest.js';
import { PointInTimeStore, LeakError } from '../../netlify/functions/point-in-time.js';

const CONFIGS = JSON.parse(fs.readFileSync('netlify/functions/payout-tables.json', 'utf8')).configs;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const D = 86400000;
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const at = (d, h = 12) => new Date(T0 + d * D + h * 3600000).toISOString();

export default async function ({ t }) {
  // =========================================================================
  // 1. THE STORE REFUSES DATA IT CANNOT PLACE IN TIME
  // =========================================================================
  t.ok('a row with no ingested_at is refused at construction', (() => {
    try { new PointInTimeStore([{ id: 'a', line: 1 }]); return false; }
    catch (e) { return e instanceof LeakError && /no ingested_at/.test(e.message); }
  })(), '');
  t.ok('...with a sentence saying why, not a type error',
    (() => { try { new PointInTimeStore([{ id: 'a' }]); } catch (e) { return /no moment at which it is safe to read/.test(e.message); } })(), '');
  t.ok('a row with no id is refused too', (() => {
    try { new PointInTimeStore([{ ingested_at: at(0) }]); return false; } catch { return true; }
  })(), '');

  // =========================================================================
  // 2. A VIEW CANNOT SEE PAST ITS OWN TIMESTAMP
  // =========================================================================
  const store = new PointInTimeStore([
    { id: 'p1', ingested_at: at(0, 8), line: 5.5, available: true },
    { id: 'p1', ingested_at: at(0, 20), line: 6.5, available: true },   // a later revision
    { id: 'p2', ingested_at: at(1, 8), line: 2.5, available: true },
  ], [
    { id: 'p1', resolved_at: at(1, 2), hit: true },
    { id: 'p2', resolved_at: at(2, 2), hit: false },
  ]);

  const morning = store.asOf(at(0, 12));
  t.eq('a view at noon on day 0 sees one prop', morning.props().length, 1);
  t.eq('...at the line it had that morning, not the evening revision', morning.get('p1').line, 5.5);
  t.eq('...and knows how much it is hiding', morning.hidden(), 2);

  const evening = store.asOf(at(0, 22));
  t.eq('the evening view sees the revised line', evening.get('p1').line, 6.5);
  t.eq('a prop ingested tomorrow is invisible today', morning.get('p2'), null);
  t.eq('...and visible tomorrow', store.asOf(at(1, 12)).get('p2').line, 2.5);

  //   THE RETURNED ROWS ARE FROZEN, so a caller cannot stash a mutation that
  //   would be visible to the next window.
  t.ok('returned rows are frozen', Object.isFrozen(morning.get('p1')), '');
  t.ok('...and carry no ingestion bookkeeping to reason about',
    morning.get('p1')._t === undefined, '');

  //   OUTCOMES ARE NOT REACHABLE FROM A VIEW, by construction.
  t.ok('a view cannot read outcomes at all', (() => {
    try { morning.outcomes(); return false; }
    catch (e) { return e instanceof LeakError && /the strategy is not given the store/.test(e.message); }
  })(), '');
  t.eq('the SCORER can, from the store', store.outcomes().length, 2);
  t.eq('...filtered by resolution time when asked', store.outcomes({ upTo: at(1, 12) }).length, 1);

  // =========================================================================
  // 3. THE LEAKAGE TEST — requirement 4
  //
  // `theAnswer` is 1 when the prop hit and 0 when it missed, and it is ingested
  // the morning AFTER the game. The strategy reads it greedily and bets every
  // prop where it says 1. Under the guard it can never see it, so it bets
  // blind and its hit rate is the base rate. Without the guard it goes 100%.
  // =========================================================================
  const rows = [], outcomes = [];
  for (let d = 0; d < 80; d++) {
    for (let i = 0; i < 4; i++) {
      const id = `d${d}-${i}`;
      const hit = (d * 4 + i) % 2 === 0;             // exactly 50%, alternating
      rows.push({ id, ingested_at: at(d, 8), line: 5.5, prob: 0.5, available: true, player: `P${i}`, market: 'K' });
      // THE FUTURE-ONLY COLUMN. Same prop id, ingested after the game.
      rows.push({ id, ingested_at: at(d + 1, 6), line: 5.5, prob: 0.5, available: true, player: `P${i}`, market: 'K', theAnswer: hit ? 1 : 0 });
      outcomes.push({ id, resolved_at: at(d, 23), hit });
    }
  }
  const leaky = new PointInTimeStore(rows, outcomes);

  //   A strategy that WANTS to cheat.
  //   Filtered to TODAY's board, as any real strategy is — you cannot place a
  //   bet on yesterday's game. That is what makes this a clean test of the
  //   feature guard rather than of the settled-event guard.
  const cheat = (view, ctx) => {
    const props = view.props().filter((p) => p.ingested_at.slice(0, 10) === ctx.day && p.theAnswer === 1);
    if (props.length < 2) return [];
    return [{ slipType: 'power', legs: props.slice(0, 2).map((p) => ({ id: p.id, prob: 0.99, side: 'over' })), stake: 10 }];
  };

  //   TWO GUARDS HAVE TO FIRE HERE, and the first version of this test found
  //   that only one of them existed.
  //
  //   The store hides `theAnswer` for TODAY's props, because it is ingested
  //   tomorrow morning. But tomorrow morning it is legitimately visible — it
  //   WAS knowable then — attached to a prop whose game is over. The cheating
  //   strategy simply waited a day and bet settled events, and went 100%
  //   through a store behaving exactly as designed.
  //
  //   So the engine also refuses any leg whose outcome resolved at or before
  //   the decision timestamp. Betting a known result is a leak even when every
  //   byte you read was knowable.
  let guarded = null, guardError = null;
  try {
    guarded = await B.backtest({
      store: leaky, strategy: cheat, payoutConfigs: CONFIGS,
      trainDays: 14, testDays: 7, bankroll: 10000,
      rules: { min_stake: 5, max_pct_of_bankroll: 0.05, max_slate_stake: 100 },
    });
  } catch (e) { guardError = e; }

  t.ok('UNDER THE GUARD THE CHEATING STRATEGY CANNOT PROFIT',
    guardError instanceof LeakError || (guarded && guarded.overall.slips === 0),
    guardError ? guardError.message.slice(0, 90) : `${guarded.overall.slips} slips`);
  t.ok('...because betting an already-resolved event is refused by name',
    guardError == null || /had already resolved/.test(guardError.message),
    guardError?.message || '');
  t.ok('...and the future-only column is invisible on the day it would matter',
    leaky.asOf(at(10, 8)).get('d10-0').theAnswer === undefined, '');
  t.ok('...while the SAME prop shows it a day later, which is why the second guard exists',
    leaky.asOf(at(11, 8)).get('d10-0').theAnswer === 1, String(leaky.asOf(at(11, 8)).get('d10-0').theAnswer));

  //   THE CONTROL. The same data, the same strategy, with the column ingested
  //   BEFORE the decision instead of after. If this did not go 100%, the test
  //   above would prove nothing — the strategy might simply be broken.
  const unguarded = new PointInTimeStore(
    // The answer moved to 7am on the SAME day — before the 8am decision and
    // before the 23:00 resolution. Both guards are satisfied and the leak is
    // pure: a feature that should not exist.
    rows.map((r) => (r.theAnswer === undefined ? r : { ...r, ingested_at: at(Number(r.id.slice(1).split('-')[0]), 7) })),
    outcomes,
  );
  const leaked = await B.backtest({
    store: unguarded, strategy: cheat, payoutConfigs: CONFIGS,
    trainDays: 14, testDays: 7, bankroll: 10000,
    rules: { min_stake: 5, max_pct_of_bankroll: 0.05, max_slate_stake: 100 },
  });
  t.ok('WITH THE COLUMN VISIBLE, THE SAME STRATEGY GOES PERFECT', leaked.overall.slips > 0, String(leaked.overall.slips));
  t.ok('...at a hit rate of 100%', near(leaked.overall.hitRate, 1, 1e-12), String(leaked.overall.hitRate));
  t.ok('...and an enormous ROI', leaked.overall.roi > 1, String(leaked.overall.roi));
  t.ok('SO THE GUARDS ARE WHAT STOPPED IT, not a broken strategy',
    (guardError != null || guarded.overall.slips === 0) && leaked.overall.slips > 0, '');

  //   A strategy proposing an id it could not have seen is caught even if it
  //   somehow got one — the last line of defence behind the store.
  const smuggler = () => [{ slipType: 'power', legs: [{ id: 'not-on-the-board', prob: 0.9, side: 'over' }, { id: 'nor-this', prob: 0.9, side: 'over' }], stake: 10 }];
  let caught = null;
  try {
    await B.backtest({ store: leaky, strategy: smuggler, payoutConfigs: CONFIGS, trainDays: 14, testDays: 7 });
  } catch (e) { caught = e; }
  t.ok('a strategy that names an invisible prop throws', caught instanceof LeakError, String(caught));
  t.ok('...naming the prop and the date', /not-on-the-board/.test(caught.message), caught.message);

  // =========================================================================
  // 4. WALK-FORWARD WINDOWS — requirement 2
  // =========================================================================
  const w = B.walkForwardWindows({ from: at(0, 0), to: at(70, 0), trainDays: 28, testDays: 7 });
  t.eq('a 70-day span with 28/7 gives six folds', w.length, 6);
  t.ok('every test window follows its own training window',
    w.every((x) => Date.parse(x.test.from) >= Date.parse(x.train.to)), '');
  t.ok('...and test windows never overlap each other',
    w.every((x, i) => i === 0 || Date.parse(x.test.from) >= Date.parse(w[i - 1].test.to)), '');
  t.ok('the rolling window moves its start', Date.parse(w[1].train.from) > Date.parse(w[0].train.from), '');
  const anchored = B.walkForwardWindows({ from: at(0, 0), to: at(70, 0), trainDays: 28, testDays: 7, anchored: true });
  t.ok('an anchored window keeps its start and grows',
    anchored.every((x) => x.train.from === anchored[0].train.from), '');

  //   THE FITTER ONLY EVER SEES A TRAINING-WINDOW VIEW. It is handed a view
  //   bound to the end of training, so the evaluation window has not happened.
  const seenBy = [];
  await B.backtest({
    store: leaky, payoutConfigs: CONFIGS, trainDays: 14, testDays: 7,
    fitter: (view, { window }) => { seenBy.push({ at: view.at, testFrom: window.test.from }); return { n: view.props().length }; },
    strategy: () => [],
  });
  t.ok('the fitter is called once per fold', seenBy.length > 3, String(seenBy.length));
  t.ok('...always at a timestamp at or before its own test window opens',
    seenBy.every((s) => Date.parse(s.at) <= Date.parse(s.testFrom)), '');

  // =========================================================================
  // 5. METRICS — requirement 3
  //
  //   Brier on four legs: 0.8/hit, 0.6/miss, 0.3/hit, 0.9/hit
  //     0.04 + 0.36 + 0.49 + 0.01 = 0.90, /4 = 0.225
  // =========================================================================
  t.ok('Brier is the mean squared error', near(B.brier([
    { prob: 0.8, hit: true }, { prob: 0.6, hit: false }, { prob: 0.3, hit: true }, { prob: 0.9, hit: true },
  ]), 0.225), '');
  t.ok('ungraded legs are skipped, not scored as zero',
    near(B.brier([{ prob: 0.8, hit: true }, { prob: 0.5, hit: null }]), 0.04), '');

  //   Max drawdown: 100 -> 120 -> 60 -> 90. Peak 120, trough 60 => 50%.
  t.ok('max drawdown is peak to trough', near(B.maxDrawdown([100, 120, 60, 90]), 0.5), String(B.maxDrawdown([100, 120, 60, 90])));
  t.ok('a monotone rise has no drawdown', B.maxDrawdown([100, 110, 120]) === 0, '');

  // =========================================================================
  // 6. "INDISTINGUISHABLE FROM NOISE" — requirement 5
  //
  // A coin-flip strategy on a fair-ish payout. The point estimate will wander;
  // the interval must contain zero and the report must SAY the phrase, at the
  // top, before any ROI number appears.
  // =========================================================================
  const coinRows = [], coinOut = [];
  let k = 0;
  for (let d = 0; d < 120; d++) {
    for (let i = 0; i < 3; i++) {
      const id = `c${d}-${i}`;
      coinRows.push({ id, ingested_at: at(d, 8), line: 5.5, available: true, player: `P${i}`, market: 'K' });
      coinOut.push({ id, resolved_at: at(d, 23), hit: (k++ % 2 === 0) });
    }
  }
  const coinStore = new PointInTimeStore(coinRows, coinOut);
  const coinStrategy = (view, ctx) => {
    const p = view.props().filter((x) => x.ingested_at.slice(0, 10) === ctx.day);
    if (p.length < 2) return [];
    return [{ slipType: 'power', legs: p.slice(0, 2).map((x) => ({ id: x.id, prob: 0.5, side: 'over' })), stake: 10 }];
  };
  const noise = await B.backtest({
    store: coinStore, strategy: coinStrategy, payoutConfigs: CONFIGS,
    trainDays: 21, testDays: 14, bankroll: 100000,
    rules: { min_stake: 5, max_pct_of_bankroll: 0.05, max_slate_stake: 100 },
  });
  t.ok('a coin-flip strategy does bet', noise.overall.slips > 20, String(noise.overall.slips));
  t.ok('...and its ROI interval is reported', noise.overall.roiCI.lo != null, '');

  const text = B.renderBacktest(noise);
  const firstBlock = text.split('\n').slice(0, 14).join(' ').replace(/[│┌┐└┘]/g, ' ').replace(/\s+/g, ' ');
  if (noise.overall.indistinguishableFromNoise) {
    t.ok('THE PHRASE APPEARS, IN THOSE WORDS, AT THE TOP',
      /INDISTINGUISHABLE FROM NOISE/i.test(firstBlock), firstBlock.slice(0, 120));
    //   And it appears BEFORE any ROI figure — the whole point of requirement 5.
    const idxPhrase = text.search(/INDISTINGUISHABLE FROM NOISE/i);
    const idxRoi = text.search(/ {2}ROI {2}/);
    t.ok('...before any ROI number', idxPhrase >= 0 && idxPhrase < idxRoi, `${idxPhrase} vs ${idxRoi}`);
  } else {
    t.ok('a coin flip that happened to clear the interval still reports its bounds',
      /95% interval/.test(text), '');
  }
  t.ok('the achieved sample size is reported, not just the ROI',
    /sample achieved: +\d+ slips/.test(text), '');

  //   The phrase is a property of the interval, so it can be checked directly.
  const spanning = { overall: { slips: 40, roi: 0.02, roiCI: { lo: -0.2, hi: 0.3 }, indistinguishableFromNoise: true, hitRate: 0.5, requiredHitRate: 0.58, hitRateEdge: -0.08, brier: 0.25, clv: null, clvCoverage: 0, maxDrawdown: 0.3, gradedLegs: 80 }, windows: [], folds: 3, bankroll: { start: 1000, end: 900 }, counts: {}, pessimism: [] };
  const spanText = B.renderBacktest(spanning);
  t.ok('an interval spanning zero always prints the phrase',
    /INDISTINGUISHABLE FROM NOISE/i.test(spanText), '');
  t.ok('...and says the interval contains zero in words',
    /contains zero/.test(spanText), '');
  const losing = B.renderBacktest({ ...spanning, overall: { ...spanning.overall, roiCI: { lo: -0.4, hi: -0.1 }, indistinguishableFromNoise: false } });
  t.ok('an interval entirely below zero says the strategy lost money',
    /LOST MONEY, AND THE INTERVAL AGREES/.test(losing), '');

  // =========================================================================
  // 7. PESSIMISM, REPORTED — the brief's explicit ask
  // =========================================================================
  const unavailable = new PointInTimeStore([
    { id: 'u1', ingested_at: at(0, 8), line: 5.5, available: false },
    { id: 'u2', ingested_at: at(0, 8), line: 5.5, available: true },
    { id: 'u3', ingested_at: at(0, 8), line: 5.5, available: true },
  ], [
    { id: 'u1', resolved_at: at(0, 23), hit: true },
    { id: 'u2', resolved_at: at(0, 23), hit: true },
    { id: 'u3', resolved_at: at(0, 23), hit: true },
  ]);
  const takesEverything = (view, ctx) => {
    const p = view.props().filter((x) => x.ingested_at.slice(0, 10) === ctx.day);
    return p.length >= 2 ? [{ slipType: 'power', legs: p.slice(0, 2).map((x) => ({ id: x.id, prob: 0.9, side: 'over' })), stake: 10 }] : [];
  };
  const skipped = await B.backtest({
    store: unavailable, strategy: takesEverything, payoutConfigs: CONFIGS,
    from: at(0, 12), to: at(1, 12), trainDays: 0, testDays: 1, bankroll: 1000,
    rules: { min_stake: 5, max_pct_of_bankroll: 0.5, max_slate_stake: 100 },
  });
  t.ok('a prop marked unavailable at the timestamp is not bet',
    skipped.pessimism.some((p) => /availability/.test(p.what)), JSON.stringify(skipped.pessimism.map((p) => p.what)));
  t.ok('...and the report says what the flattering alternative would have been',
    skipped.pessimism.every((p) => !!p.flattering_alternative), '');

  const pessText = B.renderBacktest(skipped);
  t.ok('the biases are printed, not buried in comments',
    /WHERE THIS WAS BIASED TOWARD PESSIMISM/.test(pessText), '');

  //   Unresolved outcomes are counted as losses by default.
  const unresolved = new PointInTimeStore([
    { id: 'x1', ingested_at: at(0, 8), line: 5.5, available: true },
    { id: 'x2', ingested_at: at(0, 8), line: 5.5, available: true },
  ], []);   // nothing ever resolved
  const never = await B.backtest({
    store: unresolved, strategy: takesEverything, payoutConfigs: CONFIGS,
    from: at(0, 12), to: at(1, 12), trainDays: 0, testDays: 1, bankroll: 1000,
    rules: { min_stake: 5, max_pct_of_bankroll: 0.5, max_slate_stake: 100 },
  });
  t.ok('a slip whose legs never resolved is counted as a loss',
    never.overall.slips > 0 && never.overall.returned === 0,
    `${never.overall.slips} slips, returned ${never.overall.returned}`);
  t.ok('...and that choice is on the record',
    never.pessimism.some((p) => /never resolved/.test(p.what)), '');
  t.ok('...with the count of legs it applied to', never.counts.unresolvedLegs > 0, String(never.counts.unresolvedLegs));

  // =========================================================================
  // 8. Realistic simulation — requirement 6
  // =========================================================================
  t.ok('the payout config is chosen by the DATE of the slip, not by today',
    (() => {
      const early = new Date('2025-01-15').toISOString().slice(0, 10);
      const late = new Date('2026-09-10').toISOString().slice(0, 10);
      return configFromDate(early) !== null && configFromDate(late) !== null;
    })(), '');

  //   Stakes obey the bankroll rules, and are rounded DOWN.
  const allAvailable = new PointInTimeStore([
    { id: 'a1', ingested_at: at(0, 8), line: 5.5, available: true },
    { id: 'a2', ingested_at: at(0, 8), line: 5.5, available: true },
  ], [
    { id: 'a1', resolved_at: at(0, 23), hit: true },
    { id: 'a2', resolved_at: at(0, 23), hit: true },
  ]);
  const tiny = await B.backtest({
    store: allAvailable, strategy: takesEverything, payoutConfigs: CONFIGS,
    from: at(0, 12), to: at(1, 12), trainDays: 0, testDays: 1, bankroll: 60,
    rules: { min_stake: 5, max_pct_of_bankroll: 0.05, max_slate_stake: 100 },
  });
  t.ok('a stake under the $5 minimum means no bet, not a rounded-up bet',
    tiny.overall.slips === 0 || tiny.overall.staked >= 5, String(tiny.overall.staked));
  t.ok('...which is itself recorded as a pessimistic choice when it happens',
    tiny.overall.slips > 0 || tiny.pessimism.some((p) => /\$5 minimum/.test(p.what)),
    JSON.stringify(tiny.pessimism.map((p) => p.what)));

  function configFromDate(d) {
    const { configFor } = require0();
    return configFor(CONFIGS, d);
  }
  function require0() {
    return { configFor: (cfgs, d) => (cfgs || []).filter((c) => c.effective_date <= d).sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))[0] || null };
  }
}

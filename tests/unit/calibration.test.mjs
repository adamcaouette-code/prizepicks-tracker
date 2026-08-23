// Calibration, scored per league.
//
// A rater can be sharp on baseball and hopeless on tennis. Pooling them into one
// Brier says neither, and the blended number moves for reasons that have nothing
// to do with the league you're about to bet on. So every league gets its own
// full calibration — Brier, bands, record, coverage — with the overall kept
// alongside.
//
// The cost is real and worth pinning too: splitting the sample means each league
// needs its own ~50 graded picks before it means anything.

import { loadFn } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

const DAY = '2026-08-14';
const mk = (league, prob, hit, i) => ({
  date: DAY, loggedAt: DAY + 'T18:00:00Z', league, source: 'board',
  projectionId: `${league}-${i}`, player: `P${i}`, stat: 'Hits', line: 0.5,
  prob, verdict: prob >= 0.62 ? 'play' : 'lean', oddsType: 'standard',
  result: hit ? 1 : 0, hit, gradedAt: DAY + 'T23:00:00Z',
});

export default async function ({ t }) {
  reset();
  // MLB claims 70% and lands 7 of 10 — honest.
  // TENNIS claims the same 70% and lands 2 of 10 — badly overconfident.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mk('mlb', 0.70, i < 7, i));
  for (let i = 0; i < 10; i++) rows.push(mk('tennis', 0.70, i < 2, 100 + i));
  seed('pick-log', DAY, rows);

  const cal = await loadFn('calibration.js');
  const res = JSON.parse((await cal.handler({ queryStringParameters: { format: 'json' } })).body);

  t.eq('every graded pick still counts toward the overall', res.graded, 20);
  t.ok('the overall Brier lands between the two — which is exactly the problem with pooling',
    res.brier > 0 && res.brier < 1, res.brier.toFixed(3));

  const mlb = res.leagues?.mlb, tennis = res.leagues?.tennis;
  t.eq('MLB is scored on its own sample', mlb?.graded, 10);
  t.eq('...at its real hit rate', Math.round((mlb.playsLeans.hits / mlb.playsLeans.n) * 100), 70);
  t.eq('tennis is scored separately', tennis?.graded, 10);
  t.eq('...at ITS real hit rate', Math.round((tennis.playsLeans.hits / tennis.playsLeans.n) * 100), 20);

  // The whole point of separating them.
  t.ok('the honest league scores better apart than pooled',
    mlb.brier < res.brier, `mlb ${mlb.brier.toFixed(3)} vs overall ${res.brier.toFixed(3)}`);
  t.ok('...and the overconfident one is no longer hidden behind it',
    tennis.brier > res.brier, `tennis ${tennis.brier.toFixed(3)} vs overall ${res.brier.toFixed(3)}`);

  t.ok('each league carries its own bands, not just a count',
    Array.isArray(mlb.bands) && mlb.bands.length > 0);
  t.ok('...and its own coverage figures',
    typeof mlb.logged === 'number' && typeof mlb.pending === 'number');
  t.eq('a league does not recursively split itself', mlb.leagues, undefined);
  t.eq('the overall counter is kept alongside', typeof res.brier, 'number');

  // ---- the honest cost of splitting --------------------------------------
  t.ok('each league is small enough to be flagged EARLY on its own',
    mlb.graded < 50 && tennis.graded < 50, `mlb n=${mlb.graded}, tennis n=${tennis.graded}`);
  const html = (await cal.handler({ queryStringParameters: {} })).body;
  t.ok('the page renders a per-league table', /<th>league<\/th>/.test(html));
  t.ok('...with a brier column per league', /<th>brier<\/th>/.test(html));
  t.ok('...naming both leagues', /MLB/.test(html) && /TENNIS/.test(html));
  t.ok('...flagging the small samples rather than presenting them as settled',
    /early · n=10/.test(html), (html.match(/early · n=\d+/g) || []).join(' '));
  t.ok('...and stating why splitting costs sample size',
    /needs its own\s+~50 graded picks/.test(html));

  // ---- a dormant league is kept out of the record entirely ---------------
  // The World Cup runs once every four years. A handful of picks from one
  // tournament say nothing about a slate you can actually bet, and they will not
  // be refreshed for years — so they only drag the overall number around. That
  // is different from a league performing BADLY, which is a finding worth
  // keeping; this is a dormant one, which is noise.
  reset();
  const withWC = [];
  for (let i = 0; i < 10; i++) withWC.push(mk('mlb', 0.70, i < 7, i));
  for (let i = 0; i < 10; i++) withWC.push(mk('world_cup', 0.70, i < 3, 200 + i));
  seed('pick-log', DAY, withWC);
  const calWC = await loadFn('calibration.js');
  const wc = JSON.parse((await calWC.handler({ queryStringParameters: { format: 'json' } })).body);

  t.eq('World Cup picks are excluded from the graded count', wc.graded, 10);
  t.eq('...and get no league row of their own', wc.leagues?.world_cup, undefined);
  t.eq('...while MLB is untouched', wc.leagues?.mlb?.graded, 10);
  t.ok('...and the overall Brier is MLB\'s alone, not dragged by a dormant league',
    Math.abs(wc.brier - wc.leagues.mlb.brier) < 1e-9,
    `overall ${wc.brier.toFixed(3)} vs mlb ${wc.leagues.mlb.brier.toFixed(3)}`);
  const wcHtml = (await calWC.handler({ queryStringParameters: {} })).body;
  t.ok('...and it never appears in the table', !/WORLD_CUP/i.test(wcHtml));

  // Excluding rather than only deleting matters: a future tournament must not
  // silently start counting again without a decision being made.
  t.ok('the exclusion is a named list, so it survives new picks arriving',
    calWC.EXCLUDED_LEAGUES.has('world_cup') && calWC.EXCLUDED_LEAGUES.has('fifa_world_cup'));

  // ---- a league with nothing graded doesn't clutter the table -------------
  reset();
  seed('pick-log', DAY, [
    mk('mlb', 0.7, true, 1),
    { ...mk('nfl', 0.7, null, 2), hit: null, result: null, gradedAt: null },
  ]);
  const cal2 = await loadFn('calibration.js');
  const res2 = JSON.parse((await cal2.handler({ queryStringParameters: { format: 'json' } })).body);
  t.eq('an ungraded league is still tracked in the data', typeof res2.leagues?.nfl, 'object');
  t.eq('...with zero graded', res2.leagues.nfl.graded, 0);
  const html2 = (await cal2.handler({ queryStringParameters: {} })).body;
  t.ok('...but is left out of the table until it has a result',
    !/<td>NFL<\/td>/.test(html2));

  // ---- by prop type -------------------------------------------------------
  // The question: is the engine wrong about a KIND of prop, rather than about
  // individual players? PrizePicks already prices rarity into the TIER — a home
  // run "over 0.5" is unlikely, which is why it posts as standard or demon
  // rather than goblin — so rarity alone should not surface here. What surfaces
  // is what the tier does not capture.
  reset();
  const stat = (league, name, prob, hit, i, tier = 'standard') => ({
    ...mk(league, prob, hit, i), stat: name, oddsType: tier,
  });
  const rows2 = [];
  // Honest: claims 60%, hits 60% over 20 picks.
  for (let i = 0; i < 20; i++) rows2.push(stat('mlb', 'Hits', 0.60, i < 12, i));
  // Badly overstated, and on enough picks to matter: claims 55%, hits 20%.
  for (let i = 0; i < 40; i++) rows2.push(stat('mlb', 'Home Runs', 0.55, i < 8, 100 + i));
  // A big miss on a tiny sample — must NOT outrank the row above.
  for (let i = 0; i < 4; i++) rows2.push(stat('mlb', 'Triples', 0.80, false, 300 + i));
  // Same stat NAME, different sport: "Fantasy Score" is an unrelated quantity in
  // each, and pooling them would average two different things into one row.
  for (let i = 0; i < 25; i++) rows2.push(stat('wnba', 'Fantasy Score', 0.50, i < 20, 400 + i));
  for (let i = 0; i < 25; i++) rows2.push(stat('mlb', 'Fantasy Score', 0.50, i < 5, 500 + i));
  seed('pick-log', DAY, rows2);

  const cal3 = await loadFn('calibration.js');
  const res3 = JSON.parse((await cal3.handler({ queryStringParameters: { format: 'json' } })).body);
  const byStat = res3.byStat;

  t.eq('prop types are keyed by league AND stat', Object.keys(byStat).includes('mlb :: Home Runs'), true);
  t.ok('the same stat name in two sports stays two rows',
    byStat['mlb :: Fantasy Score'] && byStat['wnba :: Fantasy Score'], Object.keys(byStat).join(' | '));
  t.eq('...and they are not averaged together',
    [byStat['mlb :: Fantasy Score'].actual, byStat['wnba :: Fantasy Score'].actual], [0.2, 0.8]);

  t.eq('an honest prop type reports no gap',
    Math.round(byStat['mlb :: Hits'].overstatement * 100), 0);
  t.eq('an overstated one reports the gap it earned',
    Math.round(byStat['mlb :: Home Runs'].overstatement * 100), 35);
  // The tier split carries its OWN rate, not just a count. A prop type's blended
  // rate cannot be quoted at an individual prop: it mixes goblin lines that go
  // over ~70% of the time with demon lines that go over ~20%, so handing a judge
  // that already knows the tier one averaged number pushes it wrong on both.
  t.eq('...with the tier mix that produced it, each tier carrying its own rate',
    byStat['mlb :: Home Runs'].tiers, { standard: { n: 40, hits: 8, rate: 0.2 } });
  t.eq('a prop type split across tiers reports each one separately',
    Object.keys(byStat['mlb :: Hits'].tiers), ['standard']);

  // THE RANKING RULE. Triples is off by 80 points but on 4 picks; Home Runs is
  // off by 35 on 40. Ranking by percentage would put Triples on top and send you
  // chasing a rounding error while the row that actually moves the Brier sits
  // below it.
  const order = Object.keys(byStat);
  t.ok('ranked by TOTAL error contributed, not by the biggest percentage miss',
    order.indexOf('mlb :: Home Runs') < order.indexOf('mlb :: Triples'), order.join(' | '));

  const html3 = (await cal3.handler({ queryStringParameters: {} })).body;
  t.ok('the prop-type table renders', /By prop type/.test(html3));
  t.ok('...naming the worst offender', /mlb :: Home Runs/.test(html3));
  t.ok('...and greys a row too thin to trust', /style="color:var\(--faint\)"><td>mlb :: Triples/.test(html3));
  t.ok('a tier with enough picks shows its rate', /sta 40 @20\.0%/.test(html3));
  t.ok('...and a tier too thin to trust shows only its count, not a made-up rate',
    /sta 4(?!0)[^@]/.test(html3.replace(/\s+/g, ' ')) || !/@/.test(html3.split('Triples')[1].slice(0, 120)));

  // ---- does the judge beat the tier, and does the signal concentrate? -----
  // Two different questions. LIFT asks whether the judge separates its own good
  // picks from its bad ones inside one tier — whether it has any signal at all
  // beyond reading the payout tier back to us. The TOP SLICES ask whether that
  // signal is enough: if you only ever bet its very best picks, does the rate
  // climb far enough to clear the payout? A judge can have real, measurable lift
  // and still have nothing bettable at any threshold.
  reset();
  const sk = (prob, hit, i, tier) => ({ ...mk('mlb', prob, hit, i), oddsType: tier });
  const rows4 = [];
  // GOBLIN: signal that CONCENTRATES. Probabilities descend 0.90 -> 0.60 and the
  // hit rate falls with them, so a narrower slice is a better one.
  //   top 10% (30)  27 hit  90%      top 30% (90)   72 hit  80%
  //   top 20% (60)  51 hit  85%      top 50% (150) 102 hit  68%
  const gRate = (i) => (i < 30 ? i < 27 : i < 60 ? i < 54 : i < 90 ? i < 81 : i < 150 ? i < 120 : i < 195);
  for (let i = 0; i < 300; i++) rows4.push(sk(0.9 - i * 0.001, gRate(i), i, 'goblin'));
  // DEMON: honest numbers, no ranking signal. Every slice hits 30%, so narrowing
  // buys nothing and no threshold can rescue it.
  for (let i = 0; i < 300; i++) rows4.push(sk(0.9 - i * 0.001, i % 10 < 3, 1000 + i, 'demon'));
  // STANDARD: too few to split, and must not be guessed at.
  for (let i = 0; i < 10; i++) rows4.push(sk(0.60, i < 5, 2000 + i, 'standard'));
  seed('pick-log', DAY, rows4);

  const cal4 = await loadFn('calibration.js');
  const res4 = JSON.parse((await cal4.handler({ queryStringParameters: { format: 'json' } })).body);

  t.eq('a judge that ranks well shows real lift inside the tier',
    Math.round(res4.skill.goblin.lift * 100), 38);
  t.eq('...separating its best half from its worst',
    [res4.skill.goblin.topHalf, res4.skill.goblin.bottomHalf], [0.68, 0.3]);
  t.eq('a judge that ranks at random shows none, however honest its numbers are',
    res4.skill.demon.lift, 0);
  t.eq('a tier too thin to split is left out rather than guessed at',
    res4.skill.standard, undefined);

  // The split is kept INSIDE a tier on purpose. Pooled, this judge looks skilled
  // — its goblins beat its demons — but that is the tier talking, not the judge.
  t.ok('the comparison never crosses tiers, where the tier would do the work',
    res4.skill.goblin.tierRate === 0.49 && res4.skill.demon.tierRate === 0.3);

  // Honest and useless are different failures, and this is what separates them:
  // a goblin needs 79.4% a leg on a 3-pick just to return the stake.
  t.ok('break-even is the real payout table, not a round number',
    Math.abs(res4.skill.goblin.breakEven - 0.7937) < 0.001, String(res4.skill.goblin.breakEven));
  t.eq('betting the whole tier blind does not clear it', res4.skill.goblin.baselineClears, false);
  t.eq('...and neither does its best half here', res4.skill.goblin.bestHalfClears, false);

  // THE POINT: the half is not bettable, but the signal keeps concentrating, so
  // a stricter threshold IS a route to a bettable board. That is the finding a
  // lift number alone cannot give you.
  const gob = res4.skill.goblin.topSlices.map((x) => [x.pctile, x.n, x.rate, x.clears]);
  t.eq('the rate climbs as the slice narrows', gob.map((x) => x[2]), [0.9, 0.85, 0.8, 0.68]);
  t.eq('...and the narrow slices clear break-even where the half did not',
    gob.map((x) => x[3]), [true, true, true, false]);

  // A judge with no ranking signal stays flat however hard you filter it — the
  // outcome that says no threshold will help and the fix is better information.
  t.eq('flat slices mean no threshold rescues it',
    res4.skill.demon.topSlices.map((x) => x.rate), [0.3, 0.3, 0.3, 0.3]);
  t.eq('...and none of them clear', res4.skill.demon.topSlices.every((x) => x.clears === false), true);

  const html4 = (await cal4.handler({ queryStringParameters: {} })).body;
  t.ok('the table renders', /Does the judge beat the tier\?/.test(html4));
  t.ok('...and says plainly that honest is not the same as bettable',
    /being honest about a bad number does not make it a\s+good one/.test(html4));

  // ---- judge behaviour, readable before a single game settles -------------
  // The worry about a cheaper model is not that it reasons worse in the
  // abstract, it is that it follows a demanding prompt less faithfully. That is
  // checkable the hour a run finishes, against zero graded picks — which is the
  // difference between deciding the model question on Monday and deciding it in
  // three weeks.
  reset();
  const beh = (prob, tier, i, extra = {}) =>
    ({ ...mk('mlb', prob, null, i), oddsType: tier, hit: null, gradedAt: null, ...extra });
  const rows5 = [];
  // A judge that READ the tier instruction: goblins high, demons low, a real
  // spread, unrounded numbers, and the required field filled in.
  for (let i = 0; i < 30; i++) rows5.push(beh(0.68 + i * 0.003, 'goblin', i, { promptVersion: 'aphrodite', judgeModel: 'good', cleared: 4 }));
  for (let i = 0; i < 30; i++) rows5.push(beh(0.18 + i * 0.003, 'demon', 100 + i, { promptVersion: 'aphrodite', judgeModel: 'good', cleared: 1 }));
  // A judge that IGNORED it: everything at a coin flip regardless of tier, every
  // answer a round number, the required field dropped. This is what a prompt
  // failing to land looks like, and none of it needs an outcome to see.
  for (let i = 0; i < 30; i++) rows5.push(beh(0.55, 'goblin', 200 + i, { promptVersion: 'aphrodite', judgeModel: 'bad' }));
  for (let i = 0; i < 30; i++) rows5.push(beh(0.50, 'demon', 300 + i, { promptVersion: 'aphrodite', judgeModel: 'bad' }));
  seed('pick-log', DAY, rows5);

  const cal5 = await loadFn('calibration.js');
  const res5 = JSON.parse((await cal5.handler({ queryStringParameters: { format: 'json' } })).body);
  const good = res5.behaviour['aphrodite · good'], bad = res5.behaviour['aphrodite · bad'];

  t.eq('behaviour is measured with nothing graded at all', res5.graded, 0);
  t.eq('...on every logged pick', [good.n, bad.n], [60, 60]);

  // THE headline: did the tier instruction land?
  t.eq('a judge that read the tier separates goblins from demons', Math.round(good.tierGap * 100), 50);
  t.eq('one that ignored it prices them almost the same', Math.round(bad.tierGap * 100), 5);

  t.ok('...and hedges toward the middle instead of using the range',
    bad.spread < good.spread, `${bad.spread.toFixed(3)} vs ${good.spread.toFixed(3)}`);
  t.eq('every answer a round number is what verdict-first reasoning looks like',
    [Math.round(bad.roundShare * 100), Math.round(good.roundShare * 100)], [100, 0]);
  t.eq('a dropped required field is instruction-following failing in the open',
    [bad.clearedShare, good.clearedShare], [0, 1]);
  // Two values across sixty picks versus a real distribution — an order of
  // magnitude apart, which is the shape of the claim rather than any one number.
  t.ok('a judge repeating two values has almost no granularity',
    bad.granularity < 0.05 && good.granularity > bad.granularity * 5,
    `bad ${bad.granularity.toFixed(3)} vs good ${good.granularity.toFixed(3)}`);

  const html5 = (await cal5.handler({ queryStringParameters: {} })).body;
  t.ok('the table renders', /Judge behaviour — readable the same day/.test(html5));
  t.ok('...and names the tier gap as the test that matters', /<b>Tier gap<\/b> is the headline/.test(html5));
}

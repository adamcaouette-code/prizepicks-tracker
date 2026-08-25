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
  // Two values across sixty picks versus a real distribution. Measured as
  // PERPLEXITY — 2^H over how often each distinct probability appears, i.e. how
  // many values the judge is effectively using — because distinct/n falls
  // mechanically as n grows and so cannot compare configs of different sizes.
  t.ok('a judge alternating two values is effectively using two',
    Math.abs(bad.effectiveValues - 2) < 0.01, String(bad.effectiveValues));
  t.ok('...while a real distribution uses many more', good.effectiveValues > 10,
    String(good.effectiveValues));
  t.eq('the raw count rides along, since a count is only readable next to its n',
    [bad.distinctValues, bad.n], [2, 60]);

  // THE POINT: the metric must not move just because one config has more picks.
  // A judge with 4x the sample and the same behaviour must score the same.
  reset();
  const big = [];
  for (let i = 0; i < 240; i++) big.push(beh(i % 2 ? 0.55 : 0.50, 'goblin', 500 + i, { promptVersion: 'aphrodite', judgeModel: 'bigsample' }));
  seed('pick-log', DAY, big);
  const calBig = await loadFn('calibration.js');
  const resBig = JSON.parse((await calBig.handler({ queryStringParameters: { format: 'json' } })).body);
  t.ok('four times the picks, identical behaviour, identical score',
    Math.abs(resBig.behaviour['aphrodite · bigsample'].effectiveValues - 2) < 0.01,
    `${resBig.behaviour['aphrodite · bigsample'].effectiveValues} at n=240 vs ${bad.effectiveValues} at n=60`);

  // ---- named models read back by name ------------------------------------
  // The models are the user's to name, the same as the prompt versions. A report
  // that answers in model ids makes them translate their own vocabulary back
  // every time they read it.
  reset();
  seed('pick-log', DAY, [
    ...Array.from({ length: 4 }, (_, i) => ({ ...mk('mlb', 0.7, i < 3, 900 + i), judgeModel: 'claude-haiku-4-5-20251001' })),
    ...Array.from({ length: 4 }, (_, i) => ({ ...mk('mlb', 0.7, i < 2, 950 + i), judgeModel: 'claude-opus-4-8' })),
  ]);
  const cal6 = await loadFn('calibration.js');
  const res6 = JSON.parse((await cal6.handler({ queryStringParameters: { format: 'json' } })).body);
  t.eq('a named model is scored under its name', Object.keys(res6.byModel).sort(), ['Vilifiant', 'claude-opus-4-8']);
  t.eq('...and the name follows it into the behaviour table',
    Object.keys(res6.behaviour).some((k) => k.endsWith('· Vilifiant')), true);
  t.eq('an unnamed model still shows its id rather than vanishing',
    res6.byModel['claude-opus-4-8'].n, 4);

  const html5 = (await cal5.handler({ queryStringParameters: {} })).body;
  t.ok('the table renders', /Judge behaviour — readable the same day/.test(html5));
  t.ok('...and names the tier gap as the test that matters', /<b>Tier gap<\/b> is the headline/.test(html5));

  // ---- how close, not just whether ---------------------------------------
  // Two losses that a Brier score cannot tell apart: over 3.5 finishing on 3 was
  // nearly right and broke the wrong way; over 6.5 finishing on 1 was never in
  // it. Both are hit=false with an identical penalty, and that identical penalty
  // discards the most informative thing in the log.
  //
  // Grading itself stays binary on purpose — PrizePicks pays the same nothing
  // for either — so this is a diagnostic, never a score.
  reset();
  const mg = (stat, line, res, i, tier = 'standard') => ({
    ...mk('mlb', 0.6, res > line, 700 + i), stat, line, result: res, oddsType: tier,
  });
  const rows7 = [];
  // A prop the engine READS WELL: results cluster right around the line, and the
  // losses are all within touching distance.
  for (let i = 0; i < 20; i++) rows7.push(mg('Pitcher Strikeouts', 5.5, i % 2 ? 6 : 5, i));
  // A prop it does NOT understand: the line is 6.5 and results come in around 1.
  // Every loss is a blowout, none would be saved by a lower line.
  for (let i = 0; i < 20; i++) rows7.push(mg('Home Runs', 6.5, i % 2 ? 1 : 0, 100 + i));
  // Too few to trust: a spread computed from six points is not a spread.
  for (let i = 0; i < 6; i++) rows7.push(mg('Rare Prop', 2.5, 2, 200 + i));
  seed('pick-log', DAY, rows7);

  const cal7 = await loadFn('calibration.js');
  const res7 = JSON.parse((await cal7.handler({ queryStringParameters: { format: 'json' } })).body);
  const near = res7.margins['mlb :: Pitcher Strikeouts'];
  const far = res7.margins['mlb :: Home Runs'];

  t.eq('a prop that lands on its line reads as near misses', near.nearMissShare, 1);
  t.eq('...and none of them as blowouts', near.blowoutShare, 0);
  t.eq('a prop that lands nowhere near its line reads as blowouts', far.blowoutShare, 1);
  t.eq('...and none of ITS losses as near misses', far.nearMissShare, 0);
  t.ok('...with a mean margin far below the line', far.meanMargin < -5, String(far.meanMargin));
  t.ok('...while the well-read prop sits on it', Math.abs(near.meanMargin) < 0.6, String(near.meanMargin));

  // The actionable column: the 5.5 losses came in at 5, so a line one unit lower
  // would have won every one of them. The 6.5 losses came in at 0-1 and nothing
  // a whole unit lower would have saved them.
  t.eq('losses that a lower line would have saved are counted', near.savedByLowerLine, 1);
  t.eq('...and losses nothing could have saved are not', far.savedByLowerLine, 0);

  t.ok('a stat with too few picks gets no spread invented for it',
    res7.margins['mlb :: Rare Prop'] === undefined);

  // Margins are z-scored per stat before being pooled. Raw, a miss of 0.5 on a
  // home-run line and a miss of 0.5 on a Fantasy Score line of 25 are the same
  // number and mean nothing alike.
  t.ok('the tier view pools only after z-scoring', res7.marginByTier.standard.meanZ != null);
  t.eq('...over every stat that qualified', res7.marginByTier.standard.n, 40);

  const html7 = (await cal7.handler({ queryStringParameters: {} })).body;
  t.ok('the table renders', /How close, not just whether/.test(html7));
  t.ok('...and says plainly that grading stays binary',
    /Grading is binary and stays that way/.test(html7));

  // ---- the tier-only baseline: the bar the judge has to clear -------------
  // A Brier score on its own has no scale. 0.240 is meaningless until you know
  // what the cheapest possible predictor scores on the same picks — output each
  // tier's own base rate and nothing else, no player, no matchup, no model.
  // Until that number is on the page there is nothing for a change to beat.
  reset();
  const bl = (tier, hit, i, prob) => ({ ...mk('mlb', prob, hit, 800 + i), oddsType: tier });
  const rows8 = [];
  // goblin: 70 of 100 hit. A tier lookup says 0.70 on all of them and scores
  // 0.70*0.30 = 0.2100.  The judge says a flat 0.70 too, so it must TIE.
  for (let i = 0; i < 100; i++) rows8.push(bl('goblin', i < 70, i, 0.70));
  // demon: 20 of 100 hit -> lookup scores 0.20*0.80 = 0.1600. The judge says
  // 0.50 on every one, which is much worse, so it must LOSE overall.
  for (let i = 0; i < 100; i++) rows8.push(bl('demon', i < 20, 200 + i, 0.50));
  seed('pick-log', DAY, rows8);

  const cal8 = await loadFn('calibration.js');
  const res8 = JSON.parse((await cal8.handler({ queryStringParameters: { format: 'json' } })).body);

  // LEAVE-ONE-OUT. Each pick is predicted by its tier's rate computed EXCLUDING
  // that pick, so the baseline never scores against an outcome it has already
  // seen. Closed form per tier: h(n-h)/(n-1)^2.
  //   goblin  70*30/99^2 = 0.214264      demon  20*80/99^2 = 0.163249
  //   equal n -> 0.188757
  t.ok('the baseline is leave-one-out, not fitted on the rows it scores',
    Math.abs(res8.baseline - 0.1887562) < 1e-6, String(res8.baseline));
  // The in-sample number is kept because the DIFFERENCE between the two is
  // exactly the hindsight the first version was getting: 0.1850 -> 0.1888.
  t.ok('...with the in-sample figure kept alongside',
    Math.abs(res8.baselineInSample - 0.185) < 1e-9, String(res8.baselineInSample));
  t.ok('...and the gap between them IS the optimism, ~0.0038 here',
    Math.abs((res8.baseline - res8.baselineInSample) - 0.0037562) < 1e-6,
    String(res8.baseline - res8.baselineInSample));

  // Judge: goblin rows say 0.70 against a 0.70 rate -> 0.21; demon rows guess
  // 0.50 against a 0.20 rate -> 0.25. Mean 0.23.
  t.ok('the judge is scored on the same rows', Math.abs(res8.brier - 0.23) < 1e-9, String(res8.brier));
  t.ok('the delta is stated as a loss when the judge is behind',
    Math.abs(res8.baselineDelta - 0.0412) < 1e-9, String(res8.baselineDelta));
  t.eq('...and says plainly that the lookup table won', res8.beatsBaseline, false);

  // Under leave-one-out, a judge that reproduces each tier's rate EXACTLY now
  // edges the baseline rather than tying it — and it wins by precisely the
  // optimism, because it is being handed the in-sample rate the baseline is
  // denied. That is the bar behaving correctly, not a flaw: an honest
  // out-of-sample floor should be beatable by an oracle.
  reset();
  const tie = [];
  for (let i = 0; i < 100; i++) tie.push(bl('goblin', i < 70, i, 0.70));
  for (let i = 0; i < 100; i++) tie.push(bl('demon', i < 20, 200 + i, 0.20));
  seed('pick-log', DAY, tie);
  const cal9 = await loadFn('calibration.js');
  const res9 = JSON.parse((await cal9.handler({ queryStringParameters: { format: 'json' } })).body);
  t.ok('an oracle on the in-sample rates beats leave-one-out by exactly the optimism',
    Math.abs(res9.baselineDelta + 0.0038) < 1e-4, String(res9.baselineDelta));
  t.ok('...and it ties the IN-SAMPLE baseline exactly, as it must',
    Math.abs(res9.brier - res9.baselineInSample) < 1e-9,
    `${res9.brier} vs ${res9.baselineInSample}`);

  // Real skill — separating outcomes INSIDE a tier — beats it properly.
  reset();
  const skilled = [];
  for (let i = 0; i < 100; i++) skilled.push(bl('goblin', i < 70, i, i < 70 ? 0.9 : 0.3));
  for (let i = 0; i < 100; i++) skilled.push(bl('demon', i < 20, 200 + i, i < 20 ? 0.9 : 0.1));
  seed('pick-log', DAY, skilled);
  const cal10 = await loadFn('calibration.js');
  const res10 = JSON.parse((await cal10.handler({ queryStringParameters: { format: 'json' } })).body);
  t.eq('a judge with real within-tier skill beats it', res10.beatsBaseline, true);
  t.ok('...and by far more than the optimism', res10.baselineDelta < -0.05, String(res10.baselineDelta));

  // ---- per config, on its own rows ---------------------------------------
  reset();
  const split = [];
  for (let i = 0; i < 60; i++) split.push({ ...bl('goblin', i < 42, i, 0.70), promptVersion: 'psyche' });
  for (let i = 0; i < 60; i++) split.push({ ...bl('demon', i < 12, 300 + i, 0.50), promptVersion: 'aphrodite' });
  seed('pick-log', DAY, split);
  const cal11 = await loadFn('calibration.js');
  const res11 = JSON.parse((await cal11.handler({ queryStringParameters: { format: 'json' } })).body);
  // 42*18/59^2 = 0.217179 and 12*48/59^2 = 0.165470
  t.ok('psyche is scored against a goblin-only baseline',
    Math.abs(res11.byPrompt.psyche.baseline - 0.2171790) < 1e-6, String(res11.byPrompt.psyche.baseline));
  t.ok('aphrodite against a demon-only one',
    Math.abs(res11.byPrompt.aphrodite.baseline - 0.1654697) < 1e-6, String(res11.byPrompt.aphrodite.baseline));
  t.eq('...and each gets its own verdict',
    [res11.byPrompt.psyche.beatsBaseline, res11.byPrompt.aphrodite.beatsBaseline], [true, false]);

  // ---- the gate is PER TIER, not per config ------------------------------
  // A config-level gate lets a lopsided mix through: 40 rows split 30/5/5 clears
  // any per-config threshold and then fits two tier baselines on five picks
  // each, where h(n-h) collapses toward zero and nothing could beat them.
  //
  // The thin tiers are dropped from BOTH sides — the judge is re-scored on
  // exactly the rows the baseline covers — so the delta stays like-for-like
  // rather than comparing two different row sets.
  reset();
  const lopsided = [];
  for (let i = 0; i < 30; i++) lopsided.push(bl('goblin', i < 21, i, 0.70));
  for (let i = 0; i < 5; i++) lopsided.push(bl('standard', true, 600 + i, 0.99));   // 5/5, p(1-p)=0
  for (let i = 0; i < 5; i++) lopsided.push(bl('demon', false, 700 + i, 0.01));     // 0/5, p(1-p)=0
  seed('pick-log', DAY, lopsided);
  const cal13 = await loadFn('calibration.js');
  const res13 = JSON.parse((await cal13.handler({ queryStringParameters: { format: 'json' } })).body);
  t.eq('only the tier with enough picks is covered', res13.baselineCoverage, 30);
  t.eq('...and the thin ones are reported as dropped, not silently ignored',
    res13.baselineDropped, 10);
  // 21*9/29^2 = 0.224732 — the goblin tier alone, uncontaminated by two tiers
  // whose baselines would have been exactly zero.
  t.ok('the baseline is the qualifying tier alone',
    Math.abs(res13.baseline - 0.2247324) < 1e-6, String(res13.baseline));
  t.ok('the judge is re-scored on those same 30 rows, not all 40',
    Math.abs(res13.brierOnBaselineRows - 0.21) < 1e-9, String(res13.brierOnBaselineRows));
  t.ok('...so the delta compares like with like',
    Math.abs(res13.baselineDelta - (0.21 - 0.2247324)) < 1e-4, String(res13.baselineDelta));

  // Rendered NOW, while this fixture is still the seeded one. Reading it after
  // the reset below would render the next fixture's data through cal13's
  // handler and quietly assert against the wrong board.
  const html8 = (await cal13.handler({ queryStringParameters: {} })).body;

  // Nothing qualifying at all yields no baseline rather than a fabricated one.
  reset();
  seed('pick-log', DAY, [0, 1, 2].map((i) => bl('goblin', true, 900 + i, 0.7)));
  const cal12 = await loadFn('calibration.js');
  const res12 = JSON.parse((await cal12.handler({ queryStringParameters: { format: 'json' } })).body);
  t.eq('too few picks in every tier gives no baseline', res12.baseline, null);
  t.eq('...and no verdict either', res12.beatsBaseline, null);

  t.ok('the baseline is on the page next to the brier it judges',
    /tier-only baseline/.test(html8));
  t.ok('...and says which side is winning', /judge BEHIND by|judge ahead by/.test(html8));

  // ---- did the judge have anything to work with? --------------------------
  // ~40% of props reach the judge with no recent5, and the prompt's fallback on
  // those is to lean on the payout tier — which is what the baseline already is.
  // So the judge may be structurally unable to beat the floor on that 40%, and a
  // pooled Brier would hide it behind the rows where it could actually reason.
  //
  // recentAvg is written only when the payload carried recent5, so this splits
  // on a record of what the judge was fed rather than an inference about it.
  reset();
  const fm = (hasForm, tier, hit, i, prob) => ({
    ...mk('mlb', prob, hit, 950 + i), oddsType: tier,
    recentAvg: hasForm ? 1.4 : null, stat: hasForm ? 'Hits' : 'Pitcher Fantasy Score',
  });
  const rows14 = [];
  // WITH form: the judge separates outcomes inside the tier — real skill.
  for (let i = 0; i < 60; i++) rows14.push(fm(true, 'goblin', i < 30, i, i < 30 ? 0.88 : 0.32));
  // WITHOUT form: one flat number for everything, leaning on the tier and
  // overshooting it. Hits are INTERLEAVED rather than front-loaded: with equal
  // probabilities the sort is stable, so a block of hits followed by a block of
  // misses would manufacture a perfect lift out of nothing but fixture order.
  for (let i = 0; i < 60; i++) rows14.push(fm(false, 'goblin', i % 2 === 0, 200 + i, 0.70));
  seed('pick-log', DAY, rows14);

  const cal14 = await loadFn('calibration.js');
  const res14 = JSON.parse((await cal14.handler({ queryStringParameters: { format: 'json' } })).body);
  const has = res14.byFormCoverage['has-form'], no = res14.byFormCoverage['no-form'];

  t.eq('the split is on what the payload actually carried', [has.n, no.n], [60, 60]);
  t.eq('a judge with form separates outcomes inside the tier',
    Math.round(has.meanLift * 100), 100);   // top half all hit, bottom half all missed
  t.eq('...and without it, shows no separation at all', no.meanLift, 0);
  t.eq('with form it beats its own baseline', has.beatsBaseline, true);
  t.eq('...and without form it does not', no.beatsBaseline, false);

  // THE POINT: pooled, this judge looks mediocre. Split, it is excellent on the
  // rows it could reason from and inert on the rows it could not — which is a
  // data-coverage finding, not a prompt one.
  t.ok('each bucket is scored against a baseline from its own rows',
    has.baseline != null && no.baseline != null);
  t.ok('the pooled brier sits between the two, hiding both',
    res14.brier > has.brier && res14.brier < no.brier,
    `has ${has.brier.toFixed(4)} < pooled ${res14.brier.toFixed(4)} < no ${no.brier.toFixed(4)}`);

  // The actionable half: WHICH props arrive without form.
  t.eq('the uncovered rows are named by league and stat',
    res14.noFormBy.stat['mlb :: Pitcher Fantasy Score'], 60);
  t.eq('...and covered stats do not appear there',
    res14.noFormBy.stat['mlb :: Hits'], undefined);

  // ---- AUC, and the intervals that stop lift being over-read -------------
  // A median half-split keeps only which side of the middle each pick fell on.
  // At n=200 that is most of the information thrown away, and the standard error
  // balloons — a -2.0pt lift on 402 picks carries ±4.6 and cannot be told from
  // zero, which is exactly how a noise reading becomes an "inversion".
  const hg = has.skill.goblin, ng = no.skill.goblin;
  t.ok('a perfectly ordered ranking scores AUC 1', Math.abs(hg.auc - 1) < 1e-9, String(hg.auc));
  t.ok('a ranking carrying no information scores 0.5',
    Math.abs(ng.auc - 0.5) < 1e-9, String(ng.auc));
  t.ok('every lift carries its own standard error', hg.liftSE >= 0 && ng.liftSE > 0);
  t.ok('...and every AUC does too', hg.aucSE != null && ng.aucSE != null);

  // Ties count half. A judge that says one number for everything cannot order
  // anything, and must score exactly 0.5 rather than being rewarded by the sort.
  t.ok('a flat judge scores exactly 0.5, ties counted as half',
    Math.abs(ng.auc - 0.5) < 1e-9, String(ng.auc));

  // The cross-bucket comparison — the only well-powered statement available,
  // because it is paired on tier rather than resting on one bucket alone.
  const cb = res14.byFormCoverage.noFormMinusHasForm;
  t.ok('the no-form minus has-form difference is reported with an interval',
    cb.lift && typeof cb.lift.estimate === 'number' && cb.lift.se > 0);
  t.ok('...and a z so it can be read as suggestive rather than settled',
    Math.abs(cb.lift.z - cb.lift.estimate / cb.lift.se) < 1e-9);
  t.ok('...pooled across the tiers present in both buckets',
    Object.keys(cb.lift.perTier).includes('goblin'));
  // In this fixture the judge ranks perfectly WITH form and not at all without,
  // so the difference must come out negative — form helped.
  t.ok('form helping shows as a negative difference', cb.lift.estimate < 0, String(cb.lift.estimate));

  // ---- coverage is stated as the covered share, not the uncovered one -----
  t.ok('form coverage is the share that HAD form',
    Math.abs(res14.byFormCoverage.formCoverage - 0.5) < 1e-9,
    String(res14.byFormCoverage.formCoverage));

  const html14 = (await cal14.handler({ queryStringParameters: {} })).body;
  t.ok('the page states coverage the right way round',
    /of graded picks reached the judge carrying recent form/.test(html14));
  t.ok('...and warns that a bare lift reads as an inversion it cannot support',
    /reads as an inversion that\s+the data does not support/.test(html14));
  t.ok('the split is on the page', /Did the judge have anything to work with\?/.test(html14));
  t.ok('...along with what arrives uncovered', /What arrives without form/.test(html14));
  // Item 5 proved the old label wrong: coverage, not obedience.
  t.ok('"cleared" is labelled as coverage, not instruction-following',
    /COVERAGE metric, not an obedience one/.test(html14));
  t.ok('...and the old claim is gone', !/plain instruction-following/.test(html14));
}

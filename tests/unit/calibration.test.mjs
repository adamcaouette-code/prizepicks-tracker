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
  t.eq('...with the tier mix that produced it', byStat['mlb :: Home Runs'].tiers, { standard: 40 });

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
}

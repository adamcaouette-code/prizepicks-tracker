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
}

// The Fantasy Score weight check.
//
// This endpoint failed three times in a row against the ~10s a synchronous
// Netlify function gets: a blank page, then 15 of 40 sampled, then 6 of 40 with
// the basketball control starved to null so no verdict was reachable at all.
// Each MLB pick needs a season game log for a distinct player; no amount of
// concurrency tuning fits a meaningful sample into ten seconds. So the work
// moved to a background function and the sync endpoint just reads the result.
//
// What this file pins is the reasoning, not the plumbing: the two corrections
// that the live runs proved necessary, and the guard against reading a computed
// zero as a real result.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const D = day(3);

const hitter = (i, over = {}) => ({
  date: D, loggedAt: D + 'T18:00:00Z', league: 'mlb', source: 'board',
  projectionId: `F${i}`, player: `Hitter ${i}`, stat: 'Hitter Fantasy Score',
  line: 8.5, prob: 0.6, verdict: 'play', oddsType: 'standard',
  result: null, hit: null, gradedAt: null, ...over,
});
const baller = (i, over = {}) => hitter(i, {
  league: 'wnba', stat: 'Fantasy Score', player: `Wing ${i}`, line: 30, ...over,
});

const NBA_KEYS = ['minutes', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers'];
const espnMock = (names) => [
  [/scoreboard/, async () => ({ events: [{ id: '9', date: D + 'T23:00Z', status: { type: { completed: true, state: 'post' } } }] })],
  [/summary/, async () => ({ boxscore: { players: [{ statistics: [{ keys: NBA_KEYS,
    athletes: names.map((n) => ({ athlete: { displayName: n }, stats: ['30', '30', '5', '4', '1', '1', '2'] })) }] }] } })],
];
const mlbMock = (n, stat) => [
  [/\/sports\/1\/players/, async () => ({ people: Array.from({ length: n }, (_, i) => ({ id: 700 + i, fullName: `Hitter ${i}` })) })],
  [/people\/\d+\/stats/, async () => ({ stats: [{ splits: [{ date: D, stat }] }] })],
];
const GOOD_LINE = { hits: 2, doubles: 1, triples: 0, homeRuns: 0, runs: 1, rbi: 1, baseOnBalls: 1 };

const runBg = async (routes, params = {}) => {
  const bg = await loadFn('fantasy-check-background.js');
  const m = mockFetch(routes);
  try { await bg.handler({ queryStringParameters: params }); } finally { m.restore(); }
  return read('run-stats', 'fantasy-check');
};

export default async function ({ t }) {
  // ---- the reader answers before anything has run -------------------------
  reset();
  const reader = await loadFn('fantasy-check.js');
  const empty = JSON.parse((await reader.handler({})).body);
  t.eq('with no result stored it says so rather than erroring', empty.state, 'never run');
  t.ok('...and names the thing to run', /fantasy-check-background/.test(empty.next));
  t.eq('MLB stays gated in every case', empty.mlbCurrentlyEnabled, false);
  t.ok('the weights are shown even with no result', !!empty.weightsInUse?.mlbHitter?.singles);

  // ---- correction 1: tiers cannot be mixed --------------------------------
  // A goblin line is set BELOW the median outcome by design, a demon above it.
  // The first live run had 578 goblins against 142 standard, and mixing them
  // manufactured a 2.35x "weight error" that was really just tier mix.
  reset();
  const mixed = [
    ...Array.from({ length: 12 }, (_, i) => hitter(i, { oddsType: 'standard', line: 8.5 })),
    ...Array.from({ length: 30 }, (_, i) => hitter(100 + i, { oddsType: 'goblin', line: 2.5 })),
    ...Array.from({ length: 10 }, (_, i) => hitter(200 + i, { oddsType: 'demon', line: 20 })),
  ];
  seed('pick-log', D, mixed);
  const tiered = await runBg(mlbMock(400, GOOD_LINE));

  t.eq('only standard-tier picks feed the ratio', tiered.standardTierPicksAvailable['mlb-hitter'], 12);
  t.eq('...while every tier is still counted, so the exclusion is visible', tiered.allTiersInLog.goblin, 30);
  t.eq('...and the demons too', tiered.allTiersInLog.demon, 10);
  t.eq('the median line is the STANDARD line, not dragged down by goblins',
    tiered.verdicts['mlb-hitter'].medianLine, 8.5);

  // ---- correction 2: the control must not be starved ----------------------
  // The previous run sampled every Nth pick GLOBALLY, ran out six picks in, and
  // resolved nothing but MLB — so the control was null and no verdict was
  // reachable. Sampling is per kind now.
  reset();
  seed('pick-log', D, [
    ...Array.from({ length: 200 }, (_, i) => hitter(i)),      // MLB dominates
    ...Array.from({ length: 12 }, (_, i) => baller(i)),        // control is a sliver
  ]);
  const strat = await runBg([...espnMock(Array.from({ length: 12 }, (_, i) => `Wing ${i}`)), ...mlbMock(200, GOOD_LINE)]);

  t.ok('the control resolves even when MLB dominates the log',
    strat.verdicts.basketball?.n >= 10, `basketball n=${strat.verdicts.basketball?.n}`);
  t.ok('...and is published as the baseline', typeof strat.controlRatio === 'number');
  t.ok('...labelled a control, not judged as a result', /CONTROL/.test(strat.verdicts.basketball.verdict));
  t.ok('MLB is measured RELATIVE to it, not against 1.0',
    typeof strat.verdicts['mlb-hitter'].vsControl === 'number');
  t.ok('...and reaches an actual verdict', /WEIGHTS LOOK RIGHT|TOO HIGH|TOO LOW/.test(strat.verdicts['mlb-hitter'].verdict),
    strat.verdicts['mlb-hitter'].verdict);

  // ---- a computed zero is not quietly treated as a result -----------------
  // Three of six sampled hitters computed to exactly 0 on one live run. That is
  // possible — a real 0-for-4 — but at that rate it more likely means the lookup
  // found a game the player never appeared in, and a ratio built on it is junk.
  reset();
  seed('pick-log', D, Array.from({ length: 14 }, (_, i) => hitter(i)));
  const zeroed = await runBg(mlbMock(14, { hits: 0, doubles: 0, triples: 0, homeRuns: 0, runs: 0, rbi: 0, baseOnBalls: 0 }));

  t.ok('zero results are counted', zeroed.verdicts['mlb-hitter'].zeroResults >= 10);
  t.ok('...and a high share is called SUSPECT rather than scored',
    /SUSPECT/.test(zeroed.verdicts['mlb-hitter'].verdict), zeroed.verdicts['mlb-hitter'].verdict);
  t.ok('...pointing at the raw stat line as the way to tell them apart',
    /statLine/.test(zeroed.verdicts['mlb-hitter'].verdict));
  t.ok('the raw box-score line is attached so a real 0-for-4 is distinguishable',
    zeroed.sampleRows.some((r) => r.statLine && typeof r.statLine === 'object'));
  t.ok('...along with the game date that settled it',
    zeroed.sampleRows.some((r) => !!r.gameDate));

  // ---- the scale test: the one check selection bias cannot corrupt --------
  // The control ratio never resolved on real data, because every basketball
  // fantasy pick in the log turned out to be goblin or demon and the standard
  // filter removed them all. Without a control, a raw ratio of 1.82 could be a
  // weight error or could be the engine picking overs it liked — indistinguishable.
  //
  // Scoring a LEAGUE-AVERAGE game needs no pick log at all, so nothing about
  // selection can explain its answer away.
  const fs2 = await loadFn('fantasy-score.js');
  t.ok('an average hitter game scores something sane', fs2.scaleCheck('mlb-hitter') > 0);
  t.ok('an average pitcher start too', fs2.scaleCheck('mlb-pitcher') > 0);
  t.eq('a kind with no formula has no scale check', fs2.scaleCheck('tennis'), null);

  reset();
  seed('pick-log', D, Array.from({ length: 14 }, (_, i) => hitter(i, { line: 5.5 })));
  const scaled = await runBg(mlbMock(14, GOOD_LINE));
  const hv = scaled.verdicts['mlb-hitter'];
  t.ok('the verdict reports what an average game scores', typeof hv.averageGameScore === 'number');
  t.ok('...against the typical line, as a ratio', typeof hv.scaleVsTypicalLine === 'number');
  t.ok('...and leads with it when the weights are off, naming the factor',
    /WEIGHTS ARE WRONG/.test(hv.verdict) && /too HIGH|too LOW/.test(hv.verdict), hv.verdict);
  t.ok('...saying explicitly that selection bias cannot explain it',
    /selection bias cannot explain/.test(hv.verdict));

  // ---- a player who did not bat is a VOID, not a zero ---------------------
  // Corey Seager appeared in a live sample as "0-0" with 0 plate appearances —
  // he never came to the plate. PrizePicks voids that rather than settling it at
  // 0, so scoring it 0 writes a false loss into calibration.
  t.eq('zero plate appearances refuses rather than scoring 0',
    fs2.mlbHitterFantasy({ plateAppearances: 0, hits: 0, doubles: 0, triples: 0, homeRuns: 0, runs: 0, rbi: 0, baseOnBalls: 0 }), null);
  t.eq('...while a genuine 0-for-4 still scores 0, because he DID play',
    fs2.mlbHitterFantasy({ plateAppearances: 4, hits: 0, doubles: 0, triples: 0, homeRuns: 0, runs: 0, rbi: 0, baseOnBalls: 0 }), 0);
  t.eq('a pitcher who never took the mound refuses too',
    fs2.mlbPitcherFantasy({ outs: 0, battersFaced: 0, strikeOuts: 0, earnedRuns: 0, hits: 0, baseOnBalls: 0 }), null);
  t.ok('...while one who faced batters and recorded no outs still scores',
    fs2.mlbPitcherFantasy({ outs: 0, battersFaced: 3, strikeOuts: 0, earnedRuns: 3, hits: 3, baseOnBalls: 0 }) != null);

  // ---- a job that died must not read as still running ---------------------
  // The save helper did not AWAIT its write, so the final 'done' state was a
  // floating promise and the invocation ended before it flushed. The store kept
  // the earlier 'running' and the reader showed a finished job as in progress —
  // for hours, with nothing to indicate otherwise.
  reset();
  seed('run-stats', 'fantasy-check', { state: 'running', at: new Date(Date.now() - 90 * 60000).toISOString() });
  const stale = JSON.parse((await (await loadFn('fantasy-check.js')).handler({})).body);
  t.eq('a run still "running" long past the ceiling is reported stalled', stale.state, 'stalled');
  t.ok('...saying why, since 15 minutes is the hard limit', /15-minute|ceiling/.test(stale.stalledNote));
  t.ok('...and how to start a fresh one', /fantasy-check-background/.test(stale.stalledNote));
  t.ok('...with the age shown', stale.ageMinutes >= 89);

  reset();
  seed('run-stats', 'fantasy-check', { state: 'running', at: new Date(Date.now() - 60000).toISOString() });
  const fresh2 = JSON.parse((await (await loadFn('fantasy-check.js')).handler({})).body);
  t.eq('a job that started a minute ago is genuinely still running', fresh2.state, 'running');

  // ---- the reader serves what the background job stored -------------------
  reset();
  seed('pick-log', D, Array.from({ length: 14 }, (_, i) => hitter(i)));
  await runBg(mlbMock(14, GOOD_LINE));
  const served = JSON.parse((await (await loadFn('fantasy-check.js')).handler({})).body);
  t.eq('the reader returns the stored run', served.state, 'done');
  t.ok('...with its verdicts intact', !!served.verdicts['mlb-hitter']);
  t.ok('...and still says MLB is gated', served.mlbCurrentlyEnabled === false);
  t.ok('...and how to turn it on once the weights check out', /FANTASY_MLB_VERIFIED/.test(served.howToEnable));
}

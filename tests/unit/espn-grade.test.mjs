// ESPN grading for the leagues MLB's API doesn't cover.
//
// Framed as a SOURCE CHAIN rather than a fallback: the sport's own box score
// leads, PrizePicks is last. That ordering matters because PrizePicks now
// answers 403 to everything — measured, 40/40 on a real diagnostic — so putting
// it first would spend a guaranteed-failing round trip on every single pick.
//
// The same rule as the MLB grader applies throughout: refuse rather than guess.
// A wrong grade writes a false result into calibration, which is worse than
// leaving a pick ungraded.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

// ESPN's real shape: positional `stats` parallel to `keys`, several cells
// holding a made-attempted PAIR in one string.
const NBA_KEYS = ['minutes', 'fieldGoalsMade-fieldGoalsAttempted',
  'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted',
  'offensiveRebounds', 'defensiveRebounds', 'rebounds', 'assists', 'steals', 'blocks',
  'turnovers', 'fouls', 'plusMinus', 'points'];
const nbaBox = (name, stats) => ({
  boxscore: { players: [{ statistics: [{ name: 'starters', keys: NBA_KEYS,
    athletes: [{ athlete: { displayName: name }, stats }] }] }] },
});

export default async function ({ t }) {
  reset();
  const mod = await loadFn('espn-grade.js');

  // ---- the mapping -------------------------------------------------------
  t.ok('a basketball stat resolves', !!mod.resolveStat('nba', 'Points'));
  t.ok('a football stat resolves', !!mod.resolveStat('nfl', 'Rush Yards'));
  t.ok('a hockey stat resolves', !!mod.resolveStat('nhl', 'Goalie Saves'));
  t.eq('a league with no ESPN coverage resolves nothing', mod.resolveStat('tennis', 'Total Games Won'), null);
  t.eq('an unmapped stat resolves nothing rather than guessing', mod.resolveStat('nba', 'Fantasy Score'), null);

  // ---- reading a real box score ------------------------------------------
  //                 min   FG     3PT    FT    OR DR REB AST STL BLK TO PF +/- PTS
  const line = ['32', '9-17', '4-9', '5-6', '1', '6', '7', '5', '2', '1', '3', '2', '+8', '27'];
  const mock = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '401' }] })],
    [/summary/, async () => nbaBox('Some Guard', line)],
  ]);
  let pts, threes, pra, fg;
  try {
    pts = await mod.gradeFromEspn({ league: 'nba', player: 'Some Guard', date: '2026-08-14', stat: 'Points', line: 24.5 });
    threes = await mod.gradeFromEspn({ league: 'nba', player: 'Some Guard', date: '2026-08-14', stat: '3-PT Made', line: 3.5 });
    pra = await mod.gradeFromEspn({ league: 'nba', player: 'Some Guard', date: '2026-08-14', stat: 'Pts+Rebs+Asts', line: 38.5 });
    fg = await mod.gradeFromEspn({ league: 'nba', player: 'Some Guard', date: '2026-08-14', stat: 'FG Made', line: 8.5 });
  } finally { mock.restore(); }

  t.eq('a simple stat reads straight off the row', pts?.result, 27);
  t.eq('...and grades the over', pts?.hit, true);
  t.eq('...tagged with the source that settled it', pts?.source, 'espn');
  // The subtle one: "4-9" is made-attempted in a single cell, so a naive
  // Number() would read NaN and the pick would go ungraded forever.
  t.eq('a made-attempted PAIR is split, not parsed as one number', threes?.result, 4);
  t.eq('...and graded on the made half', threes?.hit, true);
  t.eq('field goals made comes off the same kind of pair', fg?.result, 9);
  t.eq('a derived combo stat is computed from its parts', pra?.result, 39);
  t.eq('...and grades correctly', pra?.hit, true);

  // A miss is a miss.
  reset();
  const missMock = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '402' }] })],
    [/summary/, async () => nbaBox('Cold Wing', ['20', '2-11', '0-5', '0-0', '0', '2', '2', '1', '0', '0', '1', '2', '-6', '4'])],
  ]);
  let miss;
  try { miss = await mod.gradeFromEspn({ league: 'nba', player: 'Cold Wing', date: '2026-08-14', stat: 'Points', line: 12.5 }); } finally { missMock.restore(); }
  t.eq('an over that did not clear grades false, not null', miss?.hit, false);
  t.eq('...with the real value', miss?.result, 4);

  // ---- where it must refuse ----------------------------------------------
  reset();
  const refuse = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '403' }] })],
    [/summary/, async () => nbaBox('Someone Else', line)],
  ]);
  let absent, unmapped, uncovered;
  try {
    absent = await mod.gradeFromEspn({ league: 'nba', player: 'Did Not Play', date: '2026-08-14', stat: 'Points', line: 5.5 });
    unmapped = await mod.gradeFromEspn({ league: 'nba', player: 'Someone Else', date: '2026-08-14', stat: 'Fantasy Score', line: 30.5 });
    uncovered = await mod.gradeFromEspn({ league: 'tennis', player: 'Someone Else', date: '2026-08-14', stat: 'Total Games Won', line: 20.5 });
  } finally { refuse.restore(); }
  t.eq('a player who never appears refuses', absent, null);
  t.eq('an unmapped stat refuses', unmapped, null);
  t.eq('a league with no ESPN coverage refuses', uncovered, null);

  // ---- the source chain ---------------------------------------------------
  const gp = await loadFn('grade-picks.js');
  t.eq('MLB leads with its own API', gp.gradersFor('mlb')[0], 'mlb');
  t.eq('an ESPN league leads with ESPN', gp.gradersFor('nba')[0], 'espn');
  t.eq('...and WNBA too', gp.gradersFor('wnba')[0], 'espn');
  t.ok('PrizePicks is always LAST, never first — it 403s everything',
    gp.gradersFor('mlb').slice(-1)[0] === 'prizepicks' && gp.gradersFor('nfl').slice(-1)[0] === 'prizepicks');
  t.eq('a league with no box-score source has only PrizePicks', gp.gradersFor('tennis'), ['prizepicks']);

  // ---- end to end: a WNBA pick grades without PrizePicks ------------------
  reset();
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  seed('pick-log', day, [
    { date: day, loggedAt: day + 'T18:00:00Z', league: 'wnba', projectionId: 'PP-DEAD',
      player: 'Sonia Citron', stat: 'Points', line: 14.5, prob: 0.62, verdict: 'play',
      result: null, hit: null, gradedAt: null },
  ]);
  let ppCalls = 0;
  const e2e = mockFetch([
    [/api\.prizepicks\.com/, async () => { ppCalls++; return { status: 403, body: 'forbidden' }; }],
    [/scoreboard/, async () => ({ events: [{ id: '900' }] })],
    [/summary/, async () => nbaBox('Sonia Citron', ['30', '7-13', '2-4', '3-3', '1', '4', '5', '4', '2', '0', '2', '1', '+5', '19'])],
  ]);
  let out;
  try {
    out = JSON.parse((await gp.handler({ queryStringParameters: { date: day } })).body);
  } finally { e2e.restore(); }

  const row = (read('pick-log', day) || [])[0];
  t.eq('a WNBA pick now grades', row.hit, true);
  t.eq('...off the ESPN box score', row.result, 19);
  t.eq('...recorded as ESPN-sourced', row.gradedVia, 'espn');
  t.eq('PrizePicks was never called — it is last in the chain and ESPN answered', ppCalls, 0);
  t.eq('the run reports which sources did the grading', out.gradedBySource?.espn, 1);

  // ---- the probe checks the mapping instead of asking a human to eyeball it --
  // ESPN's key names are the one thing that can't be verified from a build
  // environment, and a mapped stat whose key is absent grades NOTHING while
  // everything around it looks healthy. So the probe does the diff itself.
  t.ok('every mapped stat declares the keys it depends on',
    mod.keysNeeded('basketball').points.includes('points'));
  t.ok('a combo stat declares ALL its parts, so a half-broken combo is catchable',
    ['points', 'rebounds', 'assists'].every((k) => mod.keysNeeded('basketball').pra.includes(k)));
  t.ok('a made-attempted stat declares the paired key it splits',
    mod.keysNeeded('basketball').fgmade.includes('fieldGoalsMade-fieldGoalsAttempted'));

  reset();
  const good = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '77', date: '2026-08-14T23:00Z' }] })],
    [/summary/, async () => nbaBox('Some Guard', line)],
  ]);
  let okProbe;
  try {
    okProbe = JSON.parse((await mod.handler({ queryStringParameters: { mode: 'probe', league: 'nba', date: '2026-08-14' } })).body);
  } finally { good.restore(); }
  t.ok('a healthy mapping is reported as verified, not left to interpretation',
    /verified/.test(okProbe.verdict), okProbe.verdict);
  t.eq('...with nothing listed as broken', okProbe.brokenStats, undefined);
  t.ok('...and names the stats it confirmed', okProbe.verifiedStats.includes('points'));

  // ESPN renames a key: the probe must SAY so rather than report a clean bill.
  reset();
  const renamed = NBA_KEYS.map((k) => (k === 'points' ? 'pts' : k));
  const drift = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '78', date: '2026-08-14T23:00Z' }] })],
    [/summary/, async () => ({ boxscore: { players: [{ statistics: [{ name: 'starters', keys: renamed,
      athletes: [{ athlete: { displayName: 'Some Guard' }, stats: line }] }] }] } })],
  ]);
  let bad;
  try {
    bad = JSON.parse((await mod.handler({ queryStringParameters: { mode: 'probe', league: 'nba', date: '2026-08-14' } })).body);
  } finally { drift.restore(); }
  t.ok('a renamed ESPN key is caught and called out', /grade NOTHING/.test(bad.verdict), bad.verdict);
  t.ok('...naming the stat that broke', !!bad.brokenStats?.points);
  t.ok('...and the exact key ESPN stopped sending', bad.brokenStats.points.missing.includes('points'));
  t.ok('...including combos that silently lost a part', !!bad.brokenStats?.pra);
  t.ok('...while stats that still work are not flagged', bad.verifiedStats.includes('assists'));
  t.ok('...and the key ESPN sent instead is surfaced as a candidate',
    bad.unmappedEspnKeys.includes('pts'));

  // ---- the offseason is a calendar fact, not a failure --------------------
  // Probing NBA in August returns zero games. Widening the window finds the
  // most recent real slate instead of reporting an empty result.
  reset();
  let ranged = false;
  const off = mockFetch([
    [/scoreboard/, async (url) => {
      if (/dates=\d{8}-\d{8}/.test(url)) { ranged = true; return { events: [
        { id: '10', date: '2026-05-01T23:00Z' }, { id: '11', date: '2026-06-19T23:00Z' }] }; }
      return { events: [] };   // nothing on the requested August day
    }],
    [/summary/, async () => nbaBox('Some Guard', line)],
  ]);
  let season;
  try {
    season = JSON.parse((await mod.handler({ queryStringParameters: { mode: 'probe', league: 'nba', date: '2026-08-17' } })).body);
  } finally { off.restore(); }
  t.ok('an empty day widens the search rather than giving up', ranged);
  t.eq('...landing on the most recent slate, not the oldest in the window', season.gameUsed?.date, '2026-06-19');
  t.ok('...and says plainly why the date moved', /offseason|most recent/.test(season.note || ''), season.note);
  t.ok('...then still verifies the mapping off that game', /verified/.test(season.verdict));
}

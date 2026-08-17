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

// Every real ESPN event carries a status. A game that hasn't finished has no
// final stat line, so nothing is read from one — see the in-progress section
// below for why that matters more than it sounds.
const FINAL = { status: { type: { completed: true, state: 'post', name: 'STATUS_FINAL' } } };
const LIVE = { status: { type: { completed: false, state: 'in', name: 'STATUS_IN_PROGRESS' } } };
const SCHEDULED = { status: { type: { completed: false, state: 'pre', name: 'STATUS_SCHEDULED' } } };
const ev = (id, date = '2026-08-14T23:00Z', st = FINAL) => ({ id, date, ...st });

export default async function ({ t }) {
  reset();
  const mod = await loadFn('espn-grade.js');

  // ---- the mapping -------------------------------------------------------
  t.ok('a basketball stat resolves', !!mod.resolveStat('nba', 'Points'));
  t.ok('a football stat resolves', !!mod.resolveStat('nfl', 'Rush Yards'));
  t.ok('a hockey stat resolves', !!mod.resolveStat('nhl', 'Goalie Saves'));
  t.eq('a league with no ESPN coverage resolves nothing', mod.resolveStat('esports', 'Maps Won'), null);
  t.eq('an unmapped stat resolves nothing rather than guessing', mod.resolveStat('nba', 'Fantasy Score'), null);

  // ---- reading a real box score ------------------------------------------
  //                 min   FG     3PT    FT    OR DR REB AST STL BLK TO PF +/- PTS
  const line = ['32', '9-17', '4-9', '5-6', '1', '6', '7', '5', '2', '1', '3', '2', '+8', '27'];
  const mock = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('401')] })],
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
    [/scoreboard/, async () => ({ events: [ev('402')] })],
    [/summary/, async () => nbaBox('Cold Wing', ['20', '2-11', '0-5', '0-0', '0', '2', '2', '1', '0', '0', '1', '2', '-6', '4'])],
  ]);
  let miss;
  try { miss = await mod.gradeFromEspn({ league: 'nba', player: 'Cold Wing', date: '2026-08-14', stat: 'Points', line: 12.5 }); } finally { missMock.restore(); }
  t.eq('an over that did not clear grades false, not null', miss?.hit, false);
  t.eq('...with the real value', miss?.result, 4);

  // ---- where it must refuse ----------------------------------------------
  reset();
  const refuse = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('403')] })],
    [/summary/, async () => nbaBox('Someone Else', line)],
  ]);
  let absent, unmapped, uncovered;
  try {
    absent = await mod.gradeFromEspn({ league: 'nba', player: 'Did Not Play', date: '2026-08-14', stat: 'Points', line: 5.5 });
    unmapped = await mod.gradeFromEspn({ league: 'nba', player: 'Someone Else', date: '2026-08-14', stat: 'Fantasy Score', line: 30.5 });
    uncovered = await mod.gradeFromEspn({ league: 'esports', player: 'Someone Else', date: '2026-08-14', stat: 'Maps Won', line: 20.5 });
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
  t.eq('a league with no box-score source has only PrizePicks', gp.gradersFor('esports'), ['prizepicks']);
  t.eq('tennis and soccer now route to ESPN', gp.gradersFor('tennis')[0], 'espn');
  t.eq('...soccer too', gp.gradersFor('epl')[0], 'espn');

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
    [/scoreboard/, async () => ({ events: [ev('900')] })],
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

  // ---- the REAL WNBA box score, captured from a live probe ----------------
  // Copied verbatim from /api/espn-grade?mode=probe&league=wnba on a played
  // game (Lynx/Storm, 2026-08-15). Note the key ORDER is nothing like the
  // fixture above — points sits at index 1, not 13. Lookups go by key name, so
  // order is irrelevant; this pins that, because a positional assumption would
  // have read minutes as points and graded confidently off the wrong column.
  const REAL_KEYS = ['minutes', 'points', 'fieldGoalsMade-fieldGoalsAttempted',
    'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted',
    'rebounds', 'assists', 'turnovers', 'steals', 'blocks',
    'offensiveRebounds', 'defensiveRebounds', 'fouls', 'plusMinus'];
  //                    MIN  PTS  FG      3PT     FT    REB AST TO STL BLK OREB DREB PF  +/-
  const carleton = ['29', '14', '5-13', '4-10', '0-0', '9', '2', '0', '0', '0', '2', '7', '3', '-7'];
  reset();
  const realBox = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('401857144', '2026-08-15T23:00Z')] })],
    [/summary/, async () => ({ boxscore: { players: [{ statistics: [{ keys: REAL_KEYS,
      athletes: [{ athlete: { displayName: 'Bridget Carleton' }, stats: carleton }] }] }] } })],
  ]);
  const real = (stat, ln) => mod.gradeFromEspn({ league: 'wnba', player: 'Bridget Carleton', date: '2026-08-15', stat, line: ln });
  let rPts, rMin, rThree, rOreb, rDreb, rFouls, rPra, rFga;
  try {
    rPts = await real('Points', 10.5);
    rMin = await real('Minutes', 25.5);
    rThree = await real('3-PT Made', 3.5);
    rOreb = await real('Offensive Rebounds', 1.5);
    rDreb = await real('Defensive Rebounds', 5.5);
    rFouls = await real('Personal Fouls', 2.5);
    rPra = await real('Pts+Rebs+Asts', 24.5);
    rFga = await real('FG Attempted', 12.5);
  } finally { realBox.restore(); }

  t.eq('points read by NAME, not position — index 1 here, 13 in the other shape', rPts?.result, 14);
  t.eq('...and minutes is not mistaken for it', rMin?.result, 29);
  t.eq('a made-attempted pair still splits on real data', rThree?.result, 4);
  t.eq('offensive rebounds now grade', rOreb?.result, 2);
  t.eq('defensive rebounds now grade', rDreb?.result, 7);
  t.eq('personal fouls now grade', rFouls?.result, 3);
  t.eq('the attempted half of a pair is readable too', rFga?.result, 13);
  t.eq('a combo adds up off the real row', rPra?.result, 25);   // 14 + 9 + 2
  t.eq('...and grades the over', rPra?.hit, true);

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
    [/scoreboard/, async () => ({ events: [ev('77')] })],
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
    [/scoreboard/, async () => ({ events: [ev('78')] })],
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

  // ---- a game in progress must NEVER be graded ---------------------------
  // ESPN serves a partial box score for a live game. Reading it records
  // points-at-halftime as the final result — a WRONG grade in calibration,
  // which is strictly worse than leaving the pick pending for another pass.
  reset();
  const halftime = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '500', date: '2026-08-14T23:00Z', ...LIVE }] })],
    // 11 points at the half — over a 20.5 line this reads as a MISS if graded now.
    [/summary/, async () => nbaBox('Live Guard', ['14', '4-8', '1-3', '2-2', '0', '3', '3', '2', '1', '0', '1', '2', '+4', '11'])],
  ]);
  let live;
  try { live = await mod.gradeFromEspn({ league: 'nba', player: 'Live Guard', date: '2026-08-14', stat: 'Points', line: 20.5 }); } finally { halftime.restore(); }
  t.eq('a game still in progress does not grade — a partial line is not a result', live, null);

  reset();
  const notYet = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '501', date: '2026-08-14T23:00Z', ...SCHEDULED }] })],
    [/summary/, async () => nbaBox('Future Guard', line)],
  ]);
  let sched;
  try { sched = await mod.gradeFromEspn({ league: 'nba', player: 'Future Guard', date: '2026-08-14', stat: 'Points', line: 20.5 }); } finally { notYet.restore(); }
  t.eq('a scheduled game does not grade', sched, null);

  // The same slate once it finishes: the pick grades on a later pass, so
  // refusing above costs nothing but a delay.
  reset();
  const done = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '502', date: '2026-08-14T23:00Z', ...FINAL }] })],
    [/summary/, async () => nbaBox('Live Guard', ['34', '9-17', '4-9', '5-6', '1', '6', '7', '5', '2', '1', '3', '2', '+8', '27'])],
  ]);
  let settled;
  try { settled = await mod.gradeFromEspn({ league: 'nba', player: 'Live Guard', date: '2026-08-14', stat: 'Points', line: 20.5 }); } finally { done.restore(); }
  t.eq('...and grades once the game is final', settled?.hit, true);
  t.eq('...on the FINAL number, not the halftime one', settled?.result, 27);

  // A mixed slate: finished games are usable immediately, live ones excluded.
  reset();
  const mixed = mockFetch([
    [/scoreboard/, async () => ({ events: [
      { id: '600', date: '2026-08-14T20:00Z', ...FINAL },
      { id: '601', date: '2026-08-14T23:00Z', ...LIVE }] })],
    [/summary\?event=600/, async () => nbaBox('Early Game', ['30', '8-14', '3-6', '4-4', '2', '5', '7', '6', '1', '1', '2', '3', '+9', '23'])],
    [/summary\?event=601/, async () => nbaBox('Late Game', ['12', '3-7', '1-2', '0-0', '0', '2', '2', '1', '0', '0', '0', '1', '-2', '7'])],
  ]);
  let early, late, idx;
  try {
    early = await mod.gradeFromEspn({ league: 'nba', player: 'Early Game', date: '2026-08-14', stat: 'Points', line: 19.5 });
    late = await mod.gradeFromEspn({ league: 'nba', player: 'Late Game', date: '2026-08-14', stat: 'Points', line: 15.5 });
    idx = await mod.dayIndex('nba', '2026-08-14');
  } finally { mixed.restore(); }
  t.eq('a finished game on a mixed slate grades right away', early?.result, 23);
  t.eq('...while the game still running on the same slate does not', late, null);
  t.eq('the index counts only completed games', idx.games, 1);
  t.eq('...and reports how many are still running', idx.unfinished, 1);

  // ---- the offseason is a calendar fact, not a failure --------------------
  // Probing NBA in August returns zero games. Widening the window finds the
  // most recent real slate instead of reporting an empty result.
  reset();
  let ranged = false;
  const off = mockFetch([
    [/scoreboard/, async (url) => {
      if (/dates=\d{8}-\d{8}/.test(url)) { ranged = true; return { events: [
        { id: '10', date: '2026-05-01T23:00Z', ...FINAL }, { id: '11', date: '2026-06-19T23:00Z', ...FINAL }] }; }
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
  t.ok('...and says plainly why the date moved', /most recent/.test(season.note || ''), season.note);
  t.ok('...then still verifies the mapping off that game', /verified/.test(season.verdict));

  // ---- the probe must not blame the mapping for tonight's unplayed game ----
  // The real failure: the newest event on the scoreboard was TOMORROW's tip-off,
  // so the summary carried no box score and all 19 stats looked broken at once.
  reset();
  const tonight = mockFetch([
    [/scoreboard/, async () => ({ events: [
      { id: '20', date: '2026-08-16T23:00Z', ...FINAL },
      { id: '21', date: '2026-08-18T23:00Z', ...SCHEDULED }] })],
    [/summary\?event=21/, async () => ({ boxscore: { players: [] } })],
    [/summary\?event=20/, async () => nbaBox('Some Guard', line)],
  ]);
  let skipped;
  try {
    skipped = JSON.parse((await mod.handler({ queryStringParameters: { mode: 'probe', league: 'nba', date: '2026-08-17' } })).body);
  } finally { tonight.restore(); }
  t.eq('the probe skips an unplayed game for the most recent FINISHED one', skipped.gameUsed?.eventId, '20');
  t.ok('...and so reaches a real verdict', /verified/.test(skipped.verdict), skipped.verdict);

  // If every candidate is empty anyway, say the check was inconclusive rather
  // than reporting the whole mapping as broken.
  reset();
  const empty = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '30', date: '2026-08-16T23:00Z', ...FINAL }] })],
    [/summary/, async () => ({ boxscore: { players: [] } })],
  ]);
  let none;
  try {
    none = JSON.parse((await mod.handler({ queryStringParameters: { mode: 'probe', league: 'nba', date: '2026-08-17' } })).body);
  } finally { empty.restore(); }
  t.ok('an empty box score is INCONCLUSIVE, not 19 broken stats', /INCONCLUSIVE/.test(none.verdict));
  t.eq('...and nothing is listed as broken on no evidence', none.brokenStats, undefined);
  t.ok('...with a concrete next step', /mode=probe/.test(none.nextStep || ''));
}

// The MLB fallback grader.
//
// Grading reads PrizePicks' /projections/{id}/history, and a projection is
// retired from that API once it leaves the board. We grade ~36h later, so the id
// can simply be gone — a permanent 404. That is not a neutral gap: an ungradeable
// pick drops out of the calibration sample, so the Brier score ends up computed
// on whatever subset happened to still be reachable. Biased, and silently so.
//
// MLB's game logs are permanent. This suite pins that the fallback settles what
// PrizePicks can't, uses the SAME hit convention, and — most importantly —
// refuses rather than guesses whenever the mapping is uncertain. A wrong grade is
// far worse than an ungraded pick: it writes a false result into calibration.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const log = (group, splits) => ({ stats: [{ splits: splits.map((s) => ({ date: s.date, stat: s.stat })) }] });

export default async function ({ t }) {
  reset();
  const mod = await loadFn('mlb-grade.js');

  // ---- the mapping, which must be exact ----------------------------------
  t.eq('a hitting stat resolves to the hitting box score', mod.resolveStat('Hits')?.group, 'hitting');
  t.eq('a pitching stat resolves to the pitching box score', mod.resolveStat('Pitcher Strikeouts')?.group, 'pitching');
  t.eq('the display name works too', mod.resolveStat('Hitter Ks')?.group, 'hitting');
  t.eq('...and lands on the hitter\'s own strikeouts', mod.resolveStat('Hitter Ks')?.read({ strikeOuts: 3 }), 3);
  t.eq('pitcher Ks read the pitching side', mod.resolveStat('Ks')?.read({ strikeOuts: 9 }), 9);
  t.eq('a derived stat is computed, not guessed',
    mod.resolveStat('Hits+Runs+RBIs')?.read({ hits: 2, runs: 1, rbi: 3 }), 6);
  t.eq('singles are derived from the other hit types',
    mod.resolveStat('Singles')?.read({ hits: 4, doubles: 1, triples: 0, homeRuns: 1 }), 2);
  t.eq('an UNMAPPED stat resolves to nothing rather than a guess', mod.resolveStat('Fantasy Score'), null);

  // ---- grading from a real game log --------------------------------------
  const mock = mockFetch([
    [/\/sports\/1\/players/, async () => ({ people: [{ id: 5001, fullName: 'Elly De La Cruz' }] })],
    [/people\/5001\/stats.*group=hitting/, async () => log('hitting', [
      { date: '2026-08-14', stat: { hits: 2, totalBases: 5, homeRuns: 1, rbi: 3, runs: 1, strikeOuts: 1 } },
      { date: '2026-08-13', stat: { hits: 0, totalBases: 0, homeRuns: 0, rbi: 0, runs: 0, strikeOuts: 2 } },
    ])],
  ]);
  let g;
  try {
    g = await mod.gradeFromMlb({ player: 'Elly De La Cruz', date: '2026-08-14', stat: 'Hits', line: 0.5 });
  } finally { mock.restore(); }
  t.eq('a pick PrizePicks could not serve grades from MLB instead', g?.result, 2);
  t.eq('...using the same convention: hit = actual > line', g?.hit, true);
  t.eq('...and records which source settled it', g?.source, 'mlb');

  // The name lookup is only needed when the pick predates mlbId being logged.
  reset();
  const withId = mockFetch([
    [/\/sports\/1\/players/, async () => { throw new Error('should not need the name index when mlbId is known'); }],
    [/people\/5001\/stats.*group=hitting/, async () => log('hitting', [{ date: '2026-08-14', stat: { totalBases: 5 } }])],
  ]);
  let byId;
  try {
    byId = await mod.gradeFromMlb({ player: 'ignored', mlbId: 5001, date: '2026-08-14', stat: 'Total Bases', line: 3.5 });
  } finally { withId.restore(); }
  t.eq('a known mlbId skips the league-wide name index', byId?.result, 5);
  t.eq('...and grades the over correctly', byId?.hit, true);

  // A miss is a miss.
  reset();
  const missMock = mockFetch([
    [/\/sports\/1\/players/, async () => ({ people: [{ id: 7, fullName: 'Cold Bat' }] })],
    [/people\/7\/stats.*group=hitting/, async () => log('hitting', [{ date: '2026-08-14', stat: { hits: 0 } }])],
  ]);
  let miss;
  try { miss = await mod.gradeFromMlb({ player: 'Cold Bat', date: '2026-08-14', stat: 'Hits', line: 0.5 }); } finally { missMock.restore(); }
  t.eq('an over that did not clear is graded false, not skipped', miss?.hit, false);
  t.eq('...with the real value', miss?.result, 0);

  // ---- where it must REFUSE ----------------------------------------------
  reset();
  const refuse = mockFetch([
    [/\/sports\/1\/players/, async () => ({ people: [{ id: 9, fullName: 'Some Guy' }] })],
    [/people\/9\/stats/, async () => log('hitting', [
      { date: '2026-08-14', stat: { hits: 1 } },
      { date: '2026-08-14', stat: { hits: 2 } },      // doubleheader
    ])],
  ]);
  let dh, unknown, unmapped, noGame;
  try {
    dh = await mod.gradeFromMlb({ player: 'Some Guy', date: '2026-08-14', stat: 'Hits', line: 0.5 });
    unmapped = await mod.gradeFromMlb({ player: 'Some Guy', date: '2026-08-14', stat: 'Fantasy Score', line: 20.5 });
    noGame = await mod.gradeFromMlb({ player: 'Some Guy', date: '2026-08-01', stat: 'Hits', line: 0.5 });
    unknown = await mod.gradeFromMlb({ player: 'Nobody At All', date: '2026-08-14', stat: 'Hits', line: 0.5 });
  } finally { refuse.restore(); }
  t.eq('a doubleheader refuses rather than guessing which game the prop meant', dh, null);
  t.eq('an unmapped stat refuses — a wrong grade is worse than none', unmapped, null);
  t.eq('no game on that date refuses', noGame, null);
  t.eq('an unresolvable player refuses', unknown, null);

  // ---- end to end: PrizePicks 404s, the pick still grades -----------------
  reset();
  const today = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);   // long final
  seed('pick-log', today, [
    { date: today, loggedAt: today + 'T18:00:00Z', league: 'mlb', projectionId: 'DEAD-1',
      player: 'Elly De La Cruz', stat: 'Hits', line: 0.5, prob: 0.7, verdict: 'play',
      result: null, hit: null, gradedAt: null },
  ]);
  const e2e = mockFetch([
    // PrizePicks has retired the projection — exactly the real failure.
    [/api\.prizepicks\.com\/projections\/DEAD-1\/history/, async () => ({ status: 404, body: 'not found' })],
    [/\/sports\/1\/players/, async () => ({ people: [{ id: 5001, fullName: 'Elly De La Cruz' }] })],
    [/people\/5001\/stats.*group=hitting/, async () => log('hitting', [{ date: today, stat: { hits: 2 } }])],
  ]);
  let out;
  try {
    const grader = await loadFn('grade-picks.js');
    out = JSON.parse((await grader.handler({ queryStringParameters: { date: today } })).body);
  } finally { e2e.restore(); }

  const graded = (read('pick-log', today) || [])[0];
  t.eq('a pick whose PrizePicks projection is gone still grades', graded.hit, true);
  t.eq('...with the real box-score value', graded.result, 2);
  t.eq('...marked as settled by the fallback', graded.gradedVia, 'mlb');
  t.eq('the run reports how many the fallback rescued', out.gradedViaMlbFallback, 1);
  t.eq('...and it counts toward the calibration sample', out.totalGraded, 1);

  // ---- attempts are per DAY, not per call --------------------------------
  // grade-cron drains with up to 15 passes per firing, and every pass used to
  // increment the counter. With a limit of 3, anything not instantly gradeable
  // burned all three lives within seconds of the first run and was tombstoned
  // forever — across every league, not just MLB. That is the single biggest
  // reason the graded share sat so far below the logged count.
  reset();
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  seed('pick-log', past, [
    { date: past, loggedAt: past + 'T18:00:00Z', league: 'wnba', projectionId: 'GONE-1',
      player: 'Some Player', stat: 'Points', line: 15.5, prob: 0.6, verdict: 'lean',
      result: null, hit: null, gradedAt: null },
  ]);
  const dead = mockFetch([[/prizepicks\.com/, async () => ({ status: 404, body: 'nf' })]]);
  let last;
  try {
    const grader = await loadFn('grade-picks.js');
    // Ten passes in one run, exactly what the cron's drain loop does.
    for (let i = 0; i < 10; i++) last = JSON.parse((await grader.handler({ queryStringParameters: { date: past } })).body);
  } finally { dead.restore(); }

  const row = (read('pick-log', past) || [])[0];
  t.eq('ten passes in one run cost ONE attempt, not ten', row.gradeAttempts, 1);
  t.eq('...so nothing is tombstoned on day one', row.ungradeable, undefined);
  t.eq('...and it is still counted as pending, not given up', last.givenUp, 0);
  t.ok('the day it was last tried is recorded', !!row.lastAttemptDay, row.lastAttemptDay);

  // Simulate three separate days of failing — THAT is a real give-up.
  const aged = read('pick-log', past);
  aged[0].gradeAttempts = 3;
  aged[0].lastAttemptDay = '2000-01-01';
  seed('pick-log', past, aged);
  const dead2 = mockFetch([[/prizepicks\.com/, async () => ({ status: 404, body: 'nf' })]]);
  let after;
  try {
    const grader = await loadFn('grade-picks.js');
    after = JSON.parse((await grader.handler({ queryStringParameters: { date: past } })).body);
  } finally { dead2.restore(); }
  t.eq('after three DAYS of failing it is finally given up on', after.givenUp, 1);
}

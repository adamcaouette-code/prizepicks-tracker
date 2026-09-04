// Head-of-line blocking in the grader queue.
//
// The grader is time-budgeted: one call reaches ~57 picks and returns, and
// grade-cron drains a day by calling it repeatedly. But every call rebuilt the
// queue from the same head, so whatever failed last pass was re-tried FIRST on
// the next one. A day therefore advanced only by however many of its leading
// picks happened to grade — and if the leaders were ungradeable, it advanced by
// nothing at all, forever.
//
// Measured on 2026-08-31 (359 logged picks) before the fix:
//   gradeAttempts across the ungraded: { 1: 33, undefined: 326 }
//   one pass: newlyGraded 15, stillPending 42, remaining 302, timedOut true
// 326 of 359 picks had never been looked at ONCE, four days running, while ~42
// dead soccer/tennis props at the front ate most of the budget on every pass.
// The whole day is missing from the calibration sample as a result, and 08-29
// (181 pending) fell out of the cron's four-day window still in that state.
//
// The fix is one rule: on a day whose games ended 36h+ ago, a pick gets ONE
// turn per calendar day. It still gets MAX_ATTEMPTS days of turns; it just
// can't take the tail's turn as well.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const iso = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const FINAL = iso(5);         // 5 days ago: comfortably past the 36h final mark
const TODAY = iso(0);

// 'esports' has no MLB and no ESPN slug, so PrizePicks is its only source —
// which makes one mocked endpoint the whole grading path for these picks.
const pick = (n) => ({
  player: `P${n}`, stat: 'Kills', line: 10.5, date: FINAL, league: 'esports',
  projectionId: `proj-${n}`, prob: 0.6, verdict: 'play', tier: 'standard',
  loggedAt: `${FINAL}T18:00:00Z`,
});

const history = (value) => ({
  games: [{ game_start_time: `${FINAL}T20:00:00Z`, stat_value: value }],
});

// A slow endpoint, so a small budget actually bites the way the real one does.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async (gp, q = {}) =>
  JSON.parse((await gp.handler({ queryStringParameters: { date: FINAL, ...q } })).body);

export default async function ({ t }) {
  // A budget small enough to bite, so a pass really does stop partway through
  // the day the way the deployed one does. Read at module load, so it has to be
  // set before the function is imported.
  const prevBudget = process.env.GRADE_BUDGET_MS;
  process.env.GRADE_BUDGET_MS = '60';
  const gp = await loadFn('grade-picks.js');

  // ---- 1. the queue advances even when nothing at the head grades ---------
  reset();
  seed('pick-log', FINAL, Array.from({ length: 24 }, (_, i) => pick(i)));

  const seen = [];
  // The first 6 are permanently dead — exactly the shape of the real failure.
  const m = mockFetch([[/prizepicks\.com\/projections\/proj-(\d+)\/history/, async (url) => {
    const n = Number(url.match(/proj-(\d+)/)[1]);
    seen.push(n);
    await sleep(40);
    return n < 6 ? { status: 404, body: 'gone' } : history(14);
  }]]);

  let passes = [];
  try {
    for (let i = 0; i < 8; i++) passes.push(await run(gp));
  } finally { m.restore(); process.env.GRADE_BUDGET_MS = prevBudget; }

  t.ok('a single budgeted pass cannot reach the whole day',
    passes[0].timedOut === true && passes[0].remaining > 0,
    JSON.stringify({ timedOut: passes[0].timedOut, remaining: passes[0].remaining }));

  // The heart of it: the queue shrinks every pass, so the tail gets its turn.
  const queues = passes.map((p) => p.remaining);
  t.ok('the queue drains monotonically instead of restarting at the head',
    queues.every((r, i) => i === 0 || r <= queues[i - 1]), queues.join(' -> '));
  t.eq('...all the way to empty', queues[queues.length - 1], 0);

  // Every pick was looked at exactly once — the dead six included, and no more.
  const counts = seen.reduce((a, n) => { a[n] = (a[n] || 0) + 1; return a; }, {});
  t.eq('every pick in the day got a turn', Object.keys(counts).length, 24);
  t.eq('...and no pick took a second one while others waited',
    Object.values(counts).filter((c) => c > 1).length, 0, JSON.stringify(counts));

  const saved = read('pick-log', FINAL);
  t.eq('the 18 gradeable picks all settled', saved.filter((p) => p.hit === true).length, 18);
  t.eq('...and only the genuinely dead ones are still pending',
    saved.filter((p) => p.hit == null).map((p) => p.player).sort(),
    ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']);

  // ---- 2. one turn per DAY, not one turn ever -----------------------------
  // A failed pick is held back for the rest of today, then tried again tomorrow
  // — MAX_ATTEMPTS days of chances, not MAX_ATTEMPTS seconds of them.
  const dead = saved.filter((p) => p.hit == null);
  t.eq('a failed pick is stamped with the day it was tried',
    dead.every((p) => p.lastAttemptDay === TODAY), true);
  t.eq('...and charged exactly one attempt for the whole day, across 8 passes',
    dead.map((p) => p.gradeAttempts), [1, 1, 1, 1, 1, 1]);

  // Even with the data now available, they wait their turn — the queue is empty
  // for today, and that is the signal the cron loop stops on.
  const m2 = mockFetch([[/history/, async () => history(14)]]);
  let held;
  try { held = await run(gp); } finally { m2.restore(); }
  t.eq('a pick already tried today is not re-tried today', held.newlyGraded, 0);
  t.eq('...the queue reports itself empty rather than stuck', held.remaining, 0);
  t.eq('...and says why, so an empty pass is not mistaken for a broken one',
    held.triedToday, 6);

  // ---- 3. "try again now" still means now --------------------------------
  // retry=1 used to clear the attempt COUNT only. With a per-day skip in front
  // of it that would report success and grade nothing.
  const m3 = mockFetch([[/history/, async () => history(14)]]);
  const retried = [];
  // Two passes because the tiny test budget only reaches one chunk at a time —
  // the same reason the real drain loops.
  try {
    retried.push(await run(gp, { retry: '1' }));
    retried.push(await run(gp, { retry: '1' }));
  } finally { m3.restore(); }
  t.ok('retry=1 overrides the once-a-day hold rather than reporting a no-op',
    retried[0].newlyGraded > 0, JSON.stringify(retried[0]));
  t.eq('...and draining under it settles all six', retried[1].pendingSingles, 0);

  // ---- 4. a day that is NOT final is the opposite case --------------------
  // Games are still finishing, so re-trying minutes later is exactly right and
  // the skip must not apply.
  const LIVE = iso(0);
  reset();
  seed('pick-log', LIVE, [{ ...pick(99), date: LIVE, loggedAt: `${LIVE}T18:00:00Z` }]);
  const live = async (mock) => {
    const mm = mockFetch([[/history/, mock]]);
    try {
      return JSON.parse((await gp.handler({ queryStringParameters: { date: LIVE } })).body);
    } finally { mm.restore(); }
  };
  const first = await live(async () => ({ status: 404, body: 'not yet' }));
  t.eq('an unfinished game grades nothing on the first look', first.newlyGraded, 0);
  t.eq('...and is not stamped as spent for the day', first.triedToday, 0);
  const second = await live(async () => ({
    games: [{ game_start_time: `${LIVE}T20:00:00Z`, stat_value: 14 }],
  }));
  t.eq('...so the same call minutes later settles it once the game ends',
    second.newlyGraded, 1);

  await cronLoop({ t });
}

// The other half of the same bug lives in the cron loop that calls the grader.
//
// It stopped after two passes that graded nothing, which was correct when every
// pass re-chewed the same head: back then "nothing graded" really did mean
// nothing more ever would. Now that the queue advances whether or not anything
// settles, that rule abandons a tail nobody ever looked at — two passes over a
// run of ungradeable soccer props was enough to bench the MLB picks behind them.
async function cronLoop({ t }) {
  reset();
  const { handler } = await loadFn('grade-cron-background.js');
  const DAY = iso(1);

  // Five scripted passes for one day. Passes 1-3 grade NOTHING — a run of
  // ungradeable soccer props — while the queue behind them drops 240 -> 180 ->
  // 120. The old rule saw two flat readings of pendingSingles and quit at pass
  // 3, with the 120 MLB picks behind them never looked at.
  const script = [
    { pendingSingles: 300, remaining: 240, newlyGraded: 0, dayFinal: true },
    { pendingSingles: 300, remaining: 180, newlyGraded: 0, dayFinal: true },
    { pendingSingles: 300, remaining: 120, newlyGraded: 0, dayFinal: true },
    { pendingSingles: 250, remaining: 60, newlyGraded: 50, dayFinal: true },
    { pendingSingles: 250, remaining: 0, newlyGraded: 0, dayFinal: true, totalGraded: 50 },
  ];
  let n = 0;
  const m = mockFetch([
    [/grade-picks/, async (url) => {
      if (!url.includes(DAY)) return { pendingSingles: 0, remaining: 0, newlyGraded: 0, dayFinal: true };
      return script[Math.min(n++, script.length - 1)];
    }],
    [/grade-slips/, async () => ({ legsGraded: 0, slipsSettled: 0 })],
  ]);
  let out;
  try { out = JSON.parse((await handler({ body: '{}' })).body); } finally { m.restore(); }

  const day = out.ran.find((r) => r.date === DAY);
  t.eq('the loop keeps going through passes that grade nothing but drain the queue',
    day.passes, 5, JSON.stringify(day));
  t.ok('...so it reaches the picks the old two-strike rule left untouched',
    day.totalGraded === 50, JSON.stringify(day));

  // And the window it works over. 2026-08-29 fell out of a four-day window
  // still holding 181 ungraded picks, with nothing left that would revisit it.
  t.eq('a full week is swept, not four days', out.ran.length, 7);
  t.eq('...ending a week back', out.ran[out.ran.length - 1].date, iso(7));

  // A clean day still costs exactly one pass, which is what makes the wider
  // window cheap enough to widen.
  t.eq('a day with nothing pending returns after a single pass',
    out.ran.filter((r) => r.date !== DAY).every((r) => r.passes === 1), true);
}

// The graded-date window on /api/calibration.
//
// `?days=N` filters the date-keyed log, which is when a pick was LOGGED. A
// pre-registered check is scoped by when a pick was GRADED, and the two come
// apart badly here: grading ran by hand for months and then in backfills, so a
// June pick can carry a September gradedAt. Asking `?days` for "graded after
// August 25th" silently answers a different question.
//
// The second half of this suite is about the failure mode that makes the first
// half worth having. A backfill stamps old picks with a fresh gradedAt, so a
// window can be technically correct and still be made almost entirely of games
// the hypothesis was generated from — the in-sample data wearing a new
// timestamp. Nothing in the AUC would look wrong. `gameMonths` is what makes it
// visible without anyone having to think to ask.

import { loadFn } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

const mk = (o) => ({
  league: 'mlb', source: 'board', player: 'P', stat: 'Hits', line: 0.5,
  prob: 0.7, verdict: 'play', oddsType: 'standard',
  result: 1, hit: true, ...o,
});

const call = async (q) => {
  const cal = await loadFn('calibration.js');
  return JSON.parse((await cal.handler({ queryStringParameters: { format: 'json', ...q } })).body);
};

export default async function ({ t }) {
  reset();

  // Three picks logged on the same old day, graded on three different days:
  // before the cutoff, ON the cutoff, and after it.
  seed('pick-log', '2026-06-10', [
    mk({ projectionId: 'before', date: '2026-06-10', gradedAt: '2026-08-24T23:00:00Z' }),
    mk({ projectionId: 'on-the-day', date: '2026-06-10', gradedAt: '2026-08-25T23:00:00Z' }),
    mk({ projectionId: 'after', date: '2026-06-10', gradedAt: '2026-08-26T01:00:00Z' }),
    mk({ projectionId: 'pending', date: '2026-06-10', gradedAt: null, hit: null, result: null }),
  ]);

  const win = await call({ gradedSince: '2026-08-25' });

  t.eq('only the pick graded after the cutoff survives the window', win.graded, 1);
  t.eq('...and the window says so itself', win.gradedWindow.n, 1);

  // The boundary is the reason this is compared on the date part. A timestamp
  // comparison would keep everything graded later in the day on the 25th, which
  // is half a day of the very data a cutoff exists to exclude.
  t.eq('the cutoff day is excluded whole, not split at midnight',
    win.gradedWindow.gameMonths['2026-06'], 1);

  // The point of the parameter: log date and grade date are different axes.
  const byLogDate = await call({ days: 1 });
  t.eq('?days sees none of this — the picks were logged in June', byLogDate.graded, 0);

  // An ungraded pick has no gradedAt, so it cannot be in any graded window.
  // Stated as its own case because "pending rows dropped out" and "pending rows
  // were never picked up" look identical in a count.
  const wideOpen = await call({ gradedSince: '2020-01-01' });
  t.eq('every graded pick is in a wide-open window', wideOpen.graded, 3);
  t.eq('...and the pending one is in none of them', wideOpen.gradedWindow.n, 3);

  // ---- the backfill hazard -------------------------------------------------
  reset();

  // A backfill on 2026-09-04 grades a pile of June games and a few September
  // ones. By gradedAt every row is "after the cutoff". By game date the window
  // is 90% the old season.
  const backfilled = [];
  for (let i = 0; i < 45; i++) {
    backfilled.push(mk({ projectionId: `old-${i}`, date: '2026-06-15', gradedAt: '2026-09-04T12:00:00Z' }));
  }
  for (let i = 0; i < 5; i++) {
    backfilled.push(mk({ projectionId: `new-${i}`, date: '2026-09-02', gradedAt: '2026-09-04T12:00:00Z' }));
  }
  seed('pick-log', '2026-09-04', backfilled);

  const after = await call({ gradedSince: '2026-08-25' });

  t.eq('the whole backfill passes a gradedAt cutoff', after.gradedWindow.n, 50);
  t.ok('but the game months show it is mostly the old season, not new evidence',
    after.gradedWindow.gameMonths['2026-06'] === 45 && after.gradedWindow.gameMonths['2026-09'] === 5,
    JSON.stringify(after.gradedWindow.gameMonths));
  t.ok('...which is the check a bare window count cannot make',
    after.gradedWindow.gameMonths['2026-06'] > after.gradedWindow.gameMonths['2026-09'] * 5,
    '45 old vs 5 new');
}

// Stopping the grader from retrying what it can never settle.
//
// Every ungraded pick costs an attempt and a slot in the run budget on each
// pass. Most of the residue is not waiting on anything: a combo has two players
// in one prop, and an esports pick has no free data source in existence.
//
// The design decision this file pins is that marking is NOT deleting, and that
// two very different things were being lumped together as "can't grade":
//
//   permanent    the prop itself cannot be settled by any box score, ever
//   conditional  only unsupported TODAY — a mapping or a source fixes it
//
// Wiping the conditional ones would have been actively harmful. Every unmapped
// stat in the recent audit became gradeable within days of being reported.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
const pick = (o = {}) => ({
  date: D, loggedAt: D + 'T18:00:00Z', league: 'mlb', source: 'board',
  projectionId: `P${Math.random()}`, player: 'A Hitter', stat: 'Hits', line: 0.5,
  prob: 0.6, verdict: 'play', oddsType: 'standard',
  result: null, hit: null, gradedAt: null, ...o,
});

export default async function ({ t }) {
  reset();
  seed('pick-log', D, [
    pick({ player: 'Real Guy', stat: 'Hits' }),                              // gradeable
    pick({ player: 'A Hitter + B Hitter', stat: 'Hits' }),                   // combo
    pick({ league: 'lol', stat: 'Kills', player: 'Faker' }),                 // no source
    pick({ stat: 'Strikes Counted', player: 'Some Arm' }),                   // no mapping
    pick({ league: 'nba1h', stat: 'Points', player: 'Half Guy' }),           // period prop
    pick({ player: 'Already Done', stat: 'Hits', hit: true, result: 2 }),    // graded
  ]);

  const mod = await loadFn('grade-cleanup.js');

  // ---- preview writes nothing --------------------------------------------
  const preview = JSON.parse((await mod.handler({ queryStringParameters: { dry: '1' } })).body);
  t.ok('the preview reports what it would mark', preview.marked >= 4, `marked ${preview.marked}`);
  t.ok('...and says plainly that it wrote nothing', /nothing written/.test(preview.mode));
  t.eq('...leaving the log untouched',
    (read('pick-log', D) || []).filter((p) => p.ungradeable).length, 0);
  t.ok('...with examples so the list can be sanity-checked before applying',
    preview.examples.length > 0 && !!preview.examples[0].reason);

  // ---- applying marks, and never touches a graded pick --------------------
  const applied = JSON.parse((await mod.handler({ queryStringParameters: {} })).body);
  const rows = read('pick-log', D);
  const by = (n) => rows.find((p) => p.player === n);

  t.eq('a gradeable pick is left alone', by('Real Guy').ungradeable, undefined);
  t.eq('...and counted as still gradeable', applied.stillGradeable, 1);
  t.eq('an already-graded pick is untouched', by('Already Done').hit, true);
  t.eq('...and never marked', by('Already Done').ungradeable, undefined);

  t.ok('a combo is marked', !!by('A Hitter + B Hitter').ungradeable);
  t.eq('...as PERMANENT, because no box score will ever settle it',
    by('A Hitter + B Hitter').ungradeablePermanent, true);
  t.ok('a period prop is permanent too', by('Half Guy').ungradeablePermanent, true);

  t.ok('an esports pick is marked', !!by('Faker').ungradeable);
  t.eq('...but only CONDITIONALLY — a data source would fix it',
    by('Faker').ungradeablePermanent, false);
  t.eq('an unmapped stat is conditional as well',
    by('Some Arm').ungradeablePermanent, false);
  t.ok('...and each carries the reason, not just a flag',
    /no mapping/.test(by('Some Arm').ungradeableReason), by('Some Arm').ungradeableReason);

  t.ok('the split between permanent and conditional is reported',
    applied.permanent === 2 && applied.conditional === 2,
    `permanent ${applied.permanent}, conditional ${applied.conditional}`);
  t.ok('...and it says marks are reversible rather than destructive',
    /not deleted/.test(applied.note));

  // Running it twice must not double-count or re-mark.
  const again = JSON.parse((await mod.handler({ queryStringParameters: {} })).body);
  t.eq('a second run marks nothing new', again.marked, 0);
  t.eq('...and reports what was already marked', again.alreadyMarked, 4);

  // ---- the grader now skips them -----------------------------------------
  const gp = await loadFn('grade-picks.js');
  const m = mockFetch([[/./, async () => ({ status: 404, body: 'no' })]]);
  let run;
  try { run = JSON.parse((await gp.handler({ queryStringParameters: { date: D } })).body); } finally { m.restore(); }
  t.ok('the grader no longer spends attempts on them',
    (read('pick-log', D) || []).filter((p) => p.ungradeable && p.gradeAttempts).length === 0);

  // ---- undo brings back ONLY the conditional ones -------------------------
  const undone = JSON.parse((await mod.handler({ queryStringParameters: { undo: '1' } })).body);
  const after = read('pick-log', D);
  const afterBy = (n) => after.find((p) => p.player === n);
  t.eq('undo revives the conditional marks', undone.revived, 2);
  t.eq('...clearing the mark', afterBy('Faker').ungradeable, undefined);
  t.eq('...and resetting attempts so they are tried again', afterBy('Faker').gradeAttempts, 0);
  t.ok('...while a combo stays marked, because it is still a combo',
    !!afterBy('A Hitter + B Hitter').ungradeable);

  // ---- purging a league outright ------------------------------------------
  // Marking is the default because it is reversible. Purging is not, so it only
  // ever acts on leagues named explicitly in the request — never on a default,
  // and never as a side effect of a normal cleanup run.
  reset();
  seed('pick-log', D, [
    pick({ league: 'world_cup', player: 'A Winger', stat: 'Clearances' }),
    pick({ league: 'world_cup', player: 'B Winger', stat: 'Shots', hit: true, result: 3 }),
    pick({ league: 'mlb', player: 'Keep Me', stat: 'Hits' }),
  ]);
  const plain = JSON.parse((await mod.handler({ queryStringParameters: { dry: '1' } })).body);
  t.eq('a normal run never purges anything', plain.purged, undefined);
  t.eq('...and leaves every row in place', (read('pick-log', D) || []).length, 3);

  const purged = JSON.parse((await mod.handler({
    queryStringParameters: { purgeLeague: 'world_cup' } })).body);
  const left = read('pick-log', D);
  t.eq('naming a league removes its picks', purged.purged, 2);
  t.eq('...including the graded ones, since the whole league is going', left.length, 1);
  t.eq('...leaving other leagues untouched', left[0].player, 'Keep Me');
  t.ok('...and reporting exactly what went, per league', purged.purgedByLeague.world_cup === 2);

  // ---- a new grader era lifts conditional marks by itself -----------------
  // This is why conditional marks are safe to apply now: when a mapping or a
  // source lands, the picks come back with no manual step.
  reset();
  seed('pick-log', D, [
    { ...pick({ league: 'lol', player: 'Faker', stat: 'Kills' }),
      ungradeable: 'cannot grade', ungradeableReason: 'no box-score source wired for lol',
      ungradeablePermanent: false, gradeAttempts: 3, graderEra: 'an-older-era' },
    { ...pick({ player: 'A + B', stat: 'Hits' }),
      ungradeable: 'cannot grade', ungradeableReason: 'combo — two players in one prop',
      ungradeablePermanent: true, gradeAttempts: 3, graderEra: 'an-older-era' },
  ]);
  const gp2 = await loadFn('grade-picks.js');
  const m2 = mockFetch([[/./, async () => ({ status: 404, body: 'no' })]]);
  let era;
  try { era = JSON.parse((await gp2.handler({ queryStringParameters: { date: D } })).body); } finally { m2.restore(); }
  const post = read('pick-log', D);
  t.eq('a conditional mark lifts when the grader era moves',
    post.find((p) => p.player === 'Faker').ungradeable, undefined);
  t.ok('...and is reported as revived', era.revived >= 1);
  t.ok('...while the permanent one stays marked forever',
    !!post.find((p) => p.player === 'A + B').ungradeable);
}

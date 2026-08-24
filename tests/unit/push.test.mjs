// Whole-number lines, and the push.
//
// PrizePicks now posts lines on whole numbers — Points 19, Rebs+Asts 11, Fantasy
// Score 43. On a live board that is 1.1% of MLB and 6.3% of WNBA, and every one
// of them comes back flagged refundable. Landing exactly on the line is not a
// loss there; the leg is refunded and the slip repriced without it.
//
// The whole pipeline settled on `hit = actual > line`, which calls that tie a
// MISS. That is wrong twice: it charges the forecaster for an outcome nobody
// lost money on, and it does so on precisely the picks that landed closest to
// the line — so it drags the calibration curve down exactly where the judge was
// most nearly right.

import { settle } from '../../netlify/functions/grade-picks.js';

export default async function ({ t }) {
  // ---- the ordinary half-point line, unchanged ---------------------------
  t.eq('over a half-point line is a hit', settle(6, 5.5), { result: 6, hit: true });
  t.eq('under it is a miss', settle(5, 5.5), { result: 5, hit: false });
  // A half-point line CANNOT tie, so the push rule can never fire on one.
  t.ok('no half-point line can push',
    [0.5, 1.5, 5.5, 92.5].every((l) => settle(l - 0.5, l).push === undefined
      && settle(l + 0.5, l).push === undefined));

  // ---- the whole-number line --------------------------------------------
  t.eq('landing exactly on a whole line is a push, not a loss',
    settle(19, 19), { result: 19, hit: null, push: true });
  t.eq('...and hit is null rather than false, so it scores nothing either way',
    settle(19, 19).hit, null);
  t.eq('one above still hits', settle(20, 19), { result: 20, hit: true });
  t.eq('one below still misses', settle(18, 19), { result: 18, hit: false });

  // Zero is a real value, not a missing one — a whole line of 0 is rare but a
  // player who records nothing against it has pushed, not lost.
  t.eq('zero against a zero line pushes', settle(0, 0).push, true);
  t.eq('zero against a half line misses', settle(0, 0.5), { result: 0, hit: false });

  // ---- nothing to settle -------------------------------------------------
  // null and '' both become 0 under Number(), so without an explicit guard an
  // absent value settles as a genuine zero — the DNP-scored-as-a-loss failure
  // this pipeline already fights elsewhere. Absent means "no answer".
  t.eq('a missing value settles nothing', settle(null, 5.5), null);
  t.eq('...nor does an empty one', settle('', 5.5), null);
  t.eq('...nor an undefined one', settle(undefined, 5.5), null);
  t.eq('...as does a missing line', settle(3, undefined), null);
  t.eq('...and a non-numeric one', settle('DNP', 5.5), null);

  // Strings arrive from box scores routinely; they must compare as numbers or a
  // push would be missed on every one of them.
  t.eq('a numeric string still pushes', settle('19', 19).push, true);
  t.eq('...and still hits', settle('20', '19').hit, true);
}

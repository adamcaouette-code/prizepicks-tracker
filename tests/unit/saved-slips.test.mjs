// Saved slips: storage, then grading.
//
// The grading half is the dangerous half. grade-picks' gradeOne returns
// `hit = actual > line` — "did the OVER hit" — but a saved leg carries the side
// YOU took. If the under-flip is ever dropped, every under you win gets recorded
// as a loss and the whole saved-slip ledger inverts. That is the assertion this
// suite exists for.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const LEG = (over) => ({
  projectionId: over.id, player: over.player, stat: over.stat, line: over.line,
  pick: over.pick, oddsType: 'standard', team: 'CIN', matchup: 'CIN vs PIT',
  start: '2026-08-14T19:30:00.000-04:00', prob: 0.6, image: null,
});

// PrizePicks history: one settled game per projection.
const history = (value) => ({ games: [{ stat_value: value, game_start_time: '2026-08-14T23:30:00Z' }] });

export default async function ({ t }) {
  // ---------- save / list / rename / delete --------------------------------
  reset();
  const slips = await loadFn('slips.js');

  const save = (body) => slips.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify(body) });
  const list = () => slips.handler({ httpMethod: 'GET', queryStringParameters: {} });

  let res = await save({ legs: [LEG({ id: 'A', player: 'One', stat: 'Hits', line: 0.5, pick: 'over' })] });
  t.eq('a 1-leg slip is rejected — that is not a parlay', res.statusCode, 400);

  res = await save({
    name: '  Friday   night  card ', stake: 10, entry: 'power', league: 'mlb',
    legs: [
      LEG({ id: 'A', player: 'Over Guy',  stat: 'Hits', line: 0.5, pick: 'over' }),
      LEG({ id: 'B', player: 'Under Guy', stat: 'Hits', line: 2.5, pick: 'under' }),
    ],
    sizing: { label: 'POWER', payouts: [{ hits: 2, pays: 30 }, { hits: 1, pays: 0 }], evPerDollar: 0.08 },
  });
  const saved = JSON.parse(res.body).slip;
  t.eq('a valid slip saves', res.statusCode, 200);
  t.eq('the name is trimmed and collapsed', saved.name, 'Friday night card');
  t.eq('stake is kept', saved.stake, 10);
  t.eq('status starts pending', saved.status, 'pending');
  t.eq('slateDate comes from when the legs PLAY, not when you saved', saved.slateDate, '2026-08-14');
  t.eq('legs start ungraded', saved.legs.map((l) => l.hit), [null, null]);

  const listed = JSON.parse((await list()).body).slips;
  t.eq('the slip lists back', listed.length, 1);

  await slips.handler({ httpMethod: 'POST', queryStringParameters: { action: 'rename' }, body: JSON.stringify({ id: saved.id, name: 'Renamed' }) });
  t.eq('rename sticks', JSON.parse((await list()).body).slips[0].name, 'Renamed');

  // An unnamed slip still gets something usable rather than a blank card.
  await save({ legs: [LEG({ id: 'C', player: 'X', stat: 'Hits', line: 0.5, pick: 'over' }), LEG({ id: 'D', player: 'Y', stat: 'Hits', line: 0.5, pick: 'over' })] });
  const auto = JSON.parse((await list()).body).slips.find((s) => s.name !== 'Renamed');
  t.ok('an unnamed slip is auto-titled', /^Slip \d{4}-\d{2}-\d{2}$/.test(auto.name), auto.name);

  await slips.handler({ httpMethod: 'POST', queryStringParameters: { action: 'delete' }, body: JSON.stringify({ id: auto.id }) });
  t.eq('delete removes it', JSON.parse((await list()).body).slips.length, 1);

  // ---------- grading: the inversion --------------------------------------
  // Over Guy took OVER 0.5 and the game produced 2 -> the over hit -> WIN.
  // Under Guy took UNDER 2.5 and the game produced 1 -> the over missed -> WIN.
  // A grader that forgets to flip would mark Under Guy a LOSS.
  const mock = mockFetch([
    ['projections/A/history', async () => history(2)],
    ['projections/B/history', async () => history(1)],
  ]);
  let out;
  try {
    const grader = await loadFn('grade-slips.js');
    out = JSON.parse((await grader.handler({ queryStringParameters: {} })).body);
  } finally { mock.restore(); }

  const graded = read('saved-slips', saved.id);
  const byName = (n) => graded.legs.find((l) => l.player === n);
  t.eq('an OVER leg that cleared its line is a hit', byName('Over Guy').hit, true);
  t.eq('an UNDER leg that stayed below its line is ALSO a hit', byName('Under Guy').hit, true);
  t.eq('the actual result is recorded for the over leg', byName('Over Guy').result, 2);
  t.eq('...and for the under leg', byName('Under Guy').result, 1);
  t.eq('a Power slip with no misses is won', graded.status, 'won');
  t.eq('payout comes from the table quoted at save time', graded.payout, 30);
  t.eq('the run reports what it settled', out.slipsSettled, 1);

  // ---------- grading: an under that loses ---------------------------------
  reset();
  const slips2 = await loadFn('slips.js');
  const r2 = await slips2.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({
    name: 'Loser', stake: 10, entry: 'power',
    legs: [
      LEG({ id: 'E', player: 'Under Loses', stat: 'Hits', line: 1.5, pick: 'under' }),
      LEG({ id: 'F', player: 'Over Wins',   stat: 'Hits', line: 0.5, pick: 'over' }),
    ],
    sizing: { label: 'POWER', payouts: [{ hits: 2, pays: 30 }] },
  }) });
  const s2 = JSON.parse(r2.body).slip;

  const mock2 = mockFetch([
    ['projections/E/history', async () => history(3)],   // 3 > 1.5, so the UNDER lost
    ['projections/F/history', async () => history(2)],   // 2 > 0.5, so the OVER won
  ]);
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock2.restore(); }

  const g2 = read('saved-slips', s2.id);
  t.eq('an UNDER leg beaten by the result is a miss', g2.legs.find((l) => l.player === 'Under Loses').hit, false);
  t.eq('the other leg still hit', g2.legs.find((l) => l.player === 'Over Wins').hit, true);
  t.eq('one miss loses a Power slip', g2.status, 'lost');
  t.eq('a lost slip pays zero, not null', g2.payout, 0);

  // ---------- grading: nothing to grade against ----------------------------
  reset();
  const slips3 = await loadFn('slips.js');
  const r3 = await slips3.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({
    entry: 'power', stake: 10,
    legs: [
      { player: 'No Id', stat: 'Hits', line: 0.5, pick: 'over', start: '2026-08-14T19:30:00.000-04:00' },
      { player: 'Also No Id', stat: 'Hits', line: 0.5, pick: 'over', start: '2026-08-14T19:30:00.000-04:00' },
    ] }) });
  const s3 = JSON.parse(r3.body).slip;
  t.eq('a leg with no projection id saves with a null id', s3.legs[0].projectionId, null);
  const mock3 = mockFetch([]);
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock3.restore(); }
  const g3 = read('saved-slips', s3.id);
  t.eq('...and is marked ungradeable rather than guessed', g3.legs[0].ungradeable, 'no projection id');
  t.eq('the slip says so instead of claiming a result', g3.status, 'ungradeable');
  t.eq('...and counts how many legs it could not look up', g3.ungradeableLegs, 2);

  // ---------- one leg gradeable, one not -----------------------------------
  // A missing id must never poison the legs that CAN be settled, and when the
  // graded legs already decide the card, the unknown one is irrelevant.
  reset();
  const slips4 = await loadFn('slips.js');
  const mkMixed = async (pick, name) => JSON.parse((await slips4.handler({ httpMethod: 'POST', queryStringParameters: {},
    body: JSON.stringify({ name, entry: 'power', stake: 10,
      legs: [
        LEG({ id: 'G', player: 'Has Id', stat: 'Hits', line: 0.5, pick }),
        { player: 'No Id', stat: 'Hits', line: 0.5, pick: 'over', start: '2026-08-14T19:30:00.000-04:00' },
      ],
      sizing: { label: 'POWER', payouts: [{ hits: 2, pays: 30 }] } }) })).body).slip;

  const decided = await mkMixed('under', 'Decided by the graded leg');
  const mock4 = mockFetch([['projections/G/history', async () => history(3)]]);  // 3 > 0.5 -> the UNDER lost
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock4.restore(); }
  const g4 = read('saved-slips', decided.id);
  t.eq('the gradeable leg still settles despite its neighbour', g4.legs[0].hit, false);
  t.eq('the unknown leg is flagged, not guessed', g4.legs[1].ungradeable, 'no projection id');
  t.eq('a confirmed miss loses a Power card even with an unknown leg', g4.status, 'lost');

  reset();
  const slips5 = await loadFn('slips.js');
  const undecided = JSON.parse((await slips5.handler({ httpMethod: 'POST', queryStringParameters: {},
    body: JSON.stringify({ name: 'Cannot be decided', entry: 'power', stake: 10,
      legs: [
        LEG({ id: 'H', player: 'Has Id', stat: 'Hits', line: 0.5, pick: 'over' }),
        { player: 'No Id', stat: 'Hits', line: 0.5, pick: 'over', start: '2026-08-14T19:30:00.000-04:00' },
      ] }) })).body).slip;
  const mock5 = mockFetch([['projections/H/history', async () => history(2)]]);   // that leg HIT
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock5.restore(); }
  const g5 = read('saved-slips', undecided.id);
  t.eq('the known leg is recorded as a hit', g5.legs[0].hit, true);
  t.eq('but a card that hinges on the unknown leg is NOT called a win', g5.status, 'ungradeable');
  t.eq('...and no payout is invented for it', g5.payout, null);

  // ---------- retention -----------------------------------------------------
  // Old slips are swept so the list stays readable. Measured from the slate date
  // with a day of grace, so last night's card is never deleted before it settles.
  reset();
  const slips6 = await loadFn('slips.js');
  const withSlate = async (slateDate, name) => {
    const r = await slips6.handler({ httpMethod: 'POST', queryStringParameters: {},
      body: JSON.stringify({ name, entry: 'power', stake: 10,
        legs: [LEG({ id: 'Z1', player: 'A', stat: 'Hits', line: 0.5, pick: 'over' }),
               LEG({ id: 'Z2', player: 'B', stat: 'Hits', line: 0.5, pick: 'over' })] }) });
    const slip = JSON.parse(r.body).slip;
    slip.slateDate = slateDate;            // rewrite the slate to age it
    seed('saved-slips', slip.id, slip);
    return slip;
  };
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const fresh = await withSlate(iso(0), 'Tonight');
  const edge = await withSlate(iso(3), 'Three days ago');
  const old = await withSlate(iso(9), 'Ancient');

  const mock6 = mockFetch([[/history/, async () => history(2)]]);
  let out6;
  try {
    const grader = await loadFn('grade-slips.js');
    out6 = JSON.parse((await grader.handler({ queryStringParameters: {} })).body);
  } finally { mock6.restore(); }

  t.eq('retention window is 3 days', out6.retentionDays, 3);
  t.ok('tonight\'s slip survives', !!read('saved-slips', fresh.id));
  t.ok('a 3-day-old slip is still inside the window', !!read('saved-slips', edge.id), 'grace day keeps it');
  t.eq('a long-expired slip is swept', read('saved-slips', old.id), null);
  t.eq('and the sweep is reported', out6.pruned, 1);
}

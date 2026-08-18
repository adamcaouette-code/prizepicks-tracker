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
  start: START, prob: 0.6, image: null,
});

// PrizePicks history: one settled game per projection.
// The slate these fixtures play on. It MUST be relative to today: retention
// sweeps a settled slip 4 days after its slate date, so a hardcoded date turns
// into a time bomb that passes until the calendar catches up and then deletes
// the fixture mid-test. Two days back is old enough to be final (36h) and far
// enough from the 4-day sweep to never race it.
const SLATE = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const START = `${SLATE}T19:30:00.000-04:00`;
const history = (value) => ({ games: [{ stat_value: value, game_start_time: `${SLATE}T23:30:00Z` }] });

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
  t.eq('slateDate comes from when the legs PLAY, not when you saved', saved.slateDate, SLATE);
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
      { player: 'No Id', stat: 'Hits', line: 0.5, pick: 'over', start: START },
      { player: 'Also No Id', stat: 'Hits', line: 0.5, pick: 'over', start: START },
    ] }) });
  const s3 = JSON.parse(r3.body).slip;
  t.eq('a leg with no projection id saves with a null id', s3.legs[0].projectionId, null);
  const mock3 = mockFetch([]);
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock3.restore(); }
  const g3 = read('saved-slips', s3.id);
  // A missing projection id is no longer an instant write-off: MLB and ESPN
  // settle a leg from player + date + stat and never needed the id. So the leg
  // stays open while the box-score sources are given a real chance, and the slip
  // reports pending rather than inventing a result.
  t.eq('a missing id is no longer an instant write-off', g3.legs[0].ungradeable, undefined);
  t.eq('the slip claims no result it does not have', g3.status, 'pending');

  // Once the box score has genuinely had its attempts and still cannot find the
  // player, THEN it is declared ungradeable — honestly, and only then.
  for (const leg of g3.legs) { leg.gradeAttempts = 9; leg.lastAttemptDay = '2020-01-01'; leg.graderEra = 'espn+mlb-2026-08'; }
  seed('saved-slips', s3.id, g3);
  const mock3b = mockFetch([]);
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock3b.restore(); }
  const g3b = read('saved-slips', s3.id);
  t.eq('a leg the box score could never find is finally marked ungradeable', g3b.legs[0].ungradeable, 'gave up');
  t.eq('...and the slip says so instead of claiming a result', g3b.status, 'ungradeable');
  t.eq('...and counts how many legs it could not look up', g3b.ungradeableLegs, 2);

  // ---------- one leg gradeable, one not -----------------------------------
  // A missing id must never poison the legs that CAN be settled, and when the
  // graded legs already decide the card, the unknown one is irrelevant.
  reset();
  const slips4 = await loadFn('slips.js');
  const mkMixed = async (pick, name) => JSON.parse((await slips4.handler({ httpMethod: 'POST', queryStringParameters: {},
    body: JSON.stringify({ name, entry: 'power', stake: 10,
      legs: [
        LEG({ id: 'G', player: 'Has Id', stat: 'Hits', line: 0.5, pick }),
        { player: 'No Id', stat: 'Hits', line: 0.5, pick: 'over', start: START },
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
  t.eq('the unknown leg is never guessed at', g4.legs[1].hit, null);
  t.eq('a confirmed miss loses a Power card even with an unknown leg', g4.status, 'lost');

  reset();
  const slips5 = await loadFn('slips.js');
  const undecided = JSON.parse((await slips5.handler({ httpMethod: 'POST', queryStringParameters: {},
    body: JSON.stringify({ name: 'Cannot be decided', entry: 'power', stake: 10,
      legs: [
        LEG({ id: 'H', player: 'Has Id', stat: 'Hits', line: 0.5, pick: 'over' }),
        { player: 'No Id', stat: 'Hits', line: 0.5, pick: 'over', start: START },
      ] }) })).body).slip;
  const mock5 = mockFetch([['projections/H/history', async () => history(2)]]);   // that leg HIT
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { mock5.restore(); }
  const g5 = read('saved-slips', undecided.id);
  t.eq('the known leg is recorded as a hit', g5.legs[0].hit, true);
  t.eq('but a card that hinges on the unknown leg is NOT called a win', g5.status, 'pending');
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

  // ---------- no model spend on saved slips --------------------------------
  // A saved slip is a RECORD, not a judgement. Saving one and settling it must
  // cost nothing at the model: results come from PrizePicks' history endpoint
  // and arithmetic. This asserts it against the real handlers rather than
  // trusting that nobody adds a "let Claude summarise it" call later.
  reset();
  const slips7 = await loadFn('slips.js');
  const guardMock = mockFetch([
    [/history/, async () => history(2)],
    // MLB is consulted first now (PrizePicks 403s), so the box-score lookups
    // belong in this trace too. Neither source is a model, which is the point.
    [/statsapi\.mlb\.com/, async () => ({})],
    ['api.anthropic.com', async () => { throw new Error('the saved-slip path must never call a model'); }],
  ]);
  let calls;
  try {
    const r7 = await slips7.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({
      name: 'No model spend', entry: 'power', stake: 10,
      legs: [
        LEG({ id: 'M1', player: 'A', stat: 'Hits', line: 0.5, pick: 'over' }),
        LEG({ id: 'M2', player: 'B', stat: 'Hits', line: 0.5, pick: 'under' }),
      ],
      sizing: { label: 'POWER', payouts: [{ hits: 2, pays: 30 }] } }) });
    const s7 = JSON.parse(r7.body).slip;
    await slips7.handler({ httpMethod: 'GET', queryStringParameters: {} });
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
    calls = guardMock.calls.map((c) => c.url);
    t.ok('the slip still settled', read('saved-slips', s7.id).status === 'lost');
  } finally { guardMock.restore(); }

  t.eq('saving + listing + grading makes ZERO model calls',
    calls.filter((u) => /anthropic|openai|\/v1\/messages/i.test(u)), []);
  t.ok('every outbound call is a plain sports-data lookup — MLB or PrizePicks',
    calls.every((u) => /prizepicks\.com|statsapi\.mlb\.com/.test(u)), calls.join(' '));

  // ---------- the slate date must not drift into tomorrow ------------------
  // A slip saved at 9pm Eastern is ALREADY tomorrow in UTC. Using the UTC date as
  // the fallback stamped such a slip with a slate a day ahead of its own games —
  // the grader then looked up the wrong day, never matched, and the slip sat
  // "pending" forever. That is the bug behind "it didn't check at 3am".
  reset();
  const slips8 = await loadFn('slips.js');
  const NINE_PM_ET = new Date('2026-08-15T01:30:00Z');   // = 9:30pm ET on the 14th
  t.eq('a 9:30pm ET save is dated the 14th, not the UTC 15th',
    slips8.slateDateFor([], NINE_PM_ET), '2026-08-14');
  t.eq('a midday save is unambiguous either way',
    slips8.slateDateFor([], new Date('2026-08-14T18:00:00Z')), '2026-08-14');
  // These slateDateFor cases pass an explicit `now`, so their dates ARE the
  // point of the test and stay fixed — nothing here is stored or swept.
  t.eq('a leg with a real start time always wins over the clock',
    slips8.slateDateFor([{ start: '2026-08-14T19:30:00.000-04:00' }], NINE_PM_ET), '2026-08-14');
  t.eq('the EARLIEST leg decides the slate',
    slips8.slateDateFor([
      { start: '2026-08-14T22:10:00.000-04:00' },
      { start: '2026-08-14T13:05:00.000-04:00' },
    ], NINE_PM_ET), '2026-08-14');

  // ---------- an off-by-one slate date is still gradeable ------------------
  // Belt and braces for slips already saved with a drifted date: the game lookup
  // now accepts D-1 as well as D and D+1.
  reset();
  const slips9 = await loadFn('slips.js');
  const drifted = JSON.parse((await slips9.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({
    name: 'Drifted date', entry: 'power', stake: 10,
    legs: [
      LEG({ id: 'W1', player: 'A', stat: 'Hits', line: 0.5, pick: 'over' }),
      LEG({ id: 'W2', player: 'B', stat: 'Hits', line: 0.5, pick: 'over' }),
    ],
    sizing: { label: 'POWER', multipliers: [{ hits: 2, mult: 3 }], payouts: [{ hits: 2, pays: 30 }] } }) })).body).slip;
  // Force the slate a day AHEAD of the games, as the old fallback would have.
  const bad = read('saved-slips', drifted.id);
  bad.slateDate = '2026-08-15';
  seed('saved-slips', drifted.id, bad);

  const driftMock = mockFetch([[/history/, async () => ({ games: [{ stat_value: 2, game_start_time: `${SLATE}T23:30:00Z` }] })]]);
  try {
    const grader = await loadFn('grade-slips.js');
    await grader.handler({ queryStringParameters: {} });
  } finally { driftMock.restore(); }
  const fixed = read('saved-slips', drifted.id);
  t.eq('a slip dated a day ahead of its games still settles', fixed.status, 'won');
  t.eq('...with the real result recorded', fixed.legs[0].result, 2);

  // ---------- attempts must not burn before the games finish ---------------
  // This is the "it gave up on grading those slips" bug. grade-picks only counts
  // a failed lookup once the day is FINAL and resets premature ones; grade-slips
  // copied the tombstone but not the guard — and settle-on-open calls it on every
  // visit to My Slips. Three page-opens while tonight's games were in progress
  // permanently benched the legs before a box score existed.
  reset();
  const slipsA = await loadFn('slips.js');
  const graderA = await loadFn('grade-slips.js');
  const todayISO = new Date().toISOString().slice(0, 10);
  const mkPending = async (slateDate, name) => {
    const r = await slipsA.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({
      name, entry: 'power', stake: 10,
      legs: [LEG({ id: 'T1', player: 'A', stat: 'Hits', line: 0.5, pick: 'over' }),
             LEG({ id: 'T2', player: 'B', stat: 'Hits', line: 0.5, pick: 'over' })] }) });
    const slip = JSON.parse(r.body).slip;
    slip.slateDate = slateDate;
    seed('saved-slips', slip.id, slip);
    return slip;
  };

  // Tonight's slate: history has nothing yet, exactly like a game in progress.
  const tonight = await mkPending(todayISO, 'Tonight');
  const noData = mockFetch([[/history/, async () => ({ games: [] })]]);
  try {
    for (let i = 0; i < 5; i++) await graderA.handler({ queryStringParameters: {} });   // five page-opens
  } finally { noData.restore(); }
  const after = read('saved-slips', tonight.id);
  t.eq('five failed passes before the slate is final bench nothing',
    after.legs.filter((l) => l.ungradeable).length, 0);
  t.eq('...and burn no attempts', after.legs.map((l) => l.gradeAttempts || 0), [0, 0]);
  t.eq('the slip is still pending, not ungradeable', after.status, 'pending');

  // And once results DO land, it settles normally.
  const late = mockFetch([[/history/, async () => ({ games: [{ stat_value: 2, game_start_time: todayISO + 'T23:30:00Z' }] })]]);
  try { await graderA.handler({ queryStringParameters: {} }); } finally { late.restore(); }
  t.eq('once the box score lands it grades', read('saved-slips', tonight.id).status, 'won');

  // ---------- a genuinely stuck leg can be rescued --------------------------
  reset();
  const slipsB = await loadFn('slips.js');
  const graderB = await loadFn('grade-slips.js');
  const rB = await slipsB.handler({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({
    name: 'Stuck', entry: 'power', stake: 10,
    legs: [LEG({ id: 'S1', player: 'A', stat: 'Hits', line: 0.5, pick: 'over' }),
           LEG({ id: 'S2', player: 'B', stat: 'Hits', line: 0.5, pick: 'over' })],
    sizing: { label: 'POWER', multipliers: [{ hits: 2, mult: 3 }], payouts: [{ hits: 2, pays: 30 }] } }) });
  const stuck = JSON.parse(rB.body).slip;
  // Two days back: past the 36h finality mark, still inside the 3-day retention
  // window. Older than that and the sweep deletes it before grading runs.
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const benched = read('saved-slips', stuck.id);
  benched.slateDate = twoDaysAgo;
  benched.legs.forEach((l) => { l.ungradeable = 'gave up'; l.gradeAttempts = 9; });
  seed('saved-slips', stuck.id, benched);

  const rescue = mockFetch([[/history/, async () => ({ games: [{ stat_value: 2, game_start_time: twoDaysAgo + 'T23:30:00Z' }] })]]);
  let rep;
  try { rep = JSON.parse((await graderB.handler({ queryStringParameters: { retry: '1' } })).body); } finally { rescue.restore(); }
  const rescued = read('saved-slips', stuck.id);
  t.ok('retry clears recoverable tombstones', rep.revived > 0, String(rep.revived));
  t.eq('...and the legs actually grade on the retry', rescued.legs.map((l) => l.hit), [true, true]);
  t.eq('...settling the slip', rescued.status, 'won');
}

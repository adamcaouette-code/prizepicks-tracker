// The append-only ledger: bets, snapshots, and grading kept apart.
//
// The whole value of a bet log is that it cannot be tidied up afterwards. A
// history you can quietly edit will drift toward the version you'd prefer, and
// nothing downstream — CLV, hit rate, ROI — means anything once it can.
//
// So the guarantee is tested from three directions:
//   1. the writer refuses a second write and THROWS, rather than returning a
//      falsy value a caller can ignore
//   2. the refusal comes from the STORE (a conditional write), not from a
//      check-then-write in the app, which two concurrent callers would race
//   3. grading a leg cannot touch the bet row, because it is a different store
//      and the grading path cannot reach the bets one
//
// The load-bearing detail is #2. `onlyIfNew` is a compare-and-set performed by
// the storage service: the second write comes back { modified: false } and the
// stored bytes are untouched. An app-level "does it exist?" test would pass
// this suite and still lose a row under concurrency.

import { loadFn } from '../helpers/fn.mjs';
import { reset, read, keys, forceWrite } from '../helpers/blobs.mjs';

const CAP = '2026-09-09T14:00:00.000Z';

const prop = (o = {}) => ({
  league: 'mlb', player: 'Elly De La Cruz', team: 'CIN', opponent: 'PIT',
  market: 'Hits', pp_line: 0.5, pp_tier: 'goblin', is_goblin: true, is_demon: false,
  pp_multiplier: 2.0, books: [], book_status: 'ok', ...o,
});

// propKey reads `line`, the shape a caller passes in; rows carry pp_line too.
const withLine = (o) => ({ ...prop(o), line: o.pp_line ?? 0.5 });

export default async function ({ t }) {
  const L = await loadFn('ledger-store.js');

  // ---- 1. a bet is written once ------------------------------------------
  reset();
  await L.appendCapture({
    capturedAt: CAP,
    rows: [withLine({ pp_line: 0.5 }), withLine({ player: 'Corbin Carroll', market: 'Total Bases', pp_line: 1.5 })],
  });
  const cap = read('line-snapshots', `capture/${CAP}`);
  const snapId = cap.rows[0].id;

  const bet = {
    slip_id: 'slip-001',
    placed_at: '2026-09-09T14:07:00.000Z',
    slip_type: 'power',
    stake: 20,
    legs: [{ player: 'Elly De La Cruz', market: 'Hits', line: 0.5, side: 'over', snapshot_id: snapId }],
  };
  const written = await L.appendBet(bet);
  t.eq('the slip is stored under its own id', keys('bets'), ['slip-001']);
  t.eq('...with the foreign key to the snapshot that was current when it was placed',
    written.legs[0].snapshot_id, snapId);

  // THE REQUIREMENT: an update attempt must throw.
  let threw = null;
  try {
    await L.appendBet({ ...bet, stake: 999 });
  } catch (e) { threw = e; }
  t.ok('a second write to the same slip THROWS', !!threw, String(threw));
  t.eq('...as a named error a caller can branch on', threw?.name, 'AppendOnlyViolation');
  t.ok('...and the message says what to do instead of editing',
    /append a new one that supersedes it/i.test(threw?.message || ''), threw?.message);
  t.eq('...and the original row is untouched', read('bets', 'slip-001').stake, 20);

  // ---- 2. the refusal comes from the store, not from a check --------------
  // If the guard were `if (await get(key)) throw`, two concurrent appends could
  // both read empty and both write, and the later one would win silently. The
  // conditional write makes the STORE reject the second, whoever calls it —
  // which is why this asserts on the raw store call, beneath the module.
  const { getStore } = await import('../helpers/blobs.mjs');
  const raw = getStore({ name: 'bets' });
  const second = await raw.setJSON('slip-001', { slip_id: 'slip-001', stake: 999 }, { onlyIfNew: true });
  t.eq('the store itself refuses an overwrite', second.modified, false);
  t.eq('...leaving the bytes alone', read('bets', 'slip-001').stake, 20);
  // And the same call WITHOUT the flag would have clobbered it — which is the
  // proof that the flag is doing the work rather than the test being polite.
  const unguarded = await raw.setJSON('slip-002', { slip_id: 'slip-002', stake: 1 });
  t.eq('an unconditional write to a FREE key still succeeds', unguarded.modified, true);

  // ---- 3. a snapshot capture is never rewritten ---------------------------
  let capThrew = null;
  try {
    await L.appendCapture({ capturedAt: CAP, rows: [withLine({ pp_line: 99 })] });
  } catch (e) { capThrew = e; }
  t.eq('re-capturing an instant that already has one throws', capThrew?.name, 'AppendOnlyViolation');
  t.eq('...and the archived line is still the original', read('line-snapshots', `capture/${CAP}`).rows[0].pp_line, 0.5);

  // ---- 4. grading cannot mutate the bet -----------------------------------
  const legIdent = written.legs[0].leg_id;
  await L.appendResult({ leg_id: legIdent, slip_id: 'slip-001', outcome: 'won', actual: 2 });
  t.eq('the grade lands in its own store', keys('bet-results'), [legIdent]);
  t.eq('...keyed by LEG, not by slip', read('bet-results', legIdent).leg_id, legIdent);
  t.eq('the bet row is byte-identical after grading',
    JSON.stringify(read('bets', 'slip-001')), JSON.stringify(written));
  t.ok('the bet row carries no outcome field at all — there is nowhere to put one',
    !('outcome' in read('bets', 'slip-001')) && !('hit' in read('bets', 'slip-001')), '');

  let regrade = null;
  try {
    await L.appendResult({ leg_id: legIdent, slip_id: 'slip-001', outcome: 'lost' });
  } catch (e) { regrade = e; }
  t.eq('a leg cannot be re-graded in place either', regrade?.name, 'AppendOnlyViolation');
  t.eq('...and the first grade stands', read('bet-results', legIdent).outcome, 'won');

  // ---- 5. foreign keys are checked, since the store cannot ----------------
  let dangling = null;
  try {
    await L.appendBet({
      ...bet, slip_id: 'slip-003',
      legs: [{ ...bet.legs[0], snapshot_id: 'capture/2020-01-01T00:00:00.000Z#deadbeef' }],
    });
  } catch (e) { dangling = e; }
  t.ok('a leg pointing at a snapshot that does not exist is refused',
    /does not exist/.test(dangling?.message || ''), dangling?.message);
  t.ok('...and nothing was written', !keys('bets').includes('slip-003'), keys('bets').join(','));

  // A leg with NO snapshot is allowed — that is a historical import, and a
  // visible null is better than a fabricated foreign key. See seed-bets.mjs.
  await L.appendBet({ ...bet, slip_id: 'slip-004', legs: [{ ...bet.legs[0], snapshot_id: null }] });
  t.ok('a leg with no snapshot at all is allowed, for pre-archive history',
    keys('bets').includes('slip-004'), '');

  // ---- 6. the integrity report finds what the store cannot enforce --------
  // Blobs has no referential integrity, so a row written by some other route —
  // a hand-run script, a future bug — can dangle. verifyIntegrity is the only
  // thing that would ever notice, so it has to actually notice.
  forceWrite('bets', 'slip-bad', {
    schema_version: 1, slip_id: 'slip-bad', placed_at: CAP, slip_type: 'power', stake: 5,
    legs: [{ leg_id: 'slip-bad#L0', player: 'X', market: 'Hits', line: 0.5, side: 'over',
      snapshot_id: 'capture/1999-01-01T00:00:00.000Z#nope' }],
  });
  const report = await L.verifyIntegrity();
  t.ok('a dangling foreign key is reported',
    report.problems.some((p) => /dangling snapshot_id/.test(p.problem)), JSON.stringify(report.problems));
  t.eq('...naming the slip it is in',
    report.problems.find((p) => /dangling/.test(p.problem))?.slip_id, 'slip-bad');
  t.ok('...while the healthy rows are not flagged',
    !report.problems.some((p) => p.slip_id === 'slip-001'), JSON.stringify(report.problems));

  // ---- 7. validation refuses a malformed bet BEFORE it reaches the store --
  // An append-only store cannot be cleaned up, so a bad row is permanent. The
  // cheapest moment to reject one is before it exists.
  const bad = [
    [{ ...bet, slip_id: 'v1', stake: -1 }, /stake/],
    [{ ...bet, slip_id: 'v2', placed_at: 'whenever' }, /placed_at/],
    [{ ...bet, slip_id: 'v3', legs: [] }, /legs/],
    [{ ...bet, slip_id: 'v4', legs: [{ ...bet.legs[0], side: 'maybe' }] }, /side/],
    [{ ...bet, slip_id: 'v5', legs: [{ ...bet.legs[0], line: 'a lot' }] }, /line/],
  ];
  for (const [b, re] of bad) {
    let e = null;
    // eslint-disable-next-line no-await-in-loop
    try { await L.appendBet(b); } catch (err) { e = err; }
    t.ok(`a bet failing "${re.source}" is refused before it is written`, re.test(e?.message || ''), e?.message);
    t.ok(`...and leaves no row behind`, !keys('bets').includes(b.slip_id), '');
  }
}

// Migrations for an append-only ledger.
//
// The constraint that shapes all of this: a migration cannot rewrite rows,
// because rewriting rows is the one operation the whole design exists to
// prevent. So a migration here may only CREATE — and it must be safe to run
// twice, since there is no transaction to roll back a half-finished one.

import { loadFn } from '../helpers/fn.mjs';
import { reset, read, keys } from '../helpers/blobs.mjs';

export default async function ({ t }) {
  const L = await loadFn('ledger-store.js');

  // ---- the version marker -------------------------------------------------
  reset();
  const fresh = await L.readMeta();
  t.eq('an uninitialised ledger reports v0, not an error', fresh.version, 0);
  t.eq('...with an empty history', fresh.history, []);

  await L.writeMeta({ version: 1, history: [{ version: 1, name: 'create-ledger-stores' }] });
  t.eq('the version is readable back', (await L.readMeta()).version, 1);

  // The ONE mutable key in the system, and deliberately so: it describes the
  // ledger rather than being part of it, and a second migration could never be
  // recorded if it were append-only.
  await L.writeMeta({ version: 2, history: [{ version: 2, name: 'next' }] });
  t.eq('...and updatable, because migration bookkeeping is not a ledger row',
    (await L.readMeta()).version, 2);

  // ---- rows carry their own version --------------------------------------
  // This is what makes a forward migration possible without rewriting history:
  // a reader can tell a v1 row from a v2 row and handle both.
  reset();
  const cap = await L.appendCapture({
    capturedAt: '2026-09-09T14:00:00.000Z',
    rows: [{ league: 'mlb', player: 'P', market: 'Hits', line: 0.5, pp_line: 0.5, books: [] }],
  });
  t.eq('a capture records the schema it was written under', cap.schema_version, L.SCHEMA_VERSION);
  t.eq('...and so does every row inside it', cap.rows[0].schema_version, L.SCHEMA_VERSION);

  await L.appendBet({
    slip_id: 's1', placed_at: '2026-09-09T14:07:00.000Z', slip_type: 'power', stake: 5,
    legs: [{ player: 'P', market: 'Hits', line: 0.5, side: 'over', snapshot_id: cap.rows[0].id }],
  });
  t.eq('a bet does too', read('bets', 's1').schema_version, L.SCHEMA_VERSION);
  await L.appendResult({ leg_id: 's1#L0', slip_id: 's1', outcome: 'won' });
  t.eq('...and a result', read('bet-results', 's1#L0').schema_version, L.SCHEMA_VERSION);

  // A row from an older schema is REPORTED rather than rewritten — the report
  // is what a forward migration acts on, and the row itself stays as written.
  const { forceWrite } = await import('../helpers/blobs.mjs');
  forceWrite('bets', 's-old', {
    schema_version: 0, slip_id: 's-old', placed_at: '2026-01-01T00:00:00.000Z',
    slip_type: 'power', stake: 5, legs: [{ leg_id: 's-old#L0', player: 'P', market: 'Hits', line: 0.5, side: 'over', snapshot_id: null }],
  });
  const report = await L.verifyIntegrity();
  t.ok('an out-of-date row is surfaced by the integrity check',
    report.problems.some((p) => p.slip_id === 's-old' && /schema_version/.test(p.problem)),
    JSON.stringify(report.problems));
  t.eq('...and is still there afterwards, unchanged', read('bets', 's-old').schema_version, 0);

  // ---- the counts the report gives ---------------------------------------
  t.eq('the report counts bets, legs and how many are priced',
    [report.bets, report.legs, report.legsWithSnapshot], [2, 2, 1]);
  t.eq('...and grades', report.results, 1);

  // A result for a leg that does not exist is the other kind of dangling
  // reference, and it points the opposite way from a bad snapshot_id.
  await L.appendResult({ leg_id: 'ghost#L9', slip_id: 'ghost', outcome: 'lost' });
  const after = await L.verifyIntegrity();
  t.ok('a grade for a leg that does not exist is caught too',
    after.problems.some((p) => p.leg_id === 'ghost#L9'), JSON.stringify(after.problems));

  // ---- idempotence -------------------------------------------------------
  // The migration's own step: writing a marker only if absent. Re-running must
  // be a no-op, because a partially-applied migration is finished by running it
  // again.
  const { getStore } = await import('../helpers/blobs.mjs');
  const s = getStore({ name: 'bets' });
  const first = await s.setJSON('_created', { at: 'T1' }, { onlyIfNew: true });
  const second = await s.setJSON('_created', { at: 'T2' }, { onlyIfNew: true });
  t.eq('the marker is written once', first.modified, true);
  t.eq('...and re-running does not rewrite it', second.modified, false);
  t.eq('...leaving the original timestamp', read('bets', '_created').at, 'T1');

  // The marker must not read as a bet. It passed a weaker version of this
  // assertion while allBets() was returning it as a row with no slip_id, which
  // verifyIntegrity then reported as a permanent schema violation — an error
  // that would have appeared the moment the ledger was initialised and never
  // gone away.
  t.ok('the marker is in the store', keys('bets').includes('_created'), keys('bets').join(','));
  const listed = await L.listBets();
  t.ok('...but is not listed as a bet', !listed.includes('_created'), listed.join(','));
  t.ok('...and every row allBets returns is a real bet',
    (await L.allBets()).every((b) => !!b.slip_id), JSON.stringify(await L.allBets()));
  const clean = await L.verifyIntegrity();
  // Precisely: no problem about a row that is not a row. A result-side problem
  // legitimately carries no slip_id, so "has no slip_id" is the wrong test.
  t.ok('...so the integrity report does not flag it forever',
    !clean.problems.some((p) => p.slip_id === '_created' || /undefined !=/.test(p.problem)),
    JSON.stringify(clean.problems));
  t.eq('...and the bet count excludes it', clean.bets, 2);
}

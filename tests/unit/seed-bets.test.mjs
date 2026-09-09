// Seeding the ledger with bets placed before it existed.
//
// The import is where an append-only store is most likely to be poisoned: it
// runs once, over data nobody will re-read, and anything wrong about it becomes
// permanent. Two things matter more than the parsing.
//
// FIRST, a historical bet has NO SNAPSHOT and must not be given one. The line
// on the board at 19:04 last April was never recorded and cannot be
// reconstructed. Attaching the nearest snapshot we happen to have would produce
// a CLV number that looks real and is comparing a bet to a different day. A
// visible null is worth more than a plausible fiction.
//
// SECOND, re-running must be safe. An import that dies halfway is finished by
// running it again, so a duplicate has to be progress rather than a failure.

import { loadFn } from '../helpers/fn.mjs';
import { reset, read, keys } from '../helpers/blobs.mjs';

const CSV = `slip_id,placed_at,slip_type,stake,leg1_player,leg1_market,leg1_line,leg1_side,leg1_tier,leg2_player,leg2_market,leg2_line,leg2_side
sheet-1,2026-04-02T18:30:00Z,power,25,Elly De La Cruz,Hits,0.5,over,goblin,"Carroll, Corbin",Total Bases,1.5,under
sheet-2,2026-04-03T19:00:00Z,flex,10,Aaron Judge,Home Runs,0.5,over,demon,,,,
`;

export default async function ({ t }) {
  const S = await import('../../scripts/seed-bets.mjs');

  // ---- the CSV reader -----------------------------------------------------
  const rows = S.parseCsv(CSV);
  t.eq('two data rows, header excluded', rows.length, 2);
  t.eq('headers are normalised to snake_case keys', Object.keys(rows[0])[0], 'slip_id');
  t.eq('a quoted field containing a comma survives intact', rows[0].leg2_player, 'Carroll, Corbin');
  t.eq('a trailing newline does not become a blank row', S.parseCsv('a,b\n1,2\n').length, 1);
  t.eq('an all-empty line is dropped rather than imported as a bet',
    S.parseCsv('a,b\n1,2\n,\n').length, 1);

  // ---- row -> bet ---------------------------------------------------------
  const bet = S.rowToBet(rows[0], 0);
  t.eq('both legs are read', bet.legs.length, 2);
  t.eq('...with their sides', bet.legs.map((l) => l.side), ['over', 'under']);
  t.eq('leg ids are derived from the slip, not invented', bet.legs[0].leg_id, 'sheet-1#L0');
  t.eq('a slip with one filled leg does not manufacture five empty ones',
    S.rowToBet(rows[1], 1).legs.length, 1);
  // The load-bearing one.
  t.eq('a historical leg carries NO snapshot rather than a guessed one',
    bet.legs.map((l) => l.snapshot_id), [null, null]);
  t.eq('...and records where it came from, so an import can be traced',
    bet.source.import, 'spreadsheet');
  t.eq('...naming the sheet row, counting the header', bet.source.row, 2);

  // A side the sheet spells oddly must not silently become an over.
  t.eq('an explicit under is preserved', S.rowToBet({ leg1_player: 'X', leg1_side: 'UNDER', leg1_line: '1' }, 0).legs[0].side, 'under');

  // ---- saved slips --------------------------------------------------------
  // The app's own saved slips are the other real source of history here. They
  // are NOT the same thing as a placed bet — a saved slip may never have been
  // staked — so the import labels them rather than pretending otherwise.
  const asBet = S.slipToBet({
    id: 'slip-x', createdAt: '2026-05-01T20:00:00Z', entry: 'flex', stake: 15, name: 'Tuesday',
    legs: [{ player: 'P', stat: 'Hits', line: 0.5, pick: 'under', oddsType: 'goblin', team: 'CIN' }],
  });
  t.eq('a saved slip maps onto the ledger shape', asBet.slip_id, 'slip-x');
  t.eq('...translating pick -> side', asBet.legs[0].side, 'under');
  t.eq('...and stat -> market', asBet.legs[0].market, 'Hits');
  t.ok('...labelled as a saved slip, not as a confirmed wager',
    asBet.source.import === 'saved-slips', JSON.stringify(asBet.source));
  t.eq('...with no snapshot, same as any pre-archive row', asBet.legs[0].snapshot_id, null);

  // ---- appending, and re-appending ---------------------------------------
  reset();
  const L = await loadFn('ledger-store.js');
  await L.appendBet(bet);
  t.eq('the seeded slip is in the ledger', keys('bets'), ['sheet-1']);
  t.eq('...and its legs survived', read('bets', 'sheet-1').legs.length, 2);

  let again = null;
  try { await L.appendBet(bet); } catch (e) { again = e; }
  t.eq('re-running the import hits the append-only guard rather than duplicating',
    again?.name, 'AppendOnlyViolation');
  t.eq('...leaving exactly one row', keys('bets').length, 1);

  // A seeded bet must be readable by the CLV view without blowing up, and must
  // report itself as unpriced rather than quietly scoring 0.
  const C = await loadFn('clv.js');
  const view = await C.buildClv({});
  t.eq('the view includes the seeded legs', view.legs.length, 2);
  t.eq('...priced: none of them', view.summary.priced, 0);
  t.ok('...each saying why', view.legs.every((l) => !!l.unpriced_reason),
    JSON.stringify(view.legs.map((l) => l.unpriced_reason)));
  t.eq('...and the mean CLV is null rather than 0 over an empty set',
    view.summary.mean_prob_delta, null);
}

// The line-snapshot archive: what a captured row holds, and what a closing
// capture is for.
//
// The archive exists to answer one question later: what was on the board when I
// bet, and where did it end up? That only works if a row is a complete record
// of an instant — so the failures worth guarding are the ones that make a row
// look complete while missing the part that matters.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, keys } from '../helpers/blobs.mjs';

const bookmakers = [
  { key: 'draftkings',
    markets: [{ key: 'batter_hits', last_update: '2026-09-09T14:00:00Z',
      outcomes: [
        { name: 'Over', description: 'Elly De La Cruz', point: 0.5, price: -160 },
        { name: 'Under', description: 'Elly De La Cruz', point: 0.5, price: 130 },
      ] }] },
  { key: 'fanduel',
    markets: [{ key: 'batter_hits', last_update: '2026-09-09T14:01:00Z',
      outcomes: [
        { name: 'Over', description: 'Elly De La Cruz', point: 0.5, price: -155 },
        { name: 'Under', description: 'Elly De La Cruz', point: 0.5, price: 125 },
      ] }] },
];

export default async function ({ t }) {
  const S = await loadFn('snapshot-background.js');

  // ---- what a row records -------------------------------------------------
  const row = S.toSnapshotRow({
    player: 'Elly De La Cruz', team: 'CIN', opp: 'PIT', stat: 'Hits', line: 0.5,
    oddsType: 'goblin', position: 'IF', id: 'pp-1', start: '2026-09-09T23:10:00Z',
  }, 'mlb');

  t.eq('every field the brief named is on the row',
    ['player', 'team', 'opponent', 'market', 'pp_line', 'pp_tier', 'is_goblin', 'is_demon', 'pp_multiplier']
      .filter((k) => !(k in row)), []);
  t.eq('the tier flag and its payout travel together — a tier alone prices nothing',
    [row.is_goblin, row.pp_multiplier], [true, 2.0]);
  t.eq('a demon carries its own multiplier',
    S.toSnapshotRow({ player: 'X', stat: 'Hits', line: 2.5, oddsType: 'demon' }, 'mlb').pp_multiplier, 12.0);
  t.eq('a standard is neither goblin nor demon, and says so explicitly',
    (({ is_goblin, is_demon }) => [is_goblin, is_demon])(
      S.toSnapshotRow({ player: 'X', stat: 'Hits', line: 1.5, oddsType: 'standard' }, 'mlb')), [false, false]);

  // The row records WHICH book market it will be compared against, not merely
  // that a comparison happened. Without it, a null book line is ambiguous
  // between "no book posts this prop" and "the lookup failed".
  t.eq('the book market it maps to is recorded on the row', row.book_market, 'batter_hits');
  t.eq('a stat no book posts records a null market rather than a guess',
    S.toSnapshotRow({ player: 'X', stat: 'Pitches Thrown', line: 88.5, oddsType: 'standard', position: 'P' }, 'mlb')
      .book_market, null);

  // ---- reading two books --------------------------------------------------
  const books = S.readBooks(bookmakers, 'batter_hits', 'Elly De La Cruz');
  t.eq('both books are read', books.map((b) => b.book), ['draftkings', 'fanduel']);
  t.eq('...with line AND both prices, since one side alone cannot be de-vigged',
    [books[0].line, books[0].over_price, books[0].under_price], [0.5, -160, 130]);
  t.eq('a player the book does not post is absent, not zero',
    S.readBooks(bookmakers, 'batter_hits', 'Nobody At All'), []);
  t.eq('a market the book does not post is absent too',
    S.readBooks(bookmakers, 'batter_home_runs', 'Elly De La Cruz'), []);

  // ---- a capture, end to end ---------------------------------------------
  reset();
  const props = {
    data: [{
      id: 'pp-1', type: 'projection',
      attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: 0.5,
        odds_type: 'goblin', description: 'PIT', allowed_wager_types: 'over',
        start_time: '2026-09-09T23:10:00.000-04:00', today: true },
      relationships: { new_player: { data: { id: 'n0' } } },
    }],
    included: [{ id: 'n0', type: 'new_player',
      attributes: { display_name: 'Elly De La Cruz', team: 'CIN', position: 'IF', market: 'CIN' } }],
    meta: { total_pages: 1 },
  };

  // The ESPN standings feed, in the shape collectTeamNames walks: PrizePicks
  // says "CIN", The Odds API says "Cincinnati Reds", and this is the only thing
  // that joins them. Stub it wrong and every book lookup silently misses.
  const standings = { children: [{ standings: { entries: [
    { team: { abbreviation: 'CIN', displayName: 'Cincinnati Reds' }, stats: [] },
    { team: { abbreviation: 'PIT', displayName: 'Pittsburgh Pirates' }, stats: [] },
  ] } }] };

  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props],
    [/site\.api\.espn\.com.*standings/, async () => standings],
    [/the-odds-api.*\/events\/ev1\/odds/, async () => ({ bookmakers })],
    [/the-odds-api.*\/events/, async () => ([{ id: 'ev1', home_team: 'Cincinnati Reds', away_team: 'Pittsburgh Pirates' }])],
    [/statsapi|espn|the-odds-api/, async () => ({})],
  ]);
  process.env.ODDS_API_KEY = 'test-key';
  let out;
  try { out = await S.capture({ league: 'mlb' }); } finally { mock.restore(); }

  t.eq('the capture is archived under its instant', keys('line-snapshots'), [`capture/${out.captured_at}`]);
  t.eq('...holding one row per prop', out.count, 1);
  t.eq('...with both books attached', out.rows[0].books.map((b) => b.book), ['draftkings', 'fanduel']);
  t.eq('...and a status saying it worked', out.rows[0].book_status, 'ok');
  t.eq('the row carries the capture time it belongs to', out.rows[0].captured_at, out.captured_at);
  t.eq('a routine capture is not a closing one', out.is_closing, false);

  // ---- fair probability, embedded at capture time -------------------------
  // It has to be IN the row: the archive is append-only, so a capture written
  // now can never be amended, and anything belonging to this instant must be
  // present when it is written.
  //
  // -160/+130 and -155/+125, de-vigged and weighted, lands a little over 58%.
  t.ok('the archived row carries a fair probability',
    out.rows[0].fair.prob > 0.55 && out.rows[0].fair.prob < 0.62, String(out.rows[0].fair.prob));
  t.eq('...at the line the books were on', out.rows[0].fair.line, 0.5);
  t.eq('...counting both books', out.rows[0].fair.book_count, 2);
  t.ok('...with the raw hold recorded before removal', out.rows[0].fair.hold > 0, String(out.rows[0].fair.hold));
  t.eq('...and the method and weight table that produced it',
    [out.rows[0].fair.method, out.rows[0].fair.config_id], ['shin', 'default-sharpness-2026-09']);
  t.eq('the capture summarises how much of it got priced', out.meta.fair_priced, 1);

  // The stored number is a CACHE of a pure function. What makes the
  // computation reconstructible is that the raw prices are archived beside it,
  // so a different method — or a corrected weight table — can be re-run against
  // this exact instant afterwards.
  const F = await loadFn('fair-odds.js');
  const archived = read('line-snapshots', `capture/${out.captured_at}`).rows[0];
  t.eq('the raw book prices survive in the archive', archived.books.length, 2);
  const weights = JSON.parse(
    (await import('node:fs')).readFileSync('netlify/functions/book-weights.json', 'utf8'),
  );
  t.ok('...so recomputing from the archive reproduces the stored number',
    Math.abs(F.fairFromBooks(archived.books, { config: weights }).fairProb - archived.fair.prob) < 1e-12, '');
  t.ok('...and another method against the same instant is a real, different answer',
    Math.abs(F.fairFromBooks(archived.books, { config: weights, method: 'multiplicative' }).fairProb
      - archived.fair.prob) > 1e-6, '');

  // ---- the budget, which is what keeps this affordable --------------------
  // The PrizePicks half is free; the book half is metered per market per event.
  // At 144 captures a day the uncapped bill is ~390k credits a month, so the
  // capture spends to a ceiling and then STOPS ASKING — while still archiving
  // every PrizePicks row, because a row with a line and no book price is a true
  // record and a missing row is not.
  reset();
  const mock2 = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props],
    [/the-odds-api/, async () => { throw new Error('the budget should have stopped this call'); }],
    [/statsapi|espn/, async () => ({})],
  ]);
  let broke;
  try { broke = await S.capture({ league: 'mlb', budget: 0 }); } finally { mock2.restore(); }
  t.eq('with no budget, every PrizePicks row is still archived', broke.count, 1);
  t.eq('...carrying its line', broke.rows[0].pp_line, 0.5);
  t.eq('...with no book data and a reason', [broke.rows[0].books.length, broke.rows[0].book_status],
    [0, 'odds budget is 0']);
  t.eq('...and a null fair probability rather than a fabricated one',
    [broke.rows[0].fair.prob, broke.rows[0].fair.unpriced], [null, 'no book posted a two-way price']);
  t.eq('...and the capture reports what it spent', broke.meta.odds_credits_spent, 0);

  // ---- closing captures ---------------------------------------------------
  // Keyed by EVENT, not by time, so "already closed?" is a property of the
  // store rather than a check someone has to remember to write.
  reset();
  const L = await loadFn('ledger-store.js');
  const EV = 'mlb:CIN vs PIT:2026-09-09T23:10';
  await L.appendCapture({
    capturedAt: '2026-09-09T23:10:00.000Z', isClosing: true, eventId: EV,
    rows: [{ league: 'mlb', player: 'Elly De La Cruz', market: 'Hits', line: 0.5, pp_line: 0.5, books: [] }],
  });
  t.eq('a close is stored under its event', keys('line-snapshots'), [`closing/${EV}`]);
  t.eq('...and is findable by event id', await L.hasClosing(EV), true);
  t.eq('an event with no close reports so', await L.hasClosing('mlb:NOPE'), false);

  let second = null;
  try {
    await L.appendCapture({
      capturedAt: '2026-09-09T23:40:00.000Z', isClosing: true, eventId: EV,
      rows: [{ league: 'mlb', player: 'Elly De La Cruz', market: 'Hits', line: 9.5, pp_line: 9.5, books: [] }],
    });
  } catch (e) { second = e; }
  t.eq('a second close for the same event is refused', second?.name, 'AppendOnlyViolation');
  t.eq('...so the line taken AT kickoff is the one that survives',
    read('line-snapshots', `closing/${EV}`).rows[0].pp_line, 0.5);

  // A close with no event cannot be resolved by anything later, so it is
  // refused rather than written as an orphan.
  let orphan = null;
  try {
    await L.appendCapture({ capturedAt: '2026-09-09T23:50:00.000Z', isClosing: true, rows: [] });
  } catch (e) { orphan = e; }
  t.ok('a closing capture with no event id is refused',
    /must name the event/.test(orphan?.message || ''), orphan?.message);
}

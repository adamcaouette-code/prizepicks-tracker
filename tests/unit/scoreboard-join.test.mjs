// The join behind the scoreboard: pick log + results + book archive.
//
// Three things here are worth more than the rest of the suite put together,
// because each one produces a REPORT THAT LOOKS FINE while being wrong:
//
//   1. The book price must be taken CONTEMPORANEOUSLY. Pricing a morning
//      forecast against the closing line scores it against information it never
//      had, and makes the book unbeatable by construction.
//   2. A refusal must come back as null WITH a reason, never as a number. A
//      silently guessed book probability is a baseline that looks like a
//      measurement.
//   3. The ledger's `won` is the outcome of the LEG AS BET. On an under, `won`
//      means the over did NOT hit. Comparing the two records without flipping
//      that would report a disagreement on every under in the book.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

// A capture's worth of rows, in the shape snapshot-background writes.
const snapRow = (over) => ({
  league: 'mlb',
  player: 'Nick Martinez',
  market: 'Pitcher Strikeouts',
  book_market: 'pitcher_strikeouts',
  pp_line: 3.5,
  pp_tier: 'standard',
  books: [{ book: 'draftkings', line: 3.5, over_price: over, under_price: -110 }],
  book_status: 'ok',
});

const capture = (key, at, rows, extra = {}) => ({
  key, captured_at: at, is_closing: false, event_id: null, count: rows.length, rows, ...extra,
});

export default async function ({ t }) {
  reset();
  const J = await loadFn('scoreboard-join.js');

  // =========================================================================
  // 1. THE LEDGER'S OUTCOME IS THE LEG'S, NOT THE OVER'S
  //
  // `won` on an under leg means the over did NOT hit. Every comparison against
  // the pick log — whose `hit` is always "did the over hit" — has to flip that
  // back first, or every under in the ledger reads as a contradiction.
  // =========================================================================
  t.eq('a won OVER means the over hit', J.ledgerOverHit({ side: 'over' }, { outcome: 'won' }), true);
  t.eq('a lost OVER means it did not', J.ledgerOverHit({ side: 'over' }, { outcome: 'lost' }), false);
  t.eq('a WON UNDER means the over did NOT hit', J.ledgerOverHit({ side: 'under' }, { outcome: 'won' }), false);
  t.eq('...and a lost under means it DID', J.ledgerOverHit({ side: 'under' }, { outcome: 'lost' }), true);
  t.eq('a push carries no binary outcome and is excluded',
    J.ledgerOverHit({ side: 'over' }, { outcome: 'push' }), null);
  t.eq('...and so is a void', J.ledgerOverHit({ side: 'over' }, { outcome: 'void' }), null);
  t.eq('an unsettled leg is not an outcome either', J.ledgerOverHit({ side: 'over' }, null), null);

  // =========================================================================
  // 2. The book price: de-vig, then translate onto the PrizePicks line
  //
  //   DK 3.5, Over -116 / Under -110
  //     implied over  = 116/216 = 0.5370370
  //     implied under = 110/210 = 0.5238095
  //     sum           = 1.0608466
  //     additive (== Shin on a two-way market) de-vig:
  //       0.5370370 - 0.0608466/2 = 0.5066137
  // =========================================================================
  const models = JSON.parse(await (await import('node:fs/promises')).readFile('netlify/functions/market-models.json', 'utf8'));
  const weights = JSON.parse(await (await import('node:fs/promises')).readFile('netlify/functions/book-weights.json', 'utf8'));

  const same = J.bookProbFor(snapRow(-116), 3.5, { weights, models });
  t.ok('at the same line the de-vigged price comes straight through',
    Math.abs(same.prob - 0.5066137) < 1e-6, String(same.prob));
  t.ok('...with no translation involved', same.translated === false, '');
  t.ok('...and no refusal reason', same.reason === null, String(same.reason));

  //   A one-step move to 2.5 must go UP: P(over 2.5) > P(over 3.5), always.
  const stepped = J.bookProbFor(snapRow(-116), 2.5, { weights, models });
  t.ok('translating down a line raises the over probability', stepped.prob > same.prob,
    `${same.prob.toFixed(4)} at 3.5 -> ${stepped.prob.toFixed(4)} at 2.5`);
  t.ok('...and records that it was translated, not observed', stepped.translated === true, '');

  //   Far enough away and the answer would be the assumed shape rather than the
  //   market, so it refuses. A silently wrong baseline is worse than none.
  const tooFar = J.bookProbFor(snapRow(-116), 12.5, { weights, models });
  t.ok('a line far from the book refuses rather than guessing', tooFar.prob === null, String(tooFar.prob));
  t.ok('...and names the distance in its reason', /sd from the book line/.test(tooFar.reason), tooFar.reason);

  const oneSided = J.bookProbFor(
    { ...snapRow(-116), books: [{ book: 'draftkings', line: 3.5, over_price: -116, under_price: null }] },
    3.5, { weights, models },
  );
  t.ok('a one-sided quote has no vig to remove and so has no fair probability',
    oneSided.prob === null, '');
  t.ok('...which is reported, not silently dropped', !!oneSided.reason, oneSided.reason);

  const noSnap = J.bookProbFor(null, 3.5, { weights, models });
  t.ok('a prop with no archived capture says exactly that',
    noSnap.prob === null && /no archived capture/.test(noSnap.reason), noSnap.reason);

  // =========================================================================
  // 3. THE JOIN — and the contemporaneous rule
  //
  // Two captures on the same prop: an early one where DK had it at -116, and a
  // late one where the price has moved hard to -260. The forecast was logged at
  // 14:05, so it must be priced against the 14:00 board — the one that was on
  // screen — and never against the 23:00 one, which contains information the
  // model did not have.
  // =========================================================================
  reset();
  seed('line-snapshots', 'capture/2026-09-10T14:00:00.000Z',
    capture('capture/2026-09-10T14:00:00.000Z', '2026-09-10T14:00:00.000Z', [{ ...snapRow(-116), id: 'a' }]));
  seed('line-snapshots', 'capture/2026-09-10T23:00:00.000Z',
    capture('capture/2026-09-10T23:00:00.000Z', '2026-09-10T23:00:00.000Z', [{ ...snapRow(-260), id: 'b' }]));
  seed('line-snapshots', 'closing/EV1',
    capture('closing/EV1', '2026-09-10T23:05:00.000Z', [{ ...snapRow(-260), id: 'c', is_closing: true }],
      { is_closing: true, event_id: 'EV1' }));

  const logRow = (over) => ({
    date: '2026-09-10',
    loggedAt: '2026-09-10T14:05:00.000Z',
    league: 'mlb',
    projectionId: 'P1',
    player: 'Nick Martinez',
    stat: 'Pitcher Strikeouts',
    line: 3.5,
    prob: 0.62,
    oddsType: 'standard',
    side: 'over',
    verdict: 'play',
    source: 'board',
    promptVersion: 'v1',
    judgeModel: 'm',
    hit: over,
    result: over ? 5 : 2,
  });

  seed('pick-log', '2026-09-10', [logRow(true)]);

  const contemporaneous = await J.joinRows({ weights, models });
  t.eq('one graded prop joins', contemporaneous.rows.length, 1);
  const r = contemporaneous.rows[0];
  t.ok('the probability scored is P(over) from the log', r.p === 0.62, String(r.p));
  t.eq('...and the outcome is 1 for an over that hit', r.y, 1);
  t.ok('THE BOOK PRICE IS THE 14:00 BOARD, not the 23:00 one',
    Math.abs(r.bookP - 0.5066137) < 1e-6, String(r.bookP));
  t.eq('...and the mode is on the record', contemporaneous.meta.mode, 'contemporaneous');

  const closing = await J.joinRows({ mode: 'closing', weights, models });
  //   -260 / -110: implied 0.7222222 and 0.5238095, sum 1.2460317,
  //   additive de-vig: 0.7222222 - 0.2460317/2 = 0.5992064
  t.ok('asking for the CLOSING line gives a materially different number',
    Math.abs(closing.rows[0].bookP - 0.5992064) < 1e-6, String(closing.rows[0].bookP));
  t.ok('...which is why the default is contemporaneous — the close knows things the forecast did not',
    closing.rows[0].bookP > contemporaneous.rows[0].bookP + 0.08,
    `${contemporaneous.rows[0].bookP.toFixed(4)} vs ${closing.rows[0].bookP.toFixed(4)}`);

  // =========================================================================
  // 4. Ungraded rows, and what counts as graded
  // =========================================================================
  reset();
  seed('pick-log', '2026-09-10', [
    logRow(true),
    { ...logRow(false), projectionId: 'P2', player: 'Other Guy' },
    { ...logRow(null), projectionId: 'P3', player: 'Pending Guy', hit: null, result: null },
  ]);
  const graded = await J.joinRows({ skipBook: true });
  t.eq('only graded props are joined by default', graded.rows.length, 2);
  t.eq('...and both outcomes come through', graded.rows.map((x) => x.y).sort(), [0, 1]);
  const all = await J.joinRows({ skipBook: true, includeUngraded: true });
  t.eq('the pending one can be included when asked for', all.rows.length, 3);
  t.ok('...carrying a null outcome rather than a fabricated one',
    all.rows.find((x) => x.player === 'Pending Guy').y === null, '');
  t.ok('--no-book skips the archive entirely rather than reporting zero coverage',
    graded.meta.captureCount === 0 && graded.rows.every((x) => x.bookP === null), '');

  // =========================================================================
  // 5. THE LEDGER CROSS-CHECK
  //
  // The pick log is the spine because it is the only source that covers props
  // that were never bet. The ledger is an INDEPENDENT record of the same
  // outcome where it overlaps, and a disagreement between them means one of the
  // two is wrong — which matters more than any calibration number on the page,
  // because the report is scored on one of them.
  // =========================================================================
  reset();
  seed('pick-log', '2026-09-10', [logRow(true), { ...logRow(false), projectionId: 'P2', player: 'Under Guy', side: 'under' }]);
  seed('bets', 'S1', {
    slip_id: 'S1', placed_at: '2026-09-10T14:10:00.000Z', slip_type: 'power', stake: 10,
    legs: [
      { leg_id: 'S1#L0', player: 'Nick Martinez', market: 'Pitcher Strikeouts', line: 3.5, side: 'over', league: 'mlb' },
      // A WON UNDER. The over did not hit — which is exactly what the pick log
      // says for this row, so the two agree.
      { leg_id: 'S1#L1', player: 'Under Guy', market: 'Pitcher Strikeouts', line: 3.5, side: 'under', league: 'mlb' },
    ],
  });
  seed('bet-results', 'S1#L0', { leg_id: 'S1#L0', slip_id: 'S1', outcome: 'won' });
  seed('bet-results', 'S1#L1', { leg_id: 'S1#L1', slip_id: 'S1', outcome: 'won' });

  const checked = await J.joinRows({ skipBook: true });
  t.eq('both props are cross-checked against the ledger', checked.meta.ledger.checked, 2);
  t.eq('...and both agree, INCLUDING the won under', checked.meta.ledger.agreed, 2);
  t.eq('...so nothing is flagged', checked.meta.ledger.disagreed, 0);
  t.ok('the rows record that they are also ledger legs', checked.rows.every((x) => x.inLedger), '');

  // Now break one and prove it is caught rather than averaged away.
  reset();
  seed('pick-log', '2026-09-10', [logRow(true)]);
  seed('bets', 'S1', {
    slip_id: 'S1', placed_at: '2026-09-10T14:10:00.000Z', slip_type: 'power', stake: 10,
    legs: [{ leg_id: 'S1#L0', player: 'Nick Martinez', market: 'Pitcher Strikeouts', line: 3.5, side: 'over', league: 'mlb' }],
  });
  seed('bet-results', 'S1#L0', { leg_id: 'S1#L0', slip_id: 'S1', outcome: 'lost' });
  const conflict = await J.joinRows({ skipBook: true });
  t.eq('a contradiction between the two records is counted', conflict.meta.ledger.disagreed, 1);
  t.ok('...and named, with the leg id, so it can actually be chased',
    conflict.meta.ledger.disagreements[0].leg_id === 'S1#L0'
    && conflict.meta.ledger.disagreements[0].pick_log_over_hit === true
    && conflict.meta.ledger.disagreements[0].ledger_over_hit === false,
    JSON.stringify(conflict.meta.ledger.disagreements[0]));

  // =========================================================================
  // 6. Refusal reasons are ITEMISED
  //
  // "The archive is empty" and "the lines are two steps apart" are different
  // problems with different fixes, and one coverage percentage cannot tell them
  // apart. The report has to say which.
  // =========================================================================
  reset();
  seed('line-snapshots', 'capture/2026-09-10T14:00:00.000Z',
    capture('capture/2026-09-10T14:00:00.000Z', '2026-09-10T14:00:00.000Z', [{ ...snapRow(-116), id: 'a' }]));
  seed('pick-log', '2026-09-10', [
    { ...logRow(true), line: 12.5 },                                     // too far to translate
    { ...logRow(false), projectionId: 'P2', player: 'Nobody', line: 3.5 }, // not in the capture at all
  ]);
  const reasons = await J.joinRows({ weights, models });
  const keys = Object.keys(reasons.meta.bookReasons);
  t.eq('two different refusals produce two different reasons', keys.length, 2);
  t.ok('...one of them naming the missing capture',
    keys.some((k) => /no archived capture/.test(k)), keys.join(' | '));
  t.ok('...and one naming the translation distance',
    keys.some((k) => /sd from the book line/.test(k)), keys.join(' | '));
  t.eq('nothing was priced', reasons.meta.bookPriced, 0);
  t.ok('and no row got a fabricated number', reasons.rows.every((x) => x.bookP === null), '');

  // =========================================================================
  // 6b. THE LADDER — the archive is indexed WITHOUT the line
  //
  // PrizePicks posts Martinez's strikeouts at 1.5 through 6.5 and archives each
  // rung as its own row; DraftKings posts ONE line. Keying the lookup on the
  // exact line would return "no archived capture" for a pick at 4.5 while the
  // prices that cover it sit in the very same capture under 3.5 — and would
  // make the translation layer, whose entire job is moving between rungs,
  // unreachable.
  // =========================================================================
  reset();
  seed('line-snapshots', 'capture/2026-09-10T14:00:00.000Z',
    capture('capture/2026-09-10T14:00:00.000Z', '2026-09-10T14:00:00.000Z', [
      // The rung the book quoted, and a neighbouring rung with no quote at all.
      { ...snapRow(-116), id: 'a' },
      { ...snapRow(-116), id: 'b', pp_line: 4.5, books: [], book_status: 'no-quote-for-this-player' },
    ]));
  seed('pick-log', '2026-09-10', [{ ...logRow(true), line: 4.5 }]);
  const ladder = await J.joinRows({ weights, models });
  t.ok('a pick at a rung the book never quoted is still priced, by translation',
    ladder.rows[0].bookP != null, ladder.rows[0].bookReason || '');
  t.eq('...from the book line that DOES exist in the same capture', ladder.rows[0].bookLine, 3.5);
  t.ok('...and it is lower than at 3.5, because clearing 4.5 is harder',
    ladder.rows[0].bookP < 0.5066137, String(ladder.rows[0].bookP));
  t.ok('...flagged as translated rather than observed', ladder.rows[0].bookTranslated === true, '');
  t.eq('so the prop counts as book-priced', ladder.meta.bookPriced, 1);

  // =========================================================================
  // 7. Deduplication is the SHARED one, not a second copy
  //
  // A re-run of a day re-logs the same props. calibration.js already decided
  // what makes two log rows the same forecast — source, judge version, model,
  // projection — and a second implementation here would drift from it.
  // =========================================================================
  reset();
  const base = logRow(true);
  seed('pick-log', '2026-09-10', [
    base,
    { ...base },                                        // an identical re-log
    { ...base, promptVersion: 'v2', prob: 0.55 },       // a DIFFERENT forecaster
  ]);
  const deduped = await J.joinRows({ skipBook: true });
  t.eq('a duplicate re-log is collapsed', deduped.meta.afterDedupe, 2);
  t.ok('...but two judge versions on the same prop are two forecasts, both scored',
    deduped.rows.map((x) => x.promptVersion).sort().join(',') === 'v1,v2', '');
  t.eq('the raw count is kept beside it, so the collapse is visible', deduped.meta.pickLogRows, 3);

  // No network anywhere in this module.
  const m = mockFetch([]);
  try {
    reset();
    seed('pick-log', '2026-09-10', [logRow(true)]);
    await J.joinRows({ skipBook: true });
    t.eq('the join makes no network calls at all', m.calls.length, 0);
  } finally { m.restore(); }
}

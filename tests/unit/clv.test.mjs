// Closing line value.
//
// CLV is the one metric that says whether a bet was good independent of whether
// it won, so it is worth more than the win rate on a sample this size — and it
// is also the easiest to compute subtly, invisibly wrong. Three ways, all
// guarded here:
//
//   1. NOT DE-VIGGING. A book's two prices sum to more than 100%; the excess is
//      its margin, not information. Comparing raw implied probabilities scores
//      the book's cut as line movement.
//   2. THE SIDE FLIP. On an over, the line moving UP is good. On an under it is
//      the reverse. A raw delta scores half the ledger backwards, and the error
//      hides because both signs occur either way.
//   3. AVERAGING THE WRONG THINGS. A point of total bases and a point of
//      passing yards are not the same quantity, and a mean over the legs that
//      happened to be priceable is not the ledger's CLV.

import { loadFn } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export default async function ({ t }) {
  const C = await loadFn('clv.js');

  // ---- american odds ------------------------------------------------------
  t.ok('-110 is 52.38%', near(C.americanToProb(-110), 110 / 210), String(C.americanToProb(-110)));
  t.ok('+100 is exactly half', near(C.americanToProb(100), 0.5), String(C.americanToProb(100)));
  t.ok('+150 is 40%', near(C.americanToProb(150), 0.4), String(C.americanToProb(150)));
  t.eq('a missing price is null, never 0 — "no quote" is not "impossible"', C.americanToProb(null), null);

  // ---- de-vigging ---------------------------------------------------------
  // -115 / -115 is 52.33% each, summing to 104.65%. The 4.65% is the book's,
  // not the game's. A fair coin priced this way must come back 50/50.
  const even = C.noVig(-115, -115);
  t.ok('a symmetric market de-vigs to 50/50', near(even.over, 0.5) && near(even.under, 0.5),
    JSON.stringify(even));
  t.ok('...and the margin is reported, not silently discarded',
    near(even.vig, 2 * (115 / 215) - 1), String(even.vig));

  const skewed = C.noVig(-200, +170);
  t.ok('an asymmetric market still sums to exactly 1',
    near(skewed.over + skewed.under, 1), String(skewed.over + skewed.under));
  t.ok('...with the favourite above half', skewed.over > 0.5 && skewed.over < 0.667, String(skewed.over));
  // The number that matters: raw implied would have said 66.7%, which is the
  // book's price INCLUDING its cut. De-vigged it is meaningfully lower, and the
  // gap is exactly what makes an un-de-vigged CLV read as free money.
  t.ok('...and materially below the raw implied 66.7%',
    C.americanToProb(-200) - skewed.over > 0.02, `${C.americanToProb(-200)} vs ${skewed.over}`);

  t.eq('a one-sided market cannot be de-vigged and says so', C.noVig(-110, null), null);

  // ---- consensus ----------------------------------------------------------
  const books = [
    { book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 },
    { book: 'fanduel', line: 1.5, over_price: -125, under_price: 105 },
  ];
  const cons = C.closingConsensus(books, 'over');
  t.eq('the consensus line is the median across books', cons.line, 1.5);
  t.eq('...counting how many books priced it', cons.pricedBooks, 2);
  // -125 is the SHORTER price, so FanDuel's de-vigged number is the HIGHER one
  // — the bounds go dk .. fd, not the other way round.
  const lo = Math.min(C.noVig(-120, 100).over, C.noVig(-125, 105).over);
  const hi = Math.max(C.noVig(-120, 100).over, C.noVig(-125, 105).over);
  t.ok('the consensus probability sits between the two de-vigged books',
    cons.prob > lo - 1e-9 && cons.prob < hi + 1e-9, `${lo} < ${cons.prob} < ${hi}`);

  // De-vig FIRST, then average. Averaging raw prices and de-vigging the mean
  // folds two different margins into one number belonging to neither book.
  const perBook = (C.noVig(-120, 100).over + C.noVig(-125, 105).over) / 2;
  t.ok('...because each book is de-vigged before averaging', near(cons.prob, perBook), `${cons.prob} vs ${perBook}`);

  // A book quoting one side only has no margin to remove, so its number is not
  // comparable — it is skipped for probability but its LINE still counts.
  const half = C.closingConsensus([...books, { book: 'x', line: 2.5, over_price: -110, under_price: null }], 'over');
  t.eq('a one-sided book still contributes its line', half.books, 3);
  t.eq('...but not a probability', half.pricedBooks, 2);

  // ---- the side flip ------------------------------------------------------
  t.eq('an over that closed higher than I took is value', C.lineEdge(1.5, 2.5, 'over'), 1);
  t.eq('...and the same move on an under is against me', C.lineEdge(1.5, 2.5, 'under'), -1);
  t.eq('an under that closed lower than I took is value', C.lineEdge(2.5, 1.5, 'under'), 1);
  t.eq('no closing line means no verdict, not zero', C.lineEdge(1.5, null, 'over'), null);

  // ---- one leg, end to end ------------------------------------------------
  const myRow = { captured_at: '2026-09-09T14:00:00.000Z', books: [{ book: 'dk', line: 1.5, over_price: 100, under_price: -120 }] };
  const closeRow = { captured_at: '2026-09-09T22:55:00.000Z', books: [{ book: 'dk', line: 2.5, over_price: -140, under_price: 120 }] };
  const leg = { leg_id: 'L0', player: 'P', market: 'Total Bases', line: 1.5, side: 'over' };
  const out = C.clvForLeg({ leg, myRow, closing: { row: closeRow, kind: 'closing', captured_at: closeRow.captured_at } });
  t.eq('the line moved a full point my way', out.line_delta, 1);
  t.ok('...and the probability delta agrees in sign', out.prob_delta > 0, String(out.prob_delta));
  t.eq('the source of the closing line is labelled', out.closing_kind, 'closing');
  t.eq('a fully priced leg has no unpriced reason', out.unpriced_reason, null);

  // A leg that cannot be priced is REPORTED, never dropped. A CLV table that
  // silently omits what it could not understand reports the average of the
  // legs it happened to understand.
  const noClose = C.clvForLeg({ leg, myRow, closing: null });
  t.eq('a leg with no closing snapshot still appears', noClose.leg_id, 'L0');
  t.eq('...with its numbers null rather than zero', noClose.prob_delta, null);
  t.ok('...and a reason', /no closing snapshot/.test(noClose.unpriced_reason), noClose.unpriced_reason);

  const noBooks = C.clvForLeg({
    leg, myRow: { captured_at: 'x', books: [] },
    closing: { row: closeRow, kind: 'closing', captured_at: 'y' },
  });
  t.ok('a leg with no book price when I bet says THAT, specifically',
    /no two-way book price in the snapshot current at placed_at/.test(noBooks.unpriced_reason),
    String(noBooks.unpriced_reason));
  t.eq('...and its probability delta is null, not silently zero', noBooks.prob_delta, null);
  t.eq('...but its line movement is still computable and reported', noBooks.line_delta, 1);

  // ---- the view over the real stores -------------------------------------
  reset();
  const L = await loadFn('ledger-store.js');
  const AT = '2026-09-09T14:00:00.000Z';
  await L.appendCapture({
    capturedAt: AT,
    rows: [{
      league: 'mlb', player: 'P', market: 'Total Bases', line: 1.5, pp_line: 1.5,
      pp_tier: 'standard', books: myRow.books,
    }],
  });
  const snapId = read('line-snapshots', `capture/${AT}`).rows[0].id;
  await L.appendCapture({
    capturedAt: '2026-09-09T22:55:00.000Z', isClosing: true, eventId: 'mlb:CIN vs PIT:2026-09-09T23:00',
    rows: [{
      league: 'mlb', player: 'P', market: 'Total Bases', line: 2.5, pp_line: 2.5,
      pp_tier: 'standard', books: closeRow.books,
    }],
  });
  await L.appendBet({
    slip_id: 's1', placed_at: '2026-09-09T14:07:00.000Z', slip_type: 'power', stake: 10,
    legs: [{ player: 'P', market: 'Total Bases', line: 1.5, side: 'over', snapshot_id: snapId }],
  });

  const view = await C.buildClv({});
  t.eq('the view produces one row per leg', view.legs.length, 1);
  t.eq('...resolving the closing capture by its is_closing flag', view.legs[0].closing_kind, 'closing');
  t.eq('...and the line movement', view.legs[0].line_delta, 1);
  t.eq('the summary counts priced legs separately from all legs',
    [view.summary.legs, view.summary.priced], [1, 1]);
  t.eq('...and how many beat the close', view.summary.beat_close, 1);
  // Line movement is counted, never averaged: a point of total bases and a
  // point of passing yards are different quantities.
  t.ok('line movement is reported as counts, not a mean',
    'line_better' in view.summary && !('mean_line_delta' in view.summary), JSON.stringify(view.summary));
}

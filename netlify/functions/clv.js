// netlify/functions/clv.js
//
// Closing line value, per leg.
//
// A "view" in the SQL sense is not available here (see the storage note in
// ledger-store.js), so this is the equivalent: a pure function over the bets
// and snapshot stores, recomputed per request and never materialised. Nothing
// it produces is written anywhere, which means it can be changed without a
// migration and can never drift from the rows it is derived from.
//
// GET /api/clv?format=json           every leg
// GET /api/clv?slip=<slip_id>        one slip
//
// ---------------------------------------------------------------------------
// WHY BOTH A LINE DELTA AND A PROBABILITY DELTA
//
// The brief asked for both, and they answer different questions.
//
// LINE MOVEMENT is in the units of the stat. "I took Judge over 1.5 and it
// closed at 2.5" is a full point of value and any bettor can read it. But a
// point means different things on different markets — a point of total bases is
// enormous, a point of passing yards is nothing — so line movement cannot be
// summed or averaged across markets.
//
// PROBABILITY DELTA is comparable across everything, which is what makes it the
// number worth aggregating. It requires stripping the vig out of the closing
// price first, because a book's posted prices sum to more than 100% and the
// excess is the book's margin, not information about the game.

import { allBets, snapshotRow, listCaptures, getCapture } from './ledger-store.js';
import { americanToProb, devig } from './fair-odds.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// ---------------------------------------------------------------------------
// Odds maths

// Odds arithmetic lives in fair-odds.js (imported above). This file had its own
// copy, and bet-finder-background.js had a third that disagreed with both on the
// missing-price case. Re-exported so existing callers and tests are unchanged.
export { americanToProb };

/**
 * Strip the vig from a two-way market by proportional (multiplicative) scaling.
 *
 * A book posting -115 / -115 is quoting 52.3% and 52.3%, which sums to 104.6%.
 * The 4.6% is the margin. Dividing each side by the total puts them back on a
 * 100% basis: 50% / 50%.
 *
 * This is the simple method and it is deliberately the one used. Shin and
 * power/logarithmic de-vigging assume a favourite-longshot bias and would shade
 * these numbers by a point or two at the extremes — but they need a model
 * fitted to this book's own pricing, and a de-vig method chosen because it
 * flatters a CLV number is worse than none. Proportional is the standard, it is
 * transparent, and it is stated here so a later reader knows it was a choice.
 */
export function noVig(overOdds, underOdds, method = 'multiplicative') {
  const o = americanToProb(overOdds);
  const u = americanToProb(underOdds);
  if (o == null || u == null) return null;
  const d = devig([o, u], method);
  if (!d) return null;
  return { over: d.probs[0], under: d.probs[1], vig: d.hold, method: d.method };
}

/**
 * The closing consensus across books, on the side that was bet.
 *
 * Consensus = the mean of each book's de-vigged probability, and the median of
 * their lines. De-vig FIRST, then average: averaging raw prices and de-vigging
 * the average would fold two books' different margins into one number that
 * belongs to neither.
 *
 * Books with only one side priced are skipped rather than half-counted — a
 * one-sided quote has no vig to remove, so its implied probability is not
 * comparable with the others'.
 */
export function closingConsensus(books, side) {
  const probs = [];
  const lines = [];
  for (const b of books || []) {
    if (b.line != null && isFinite(Number(b.line))) lines.push(Number(b.line));
    const nv = noVig(b.over_price, b.under_price);
    if (nv) probs.push(side === 'under' ? nv.under : nv.over);
  }
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    line: median(lines),
    prob: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null,
    books: lines.length,
    pricedBooks: probs.length,
  };
}

/**
 * Which way a line move helped.
 *
 * On an OVER, the line moving UP after you bet is good — you hold a lower
 * number than the market settled on. On an UNDER it is the reverse. Reporting
 * a raw delta without that flip would score half the ledger backwards, and the
 * error would be invisible because both signs appear either way.
 */
export function lineEdge(myLine, closingLine, side) {
  if (myLine == null || closingLine == null) return null;
  const raw = Number(closingLine) - Number(myLine);
  return side === 'under' ? -raw : raw;
}

// ---------------------------------------------------------------------------
// The view

/**
 * The closing capture for an event: the one flagged is_closing. Falls back to
 * the last capture that carried the prop at all, labelled so the difference is
 * never invisible in the output.
 */
async function closingRowFor(leg, myRow) {
  const match = (cap) => (cap?.rows || []).find((r) => r.player === leg.player && r.market === leg.market);

  // Closes first, and they are checked before any routine capture — a real
  // closing line is always the right answer and there are few of them.
  for (const key of await listCaptures({ kind: 'closing' })) {
    // eslint-disable-next-line no-await-in-loop
    const cap = await getCapture(key);
    const row = match(cap);
    if (row) return { row, kind: 'closing', captured_at: cap.captured_at, capture_key: key };
  }

  // No close was captured for this event — the cron missed it, or the prop came
  // off the board before kickoff. The last routine capture that still carried
  // the prop is the best available stand-in, and it is LABELLED as one:
  // reporting a last-seen line as a closing line would overstate the archive's
  // coverage precisely where it is weakest.
  for (const key of await listCaptures({ kind: 'routine' }).then((ks) => ks.reverse())) {
    // eslint-disable-next-line no-await-in-loop
    const cap = await getCapture(key);
    const row = match(cap);
    if (!row) continue;
    // Never resolve backwards past the bet itself; a "closing" line from before
    // the wager was placed is not a close, it is the opening.
    if (myRow && cap.captured_at <= myRow.captured_at) return null;
    return { row, kind: 'last-seen', captured_at: cap.captured_at, capture_key: key };
  }
  return null;
}

/** One leg's CLV. Exported so it can be tested without a store. */
export function clvForLeg({ leg, myRow, closing }) {
  const closingRow = closing?.row || null;
  const cons = closingRow ? closingConsensus(closingRow.books, leg.side) : null;

  // My probability comes from the books at the time I bet, not from PrizePicks'
  // payout. PrizePicks does not post two-way prices, so its number cannot be
  // de-vigged and is not comparable with a closing consensus.
  const mine = myRow ? closingConsensus(myRow.books, leg.side) : null;

  const lineDelta = lineEdge(leg.line, cons?.line ?? null, leg.side);
  // Positive = the market closed thinking the bet side was MORE likely than my
  // price implied, i.e. I got the better of it.
  const probDelta = (mine?.prob != null && cons?.prob != null) ? cons.prob - mine.prob : null;

  return {
    leg_id: leg.leg_id,
    player: leg.player,
    market: leg.market,
    side: leg.side,
    my_line: leg.line,
    my_prob_novig: mine?.prob ?? null,
    closing_line: cons?.line ?? null,
    closing_prob_novig: cons?.prob ?? null,
    closing_kind: closing?.kind ?? null,
    closing_captured_at: closing?.captured_at ?? null,
    line_delta: lineDelta,
    prob_delta: probDelta,
    // Nothing is silently dropped: every leg appears, and one that could not be
    // priced says why. A CLV table that quietly omits its unpriceable rows
    // reports the average of the legs it happened to understand.
    // Ordered from the outside in, and checked on `prob` rather than on the
    // object: closingConsensus always RETURNS a shape, with nulls inside it
    // when nothing could be priced. Testing `mine == null` therefore never
    // fired, and a leg with no book quote at bet time came back with a null
    // prob_delta and no reason at all — the one combination that reads as a
    // bug in the view rather than a gap in the data.
    unpriced_reason: cons == null ? 'no closing snapshot for this prop'
      : mine == null || mine.prob == null ? 'no two-way book price in the snapshot current at placed_at'
        : cons.prob == null ? 'closing snapshot had no two-way price to de-vig'
          : null,
  };
}

export async function buildClv({ slipId = null } = {}) {
  const bets = (await allBets()).filter((b) => !slipId || b.slip_id === slipId);
  const legs = [];
  for (const bet of bets) {
    for (const leg of bet.legs || []) {
      // eslint-disable-next-line no-await-in-loop
      const myRow = leg.snapshot_id ? await snapshotRow(leg.snapshot_id) : null;
      // eslint-disable-next-line no-await-in-loop
      const closing = await closingRowFor(leg, myRow);
      legs.push({
        slip_id: bet.slip_id,
        placed_at: bet.placed_at,
        ...clvForLeg({ leg, myRow, closing }),
      });
    }
  }
  const priced = legs.filter((l) => l.prob_delta != null);
  return {
    legs,
    summary: {
      legs: legs.length,
      priced: priced.length,
      // Averaged over PRICED legs only, with the denominator stated beside it
      // so a mean over 3 of 40 legs cannot be read as the ledger's CLV.
      mean_prob_delta: priced.length
        ? priced.reduce((a, l) => a + l.prob_delta, 0) / priced.length : null,
      beat_close: priced.filter((l) => l.prob_delta > 0).length,
      // Line movement is NOT averaged across markets — a point of total bases
      // and a point of passing yards are not the same quantity. Counted only.
      line_better: legs.filter((l) => l.line_delta > 0).length,
      line_worse: legs.filter((l) => l.line_delta < 0).length,
    },
  };
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    const out = await buildClv({ slipId: q.slip || null });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(out, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

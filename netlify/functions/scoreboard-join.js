// netlify/functions/scoreboard-join.js
//
// Assembles the rows the scoreboard scores. Three sources, one join.
//
//   pick-log        every prop the judge has ever scored, bet or not, with the
//                   probability it gave and the outcome the grader wrote back.
//   bet-results     the ledger's settled legs. Only covers props actually bet,
//                   so it cannot be the primary outcome source — but where it
//                   overlaps it is an INDEPENDENT record of the same fact, and
//                   a disagreement between the two is a data-integrity finding
//                   worth more than any calibration number on this page.
//   line-snapshots  the archived board, carrying DK/FD prices. The book
//                   baseline is built from these.
//
// ===========================================================================
// WHY THE PICK LOG IS THE OUTCOME SOURCE AND THE LEDGER IS THE CHECK
//
// The brief asks for every prop the judge has ever scored, "whether or not I
// bet it". The ledger only knows about bets, so scoring from it would silently
// restrict the whole report to the props that were liked enough to back — the
// most selected, least representative slice of the board, and the one where a
// calibration curve is most flattered by selection.
//
// The pick log carries the outcome for all of them (`hit`, written by
// grade-picks.js). So it is the join's spine, and the ledger is cross-checked
// against it rather than ignored.
//
// ---------------------------------------------------------------------------
// THE BOOK PRICE IS TAKEN CONTEMPORANEOUSLY, NOT AT THE CLOSE
//
// The default is the capture that was CURRENT when the forecast was made. A
// closing line is sharper, but comparing a morning forecast against a closing
// price scores the model against information it did not have and would make the
// book baseline unbeatable by construction. `mode: 'closing'` is available and
// is the right comparison for a different question — "how much did the market
// know by kickoff that I never found out" — and every row records which was
// used, so the two can never be mixed up in one number.
//
// This is the same rule, and the same reason, as captureCurrentAt() in
// ledger-store.js.
// ===========================================================================

import { getStore } from '@netlify/blobs';
import { dedupe } from './calibration.js';
import { fairFromBooks } from './fair-odds.js';
import { translate } from './alt-line.js';
import { propKey, allResults, allBets, listCaptures, getCapture } from './ledger-store.js';

const pickLog = () => getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

const isGraded = (p) => p.hit === true || p.hit === false;

/** Read the whole pick log, or the last `days` of it. */
export async function loadPickLog({ days = null, store = null } = {}) {
  const s = store || pickLog();
  let keys = [];
  try { keys = (await s.list()).blobs.map((b) => b.key); } catch { keys = []; }
  if (days) {
    const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString().slice(0, 10);
    keys = keys.filter((k) => k >= cutoff);
  }
  const out = [];
  for (const k of keys.sort()) {
    try {
      const day = await s.get(k, { type: 'json' });
      if (Array.isArray(day)) out.push(...day);
    } catch { /* a corrupt day is skipped, not fatal */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The book price

/**
 * The archive is indexed WITHOUT the line, and that is the whole reason the
 * book baseline has any coverage at all.
 *
 * PrizePicks posts a LADDER — Nick Martinez's strikeouts at 1.5, 2.5, 3.5, 4.5,
 * 5.5 and 6.5 — and every rung is archived as its own row. Keying the index on
 * the exact line would find a book price only when the archive happened to hold
 * the same rung the pick was taken at, and would return "no archived capture"
 * for a prop whose prices are sitting right there under a different rung.
 *
 * It also makes the translation layer pointless: the book has ONE line, and
 * alt-line.js exists precisely to move its probability onto whichever rung the
 * pick was at. So the lookup is by player and market, and the line is handled
 * by the translation instead of by the key.
 *
 * Built from propKey with the line pinned to a constant, rather than a second
 * normaliser — a private copy of "how a player name becomes a key" would drift
 * from the ledger's, and then a prop would resolve in one and not the other.
 */
const bookKey = ({ league, player, market }) => propKey({ league, player, market, line: 0 });

/**
 * An index of every archived capture, so a row can be priced without rescanning.
 *
 * Captures are loaded LAZILY and cached: a season of ten-minute captures is
 * thousands of blobs, and a report over thirty graded props needs a handful of
 * them. Loading them all up front would make the CLI unusable long before the
 * archive is big enough to be interesting.
 */
export async function buildCaptureIndex() {
  const keys = await listCaptures({});
  const routine = keys.filter((k) => k.startsWith('capture/')).sort();
  const closing = keys.filter((k) => k.startsWith('closing/'));
  const cache = new Map();

  const load = async (key) => {
    if (cache.has(key)) return cache.get(key);
    let idx = null;
    try {
      const cap = await getCapture(key);
      idx = new Map();
      for (const r of cap?.rows || []) {
        const k = bookKey({ league: r.league, player: r.player, market: r.market });
        const prev = idx.get(k);
        // Prefer a row that actually carries prices. PrizePicks posts a LADDER,
        // so the same player and market appear several times in one capture,
        // and only some rungs may have resolved a book quote.
        if (!prev || (!prev.books?.length && r.books?.length)) idx.set(k, r);
      }
    } catch { idx = new Map(); }
    cache.set(key, idx);
    return idx;
  };

  return {
    routineKeys: routine,
    closingKeys: closing,
    /** The capture key that was current at an instant — never a later one. */
    keyAt(when) {
      const t = new Date(when).toISOString();
      // Keys sort lexicographically the same way their ISO timestamps do.
      let best = null;
      for (const k of routine) {
        if (k.slice('capture/'.length) <= t) best = k; else break;
      }
      return best;
    },
    load,
    async closingRowFor(prop) {
      const want = bookKey(prop);
      for (const k of closing) {
        const idx = await load(k);          // eslint-disable-line no-await-in-loop
        if (idx.has(want)) return idx.get(want);
      }
      return null;
    },
  };
}

/**
 * The de-vigged book probability of the OVER, moved onto the PrizePicks line.
 *
 * Two steps, and both can refuse:
 *
 *   1. de-vig the two-way book prices (fair-odds.js). Refuses when no book
 *      posted both sides — a one-sided quote has no vig to remove and so has no
 *      fair probability.
 *   2. translate from the book's line to PrizePicks' (alt-line.js). Refuses
 *      when the two lines are far enough apart that the answer would come from
 *      the assumed distribution shape rather than from the market.
 *
 * A refusal returns null WITH its reason, and the reasons are tallied in the
 * report. A book baseline built out of silently-guessed numbers would be worse
 * than no baseline at all, because it would look like one.
 */
export function bookProbFor(snapRow, ppLine, { weights = {}, models = {} } = {}) {
  if (!snapRow) return { prob: null, reason: 'no archived capture covers this prop' };
  const fair = fairFromBooks(snapRow.books, { side: 'over', config: weights });
  if (fair.fairProb == null) {
    return { prob: null, reason: fair.unpriced || snapRow.book_status || 'no usable book price' };
  }
  const line = Number(ppLine);
  if (Number(fair.fairLine) === line) {
    return { prob: fair.fairProb, reason: null, bookLine: fair.fairLine, translated: false, bookCount: fair.bookCount };
  }
  const t = translate({
    market: snapRow.market,
    bookLine: fair.fairLine,
    bookProb: fair.fairProb,
    ppLine: line,
    config: models,
  });
  if (!t.ok) return { prob: null, reason: t.reason, bookLine: fair.fairLine, bookCount: fair.bookCount };
  // prob_no_push, NOT prob.over — and they differ on every whole-number line.
  //
  // The outcome this is scored against comes from settle() in grade-picks.js,
  // which returns hit: null on a tie. So a graded row is BY CONSTRUCTION one
  // where no push happened, and the book probability it is compared to has to
  // be conditional on the same thing. Using the unconditional P(over) would
  // charge the book for the push mass on every whole line while the model was
  // never charged for it — a systematic advantage to the model, in the one
  // comparison the whole report turns on.
  //
  // It is also what the two-way de-vig above already returns at the book's own
  // line: over and under are the only two outcomes priced, so their normalised
  // pair is conditional on the bet resolving.
  return {
    prob: t.prob_no_push.over,
    reason: null,
    bookLine: fair.fairLine,
    translated: true,
    bookCount: fair.bookCount,
  };
}

// ---------------------------------------------------------------------------
// The ledger cross-check

/**
 * Did the over hit, according to the LEDGER?
 *
 * The ledger records the outcome of the leg as bet — `won` on an under means
 * the over did NOT hit — so the side has to be flipped back before the two
 * records can be compared at all. Pushes and voids carry no binary outcome and
 * are excluded rather than counted as either.
 */
export function ledgerOverHit(leg, result) {
  if (!result || (result.outcome !== 'won' && result.outcome !== 'lost')) return null;
  const won = result.outcome === 'won';
  const side = String(leg?.side || 'over').toLowerCase();
  return side === 'under' ? !won : won;
}

/** Index the ledger's legs by prop identity, with their settled outcome. */
export async function buildLedgerIndex() {
  const [bets, results] = await Promise.all([allBets(), allResults()]);
  const byLeg = new Map(results.map((r) => [r.leg_id, r]));
  const idx = new Map();
  for (const bet of bets) {
    for (const leg of bet.legs || []) {
      const key = propKey({ league: leg.league ?? bet.league, player: leg.player, market: leg.market, line: leg.line });
      const overHit = ledgerOverHit(leg, byLeg.get(leg.leg_id));
      if (overHit == null) continue;
      idx.set(key, { overHit, leg_id: leg.leg_id, slip_id: bet.slip_id, side: leg.side });
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// The join

/**
 * Every scored prop, joined to its outcome and (where possible) a book price.
 *
 * `bookP` is the only field that can be absent on an otherwise complete row,
 * and its absence is counted rather than hidden — see `bookReasons` in the
 * returned meta, which is what tells you whether the book baseline is missing
 * because the archive is empty or because the lines are too far apart to
 * translate.
 */
export async function joinRows({
  days = null,
  mode = 'contemporaneous',
  weights = {},
  models = {},
  includeUngraded = false,
  logStore = null,
  skipBook = false,
} = {}) {
  const raw = await loadPickLog({ days, store: logStore });
  const picks = dedupe(raw);

  const captures = skipBook ? null : await buildCaptureIndex().catch(() => null);
  const ledger = await buildLedgerIndex().catch(() => new Map());

  const bookReasons = {};
  const rows = [];
  let ledgerChecked = 0, ledgerAgreed = 0;
  const ledgerDisagreements = [];

  for (const p of picks) {
    const graded = isGraded(p);
    if (!graded && !includeUngraded) continue;

    const key = propKey({ league: p.league, player: p.player, market: p.stat, line: p.line });

    // ---- the ledger cross-check ------------------------------------------
    const led = ledger.get(key);
    if (graded && led) {
      ledgerChecked++;
      if (led.overHit === p.hit) ledgerAgreed++;
      else {
        ledgerDisagreements.push({
          player: p.player, market: p.stat, line: p.line, date: p.date,
          pick_log_over_hit: p.hit, ledger_over_hit: led.overHit,
          leg_id: led.leg_id, slip_id: led.slip_id,
        });
      }
    }

    // ---- the book price ---------------------------------------------------
    let bookP = null, bookMeta = null;
    if (captures) {
      let snap = null;
      if (mode === 'closing') {
        snap = await captures.closingRowFor({ league: p.league, player: p.player, market: p.stat, line: p.line });
      } else {
        const capKey = captures.keyAt(p.loggedAt || `${p.date}T00:00:00.000Z`);
        if (capKey) {
          const idx = await captures.load(capKey);
          snap = idx.get(bookKey({ league: p.league, player: p.player, market: p.stat })) || null;
        }
      }
      const got = bookProbFor(snap, p.line, { weights, models });
      bookP = got.prob;
      bookMeta = got;
      if (got.prob == null) {
        const r = got.reason || 'unknown';
        bookReasons[r] = (bookReasons[r] || 0) + 1;
      }
    }

    rows.push({
      key,
      // What the scoreboard scores. p is P(over), y is "did the over hit" — the
      // convention the entire pick log rests on. See the header of scoreboard.js.
      p: Number(p.prob),
      y: p.hit === true ? 1 : p.hit === false ? 0 : null,
      bookP,
      // Everything the breakdowns split on.
      league: p.league || null,
      market: p.stat || null,
      tier: p.oddsType || null,
      side: p.side || p.sidePick || null,
      date: p.date || null,
      loggedAt: p.loggedAt || null,
      // Provenance, so a report can be narrowed to one judge version later.
      source: p.source || 'board',
      promptVersion: p.promptVersion || null,
      judgeModel: p.judgeModel || null,
      deepDive: !!p.deepDive,
      player: p.player || null,
      line: p.line ?? null,
      bookLine: bookMeta?.bookLine ?? null,
      bookTranslated: bookMeta?.translated ?? null,
      bookCount: bookMeta?.bookCount ?? null,
      bookReason: bookMeta?.reason ?? null,
      inLedger: !!led,
    });
  }

  return {
    rows,
    meta: {
      mode,
      pickLogRows: raw.length,
      afterDedupe: picks.length,
      joined: rows.length,
      captureCount: captures ? captures.routineKeys.length : 0,
      closingCount: captures ? captures.closingKeys.length : 0,
      bookPriced: rows.filter((r) => r.bookP != null).length,
      // WHY the book baseline is thin, itemised. "The archive is empty" and
      // "the lines are two steps apart" are different problems with different
      // fixes, and a single coverage percentage cannot tell them apart.
      bookReasons,
      ledger: {
        checked: ledgerChecked,
        agreed: ledgerAgreed,
        disagreed: ledgerChecked - ledgerAgreed,
        disagreements: ledgerDisagreements.slice(0, 20),
      },
    },
  };
}

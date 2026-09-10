// netlify/functions/fair-odds.js
//
// Fair probability from bookmaker prices: strip the vig, weight the books,
// report what the market thinks and how much it disagrees with itself.
//
// PURE. No imports, no I/O, no clock, no network. The book-weight config comes
// in as an argument (see book-weights.json), so the weights are data and this
// module holds no opinions of its own about which book is sharp.
//
// This is the canonical home for odds arithmetic in the repo. clv.js and
// bet-finder-background.js both had their own americanToProb, and they had
// already drifted: one returned `null` for a missing price and the other
// returned `0`. Those are not the same claim — `null` is "no quote", `0` is
// "cannot happen" — and a 0 flowing into a win-probability calculation is a
// silent certainty of losing. One definition, one meaning.
//
// ===========================================================================
// A RESULT WORTH KNOWING BEFORE CHOOSING A METHOD
//
// On a TWO-OUTCOME market, Shin's method and the additive method are not
// merely close — they are THE SAME NUMBER. Every player prop is two-outcome
// (over/under), so on the only markets this app touches, picking Shin over
// additive changes nothing at all.
//
// Why. Shin's condition, rearranged, is  p_i^2 + z*p_i*(1-p_i) = pi_i^2 / PI.
// Write the additive solution as p_i = pi_i - d with d = (PI-1)/2. For two
// outcomes 1-a+d = b-d, so subtracting the two conditions leaves
// (a-b) = (a-b)*PI/PI — an identity, satisfied for any z. The remaining
// equation then fixes z, and both conditions hold. Verified numerically to
// 2.5e-16 across a sweep of prices, and pinned in the tests.
//
// Where they DO differ is three-way markets (soccer 1X2): ~3e-3 apart on a
// typical line, which is real. So all three methods are implemented and the
// choice is honest — it just is not a choice on player props.
//
// What IS a real choice on player props: multiplicative against the other two.
// Multiplicative scales both sides by the same factor, so it leaves the
// favourite-longshot bias where it found it. Shin/additive take the same
// ABSOLUTE margin off each side, which shades a longshot down much harder in
// relative terms — on -2000/+1200 the longshot goes to 6.2% under Shin against
// 7.5% under multiplicative. That is the favourite-longshot correction, and it
// is the reason the default is shin.
// ===========================================================================

export const METHODS = ['shin', 'additive', 'multiplicative'];

// ---------------------------------------------------------------------------
// Odds conversion

/**
 * American odds -> implied probability, vig included.
 *
 * Returns null for anything that is not a price. NEVER 0: a book that has not
 * posted a side is not a book saying the side cannot happen, and every caller
 * has to be able to tell those apart.
 */
export function americanToProb(odds) {
  const n = Number(odds);
  if (odds == null || odds === '' || !isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

/** Probability -> American odds. The inverse of the above, for reporting a fair price. */
export function probToAmerican(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) return null;
  return x >= 0.5 ? -Math.round((100 * x) / (1 - x)) : Math.round((100 * (1 - x)) / x);
}

/** Decimal odds -> implied probability. */
export function decimalToProb(d) {
  const n = Number(d);
  if (!isFinite(n) || n <= 1) return null;
  return 1 / n;
}

/** The overround: how much more than 100% the book's own prices add up to. */
export function hold(quoted) {
  const sum = quoted.reduce((a, b) => a + b, 0);
  return sum - 1;
}

// ---------------------------------------------------------------------------
// De-vigging

/** Proportional scaling: divide each side by the book's total. */
export function devigMultiplicative(quoted) {
  const total = quoted.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return quoted.map((p) => p / total);
}

/**
 * Equal absolute margin: take the same amount off every side.
 *
 * Can go negative on a fat hold over a heavy longshot — 3 outcomes at 4%
 * against a 15% hold puts one side below zero. That is the method failing, not
 * the market being strange, so it returns null rather than a negative
 * probability and the caller falls back with the reason recorded.
 */
export function devigAdditive(quoted) {
  const total = quoted.reduce((a, b) => a + b, 0);
  const d = (total - 1) / quoted.length;
  const out = quoted.map((p) => p - d);
  return out.some((p) => p <= 0) ? null : out;
}

const shinP = (pi, PI, z) => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / PI) - z) / (2 * (1 - z));

/**
 * Shin's insider-trading parameter z, by bisection.
 *
 * Shin (1993) models the overround as the book protecting itself against a
 * proportion z of bettors who know the outcome. Recovering the fair
 * probabilities means finding the z at which they sum to 1.
 *
 * Bisection rather than a closed form: a closed form exists for two outcomes
 * only, and having two code paths for what is meant to be one method is how
 * they end up disagreeing. The sum is monotonically decreasing in z, so
 * bisection is safe.
 */
export function shinZ(quoted, { tol = 1e-14, maxIter = 300 } = {}) {
  const PI = quoted.reduce((a, b) => a + b, 0);
  const sumAt = (z) => quoted.reduce((s, pi) => s + shinP(pi, PI, z), 0);
  if (!(PI > 1)) return 0;                       // no vig to remove
  let lo = 0, hi = 1 - 1e-12;
  for (let i = 0; i < maxIter && hi - lo > tol; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function devigShin(quoted) {
  const PI = quoted.reduce((a, b) => a + b, 0);
  if (!(PI > 0)) return null;
  if (PI <= 1) return devigMultiplicative(quoted);   // no overround: nothing to strip
  const z = shinZ(quoted);
  const p = quoted.map((pi) => shinP(pi, PI, z));
  // Renormalise the last few ulps of bisection error away. The values are
  // already within 1e-14 of summing to 1; this makes the invariant exact so a
  // downstream `sum === 1` check is not at the mercy of float noise.
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((x) => x / s);
}

/**
 * De-vig one book's prices. `quoted` are vig-inclusive implied probabilities.
 *
 * Returns the fair probabilities plus what it took to get them, because a
 * de-vigged number without its method and hold cannot be reproduced or
 * compared against one produced a different way.
 */
export function devig(quoted, method = 'shin') {
  if (!Array.isArray(quoted) || quoted.length < 2) return null;
  if (quoted.some((p) => !(p > 0))) return null;
  if (!METHODS.includes(method)) throw new Error(`unknown de-vig method "${method}" — expected one of ${METHODS.join(', ')}`);

  const raw = hold(quoted);
  const fn = { shin: devigShin, additive: devigAdditive, multiplicative: devigMultiplicative }[method];
  let probs = fn(quoted);
  let usedMethod = method;
  let fallback = null;

  // Additive is the only method that can fail on real input. Falling back
  // silently would put a multiplicative number in a field labelled additive.
  if (!probs && method === 'additive') {
    probs = devigMultiplicative(quoted);
    usedMethod = 'multiplicative';
    fallback = 'additive produced a non-positive probability (hold too large relative to the longshot) — fell back to multiplicative';
  }
  if (!probs) return null;

  return {
    probs,
    method: usedMethod,
    requestedMethod: method,
    fallback,
    hold: raw,
    z: usedMethod === 'shin' && raw > 0 ? shinZ(quoted) : null,
  };
}

// ---------------------------------------------------------------------------
// Consensus across books

const weightFor = (config, bookKey) => {
  const w = config?.weights?.[String(bookKey || '').toLowerCase()];
  return typeof w === 'number' ? w : (config?.unknown_book_weight ?? 0.3);
};

const weightedMean = (pairs) => {
  const tw = pairs.reduce((s, [, w]) => s + w, 0);
  return tw > 0 ? pairs.reduce((s, [v, w]) => s + v * w, 0) / tw : null;
};

/**
 * Fair probability for one prop, across every book that priced it.
 *
 * `books` is the snapshot row's own shape:
 *   [{ book, line, over_price, under_price }, ...]
 *
 * GROUPED BY LINE, WHICH IS THE PART MOST EASILY GOT WRONG. Two books quoting
 * 1.5 and 2.5 are not pricing the same question, and averaging their
 * probabilities produces a number that answers neither. So each line gets its
 * own consensus, the line carrying the most weight becomes the headline, and
 * the others are returned beside it rather than blended in or dropped.
 *
 * DE-VIG FIRST, THEN AVERAGE. Averaging raw prices and de-vigging the average
 * folds several books' different margins into one number belonging to none of
 * them.
 */
export function fairFromBooks(books, {
  side = 'over',
  method = null,
  config = {},
  threshold = null,
} = {}) {
  const useMethod = method || config.default_method || 'shin';
  const disagreeAt = threshold ?? config.disagreement_threshold ?? 0.04;
  const lineDisagreeAt = config.line_disagreement_threshold ?? 0.5;

  const perBook = [];
  for (const b of books || []) {
    const over = americanToProb(b?.over_price);
    const under = americanToProb(b?.under_price);
    const weight = weightFor(config, b?.book);
    const base = { book: b?.book ?? null, line: b?.line ?? null, weight };
    if (over == null || under == null) {
      // A one-sided quote has no vig to remove, so it has no fair probability.
      // Recorded rather than dropped: "this book was there but only posted one
      // side" is different from "this book was not there".
      perBook.push({ ...base, fairProb: null, hold: null, excluded: 'only one side priced' });
      continue;
    }
    if (weight <= 0) {
      perBook.push({ ...base, fairProb: null, hold: hold([over, under]), excluded: 'weight 0 in config' });
      continue;
    }
    const d = devig([over, under], useMethod);
    if (!d) { perBook.push({ ...base, fairProb: null, hold: null, excluded: 'prices could not be de-vigged' }); continue; }
    perBook.push({
      ...base,
      quotedOver: over,
      fairProb: side === 'under' ? d.probs[1] : d.probs[0],
      hold: d.hold,
      method: d.method,
      fallback: d.fallback,
    });
  }

  const usable = perBook.filter((b) => b.fairProb != null && b.line != null);
  if (!usable.length) {
    return {
      fairProb: null, fairLine: null, fairAmerican: null, hold: null,
      bookCount: 0, method: useMethod, perBook,
      unpriced: 'no book posted a two-way price',
    };
  }

  // Group by line, and let weight decide the headline.
  const byLine = new Map();
  for (const b of usable) {
    const k = String(b.line);
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(b);
  }
  const groups = [...byLine.entries()].map(([lineKey, bs]) => ({
    line: Number(lineKey),
    weight: bs.reduce((s, b) => s + b.weight, 0),
    bookCount: bs.length,
    books: bs.map((b) => b.book),
    fairProb: weightedMean(bs.map((b) => [b.fairProb, b.weight])),
    hold: weightedMean(bs.map((b) => [b.hold, b.weight])),
    spread: Math.max(...bs.map((b) => b.fairProb)) - Math.min(...bs.map((b) => b.fairProb)),
  })).sort((a, b) => b.weight - a.weight || b.bookCount - a.bookCount);

  const primary = groups[0];
  const lines = usable.map((b) => b.line);
  const lineSpread = Math.max(...lines) - Math.min(...lines);

  // ---- disagreement ------------------------------------------------------
  // Surfaced, never smoothed. A book 6 points off the others is either a stale
  // quote nobody has taken down or a book that knows something, and those need
  // opposite responses — so the flag says which books and by how much, and
  // leaves the judgement to the reader.
  const flags = [];
  if (primary.bookCount > 1 && primary.spread > disagreeAt) {
    flags.push({
      kind: 'probability',
      spread: primary.spread,
      threshold: disagreeAt,
      detail: primary.books.map((bk) => {
        const b = usable.find((x) => x.book === bk && x.line === primary.line);
        return { book: bk, fairProb: b.fairProb };
      }),
    });
  }
  if (lineSpread > lineDisagreeAt) {
    flags.push({
      kind: 'line',
      spread: lineSpread,
      threshold: lineDisagreeAt,
      detail: groups.map((g) => ({ line: g.line, books: g.books, weight: g.weight })),
    });
  }

  return {
    fairProb: primary.fairProb,
    fairLine: primary.line,
    fairAmerican: probToAmerican(primary.fairProb),
    // The raw hold, weight-averaged over the books at the headline line. This
    // is the market's margin BEFORE removal — the thing being stripped out, not
    // what is left after.
    hold: primary.hold,
    bookCount: primary.bookCount,
    // Books that priced the prop at some other line. Counted separately: they
    // are evidence the market is unsettled, not evidence about this line.
    bookCountOtherLines: usable.length - primary.bookCount,
    method: useMethod,
    side,
    disagreement: flags.length ? flags : null,
    disagrees: flags.length > 0,
    byLine: groups,
    perBook,
    // TODO(correlation) does not apply here — each prop is de-vigged on its
    // own — but the ARCHIVE does depend on this being reproducible, so the
    // inputs to the decision travel with the answer.
    configId: config?.id ?? null,
  };
}

/**
 * Fair probabilities for a whole snapshot capture's worth of rows.
 *
 * Shaped for the archive: takes rows that already carry `books` and returns a
 * `fair` block per row, so the capture can embed it at write time and stay a
 * complete, self-contained record of the instant.
 */
export function fairForRows(rows, { config = {}, method = null, side = 'over' } = {}) {
  return (rows || []).map((row) => {
    const fair = fairFromBooks(row.books, { side, method, config });
    return {
      ...row,
      fair: {
        prob: fair.fairProb,
        line: fair.fairLine,
        american: fair.fairAmerican,
        hold: fair.hold,
        book_count: fair.bookCount,
        book_count_other_lines: fair.bookCountOtherLines,
        method: fair.method,
        side: fair.side,
        disagrees: fair.disagrees,
        disagreement: fair.disagreement,
        // Enough to rebuild this number exactly: which weights, which method.
        // The raw prices are already on the row, so any OTHER method can also
        // be re-run later against the same instant — which is the real
        // reconstructibility guarantee, not this cached answer.
        config_id: fair.configId,
        unpriced: fair.unpriced ?? null,
      },
    };
  });
}

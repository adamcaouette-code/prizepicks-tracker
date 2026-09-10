// netlify/functions/scoreboard.js
//
// THE PRIMARY SCOREBOARD. Grades the model's PROBABILITIES, not its results.
//
// ===========================================================================
// WHY THIS IS THE SCOREBOARD AND WIN RATE IS NOT
//
// A win rate answers "did the picks land". That number is dominated by which
// props happened to be selected, by tier mix, and by luck — three things that
// move it around far more than forecasting skill does. It can be excellent
// while every probability is wrong, and dreadful while every probability is
// right.
//
// A probability score answers "when it says 65%, does it happen 65% of the
// time". That is the thing the rest of this app is built on: sizing, edge,
// verdicts, EV — every one of them takes the probability at face value. If the
// probabilities are miscalibrated then every downstream number is wrong in a
// way no amount of good results would reveal.
//
// So: Brier, log loss, a reliability curve with intervals, and a calibration
// slope. Scored against two baselines, because a Brier score of 0.240 means
// nothing on its own — it only means something next to what a coin and a
// bookmaker scored on exactly the same props.
//
// ---------------------------------------------------------------------------
// EVERYTHING IS SCORED ON P(OVER)
//
// The pick log's `prob` is P(over) by a convention the whole log rests on, and
// `hit` is "did the over hit" — see settle() in grade-picks.js. An under
// recommendation at P(under)=0.66 is logged as prob 0.34, so the pair is always
// coherent. Scoring the SIDE's probability instead would be the same forecast
// relabelled, but it would make the reliability curve unreadable: every under
// would fold onto the top half of the axis and a systematic over-bias would
// cancel against itself instead of showing up.
//
// PURE. No imports, no I/O, no clock. Rows come in as { p, y, ... }.
// ===========================================================================

// Log loss is infinite at p = 0 or p = 1, so a single confident row would
// destroy the whole report. Clamped — and the clamp is REPORTED (see
// `clamped` in scoreSet) rather than applied quietly, because a model
// producing 0.999s is a finding, not a rounding detail.
export const EPS = 1e-6;

const clamp = (p, eps = EPS) => Math.min(1 - eps, Math.max(eps, Number(p)));
export const logit = (p, eps = EPS) => Math.log(clamp(p, eps) / (1 - clamp(p, eps)));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// `Number(null)` is 0 and `isFinite(0)` is true, so a null prediction would
// otherwise score as a confident 0% — a row with NO forecast counted as the
// most wrong forecast possible. Same trap as clearedCount() in top-picks.js.
const has = (v) => v != null && v !== '' && isFinite(Number(v));
const isScorable = (r) => !!r && has(r.p) && (r.y === 0 || r.y === 1);

// ---------------------------------------------------------------------------
// 1. The scores

/** Mean squared error of a probability. Lower is better; 0.25 is a coin. */
export function brier(rows) {
  const use = rows.filter(isScorable);
  if (!use.length) return null;
  return use.reduce((s, r) => s + (Number(r.p) - r.y) ** 2, 0) / use.length;
}

/**
 * Mean negative log likelihood. Lower is better; ln 2 = 0.6931 is a coin.
 *
 * Kept alongside Brier rather than instead of it because they disagree in a
 * useful way: log loss punishes confident mistakes far harder. A model that is
 * right on average but occasionally says 2% about something that happens will
 * look fine on Brier and terrible here, and that difference is the whole
 * warning.
 */
export function logLoss(rows, { eps = EPS } = {}) {
  const use = rows.filter(isScorable);
  if (!use.length) return null;
  return -use.reduce((s, r) => {
    const p = clamp(r.p, eps);
    return s + (r.y === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0) / use.length;
}

/**
 * Murphy's decomposition: Brier = uncertainty - resolution + reliability.
 *
 *   uncertainty  base rate variance. Nothing can do anything about it.
 *   resolution   how far the buckets' outcomes spread from the base rate.
 *                THIS IS THE SKILL: a model that says the same number about
 *                everything has zero resolution no matter how calibrated it is.
 *   reliability  how far each bucket's outcome sits from what it predicted.
 *                This is the miscalibration, and it is the only term that
 *                could be fixed by a post-hoc recalibration.
 *
 * Worth having because it separates two failures a single Brier fuses: "your
 * numbers are wrong" and "your numbers are all the same".
 *
 * THE IDENTITY IS ONLY EXACT FOR FORECASTS THAT TAKE FINITELY MANY VALUES.
 * These are continuous probabilities put into bins, and grouping them leaves a
 * residual that the textbook three-term version quietly absorbs. It is computed
 * and reported here instead, so the printed decomposition actually adds up to
 * the Brier score beside it. A decomposition whose terms do not sum to the
 * thing being decomposed is worse than none.
 */
export function decompose(rows, { bins = 10 } = {}) {
  const use = rows.filter(isScorable);
  if (!use.length) return null;
  const base = use.reduce((s, r) => s + r.y, 0) / use.length;
  const groups = new Map();
  for (const r of use) {
    const b = Math.min(bins - 1, Math.floor(clamp(r.p) * bins));
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(r);
  }
  let reliability = 0, resolution = 0;
  for (const g of groups.values()) {
    const meanP = g.reduce((s, r) => s + Number(r.p), 0) / g.length;
    const obs = g.reduce((s, r) => s + r.y, 0) / g.length;
    reliability += (g.length / use.length) * (meanP - obs) ** 2;
    resolution += (g.length / use.length) * (obs - base) ** 2;
  }
  const uncertainty = base * (1 - base);
  const score = brier(use);
  return {
    uncertainty,
    resolution,
    reliability,
    // Exactly what the three classic terms fail to account for — see above.
    residual: score - (uncertainty - resolution + reliability),
    brier: score,
    baseRate: base,
    bins,
  };
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Wilson rather than the textbook p ± z·sqrt(p(1-p)/n), which is wrong in
 * exactly the cases this report cares about: at n = 12 with 12 hits the normal
 * interval is [1.0, 1.0], claiming certainty from a dozen rows. Wilson stays
 * inside [0,1], never collapses to a point, and behaves at small n — which is
 * every bucket in this report for a long while yet.
 */
export function wilson(hits, n, z = 1.96) {
  if (!(n > 0)) return { lo: null, hi: null, centre: null, halfWidth: null };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
    centre,
    halfWidth: half,
  };
}

// ---------------------------------------------------------------------------
// 2. The reliability curve

/**
 * How many rows a bucket needs before its observed rate means anything.
 *
 * The criterion is the one the report actually shows: a Wilson interval whose
 * half-width is under `halfWidth`. The planning formula is the normal
 * approximation n = z²·p(1-p)/w², evaluated AT THE BUCKET'S OWN predicted
 * probability rather than at 0.5 — a bucket around 0.85 needs 196 rows for a
 * ±5pp read where one around 0.50 needs 385, and pretending otherwise would
 * hold the extreme buckets to a bar they do not need to clear.
 *
 * The number is large on purpose. Distinguishing 65% from 70% is a genuinely
 * expensive measurement, and a report that implied otherwise would be the most
 * damaging thing in this file.
 */
export function requiredN({ p = 0.5, halfWidth = 0.05, z = 1.96 } = {}) {
  const v = Math.max(0.01, p * (1 - p));   // floored so p=0 or 1 isn't "n=0"
  return Math.ceil((z * z * v) / (halfWidth * halfWidth));
}

/**
 * Deciles of predicted probability: predicted vs observed, with intervals.
 *
 * `meaningful` is the honest gate — it is true when the ACHIEVED Wilson
 * half-width is inside the target, not when the row count passed the planning
 * formula. The formula is an estimate; the interval is the measurement.
 */
export function reliabilityCurve(rows, { bins = 10, z = 1.96, halfWidth = 0.05 } = {}) {
  const use = rows.filter(isScorable);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const inBin = use.filter((r) => {
      const p = clamp(r.p);
      return b === bins - 1 ? p >= lo : (p >= lo && p < hi);
    });
    const n = inBin.length;
    const hits = inBin.reduce((s, r) => s + r.y, 0);
    const predicted = n ? inBin.reduce((s, r) => s + Number(r.p), 0) / n : null;
    const ci = wilson(hits, n, z);
    const need = requiredN({ p: predicted ?? (lo + hi) / 2, halfWidth, z });
    out.push({
      bin: b,
      range: [lo, hi],
      label: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      n,
      hits,
      predicted,
      observed: n ? hits / n : null,
      ci,
      // Signed, in percentage points. Negative means the outcome came in BELOW
      // what was predicted — the bucket was overconfident on the over.
      gapPP: n && predicted != null ? (hits / n - predicted) * 100 : null,
      // Does the interval still contain the prediction? If it does, this bucket
      // has no case to answer yet, however far the point estimate has drifted.
      predictionInsideCI: n && predicted != null ? predicted >= ci.lo && predicted <= ci.hi : null,
      requiredN: need,
      progress: n / need,
      meaningful: n > 0 && ci.halfWidth != null && ci.halfWidth <= halfWidth,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Calibration slope and intercept

/**
 * Logistic regression of the outcome on the predicted LOG-ODDS.
 *
 *   logit P(y = 1) = intercept + slope · logit(p)
 *
 * A perfectly calibrated forecaster gets slope 1, intercept 0 — the prediction
 * is already the answer and there is nothing to correct.
 *
 * SLOPE BELOW 1 MEANS OVERCONFIDENT: the predictions are spread further from
 * 50% than the outcomes justify, and shrinking them toward the base rate would
 * improve them. Slope above 1 means the opposite — too timid, the real signal
 * is stronger than the numbers claim. A non-zero intercept at slope 1 is a flat
 * directional bias: every number is too high, or every number too low.
 *
 * Fitted by IRLS (Newton-Raphson on a 2x2 system), which is exact for this
 * model rather than an optimiser that might stop early. The standard errors
 * come from the inverse Fisher information and they are the point: a slope of
 * 0.71 on 60 rows and a slope of 0.71 on 6,000 are completely different claims,
 * and only the second one is worth acting on.
 */
export function calibrationFit(rows, { maxIter = 100, tol = 1e-10, eps = EPS } = {}) {
  const use = rows.filter(isScorable);
  const n = use.length;
  if (n < 3) return { ok: false, reason: `only ${n} scorable rows — a slope needs at least a handful`, n };

  const x = use.map((r) => logit(r.p, eps));
  const y = use.map((r) => r.y);

  // A constant x has no slope to estimate; the fit would be singular and IRLS
  // would return a number produced entirely by floating-point noise.
  const xMin = Math.min(...x), xMax = Math.max(...x);
  if (xMax - xMin < 1e-9) {
    return { ok: false, reason: 'every prediction is the same probability — there is no slope to fit', n };
  }

  let b0 = 0, b1 = 1;    // start at "perfectly calibrated" and let the data move it
  let converged = false, iterations = 0;
  let xtwx = null;

  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    let s00 = 0, s01 = 0, s11 = 0, g0 = 0, g1 = 0;
    for (let i = 0; i < n; i++) {
      const eta = b0 + b1 * x[i];
      const mu = sigmoid(eta);
      // Floored: at mu = 0 or 1 the weight vanishes and the system goes
      // singular. This is separation, and the flag below is how it is reported
      // rather than being hidden behind a plausible-looking number.
      const w = Math.max(mu * (1 - mu), 1e-10);
      const resid = y[i] - mu;
      s00 += w; s01 += w * x[i]; s11 += w * x[i] * x[i];
      g0 += resid; g1 += resid * x[i];
    }
    const det = s00 * s11 - s01 * s01;
    if (!isFinite(det) || Math.abs(det) < 1e-14) {
      return { ok: false, reason: 'the fit is singular — the predictions do not separate the outcomes', n, iterations };
    }
    const d0 = (s11 * g0 - s01 * g1) / det;
    const d1 = (s00 * g1 - s01 * g0) / det;
    b0 += d0; b1 += d1;
    xtwx = { s00, s01, s11, det };
    if (Math.abs(d0) < tol && Math.abs(d1) < tol) { converged = true; break; }
  }

  // (X'WX)^-1 — the asymptotic covariance of the coefficients.
  const varB0 = xtwx.s11 / xtwx.det;
  const varB1 = xtwx.s00 / xtwx.det;
  const slopeSe = Math.sqrt(Math.max(0, varB1));
  const interceptSe = Math.sqrt(Math.max(0, varB0));

  // Against the null slope = 1 (perfect calibration), NOT slope = 0. A slope
  // significantly different from zero only says the predictions carry some
  // signal; the question here is whether they are the RIGHT size.
  const slopeZ = slopeSe > 0 ? (b1 - 1) / slopeSe : null;
  const interceptZ = interceptSe > 0 ? b0 / interceptSe : null;
  const slopeCI = [b1 - 1.96 * slopeSe, b1 + 1.96 * slopeSe];
  const oneInsideCI = slopeCI[0] <= 1 && slopeCI[1] >= 1;

  return {
    ok: true,
    n,
    slope: b1,
    intercept: b0,
    slopeSe,
    interceptSe,
    slopeCI,
    slopeZ,
    interceptZ,
    converged,
    iterations,
    oneInsideCI,
    interpretation: interpretFit({ slope: b1, intercept: b0, oneInsideCI, n }),
  };
}

/** The slope and intercept, said in plain language. Requirement 4. */
export function interpretFit({ slope, intercept, oneInsideCI, n }) {
  const lines = [];
  if (slope < 1) {
    lines.push(
      `Slope ${slope.toFixed(3)} is BELOW 1, which means OVERCONFIDENT: the probabilities are `
      + 'spread further from 50% than the outcomes justify. When it says 75% the truth is nearer '
      + `${(sigmoid(intercept + slope * logit(0.75)) * 100).toFixed(0)}%, and when it says 25% the truth is nearer `
      + `${(sigmoid(intercept + slope * logit(0.25)) * 100).toFixed(0)}%. Pulling every number toward the base rate would improve it.`,
    );
  } else if (slope > 1) {
    lines.push(
      `Slope ${slope.toFixed(3)} is ABOVE 1, which means UNDERCONFIDENT: the real signal is stronger `
      + 'than the numbers claim, and pushing them further from 50% would improve them. This is the '
      + 'rarer failure and worth double-checking against the reliability curve before acting on it.',
    );
  } else {
    lines.push(`Slope is exactly ${slope.toFixed(3)} — no spread correction indicated.`);
  }

  if (Math.abs(intercept) > 0.05) {
    lines.push(
      `Intercept ${intercept.toFixed(3)} is a flat ${intercept > 0 ? 'UPWARD' : 'DOWNWARD'} bias on top of that: `
      + `at the point where a perfect forecaster would say 50%, this one is really at `
      + `${(sigmoid(intercept) * 100).toFixed(1)}%. Every probability leans ${intercept > 0 ? 'high' : 'low'} for the over.`,
    );
  }

  if (oneInsideCI) {
    lines.push(
      `BUT: 1.0 is still inside the 95% interval on the slope at n=${n}. On this much data the `
      + 'calibration is NOT yet distinguishable from perfect, and the number above should be read as '
      + 'a direction to watch rather than a correction to apply.',
    );
  } else {
    lines.push(`1.0 is OUTSIDE the 95% interval at n=${n} — this is a real miscalibration, not sampling noise.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 4. Scoring a set, and the baselines

/** Every headline number for one set of rows. */
export function scoreSet(rows, opts = {}) {
  const use = rows.filter(isScorable);
  if (!use.length) return { n: 0, brier: null, logLoss: null };
  const extreme = use.filter((r) => Number(r.p) <= EPS || Number(r.p) >= 1 - EPS).length;
  return {
    n: use.length,
    hits: use.reduce((s, r) => s + r.y, 0),
    baseRate: use.reduce((s, r) => s + r.y, 0) / use.length,
    meanPrediction: use.reduce((s, r) => s + Number(r.p), 0) / use.length,
    brier: brier(use),
    logLoss: logLoss(use, opts),
    decomposition: decompose(use, opts),
    // Reported, not swept up: predictions at the clamp are a finding.
    clamped: extreme,
  };
}

/**
 * The coin. Always 50%, on the same rows.
 *
 * Its Brier is exactly 0.25 and its log loss exactly ln 2 = 0.693147, for any
 * outcome sequence whatsoever — which makes it a fixed, unarguable ruler rather
 * than something fitted to the data. Losing to it is not a subtle finding.
 */
export function coinBaseline(rows) {
  const use = rows.filter(isScorable);
  return scoreSet(use.map((r) => ({ ...r, p: 0.5 })));
}

/**
 * The book. Its de-vigged probability for the same prop, on the same rows.
 *
 * THIS IS THE BASELINE THAT MATTERS. A market price aggregates injury news,
 * lineup leaks, weather and the opinions of everyone willing to stake money on
 * being correct. Beating a coin proves almost nothing; beating the book is the
 * entire thesis of the project, and if it does not hold there is no edge to
 * size, whatever the win rate says.
 *
 * Scored on the INTERSECTION only — rows where a book price exists — with the
 * model re-scored on exactly those same rows. Comparing the model's number over
 * every prop against the book's over the subset it happens to price would
 * compare two different questions, and the subset is not random: it is the
 * liquid, heavily-modelled markets, which are the hardest ones to beat.
 */
export function bookBaseline(rows) {
  // Same null trap as above, and worse here: a row recorded as "no book price"
  // would become "the book said 0%", which on a prop that hit contributes a
  // full 1.0 to the book's Brier and hands the model a win it never earned.
  const paired = rows.filter((r) => isScorable(r) && has(r.bookP));
  if (!paired.length) {
    return {
      available: false,
      n: 0,
      coverage: 0,
      reason: 'no graded prop has an archived book price to compare against',
    };
  }
  const model = scoreSet(paired);
  const book = scoreSet(paired.map((r) => ({ ...r, p: r.bookP })));
  const scorable = rows.filter(isScorable).length;
  return {
    available: true,
    n: paired.length,
    coverage: scorable ? paired.length / scorable : 0,
    model,
    book,
    // Brier is a LOSS, so a negative delta is the model winning.
    brierDelta: model.brier - book.brier,
    logLossDelta: model.logLoss - book.logLoss,
    beatsBook: model.brier < book.brier,
    beatsBookOnLogLoss: model.logLoss < book.logLoss,
    // Paired sign test: on how many individual props was the model's squared
    // error smaller? A mean can be carried by a handful of rows; this cannot.
    // Ties are dropped rather than split, which is the conservative choice.
    ...signTest(paired),
  };
}

/** Per-row paired comparison against the book. Ties dropped. */
export function signTest(paired) {
  let modelBetter = 0, bookBetter = 0;
  for (const r of paired) {
    const mE = (Number(r.p) - r.y) ** 2;
    const bE = (Number(r.bookP) - r.y) ** 2;
    if (mE < bE) modelBetter++;
    else if (bE < mE) bookBetter++;
  }
  const decided = modelBetter + bookBetter;
  // Under "the two are equally good", wins are Binomial(decided, 0.5).
  const se = decided ? Math.sqrt(0.25 * decided) : null;
  return {
    signTest: {
      modelBetter,
      bookBetter,
      decided,
      winShare: decided ? modelBetter / decided : null,
      sigma: se ? (modelBetter - decided / 2) / se : null,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Breakdowns

/**
 * Split the rows by a key and score each group.
 *
 * Groups under `minN` are kept but marked `thin`, not dropped. A market with
 * six graded props is not evidence, but knowing it exists and has six is how
 * you find out that a whole sport has been silently failing to grade.
 */
export function breakdown(rows, keyFn, { minN = 30, label = '' } = {}) {
  const groups = new Map();
  for (const r of rows.filter(isScorable)) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [...groups.entries()].map(([key, rs]) => {
    const s = scoreSet(rs);
    const book = bookBaseline(rs);
    return {
      key,
      ...s,
      coin: coinBaseline(rs).brier,
      bookBrier: book.available ? book.book.brier : null,
      beatsBook: book.available ? book.beatsBook : null,
      bookN: book.n,
      thin: rs.length < minN,
    };
  });
  out.sort((a, b) => b.n - a.n);
  return { label, minN, groups: out };
}

/** Days between a forecast and the game it was about. */
export function daysToGame(row) {
  const game = String(row.date || '').slice(0, 10);
  const made = String(row.loggedAt || '').slice(0, 10);
  if (!game || !made) return null;
  const d = Math.round((Date.parse(game) - Date.parse(made)) / 86400000);
  return isFinite(d) ? d : null;
}

/** The bucket label for a lead time. */
export function leadTimeBucket(d) {
  if (d == null) return null;
  if (d <= 0) return 'same day';
  if (d === 1) return '1 day ahead';
  if (d === 2) return '2 days ahead';
  return '3+ days ahead';
}

// ---------------------------------------------------------------------------
// 6. The whole report, as data

export function buildReport(rows, {
  bins = 10,
  z = 1.96,
  halfWidth = 0.05,
  minN = 30,
  topMarkets = 12,
  meta = null,
} = {}) {
  const scorable = rows.filter(isScorable);
  const overall = scoreSet(scorable);
  const coin = coinBaseline(scorable);
  const book = bookBaseline(scorable);
  const fit = calibrationFit(scorable);
  const curve = reliabilityCurve(scorable, { bins, z, halfWidth });

  const marketSplit = breakdown(scorable, (r) => r.market, { minN, label: 'market' });
  marketSplit.groups = marketSplit.groups.slice(0, topMarkets);

  return {
    generated_at: null,   // stamped by the caller; this module has no clock
    settings: { bins, z, halfWidth, minN },
    // How the rows were assembled: book coverage, refusal reasons, and the
    // ledger cross-check. Carried through so the report can say WHY a baseline
    // is missing instead of only that it is.
    meta,
    counts: {
      total: rows.length,
      scorable: scorable.length,
      ungraded: rows.length - scorable.length,
      withBookPrice: scorable.filter((r) => has(r.bookP)).length,
    },
    overall,
    baselines: { coin, book },
    calibration: fit,
    reliability: curve,
    progress: {
      // Requirement 5, at the level the report is actually read: how far the
      // WHOLE curve is from being readable, not just one bucket.
      bucketsMeaningful: curve.filter((b) => b.meaningful).length,
      bucketsPopulated: curve.filter((b) => b.n > 0).length,
      bucketsTotal: bins,
      rowsNeededForAllPopulated: curve
        .filter((b) => b.n > 0 && !b.meaningful)
        .reduce((s, b) => s + Math.max(0, b.requiredN - b.n), 0),
    },
    breakdowns: {
      sport: breakdown(scorable, (r) => r.league || 'unknown', { minN, label: 'sport' }),
      market: marketSplit,
      lineType: breakdown(scorable, (r) => r.tier || 'unknown', { minN, label: 'line type' }),
      leadTime: breakdown(scorable, (r) => leadTimeBucket(daysToGame(r)), { minN, label: 'days until game' }),
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Rendering

const pct = (v, d = 1) => (v == null ? '   —  ' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 4) => (v == null ? '—' : Number(v).toFixed(d));
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

/** A one-line ASCII reliability plot for a bucket: prediction ^, interval [--]. */
function ciBar(bucket, width = 40) {
  if (!bucket.n) return ' '.repeat(width);
  const cell = (v) => Math.max(0, Math.min(width - 1, Math.round(v * (width - 1))));
  const chars = new Array(width).fill('·');
  const lo = cell(bucket.ci.lo), hi = cell(bucket.ci.hi);
  for (let i = lo; i <= hi; i++) chars[i] = '─';
  chars[lo] = '['; chars[hi] = ']';
  chars[cell(bucket.observed)] = '●';
  // The prediction goes on last, and NEVER by silently painting over what is
  // already there. At these widths it routinely lands on an interval bracket —
  // which is precisely the borderline case worth seeing — and plain overwriting
  // would delete the bracket, leaving a plot whose interval has no visible end.
  // A distinct glyph keeps both facts on the line.
  const pcell = cell(bucket.predicted);
  const under = chars[pcell];
  chars[pcell] = under === '●' ? '◉' : (under === '[' || under === ']') ? '╪' : '│';
  return chars.join('');
}

export function renderReport(rep, { width = 78 } = {}) {
  const L = [];
  const rule = (c = '─') => c.repeat(width);
  const head = (t) => { L.push('', rule(), t.toUpperCase(), rule()); };

  L.push(rule('═'));
  L.push('PROBABILITY SCOREBOARD'.padStart(Math.floor((width + 22) / 2)));
  L.push(rule('═'));

  // ---- THE BANNER -------------------------------------------------------
  // Requirement 6: if the book is not being beaten, that is the first thing on
  // the page, before any number that might soften it.
  const b = rep.baselines.book;
  if (!b.available) {
    L.push('');
    L.push('┌' + '─'.repeat(width - 2) + '┐');
    L.push('│ ⚠  NO BOOK BASELINE — THIS REPORT CANNOT TELL YOU IF YOU HAVE AN EDGE' + ' '.repeat(Math.max(0, width - 71)) + '│');
    L.push('│' + ' '.repeat(width - 2) + '│');
    for (const line of wrapText(
      `${b.reason}. Beating a coin is not evidence of anything: the only baseline that `
      + 'matters is the de-vigged market price for the same prop, and until the snapshot archive '
      + 'has captured book lines for props that have since graded, the central question of this '
      + 'project is unanswered.', width - 4)) {
      L.push('│ ' + pad(line, width - 4) + ' │');
    }
    L.push('└' + '─'.repeat(width - 2) + '┘');
  } else if (!b.beatsBook) {
    L.push('');
    L.push('┌' + '─'.repeat(width - 2) + '┐');
    L.push('│ ⛔  THE MODEL DOES NOT BEAT THE BOOK' + ' '.repeat(Math.max(0, width - 38)) + '│');
    L.push('│' + ' '.repeat(width - 2) + '│');
    for (const line of wrapText(
      `On the ${b.n} graded props where a book price exists, the model's Brier is ${fx(b.model.brier)} `
      + `against the book's ${fx(b.book.brier)} — worse by ${fx(Math.abs(b.brierDelta))}. `
      + `Per-prop, the model was closer on ${b.signTest.modelBetter} and the book on ${b.signTest.bookBetter}. `
      + 'Every edge, EV and stake this app computes is derived from these probabilities. If they are '
      + 'worse than the price you are betting into, the edge is an artefact of the model disagreeing '
      + 'with a better forecast, and sizing on it loses money faster the more confident it gets.', width - 4)) {
      L.push('│ ' + pad(line, width - 4) + ' │');
    }
    L.push('└' + '─'.repeat(width - 2) + '┘');
  } else {
    L.push('');
    L.push(`✓ Beats the book on ${b.n} paired props: Brier ${fx(b.model.brier)} vs ${fx(b.book.brier)} `
      + `(${fx(-b.brierDelta)} better).`);
  }

  // ---- what is in the sample --------------------------------------------
  head('sample');
  L.push(`  ${lpad(rep.counts.total, 7)}  props the judge has scored`);
  L.push(`  ${lpad(rep.counts.scorable, 7)}  graded — joined to an outcome, and scored below`);
  L.push(`  ${lpad(rep.counts.ungraded, 7)}  not yet graded (pending, pushed, or ungradeable)`);
  L.push(`  ${lpad(rep.counts.withBookPrice, 7)}  with an archived book price to compare against`);

  // ---- headline ---------------------------------------------------------
  head('headline');
  const o = rep.overall;
  const coin = rep.baselines.coin;
  L.push(`  ${pad('', 22)}${lpad('model', 10)}${lpad('coin (50%)', 12)}${lpad('book', 10)}`);
  L.push(`  ${pad('Brier (lower better)', 22)}${lpad(fx(o.brier), 10)}${lpad(fx(coin.brier), 12)}`
    + `${lpad(b.available ? fx(b.book.brier) : '—', 10)}`);
  L.push(`  ${pad('log loss', 22)}${lpad(fx(o.logLoss), 10)}${lpad(fx(coin.logLoss), 12)}`
    + `${lpad(b.available ? fx(b.book.logLoss) : '—', 10)}`);
  L.push(`  ${pad('n', 22)}${lpad(o.n, 10)}${lpad(coin.n, 12)}${lpad(b.available ? b.n : '—', 10)}`);
  L.push('');
  L.push(`  base rate ${pct(o.baseRate)} of overs hit · mean prediction ${pct(o.meanPrediction)}`);
  if (o.clamped) L.push(`  ⚠ ${o.clamped} prediction(s) at 0 or 1 were clamped to ${EPS} for log loss`);

  if (o.decomposition) {
    const d = o.decomposition;
    L.push('');
    L.push('  Brier = uncertainty − resolution + reliability + binning residual');
    const sgn = (v) => `${v < 0 ? '−' : '+'} ${fx(Math.abs(v))}`;
    L.push(`  ${fx(d.brier)} = ${fx(d.uncertainty)} − ${fx(d.resolution)} + ${fx(d.reliability)} ${sgn(d.residual)}`);
    L.push(`    resolution  ${fx(d.resolution)}  the skill — how far the buckets pull apart from the base rate`);
    L.push(`    reliability ${fx(d.reliability)}  the miscalibration — the only part a recalibration could fix`);
  }

  // ---- calibration fit ---------------------------------------------------
  head('calibration slope and intercept');
  const f = rep.calibration;
  if (!f.ok) {
    L.push(`  Not fitted: ${f.reason}`);
  } else {
    L.push(`  slope      ${fx(f.slope, 3)}  ± ${fx(f.slopeSe, 3)}   95% CI [${fx(f.slopeCI[0], 3)}, ${fx(f.slopeCI[1], 3)}]`);
    L.push(`  intercept  ${fx(f.intercept, 3)}  ± ${fx(f.interceptSe, 3)}`);
    if (!f.converged) L.push(`  ⚠ the fit did not converge in ${f.iterations} iterations — treat it as indicative only`);
    L.push('');
    for (const line of f.interpretation) {
      for (const w of wrapText(line, width - 4)) L.push(`  ${w}`);
      L.push('');
    }
  }

  // ---- reliability curve -------------------------------------------------
  head('reliability curve');
  L.push('  ● observed   │ predicted   [──] 95% Wilson interval   ·  0% ......... 100%');
  L.push('  ◉ the two coincide   ╪ the prediction sits exactly on the interval edge');
  L.push('');
  L.push(`  ${pad('bucket', 9)}${lpad('n', 6)}${lpad('pred', 8)}${lpad('obs', 8)}${lpad('gap', 8)}  plot`);
  for (const bk of rep.reliability) {
    if (!bk.n) {
      L.push(`  ${pad(bk.label, 9)}${lpad(0, 6)}${lpad('—', 8)}${lpad('—', 8)}${lpad('—', 8)}  (empty)`);
      continue;
    }
    const flag = bk.meaningful ? ' ' : '~';
    L.push(`  ${pad(bk.label, 9)}${lpad(bk.n, 6)}${lpad(pct(bk.predicted, 0), 8)}${lpad(pct(bk.observed, 0), 8)}`
      + `${lpad(`${bk.gapPP > 0 ? '+' : ''}${bk.gapPP.toFixed(1)}pp`, 8)}  ${flag}${ciBar(bk, 40)}`);
  }
  L.push('');
  for (const line of wrapText('~ marks a bucket whose interval is still wider than the ±'
    + `${(rep.settings.halfWidth * 100).toFixed(0)}pp target — its point estimate is not yet a measurement.`,
  width - 4)) L.push(`  ${line}`);

  // ---- how far from meaning anything -------------------------------------
  head('how much more data before this means anything');
  const pr = rep.progress;
  for (const line of wrapText(`${pr.bucketsMeaningful} of ${pr.bucketsPopulated} populated buckets are `
    + `inside the ±${(rep.settings.halfWidth * 100).toFixed(0)}pp target.`, width - 4)) L.push(`  ${line}`);
  L.push('');
  L.push(`  ${pad('bucket', 9)}${lpad('have', 7)}${lpad('need', 7)}${lpad('short', 7)}  progress`);
  for (const bk of rep.reliability) {
    if (!bk.n) continue;
    const short = Math.max(0, bk.requiredN - bk.n);
    const filled = Math.min(20, Math.round(bk.progress * 20));
    L.push(`  ${pad(bk.label, 9)}${lpad(bk.n, 7)}${lpad(bk.requiredN, 7)}${lpad(short, 7)}  `
      + `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${(Math.min(1, bk.progress) * 100).toFixed(0)}%`);
  }
  L.push('');
  for (const line of wrapText(
    `${pr.rowsNeededForAllPopulated} more graded props, spread across the buckets that already have some, `
    + `would bring every populated bucket inside ±${(rep.settings.halfWidth * 100).toFixed(0)}pp. `
    + 'That number is large because separating 65% from 70% genuinely is: it is not a flaw in the '
    + 'report, it is the cost of the measurement.', width - 4)) L.push(`  ${line}`);

  // ---- breakdowns --------------------------------------------------------
  for (const key of ['sport', 'market', 'lineType', 'leadTime']) {
    const bd = rep.breakdowns[key];
    head(`by ${bd.label}`);
    if (!bd.groups.length) { L.push('  (nothing graded yet)'); continue; }
    L.push(`  ${pad('', 22)}${lpad('n', 6)}${lpad('brier', 9)}${lpad('coin', 9)}${lpad('book', 9)}${lpad('obs', 7)}${lpad('pred', 7)}`);
    for (const g of bd.groups) {
      const mark = g.thin ? '~' : ' ';
      const bookCell = g.bookBrier == null ? '—' : `${fx(g.bookBrier)}${g.beatsBook ? '✓' : '✗'}`;
      L.push(`  ${mark}${pad(String(g.key).slice(0, 20), 21)}${lpad(g.n, 6)}${lpad(fx(g.brier), 9)}`
        + `${lpad(fx(g.coin), 9)}${lpad(bookCell, 9)}${lpad(pct(g.baseRate, 0), 7)}${lpad(pct(g.meanPrediction, 0), 7)}`);
    }
    if (bd.groups.some((g) => g.thin)) {
      for (const line of wrapText(`~ fewer than ${bd.minN} graded props — shown so a gap is visible, `
        + 'not because it is evidence.', width - 4)) L.push(`  ${line}`);
    }
  }

  // ---- where the data came from -----------------------------------------
  if (rep.meta) {
    const m = rep.meta;
    head('data integrity');
    L.push(`  pick log      ${m.pickLogRows} rows, ${m.afterDedupe} distinct forecasts, ${m.joined} joined`);
    L.push(`  archive       ${m.captureCount} routine captures, ${m.closingCount} closing captures`);
    L.push(`  book price    ${m.bookPriced} of ${rep.counts.scorable} graded `
      + `(${pct(rep.counts.scorable ? m.bookPriced / rep.counts.scorable : 0, 0)}), taken ${m.mode}`);
    const reasons = Object.entries(m.bookReasons || {}).sort((a, c) => c[1] - a[1]).slice(0, 6);
    if (reasons.length) {
      L.push('  why the rest have no book price:');
      for (const [reason, n] of reasons) {
        for (const [i, w] of wrapText(`${lpad(n, 6)}  ${reason}`, width - 6).entries()) {
          L.push(`    ${i ? '        ' : ''}${w}`);
        }
      }
    }
    // The independent check. Two records of the same fact disagreeing is worth
    // more attention than any calibration number on this page, because it means
    // one of them is wrong and the scoreboard is built on one of them.
    const led = m.ledger || {};
    if (led.checked) {
      L.push('');
      L.push(`  ledger check  ${led.agreed} of ${led.checked} bet props agree with the pick log on the outcome`);
      if (led.disagreed) {
        L.push(`  ⛔ ${led.disagreed} DISAGREE — the pick log and the ledger record different outcomes for the`);
        L.push('     same prop. One of them is wrong, and this report is scored on the pick log.');
        for (const d of (led.disagreements || []).slice(0, 5)) {
          L.push(`       ${d.date} ${d.player} ${d.market} ${d.line}: log says over ${d.pick_log_over_hit}, ledger says ${d.ledger_over_hit}`);
        }
      }
    } else {
      L.push('');
      L.push('  ledger check  no graded prop is also a settled ledger leg — nothing to cross-check yet');
    }
  }

  L.push('');
  L.push(rule('═'));
  return L.join('\n');
}

/** Word wrap, so the boxes above never blow out on a narrow terminal. */
export function wrapText(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

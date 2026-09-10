// netlify/functions/alt-line.js
//
// Translating a book's price at ITS line to a probability at PrizePicks' line.
//
// The problem this exists for: DraftKings prices Nick Martinez's strikeouts at
// 3.5 and PrizePicks posts 6.5. Those are not the same bet and the probabilities
// are not comparable, so every edge computed across them is meaningless until
// one is moved onto the other's line.
//
// The method: fit a distribution whose probability at the BOOK's line is exactly
// the book's no-vig probability, then read that distribution off at the
// PrizePicks line.
//
// PURE. No imports, no I/O, no clock. The market-model config comes in as an
// argument (see market-models.json).
//
// ===========================================================================
// THE CENTRAL LIMITATION, WHICH IS NOT A DETAIL
//
// One probability identifies exactly ONE parameter. Every two-parameter family
// here therefore has its shape fixed from outside — dispersion, coefficient of
// variation, zero-inflation — and only the mean is solved for.
//
// So the further the PrizePicks line sits from the book line, the more of the
// answer comes from the ASSUMED SHAPE and the less from the observed price. At
// the book's own line the fit reproduces the input exactly and the shape is
// irrelevant. Two steps out, it is most of what you are looking at.
//
// Two things follow, and both are implemented rather than merely noted:
//
//   1. Every result carries `shape_sensitivity` — the same book price refitted
//      under a different plausible family, evaluated at the same PrizePicks
//      line. That is not a confidence interval, but it IS a direct measure of
//      how much of the answer is assumption, and it is the number to look at
//      before believing a translated tail.
//
//   2. Translation is REFUSED past a configurable distance, and refusal returns
//      null with a reason. A silently wrong number is worse than no number,
//      because a wrong number gets bet and a missing one gets noticed.
// ===========================================================================

// ---------------------------------------------------------------------------
// Distributions
//
// All in log space where it matters. A Poisson pmf computed as
// exp(-l) * l^k / k! overflows k! at k≈170 and loses precision long before
// that; pitches-thrown lines run to 90+ and would hit it.

/** log(n!) via Lanczos, exact enough for everything here. */
function logGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
const logFact = (n) => logGamma(n + 1);

export function poissonPmf(k, lambda) {
  if (k < 0 || lambda <= 0) return k === 0 && lambda === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFact(k));
}

/** Negative binomial by mean and dispersion phi = variance/mean (> 1). */
export function negBinPmf(k, mean, phi) {
  if (k < 0 || mean <= 0) return 0;
  if (phi <= 1) return poissonPmf(k, mean);          // degenerate: Poisson
  const r = mean / (phi - 1);                         // var = mean + mean^2/r
  const p = r / (r + mean);
  return Math.exp(logGamma(k + r) - logGamma(r) - logFact(k) + k * Math.log(1 - p) + r * Math.log(p));
}

/** Zero-inflated Poisson: extra mass pi at zero, Poisson(lambda) otherwise. */
export function zipPmf(k, lambda, pi) {
  if (k === 0) return pi + (1 - pi) * poissonPmf(0, lambda);
  return (1 - pi) * poissonPmf(k, lambda);
}

/** Standard normal CDF, Abramowitz & Stegun 7.1.26 via erf. */
export function normalCdf(x, mu = 0, sd = 1) {
  const z = (x - mu) / (sd * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

// ---------------------------------------------------------------------------
// One interface over all four families
//
// Each returns { pmf(k), sf(k) = P(X >= k), mean, sd, continuous }.

function buildModel(family, mean, shape) {
  switch (family) {
    case 'poisson': {
      const pmf = (k) => poissonPmf(k, mean);
      return { pmf, sf: (k) => tailFromPmf(pmf, k), mean, sd: Math.sqrt(mean), continuous: false };
    }
    case 'negative_binomial': {
      const phi = shape.dispersion ?? 1.25;
      const pmf = (k) => negBinPmf(k, mean, phi);
      return { pmf, sf: (k) => tailFromPmf(pmf, k), mean, sd: Math.sqrt(mean * phi), continuous: false };
    }
    case 'zero_inflated_poisson': {
      const pi = shape.zero_inflation ?? 0.12;
      // `mean` is the OBSERVABLE mean; the Poisson component's lambda is higher,
      // since some of the observable mass is structural zeros.
      const lambda = mean / (1 - pi);
      const pmf = (k) => zipPmf(k, lambda, pi);
      // var = (1-pi)*lambda*(1 + pi*lambda)
      const varr = (1 - pi) * lambda * (1 + pi * lambda);
      return { pmf, sf: (k) => tailFromPmf(pmf, k), mean, sd: Math.sqrt(varr), continuous: false, lambda };
    }
    case 'discrete_normal': {
      const sd = shape.sd ?? (shape.cv ?? 0.32) * mean;
      return {
        pmf: (k) => normalCdf(k + 0.5, mean, sd) - normalCdf(k - 0.5, mean, sd),
        sf: (k) => 1 - normalCdf(k - 0.5, mean, sd),
        mean, sd, continuous: true,
      };
    }
    default:
      throw new Error(`unknown distribution family "${family}"`);
  }
}

/** P(X >= k) by summing the pmf below k. Cheap at these counts. */
function tailFromPmf(pmf, k) {
  if (k <= 0) return 1;
  let below = 0;
  for (let i = 0; i < k; i++) below += pmf(i);
  return Math.max(0, Math.min(1, 1 - below));
}

// ---------------------------------------------------------------------------
// Lines
//
// A half-point line cannot tie. A whole-number line can, and the two are
// handled differently on BOTH sides of the translation.

const isWhole = (line) => Number.isInteger(Number(line));

/**
 * The probabilities a line resolves to under a model.
 *
 * For a half-point line L: over = P(X >= ceil(L)), under = 1 - over, push = 0.
 * For a whole line L:      over = P(X >= L+1), under = P(X <= L-1), push = P(X = L).
 */
export function resolveLine(model, line, { continuous = false } = {}) {
  const L = Number(line);
  if (!isWhole(L)) {
    const over = model.sf(Math.ceil(L));
    return { over, under: 1 - over, push: 0 };
  }
  // Each family's own pmf already means the right thing at a whole line: a
  // point mass for the discrete families, and the mass in a one-unit window
  // for the discretized normal (see buildModel). So there is nothing to branch
  // on here — `continuous` is part of the signature because callers reason
  // about it, not because this line does.
  const push = model.pmf(L);
  const over = model.sf(L + 1);
  return { over, under: Math.max(0, 1 - over - push), push };
}

/**
 * What the BOOK's quoted no-vig probability actually means at its own line.
 *
 * On a half-point line it is P(over) and nothing else. On a WHOLE line the book
 * refunds a tie, so a two-way de-vigged price is P(over) / (P(over) + P(under))
 * — a probability CONDITIONAL ON NO PUSH, not P(over).
 *
 * Fitting a whole-number book line as if it were unconditional biases the fitted
 * mean, and the bias is largest exactly where the push probability is largest,
 * which is where the line sits near the mode. Getting this wrong is quiet: the
 * fit still converges and still reproduces "the" probability.
 */
function bookTarget(model, bookLine) {
  const r = resolveLine(model, bookLine, { continuous: model.continuous });
  if (!isWhole(Number(bookLine))) return r.over;
  const denom = r.over + r.under;
  return denom > 0 ? r.over / denom : r.over;
}

// ---------------------------------------------------------------------------
// Market -> model

/**
 * Market name -> model spec. EXACT normalized keys, never substring.
 *
 * This matched on `includes` for about ten minutes, and its own test caught
 * what that does: "Quarters With 5+ Rush Yards" contains "rush yards", so a
 * within-game period prop was silently handed a yardage distribution and
 * translated with total confidence. A wrong shape is precisely the
 * silently-wrong number this module exists to refuse — the same rule, for the
 * same reason, as marketFor() in odds-markets.js.
 */
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+]/g, '');

export function modelFor(market, config) {
  const key = normKey(market);
  if (!key) return null;
  for (const m of config?.markets || []) {
    if ((m.match || []).some((pattern) => normKey(pattern) === key)) return m;
  }
  return null;
}

// An alternative family for the same market, used only to measure how much of
// the answer is coming from the shape assumption. Deliberately a DIFFERENT
// shape rather than the same one re-parameterised: the point is disagreement.
const ALTERNATIVE = {
  poisson: { family: 'negative_binomial', dispersion: 1.25 },
  negative_binomial: { family: 'poisson' },
  zero_inflated_poisson: { family: 'poisson' },
  discrete_normal: { family: 'discrete_normal', cvScale: 1.35 },
};

// ---------------------------------------------------------------------------
// The fit

/**
 * Solve for the mean that reproduces `target` at `bookLine`, by bisection.
 *
 * P(over) is monotonically increasing in the mean for every family here, so
 * bisection is safe and needs no derivative. The upper bound is generous
 * because pitches-thrown means run to 100.
 */
function fitMean(family, shape, bookLine, target, { lo = 1e-6, hi = 1000, iters = 200 } = {}) {
  const at = (mean) => bookTarget(buildModel(family, mean, shape), bookLine);
  if (at(lo) > target || at(hi) < target) return null;      // unreachable
  let a = lo, b = hi;
  for (let i = 0; i < iters && b - a > 1e-12; i++) {
    const mid = (a + b) / 2;
    if (at(mid) < target) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

/**
 * Translate a book price at one line to PrizePicks' line.
 *
 * Returns { ok: false, reason } rather than a number whenever the answer would
 * rest more on the assumed shape than on the observed price.
 */
export function translate({
  market,
  bookLine,
  bookProb,
  ppLine,
  config = {},
  family: familyOverride = null,
  maxSigma = null,
  maxShapeDisagreement = null,
  tieRule = null,
}) {
  const refuse = (reason, extra = {}) => ({ ok: false, prob: null, reason, market, bookLine, ppLine, ...extra });

  const bl = Number(bookLine), pl = Number(ppLine), p = Number(bookProb);
  if (!isFinite(bl) || !isFinite(pl)) return refuse('book line and PrizePicks line must both be numbers');
  if (!(p > 0 && p < 1)) return refuse('book probability must be strictly between 0 and 1 — a 0 or a 1 pins the fit at a boundary and carries no information about shape');

  const spec = familyOverride
    ? { family: familyOverride, match: [], ...(typeof familyOverride === 'object' ? familyOverride : {}) }
    : modelFor(market, config);
  if (!spec) {
    return refuse(`no distribution is configured for market "${market}" — refusing rather than defaulting to a shape nobody chose`);
  }
  const family = typeof familyOverride === 'string' ? familyOverride : spec.family;

  const limitSigma = maxSigma ?? config?.defaults?.max_sigma ?? 2.0;
  const limitShape = maxShapeDisagreement ?? config?.defaults?.max_shape_disagreement ?? 0.06;
  const ties = tieRule ?? config?.defaults?.pp_tie_rule ?? 'push';

  // ---- fit ---------------------------------------------------------------
  const mean = fitMean(family, spec, bl, p);
  if (mean == null) {
    return refuse(`no ${family} mean reproduces P=${p.toFixed(4)} at line ${bl} — the price is outside what this family can express`);
  }
  const model = buildModel(family, mean, spec);

  // The fit must reproduce its own input. If it does not, nothing downstream is
  // trustworthy, and this is the one error that would otherwise be invisible.
  const reproduced = bookTarget(model, bl);
  if (Math.abs(reproduced - p) > 1e-6) {
    return refuse(`fit did not reproduce the book price (got ${reproduced.toFixed(6)}, wanted ${p.toFixed(6)})`);
  }

  // ---- distance ----------------------------------------------------------
  const sigmas = (pl - bl) / model.sd;
  if (Math.abs(sigmas) > limitSigma) {
    return refuse(
      `PrizePicks line ${pl} is ${Math.abs(sigmas).toFixed(2)} sd from the book line ${bl} (limit ${limitSigma}) — `
      + 'that far out the answer is the assumed distribution shape, not the market',
      { distribution: family, fitted_mean: mean, sd: model.sd, sigmas },
    );
  }

  // ---- read off ----------------------------------------------------------
  const raw = resolveLine(model, pl, { continuous: model.continuous });
  let over = raw.over, under = raw.under, push = raw.push;
  if (push > 0 && ties !== 'push') {
    // Some books grade a tie as a win for one side. PrizePicks refunds, which is
    // the default — but the rule is configurable because it is a property of the
    // operator, not of the maths.
    if (ties === 'over') { over += push; push = 0; }
    else if (ties === 'under') { under += push; push = 0; }
  }

  // ---- how much of this is the assumption? -------------------------------
  const alt = ALTERNATIVE[family];
  let sensitivity = null;
  if (alt) {
    const altSpec = alt.cvScale
      ? { ...spec, cv: (spec.cv ?? 0.32) * alt.cvScale, sd: spec.sd ? spec.sd * alt.cvScale : undefined }
      : { ...spec, ...alt };
    const altMean = fitMean(alt.family, altSpec, bl, p);
    if (altMean != null) {
      const altModel = buildModel(alt.family, altMean, altSpec);
      const altOver = resolveLine(altModel, pl, { continuous: altModel.continuous }).over;
      sensitivity = {
        alternative: alt.family === family ? `${family} (cv x${alt.cvScale})` : alt.family,
        alternative_prob: altOver,
        disagreement: Math.abs(altOver - raw.over),
      };
    }
  }

  if (sensitivity && sensitivity.disagreement > limitShape) {
    return refuse(
      `two plausible distributions fitted to the same book price disagree by `
      + `${(sensitivity.disagreement * 100).toFixed(1)} points at ${pl} (limit ${(limitShape * 100).toFixed(1)}) — `
      + 'the number would be a statement about the assumed shape rather than about the market',
      { distribution: family, fitted_mean: mean, sd: model.sd, sigmas, shape_sensitivity: sensitivity },
    );
  }

  return {
    ok: true,
    market,
    prob: { over, under, push },
    // What you would actually be betting on when a push refunds the stake: the
    // probability conditional on the bet resolving at all.
    prob_no_push: push > 0 ? { over: over / (over + under), under: under / (over + under) } : { over, under },
    // ---- diagnostics (requirement 4) -------------------------------------
    distribution: family,
    fitted_parameter: family === 'zero_inflated_poisson' ? model.lambda : mean,
    fitted_parameter_name: family === 'zero_inflated_poisson' ? 'lambda (Poisson component)' : 'mean',
    implied_mean: model.mean,
    sd: model.sd,
    shape_parameter: family === 'negative_binomial' ? { dispersion: spec.dispersion }
      : family === 'zero_inflated_poisson' ? { zero_inflation: spec.zero_inflation }
        : family === 'discrete_normal' ? { cv: spec.cv ?? null, sd: spec.sd ?? null }
          : null,
    book_line: bl,
    pp_line: pl,
    line_gap: pl - bl,
    sigmas,
    tie_rule: ties,
    pp_line_can_push: isWhole(pl),
    // Kept beside the answer so a reader can see the fit reproduced its input.
    book_prob: p,
    book_prob_reproduced: reproduced,
    shape_sensitivity: sensitivity,
    config_id: config?.id ?? null,
  };
}

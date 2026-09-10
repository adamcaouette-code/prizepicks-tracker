// netlify/functions/projection.js
//
// Per-market projection models for props the books do not price.
//
// Output is always a FULL DISTRIBUTION, never a projected number. A single
// number cannot answer "what is P(over 1.5)", which is the only question this
// app asks — and a projection reported as a point estimate invites exactly the
// false precision the rest of this codebase spends its time refusing.
//
// PURE. No imports, no I/O, no clock (`asOf` comes in). The config comes in as
// an argument — see projection-config.json, where every knob lives.
//
// ===========================================================================
// THE SHAPE OF THE MODEL
//
//   rate   = shrink( weighted recent rate , positional prior )   per unit exposure
//          x opponent factor
//          x home/away factor
//
//   count | exposure ~ Family( rate x exposure )
//   exposure         ~ Gamma( its own mean and sd )
//   count            = the compound of those two
//
// MODELLING THE RATE AND SCALING BY EXPOSURE IS THE WHOLE POINT. A raw
// per-game average conflates two different things: how often a player does
// something when he is on the pitch, and how long he is on the pitch. A striker
// averaging 0.8 shots on target per game because he plays 30 minutes is a
// different bet from one averaging 0.8 across full matches, and if he is about
// to start, only the rate model gets him right.
//
// COMPOUNDING IS NOT COSMETIC. A Poisson conditional on a random exposure is
// NOT Poisson — it is overdispersed, with the extra variance coming from not
// knowing how long he plays. Collapsing exposure to its mean would understate
// the spread of every projection, and understate it most for the bench players
// and short-outing pitchers where the exposure is least certain. That is the
// wrong direction: those are exactly the props where a confident-looking narrow
// distribution does the most damage.
// ===========================================================================

// ---------------------------------------------------------------------------
// Numerics (self-contained: this module imports nothing)

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

const poissonPmf = (k, lambda) => (lambda <= 0
  ? (k === 0 ? 1 : 0)
  : Math.exp(-lambda + k * Math.log(lambda) - logFact(k)));

function negBinPmf(k, mean, phi) {
  if (mean <= 0) return k === 0 ? 1 : 0;
  if (phi <= 1) return poissonPmf(k, mean);
  const r = mean / (phi - 1);
  const p = r / (r + mean);
  return Math.exp(logGamma(k + r) - logGamma(r) - logFact(k) + k * Math.log(1 - p) + r * Math.log(p));
}

const zipPmf = (k, lambda, pi) => (k === 0
  ? pi + (1 - pi) * poissonPmf(0, lambda)
  : (1 - pi) * poissonPmf(k, lambda));

/** Gamma density, for weighting the exposure grid. */
function gammaPdf(x, shape, scale) {
  if (x <= 0) return 0;
  return Math.exp((shape - 1) * Math.log(x) - x / scale - shape * Math.log(scale) - logGamma(shape));
}

// ---------------------------------------------------------------------------
// 1. The rate

/** 0.5^(age / halfLife). Weight on a game, by how old it is. */
export function recencyWeight(gameDate, asOf, halfLifeDays) {
  const ageMs = Date.parse(asOf) - Date.parse(gameDate);
  if (!isFinite(ageMs)) return 0;
  const ageDays = Math.max(0, ageMs / 86400000);
  if (!(halfLifeDays > 0)) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * The recency-weighted rate, and the effective sample behind it.
 *
 * sum(w*stat) / sum(w*exposure), NOT a weighted mean of per-game rates. The
 * difference is not subtle: averaging per-game rates gives a 12-minute cameo in
 * which he happened to take one shot the same standing as a full ninety, and
 * that single choice is most of what separates a rate model from a per-game
 * average with extra steps.
 */
export function weightedRate(rows, { statKey, exposureKey, halfLifeDays, asOf, maxLookbackDays = 400 }) {
  let events = 0, exposure = 0, weightSum = 0, used = 0;
  for (const g of rows || []) {
    const w = recencyWeight(g.date, asOf, halfLifeDays);
    const ageDays = (Date.parse(asOf) - Date.parse(g.date)) / 86400000;
    if (!(w > 0) || ageDays > maxLookbackDays) continue;
    const s = Number(g.stats?.[statKey]);
    const e = Number(g.exposure?.[exposureKey] ?? g.exposure?.value);
    if (!isFinite(s) || !isFinite(e) || e <= 0) continue;
    events += w * s;
    exposure += w * e;
    weightSum += w;
    used++;
  }
  return {
    events,
    exposure,
    rate: exposure > 0 ? events / exposure : null,
    // The sum of weights, not the row count. Ten games all a year old is an
    // effective sample of well under one, and the confidence flag has to know
    // that rather than seeing "10 games".
    effectiveGames: weightSum,
    rowsUsed: used,
  };
}

/**
 * Shrink an observed rate toward a prior, by prior exposure.
 *
 * posterior = (events + prior_rate * prior_exposure) / (exposure + prior_exposure)
 *
 * This is the Gamma-Poisson posterior mean, and expressing the prior's strength
 * in EXPOSURE UNITS is what makes the shrinkage scale with sample size on its
 * own. No separate weight parameter is needed — and adding one would let two
 * knobs disagree about the same thing.
 */
export function shrinkRate({ events, exposure, priorRate, priorExposure }) {
  const pe = Math.max(0, Number(priorExposure) || 0);
  const denom = exposure + pe;
  if (!(denom > 0)) return { rate: priorRate, shrinkage: 1 };
  return {
    rate: (events + priorRate * pe) / denom,
    // How much of the answer is the prior. 0 = all data, 1 = all prior.
    shrinkage: pe / denom,
  };
}

/** Opponent adjustment: (allowed / league average) ^ weight, clamped. */
export function opponentFactor(allowedRate, leagueRate, { weight = 0.5, clamp = [0.7, 1.4] } = {}) {
  if (!(allowedRate > 0) || !(leagueRate > 0)) return { factor: 1, applied: false, reason: 'no opponent rate available' };
  const raw = Math.pow(allowedRate / leagueRate, weight);
  const factor = Math.min(clamp[1], Math.max(clamp[0], raw));
  return { factor, applied: true, raw, clamped: factor !== raw };
}

// ---------------------------------------------------------------------------
// 2. Exposure, projected separately and with its own uncertainty

/**
 * Expected exposure and how uncertain it is.
 *
 * Its own half-life, longer than the rate's: role is stickier than form. A
 * player who has started six straight will probably start again; his shooting
 * rate genuinely moves week to week.
 *
 * The dispersion FLOOR is the important part. Six consecutive six-inning starts
 * do not make the seventh certain — an early hook, a rain delay, a blowout are
 * always live. Without a floor, an observed run of stability would be read as
 * knowledge and would produce a confidently narrow final distribution for
 * entirely the wrong reason.
 */
export function projectExposure(rows, { exposureKey, halfLifeDays, asOf, dispersionFloor = 0.2, minGames = 3 }) {
  const vals = [], ws = [];
  for (const g of rows || []) {
    const w = recencyWeight(g.date, asOf, halfLifeDays);
    const e = Number(g.exposure?.[exposureKey] ?? g.exposure?.value);
    if (!(w > 0) || !isFinite(e) || e < 0) continue;
    vals.push(e); ws.push(w);
  }
  if (!vals.length) return { mean: null, sd: null, cv: null, effectiveGames: 0, reason: 'no exposure history' };

  const W = ws.reduce((a, b) => a + b, 0);
  const mean = vals.reduce((s, v, i) => s + v * ws[i], 0) / W;
  // Weighted variance. Uses the plain weighted second moment rather than a
  // bias-corrected one: with decaying weights the "number of observations" is
  // not an integer and the correction would be arbitrary.
  const varr = vals.reduce((s, v, i) => s + ws[i] * (v - mean) ** 2, 0) / W;
  const observedSd = Math.sqrt(Math.max(0, varr));
  const floorSd = dispersionFloor * mean;
  const sd = Math.max(observedSd, floorSd);
  return {
    mean,
    sd,
    cv: mean > 0 ? sd / mean : null,
    observedSd,
    floorApplied: floorSd > observedSd,
    effectiveGames: W,
    thin: W < minGames,
  };
}

/**
 * A Gamma matched to (mean, sd), discretized for mixing.
 *
 * Gamma rather than normal because exposure is positive and right-skewed —
 * innings and minutes have a hard floor at zero and a soft ceiling, and a
 * normal would put real mass below zero for a bench player whose sd is a large
 * fraction of his mean.
 */
export function exposureGrid(mean, sd, nodes = 96) {
  if (!(mean > 0)) return [];
  if (!(sd > 0)) return [{ exposure: mean, weight: 1 }];
  const shape = (mean / sd) ** 2;
  const scale = (sd * sd) / mean;
  // The range matters more than the node count. Truncating at +6sd sounds
  // generous, but a Gamma is right-skewed and its upper tail is fatter than a
  // normal's — cutting there leaves ~3e-6 of mass outside the grid, and
  // renormalising that away pulls the mean down by more than the quadrature
  // error ever was. Widening to +10sd costs nothing and drops the residual by
  // three orders of magnitude; adding nodes inside a too-narrow range does not
  // help at all, which is how the truncation was found.
  const lo = Math.max(1e-9, mean - 10 * sd);
  const hi = mean + 10 * sd;
  const step = (hi - lo) / nodes;
  const grid = [];
  let total = 0;
  for (let i = 0; i < nodes; i++) {
    const x = lo + step * (i + 0.5);
    const w = gammaPdf(x, shape, scale) * step;
    if (w > 0) { grid.push({ exposure: x, weight: w }); total += w; }
  }
  // Renormalise: the truncated tails carry a little mass, and a grid that does
  // not sum to 1 silently rescales every probability downstream.
  return grid.map((g) => ({ ...g, weight: g.weight / total }));
}

// ---------------------------------------------------------------------------
// 3. The compound distribution

const conditionalPmf = (k, mean, family, shape) => {
  switch (family) {
    case 'negative_binomial': return negBinPmf(k, mean, shape?.dispersion ?? 1.25);
    case 'zero_inflated_poisson': {
      const pi = shape?.zero_inflation ?? 0.12;
      return zipPmf(k, mean / (1 - pi), pi);
    }
    default: return poissonPmf(k, mean);
  }
};

/**
 * P(count = k) for every k, mixing the conditional over the exposure grid.
 *
 *   P(X = k) = sum_j  w_j * P(X = k | exposure = e_j)
 *
 * The exposure uncertainty is what turns a Poisson conditional into an
 * overdispersed marginal, which is the realism the brief is asking for.
 * Verified against the closed form: Poisson mixed over a Gamma exposure is
 * exactly negative binomial, and the tests check this reproduces it.
 */
export function compoundPmf({ rate, exposureMean, exposureSd, family = 'poisson', shape = {}, nodes = 96, maxK = null }) {
  const grid = exposureGrid(exposureMean, exposureSd, nodes);
  if (!grid.length || !(rate >= 0)) return null;

  const mean = rate * exposureMean;
  const top = maxK ?? Math.max(8, Math.ceil(mean + 10 * Math.sqrt(Math.max(mean, 1)) + 10));
  const pmf = new Array(top + 1).fill(0);
  for (const node of grid) {
    const lam = rate * node.exposure;
    for (let k = 0; k <= top; k++) pmf[k] += node.weight * conditionalPmf(k, lam, family, shape);
  }
  const total = pmf.reduce((a, b) => a + b, 0);
  return total > 0 ? pmf.map((p) => p / total) : null;
}

/** Mean, variance and CDF of a PMF given as an array over 0..n. */
export function summarize(pmf) {
  let mean = 0, m2 = 0;
  const cdf = [];
  let run = 0;
  for (let k = 0; k < pmf.length; k++) {
    mean += k * pmf[k];
    m2 += k * k * pmf[k];
    run += pmf[k];
    cdf.push(run);
  }
  return { mean, variance: Math.max(0, m2 - mean * mean), sd: Math.sqrt(Math.max(0, m2 - mean * mean)), cdf };
}

/**
 * P(over / under / push) at a line, from a PMF.
 *
 * Same push rule as everywhere else in this codebase: a whole-number line can
 * tie and PrizePicks refunds it (settle() in grade-picks.js), a half-point line
 * cannot.
 */
export function probsAtLine(pmf, line) {
  const L = Number(line);
  const whole = Number.isInteger(L);
  let under = 0, push = 0, over = 0;
  for (let k = 0; k < pmf.length; k++) {
    if (whole && k === L) push += pmf[k];
    else if (k > L) over += pmf[k];
    else under += pmf[k];
  }
  return { over, under, push };
}

// ---------------------------------------------------------------------------
// 4. Putting it together

const get = (obj, path, dflt = undefined) => path.split('.')
  .reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? dflt;

/**
 * Project one player-market, end to end.
 *
 * Returns a full distribution plus every intermediate, because a projection
 * whose inputs cannot be inspected cannot be argued with — and this one has
 * enough knobs that "why is this number what it is" needs an answer.
 */
export function project({
  rows,
  league,
  statKey,
  exposureKey,
  position = null,
  asOf,
  isHome = null,
  opponentAllowedRate = null,
  leagueAverageRate = null,
  config = {},
  priorGroup = null,
  exposureOverride = null,
}) {
  const notes = [];
  const halfLife = get(config, 'recency.half_life_days', 30);
  const lookback = get(config, 'recency.max_lookback_days', 400);
  const group = priorGroup || league;

  // ---- rate ------------------------------------------------------------
  const observed = weightedRate(rows, { statKey, exposureKey, halfLifeDays: halfLife, asOf, maxLookbackDays: lookback });

  const priorSpec = get(config, `priors.${league}.${statKey}`, null);
  const priorRate = priorSpec
    ? (priorSpec[position] ?? priorSpec.default ?? null)
    : null;
  if (!priorSpec) notes.push(`no positional prior configured for ${league}.${statKey} — the observed rate is used unshrunk`);

  const priorExposure = get(config, `shrinkage.prior_exposure_units.${group}`, 0);
  const shrunk = priorRate != null
    ? shrinkRate({ events: observed.events, exposure: observed.exposure, priorRate, priorExposure })
    : { rate: observed.rate, shrinkage: 0 };

  if (shrunk.rate == null) {
    return { ok: false, reason: 'no usable game log rows — every row was missing the stat, the exposure, or a date', notes };
  }

  // ---- adjustments -------------------------------------------------------
  const opp = opponentFactor(opponentAllowedRate, leagueAverageRate, {
    weight: get(config, 'opponent.weight', 0.5),
    clamp: get(config, 'opponent.clamp', [0.7, 1.4]),
  });
  if (!opp.applied) notes.push(opp.reason);

  const homeFactor = isHome === null ? 1
    : isHome ? get(config, 'home_away.home_factor', 1.02) : get(config, 'home_away.away_factor', 0.98);
  if (isHome === null) notes.push('home/away unknown — no venue adjustment applied');

  const rate = shrunk.rate * opp.factor * homeFactor;

  // ---- exposure ----------------------------------------------------------
  //
  // An override is for the case where the upcoming game's role is KNOWN and the
  // history would say otherwise: a confirmed start for a player who has been
  // coming off the bench, or a bullpen day for a starter. History is the right
  // default precisely because that knowledge is usually absent, but when it
  // exists it beats an average of games played in a different role. It still
  // carries an sd — see soccer_minutes_from_appearance.sd in the config —
  // because a known role is not a known number of minutes, and the dispersion
  // floor applies to it exactly as it applies to a fitted exposure.
  const floor = get(config, `exposure.dispersion_floor.${group}`, 0.2);
  let exposure;
  if (exposureOverride && exposureOverride.mean > 0) {
    const mean = Number(exposureOverride.mean);
    const sd = Math.max(Number(exposureOverride.sd) || 0, floor * mean);
    exposure = {
      mean,
      sd,
      cv: sd / mean,
      observedSd: Number(exposureOverride.sd) || 0,
      floorApplied: floor * mean > (Number(exposureOverride.sd) || 0),
      overridden: true,
      source: exposureOverride.source || 'override',
    };
    notes.push(`exposure was supplied rather than fitted (${exposure.source})`);
  } else {
    exposure = projectExposure(rows, {
      exposureKey,
      halfLifeDays: get(config, 'exposure.half_life_days', 45),
      asOf,
      dispersionFloor: floor,
      minGames: get(config, 'exposure.min_games', 3),
    });
  }
  if (exposure.mean == null) {
    return { ok: false, reason: 'no exposure history — the rate cannot be scaled to a game', notes };
  }
  if (exposure.floorApplied) {
    notes.push('exposure sd was raised to the configured floor — observed history looked steadier than exposure ever really is');
  }

  // ---- distribution ------------------------------------------------------
  const family = get(config, `distribution.family_by_market.${statKey}`, 'poisson');
  const pmf = compoundPmf({
    rate,
    exposureMean: exposure.mean,
    exposureSd: exposure.sd,
    family,
    shape: get(config, `distribution.shape.${statKey}`, {}),
    nodes: get(config, 'distribution.quadrature_nodes', 96),
  });
  if (!pmf) return { ok: false, reason: 'the distribution could not be built from the fitted rate and exposure', notes };

  const stats = summarize(pmf);

  // ---- confidence --------------------------------------------------------
  // Per group: a fixed effective-games bar is not comparable across sports,
  // because the ceiling itself depends on how often the player plays. See
  // min_effective_games_note in the config.
  const gamesSpec = get(config, 'confidence.min_effective_games', 5);
  const minGames = typeof gamesSpec === 'object' && gamesSpec !== null
    ? (gamesSpec[group] ?? gamesSpec.default ?? 5)
    : gamesSpec;
  const minExposure = get(config, `confidence.min_effective_exposure.${group}`, 0);
  const reasons = [];
  if (observed.effectiveGames < minGames) {
    reasons.push(`effective sample is ${observed.effectiveGames.toFixed(1)} games against a ${minGames} minimum (recency-weighted, so old games count for little)`);
  }
  if (observed.exposure < minExposure) {
    reasons.push(`weighted exposure is ${observed.exposure.toFixed(1)} against a ${minExposure} minimum`);
  }
  if (shrunk.shrinkage > 0.5) {
    reasons.push(`${(shrunk.shrinkage * 100).toFixed(0)}% of the rate is the positional prior rather than this player`);
  }

  return {
    ok: true,
    league,
    statKey,
    // ---- the distribution (requirement 5) --------------------------------
    pmf,
    cdf: stats.cdf,
    mean: stats.mean,
    variance: stats.variance,
    sd: stats.sd,
    // ---- how it was built -------------------------------------------------
    rate,
    rate_components: {
      observed_rate: observed.rate,
      prior_rate: priorRate,
      shrunk_rate: shrunk.rate,
      shrinkage: shrunk.shrinkage,
      opponent_factor: opp.factor,
      home_factor: homeFactor,
    },
    exposure,
    family,
    sample: {
      rows_used: observed.rowsUsed,
      effective_games: observed.effectiveGames,
      weighted_exposure: observed.exposure,
      weighted_events: observed.events,
    },
    // A FLAG, not a suppression: a thin projection is still worth seeing beside
    // a book price, so long as nothing downstream can mistake it for a firm one.
    low_confidence: reasons.length > 0,
    confidence_reasons: reasons,
    notes,
    config_id: config?.id ?? null,
    // The compound is the point: a Poisson conditional on a RANDOM exposure is
    // overdispersed, and this is how much. 1.0 would mean the exposure
    // uncertainty contributed nothing.
    overdispersion: stats.mean > 0 ? stats.variance / stats.mean : null,
  };
}

// ---------------------------------------------------------------------------
// 5. Blending with the book

/**
 * Linear pool of the model's probability and the book's, at one line.
 *
 * DEFAULT HEAVILY TOWARD THE BOOK, and that default is right: a market price
 * aggregates injury news, lineup leaks, weather and the opinions of everyone
 * willing to stake money on being correct. This model sees a game log and a
 * dozen knobs set from convention.
 *
 * BOTH COMPONENTS ARE RETURNED UNBLENDED. That is the whole reason this is
 * worth doing: with the two logged separately against the same outcome, the
 * weight can eventually be replaced by a measurement instead of a belief. A
 * blend that discarded its inputs would make that impossible forever.
 *
 * A linear pool, not a logarithmic one. Linear keeps the result between the two
 * inputs and stays interpretable as "80% the book's view"; log pooling is
 * sharper and would push the blend outside the pair when they agree, which is
 * not a claim this evidence supports.
 */
export function blendWithBook({ modelProb, bookProb, config = {}, lowConfidence = false, bookWeight = null }) {
  const configured = bookWeight ?? get(config, 'book_blend.book_weight', 0.8);
  const lowConfFloor = get(config, 'book_blend.min_book_weight_when_low_confidence', 0.92);
  const w = lowConfidence ? Math.max(configured, lowConfFloor) : configured;

  if (bookProb == null && modelProb == null) {
    return { blended: null, reason: 'neither a book price nor a model projection is available' };
  }
  // A market the books do not price at all is the case this whole module exists
  // for, so the model stands alone there rather than being suppressed.
  if (bookProb == null) {
    return {
      blended: modelProb, book_weight_used: 0, model_prob: modelProb, book_prob: null,
      source: 'model only — no book prices this market',
      low_confidence: lowConfidence,
    };
  }
  if (modelProb == null) {
    return { blended: bookProb, book_weight_used: 1, model_prob: null, book_prob: bookProb, source: 'book only — no model projection' };
  }
  return {
    blended: w * bookProb + (1 - w) * modelProb,
    book_weight_used: w,
    book_weight_configured: configured,
    raised_for_low_confidence: w > configured,
    // Logged unblended, deliberately — see above.
    model_prob: modelProb,
    book_prob: bookProb,
    disagreement: Math.abs(modelProb - bookProb),
    source: 'blend',
    low_confidence: lowConfidence,
  };
}

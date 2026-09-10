// netlify/functions/correlation.js
//
// Estimating the correlation structure between legs, from ESPN game logs.
//
// ===========================================================================
// THE ESTIMATE IS NOT THE PARAMETER
//
// What comes out of a game log is the correlation between two COUNTS. What the
// copula needs is the correlation between the LATENT NORMALS underneath them.
// Those are not the same number, and the gap is not small: two Bernoulli(0.5)
// variables with a latent correlation of 0.5 show an observed correlation of
//
//   2 * asin(0.5) / pi = 1/3
//
// Feeding 1/3 into the copula as if it were the latent parameter understates
// the dependence by a third — and on a Power Play, which pays only for going
// perfect, understating dependence understates the price of the whole slip.
//
// So the observed correlation is INVERTED to the latent one exactly: given the
// two marginals, the map rho -> implied observed correlation is a finite sum of
// bivariate normal probabilities (see impliedPearson), it is strictly
// increasing, and it is inverted by bisection. No approximation, no
// small-correlation expansion, no assuming the counts are normal.
//
// ---------------------------------------------------------------------------
// FOUR RELATIONSHIPS, BECAUSE THEY HAVE DIFFERENT SIGNS
//
//   same_player          a pitcher's strikeouts and his outs recorded. Strongly
//                        positive: both are driven by how long he lasts.
//   same_team            two forwards on one side. Positive through team
//                        attacking volume, negative through the two of them
//                        competing for the same chances — and which dominates
//                        is a question for the data, not for me.
//   opposing_player      pace and game script. A blowout suppresses one side's
//                        volume and inflates the other's.
//   same_game_total      the common factor. Both legs load on how much football
//                        or baseball actually happened.
//
// Estimating these separately matters because averaging them would cancel
// effects with genuinely opposite signs into a mush near zero, which would look
// exactly like "no correlation" while hiding two strong ones.
//
// PURE. Rows in, table out. Fetching is the caller's job (game-logs.js).
// ===========================================================================

import { bvnCdf, normInv, normCdf } from './copula.js';

// ---------------------------------------------------------------------------
// 1. Sample statistics

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;   // a constant column has no correlation
  return sxy / Math.sqrt(sxx * syy);
}

/** Ranks with ties averaged — the standard midrank, which counts games. */
export function ranks(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

export const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

// ---------------------------------------------------------------------------
// 2. Observed -> latent, exactly

/** The empirical PMF of a column of counts, as an array over 0..max. */
export function empiricalPmf(values) {
  const use = values.filter((v) => isFinite(v) && v >= 0);
  if (!use.length) return null;
  const max = Math.max(...use.map((v) => Math.round(v)));
  const pmf = new Array(max + 1).fill(0);
  for (const v of use) pmf[Math.round(v)] += 1 / use.length;
  return pmf;
}

const cdfOf = (pmf) => {
  const c = new Array(pmf.length);
  let run = 0;
  for (let i = 0; i < pmf.length; i++) { run += pmf[i]; c[i] = Math.min(1, run); }
  return c;
};

const momentsOf = (pmf) => {
  let m = 0, m2 = 0;
  for (let k = 0; k < pmf.length; k++) { m += k * pmf[k]; m2 += k * k * pmf[k]; }
  return { mean: m, sd: Math.sqrt(Math.max(0, m2 - m * m)) };
};

/**
 * The Pearson correlation two count variables WOULD show, if their dependence
 * came from a Gaussian copula with parameter rho.
 *
 * Exact, by the tail-sum identity for non-negative integers:
 *
 *   E[XY] = sum_{j>=1} sum_{k>=1} P(X >= j, Y >= k)
 *
 * and under the copula, P(X >= j, Y >= k) = P(Z1 > a_j, Z2 > b_k)
 *                                         = 1 - Phi(a_j) - Phi(b_k) + Phi2(a_j, b_k; rho)
 * with a_j = Phi^-1(F_X(j-1)). A finite sum of exactly-computed terms — no
 * simulation anywhere in the inversion.
 */
export function impliedPearson(pmfX, pmfY, rho) {
  const Fx = cdfOf(pmfX), Fy = cdfOf(pmfY);
  const mx = momentsOf(pmfX), my = momentsOf(pmfY);
  if (!(mx.sd > 0) || !(my.sd > 0)) return null;
  const a = [], b = [];
  for (let j = 1; j < pmfX.length; j++) a.push(normInv(Fx[j - 1]));
  for (let k = 1; k < pmfY.length; k++) b.push(normInv(Fy[k - 1]));
  let exy = 0;
  for (let j = 0; j < a.length; j++) {
    const pa = normCdf(a[j]);
    for (let k = 0; k < b.length; k++) {
      exy += 1 - pa - normCdf(b[k]) + bvnCdf(a[j], b[k], rho);
    }
  }
  return (exy - mx.mean * my.mean) / (mx.sd * my.sd);
}

/**
 * Invert it: the latent rho whose copula reproduces the observed correlation.
 *
 * impliedPearson is strictly increasing in rho, so bisection is exact and
 * cannot land on the wrong root. Bounded at the FEASIBLE range rather than at
 * [-1, 1]: with discrete marginals the attainable correlation stops short of
 * +-1 (two counts with different supports simply cannot be comonotone at
 * correlation 1), and a target outside it is reported as clipped rather than
 * being silently mapped to +-0.999.
 */
export function latentRho(pmfX, pmfY, target, { tol = 1e-12, maxIter = 200 } = {}) {
  if (target == null || !isFinite(target)) return { rho: null, reason: 'no observed correlation' };
  const hi = impliedPearson(pmfX, pmfY, 1 - 1e-9);
  const lo = impliedPearson(pmfX, pmfY, -1 + 1e-9);
  if (hi == null || lo == null) return { rho: null, reason: 'a marginal has no variance' };
  if (target >= hi) return { rho: 1 - 1e-9, clipped: true, attainable: [lo, hi], reason: 'observed correlation is at or above what these marginals can attain' };
  if (target <= lo) return { rho: -1 + 1e-9, clipped: true, attainable: [lo, hi], reason: 'observed correlation is at or below what these marginals can attain' };

  let a = -1 + 1e-9, b = 1 - 1e-9;
  for (let i = 0; i < maxIter; i++) {
    const m = (a + b) / 2;
    const v = impliedPearson(pmfX, pmfY, m);
    if (v < target) a = m; else b = m;
    if (b - a < tol) break;
  }
  return { rho: (a + b) / 2, clipped: false, attainable: [lo, hi] };
}

// ---------------------------------------------------------------------------
// 3. Shrinkage toward zero — requirement 5

export const fisherZ = (r) => 0.5 * Math.log((1 + r) / (1 - r));
export const invFisherZ = (z) => Math.tanh(z);

/**
 * Shrink an estimate toward independence, by how much of it is signal.
 *
 * On Fisher's z, an estimate from n pairs has variance 1/(n-3) exactly. Put a
 * normal prior centred at ZERO with standard deviation `priorSd` on the true z,
 * and the posterior mean is
 *
 *   z_hat * tau^2 / (tau^2 + 1/(n-3))
 *
 * which is a plain signal-to-noise weight. The prior is centred at zero because
 * that is the honest default: absent evidence, the right correlation to use is
 * the one the old code assumed. But unlike the old code, the moment evidence
 * arrives the estimate moves — and it moves proportionally to how much evidence
 * there is, with no separate "confidence" knob to disagree with the arithmetic.
 *
 * Nine games of overlap between two players is common and gives a weight of
 * about 0.5 at the default prior: half the estimate, half zero. That is the
 * right amount of scepticism, and it is arithmetic rather than a judgement call.
 */
export function shrink(rho, n, { priorSd = 0.35 } = {}) {
  if (rho == null || !isFinite(rho) || !(n > 3)) {
    return { rho: 0, weight: 0, n: n || 0, reason: n > 0 ? `only ${n} paired observations` : 'no paired observations' };
  }
  const r = Math.max(-0.999999, Math.min(0.999999, rho));
  const tau2 = priorSd * priorSd;
  const varZ = 1 / (n - 3);
  const weight = tau2 / (tau2 + varZ);
  const z = fisherZ(r) * weight;
  return {
    rho: invFisherZ(z),
    raw: rho,
    weight,
    n,
    // The 95% interval on the RAW estimate, so "shrunk to nearly zero" can be
    // told apart from "measured to be nearly zero".
    ci: n > 3
      ? [invFisherZ(fisherZ(r) - 1.96 * Math.sqrt(varZ)), invFisherZ(fisherZ(r) + 1.96 * Math.sqrt(varZ))]
      : null,
  };
}

/**
 * Shrinkage for a LATENT correlation, with the sampling variance carried
 * through the inversion by the delta method.
 *
 * ===========================================================================
 * WHY THE PLAIN FISHER-Z VARIANCE IS WRONG HERE, AND DANGEROUSLY SO
 *
 * shrink() above assumes the estimate's variance is 1/(n-3), which is the
 * textbook result for a Pearson correlation. But the number being shrunk is not
 * the observed correlation — it is the LATENT one recovered by inverting a
 * discrete copula, and that inversion has a slope.
 *
 * When both marginals are sparse the slope is brutal. Triples happen in about
 * 2% of games, and two such counts can only ever show an observed correlation
 * inside roughly +-0.1 however tightly their latent normals are tied. So an
 * observed -0.089 inverts to a latent -0.95 — arithmetically correct, and
 * completely unidentified: one different game moves it across half the range.
 * Measured on three real MLB logs, that put SIX pairs above |0.9| off observed
 * correlations smaller than 0.10, and the plain 1/(n-3) weight happily kept
 * them at n=129 because it never looked at the slope.
 *
 *   var(observed) ~ (1 - r^2)^2 / (n - 1)                 Pearson, asymptotic
 *   d z_latent / d observed = 1/(1 - rho^2) * 1/slope     chain rule
 *   var(z_latent) = var(observed) / (slope^2 * (1 - rho^2)^2)
 *
 * where slope = d(implied observed) / d(rho) at the estimate. For ordinary
 * marginals slope is near 1 and this collapses to the familiar 1/(n-1); for
 * sparse ones it explodes and the weight goes to zero on its own. No threshold,
 * no special case — the arithmetic does what two hand-tuned guards could not.
 */
export function shrinkLatent({ observed, latent, n, pmfX, pmfY, priorSd = 0.35, h = 1e-4 }) {
  if (latent == null || !isFinite(latent) || !(n > 3)) {
    return { rho: 0, weight: 0, n: n || 0, reason: 'not enough paired observations' };
  }
  const r = Math.max(-0.999999, Math.min(0.999999, latent));
  const a = Math.max(-1 + 1e-9, r - h), b = Math.min(1 - 1e-9, r + h);
  const fa = impliedPearson(pmfX, pmfY, a), fb = impliedPearson(pmfX, pmfY, b);
  const slope = (fa == null || fb == null) ? 1 : (fb - fa) / (b - a);

  const varObs = ((1 - observed * observed) ** 2) / Math.max(1, n - 1);
  const jac = 1 / Math.max(1e-12, Math.abs(slope) * (1 - r * r));
  // FLOORED AT THE PLAIN FISHER-Z VARIANCE, and the floor is not cosmetic.
  //
  // The asymptotic Pearson variance (1-r^2)^2/(n-1) goes to ZERO as |r| -> 1,
  // so a perfectly collinear sample — six games where one stat is exactly twice
  // another — came out with no sampling variance and therefore no shrinkage at
  // all, at any n. Six games showing r = 1.000 is not proof of anything.
  //
  // The floor says: carrying an estimate through the inversion can only make it
  // LESS identified than a directly observed correlation on the same sample,
  // never more. That is true by construction, and it is the right bound.
  const varZ = Math.max(varObs * jac * jac, 1 / Math.max(1, n - 3));

  const tau2 = priorSd * priorSd;
  const weight = tau2 / (tau2 + varZ);
  return {
    rho: invFisherZ(fisherZ(r) * weight),
    raw: latent,
    weight,
    n,
    // Surfaced because it is the whole story on a sparse pair: an inversion
    // slope of 0.05 means a 0.01 move in the data is a 0.2 move in the answer.
    inversionSlope: slope,
    latentVarianceZ: varZ,
    // The effective sample size this variance corresponds to, which is the
    // number to read when the raw n looks reassuring and the weight does not.
    effectiveN: 1 / varZ + 1,
  };
}

// ---------------------------------------------------------------------------
// 4. Estimating from game logs

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Market pairs are unordered — correlation is symmetric. */
export const pairKey = (relationship, a, b) => {
  const [x, y] = [norm(a), norm(b)].sort();
  return `${relationship}|${x}|${y}`;
};

export const RELATIONSHIPS = ['same_player', 'same_team', 'opposing_player', 'same_game_total'];

/**
 * Is this column a COUNT? Only counts can be given an empirical PMF.
 *
 * ESPN's game logs mix counts with RATE stats in the same row — a hitter's log
 * carries atBats and hits beside avg, onBasePct, slugAvg and OPS. Rounding a
 * batting average of 0.271 to build a PMF collapses the whole column to zeros,
 * which either destroys the marginal outright or leaves a near-degenerate
 * Bernoulli whose attainable correlation range is a slit. Measured live on
 * three MLB logs, that produced sixteen pairs with no latent estimate at all
 * and eight more pinned at exactly +-1.000 from observed correlations as small
 * as 0.02.
 *
 * A rate stat is not a prop market anyway — nobody posts a line on OPS — so
 * they are excluded by name in the table's `skipped` list rather than silently
 * dropped, so the gap is visible.
 */
export function isCountColumn(values) {
  const use = values.filter((v) => isFinite(v));
  if (use.length < 3) return false;
  return use.every((v) => v >= 0 && Math.abs(v - Math.round(v)) < 1e-9);
}

/** Two aligned series of one stat each, over the games both rows cover. */
function alignOn(rowsA, rowsB, statA, statB) {
  const byEvent = new Map();
  for (const r of rowsB) if (r.eventId) byEvent.set(String(r.eventId), r);
  const xs = [], ys = [];
  for (const r of rowsA) {
    const other = byEvent.get(String(r.eventId));
    if (!other) continue;
    const x = Number(r.stats?.[statA]), y = Number(other.stats?.[statB]);
    if (!isFinite(x) || !isFinite(y)) continue;
    xs.push(x); ys.push(y);
  }
  return { xs, ys };
}

/**
 * Estimate every pair this set of logs can support.
 *
 * `logs` are what game-logs.js returns, each carrying `rows`, `team`, `league`
 * and the player's identity. Nothing is fetched here.
 *
 * EVERY ESTIMATE CARRIES ITS SAMPLE SIZE, and the sample size is the number of
 * GAMES BOTH PLAYERS APPEARED IN — not the number of games either played. Two
 * strikers who overlapped in four matches give a four-game estimate however
 * long each of their logs is, and reporting the longer number would be the
 * single easiest way to make a guess look like a measurement.
 */
export function estimateFromLogs(logs, { markets = null, config = {} } = {}) {
  const minN = config?.min_pairs ?? 5;
  const priorSd = config?.prior_sd_fisher_z ?? 0.35;
  const table = {};

  const skipped = {};
  const minAttainable = config?.min_attainable_correlation ?? 0.5;
  const maxAbs = config?.max_abs_latent ?? 0.95;

  const record = (relationship, ma, mb, xs, ys, extra = {}) => {
    if (xs.length < minN) return;
    // A rate column has no PMF worth building — see isCountColumn.
    if (!isCountColumn(xs)) { skipped[ma] = 'not a count column'; return; }
    if (!isCountColumn(ys)) { skipped[mb] = 'not a count column'; return; }
    const observed = pearson(xs, ys);
    if (observed == null) return;
    const pmfX = empiricalPmf(xs), pmfY = empiricalPmf(ys);
    if (!pmfX || !pmfY) return;
    const latent = latentRho(pmfX, pmfY, observed);
    if (latent.rho == null) return;

    // TOO SPARSE TO IDENTIFY ANYTHING — and the test has to look at the side
    // the estimate actually clipped on.
    //
    // The attainable range is ASYMMETRIC for sparse counts. Hit-by-pitch and
    // stolen bases can reach +0.6 together but only -0.05 apart, because two
    // variables that are nearly always zero are nearly always zero TOGETHER.
    // An observed -0.09 then falls outside the floor and bisection returns the
    // boundary — putting near-perfect NEGATIVE dependence in the matrix on the
    // strength of an observed -0.09. Taking max(|lo|, |hi|) let the healthy
    // ceiling vouch for the unusable floor, which is how that survived the
    // first version of this guard.
    const [lo, hi] = latent.attainable || [0, 0];
    if (latent.clipped) {
      const bound = observed >= hi ? Math.abs(hi) : Math.abs(lo);
      if (bound < minAttainable) {
        skipped[`${ma}|${mb}`] = `marginals too sparse in that direction — a Gaussian copula on them `
          + `cannot reach past ${(observed >= hi ? hi : lo).toFixed(2)}, and the observed `
          + `${observed.toFixed(3)} is outside it`;
        return;
      }
    }

    // Capped, even when the clip was legitimate. Earned runs and runs allowed
    // really do move together at an observed 0.989, and the inversion puts that
    // at the +1 boundary — but a 1.0 in a correlation matrix makes it singular
    // and asserts the two legs are the same bet. 0.95 keeps the strength and
    // leaves the matrix invertible.
    const capped = Math.max(-maxAbs, Math.min(maxAbs, latent.rho));
    const shrunk = shrinkLatent({ observed, latent: capped, n: xs.length, pmfX, pmfY, priorSd });
    const key = pairKey(relationship, ma, mb);
    const prev = table[key];
    // Pool by taking the LARGER sample rather than averaging: two estimates on
    // different player pairs are not exchangeable, and averaging a 40-game
    // estimate with a 5-game one would let the noisy one move the answer.
    if (prev && prev.n >= xs.length) { prev.pairsSeen = (prev.pairsSeen || 1) + 1; return; }
    table[key] = {
      relationship,
      markets: [ma, mb].sort(),
      observed,
      spearman: spearman(xs, ys),
      latent: capped,
      latentRaw: latent.rho,
      latentClipped: !!latent.clipped,
      attainable: latent.attainable ?? null,
      rho: shrunk.rho,
      shrinkWeight: shrunk.weight,
      inversionSlope: shrunk.inversionSlope,
      effectiveN: shrunk.effectiveN,
      ci: shrink(observed, xs.length, { priorSd }).ci,
      n: xs.length,
      pairsSeen: (prev?.pairsSeen || 0) + 1,
      ...extra,
    };
  };

  const wanted = markets ? new Set(markets.map(norm)) : null;
  const statsIn = (rows) => {
    const set = new Set();
    for (const r of rows) for (const k of Object.keys(r.stats || {})) if (!wanted || wanted.has(norm(k))) set.add(k);
    return [...set];
  };

  // ---- same player, different market -------------------------------------
  for (const log of logs) {
    const cols = statsIn(log.rows || []);
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        const { xs, ys } = alignOn(log.rows, log.rows, cols[i], cols[j]);
        record('same_player', cols[i], cols[j], xs, ys, { example: log.player || log.athleteId });
      }
    }
    // ---- the common factor: this player's stat against the game's total ----
    for (const c of cols) {
      const xs = [], ys = [];
      for (const r of log.rows || []) {
        const x = Number(r.stats?.[c]), y = Number(r.gameTotal);
        if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); }
      }
      record('same_game_total', c, '__game_total__', xs, ys, { example: log.player || log.athleteId });
    }
  }

  // ---- across players in the same game -----------------------------------
  for (let a = 0; a < logs.length; a++) {
    for (let b = a + 1; b < logs.length; b++) {
      const A = logs[a], B = logs[b];
      const sameTeam = A.team && B.team && norm(A.team) === norm(B.team);
      // Only pairs that actually shared games say anything, and which
      // relationship it is depends on which side they were on.
      const rel = sameTeam ? 'same_team' : 'opposing_player';
      const colsA = statsIn(A.rows || []), colsB = statsIn(B.rows || []);
      for (const ca of colsA) {
        for (const cb of colsB) {
          const { xs, ys } = alignOn(A.rows, B.rows, ca, cb);
          record(rel, ca, cb, xs, ys, { example: `${A.player || A.athleteId} / ${B.player || B.athleteId}` });
        }
      }
    }
  }

  return {
    schema: 1,
    generated_from: logs.length,
    prior_sd_fisher_z: priorSd,
    min_pairs: minN,
    // Named rather than silently absent: "we did not measure OPS because it is
    // not a count" and "we measured it and found nothing" are different facts.
    skipped,
    pairs: table,
  };
}

// ---------------------------------------------------------------------------
// 5. Using the table

/** Which relationship two legs stand in. */
export function relationshipOf(a, b) {
  const samePlayer = a.player && b.player && norm(a.player) === norm(b.player);
  if (samePlayer) return 'same_player';
  const sameGame = a.eventId && b.eventId && String(a.eventId) === String(b.eventId);
  if (!sameGame) return null;                       // different games: no relationship modelled
  if (a.team && b.team && norm(a.team) === norm(b.team)) return 'same_team';
  return 'opposing_player';
}

/**
 * The latent correlation between two legs, and where the number came from.
 *
 * THREE SOURCES, IN ORDER, and every result says which it used:
 *
 *   direct    a pair estimate for exactly this relationship and market pair.
 *   factor    no direct estimate, but both markets have a measured loading on
 *             the game total. Under a one-factor model the induced correlation
 *             is the PRODUCT of the loadings — a real structural claim, not a
 *             fudge, and it is the only thing that can price a market pair that
 *             has never been observed together.
 *   none      zero, stated as such.
 *
 * The factor fallback is deliberately not applied to `same_player`: two markets
 * on one player share far more than the game total (how long he was on the
 * field, most of all), so a game-total product would understate them badly, and
 * understating is not the safe direction on a Power Play.
 */
export function correlationFor(legA, legB, table, { config = {} } = {}) {
  const rel = relationshipOf(legA, legB);
  if (!rel) return { rho: 0, source: 'none', reason: 'legs are in different games', n: 0 };

  const direct = table?.pairs?.[pairKey(rel, legA.market, legB.market)];
  if (direct) {
    return {
      rho: direct.rho, source: 'direct', relationship: rel, n: direct.n,
      raw: direct.observed, latent: direct.latent, shrinkWeight: direct.shrinkWeight, ci: direct.ci,
    };
  }

  if (rel !== 'same_player' && (config?.use_game_total_factor ?? true)) {
    const la = table?.pairs?.[pairKey('same_game_total', legA.market, '__game_total__')];
    const lb = table?.pairs?.[pairKey('same_game_total', legB.market, '__game_total__')];
    if (la && lb) {
      // Opposing players load on the total with the same sign but compete for
      // the same possessions; the sign flip is the game-script effect and is a
      // configured structural assumption, not an estimate.
      const flip = rel === 'opposing_player' ? (config?.opposing_factor_sign ?? -1) : 1;
      const rho = flip * la.rho * lb.rho;
      return {
        rho, source: 'factor', relationship: rel,
        n: Math.min(la.n, lb.n),
        loadings: [la.rho, lb.rho],
        shrinkWeight: Math.min(la.shrinkWeight, lb.shrinkWeight),
        reason: 'no direct pair estimate — induced through the game-total factor',
      };
    }
  }

  return {
    rho: 0, source: 'none', relationship: rel, n: 0,
    reason: `nothing observed for ${rel} between "${legA.market}" and "${legB.market}" — shrunk fully to independence`,
  };
}

/**
 * The full matrix for a slip, with provenance for every off-diagonal entry.
 *
 * The provenance is not bookkeeping. A 6-leg slip has 15 pairs, and a matrix
 * where 14 of them are zero-by-default and one is a 5-game estimate should not
 * read the same as one built from fifteen 200-game estimates. `confidence`
 * below is what stops it from doing so.
 */
export function buildMatrix(legs, table, { config = {} } = {}) {
  const n = legs.length;
  const R = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const provenance = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = correlationFor(legs[i], legs[j], table, { config });
      R[i][j] = c.rho; R[j][i] = c.rho;
      provenance.push({ i, j, ...c });
    }
  }
  return { R, provenance, confidence: confidenceOf(provenance, config) };
}

/**
 * How much the correlation structure of this slip is actually known.
 *
 * Three things degrade it, and they are different failures:
 *   - pairs with NO estimate at all, which are being priced as independent;
 *   - pairs whose estimate was shrunk hard because the sample was thin;
 *   - pairs carried by the game-total factor rather than measured directly.
 *
 * Reported as a level AND as the counts behind it, because "medium" on its own
 * is the kind of label that stops being read.
 */
export function confidenceOf(provenance, config = {}) {
  const total = provenance.length;
  if (!total) return { level: 'n/a', reason: 'a single-leg slip has no correlation structure', pairs: 0 };
  const direct = provenance.filter((p) => p.source === 'direct');
  const factor = provenance.filter((p) => p.source === 'factor');
  const none = provenance.filter((p) => p.source === 'none');
  const meanWeight = provenance.reduce((s, p) => s + (p.shrinkWeight ?? 0), 0) / total;
  const minN = Math.min(...provenance.map((p) => p.n ?? 0));

  const t = config?.confidence ?? {};
  const highDirect = t.high_direct_share ?? 0.8;
  const highWeight = t.high_shrink_weight ?? 0.7;
  const lowDirect = t.low_direct_share ?? 0.3;

  const directShare = direct.length / total;
  let level;
  if (directShare >= highDirect && meanWeight >= highWeight) level = 'high';
  else if (directShare >= lowDirect || factor.length) level = 'medium';
  else level = 'low';

  return {
    level,
    pairs: total,
    directPairs: direct.length,
    factorPairs: factor.length,
    unestimatedPairs: none.length,
    meanShrinkWeight: meanWeight,
    minPairSample: isFinite(minN) ? minN : 0,
    reason: level === 'low'
      ? `${none.length} of ${total} leg pairs have no estimate at all and are priced as independent`
      : level === 'medium'
        ? `${direct.length} of ${total} pairs measured directly, ${factor.length} through the game-total factor`
        : `${direct.length} of ${total} pairs measured directly, mean shrinkage weight ${meanWeight.toFixed(2)}`,
  };
}

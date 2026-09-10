// netlify/functions/copula.js
//
// Gaussian copula: the numerics under correlation-aware slip pricing.
//
// ===========================================================================
// WHY NAIVE MULTIPLICATION IS WRONG, AND BY HOW MUCH
//
// Every EV in this app has been computed as if legs were independent. Three
// coin-flip legs go perfect 1/8 of the time — if they are independent. Put them
// at a modest pairwise correlation of 0.5 and the answer is 1/4. EXACTLY DOUBLE,
// and that is not a rounding error on a Power Play, which pays only for going
// perfect. It is the difference between a slip that is priced and one that is
// guessed at.
//
// The direction matters as much as the size. On a POWER play, positive
// correlation HELPS: it concentrates mass at the top of the correct-count
// distribution, which is the only place Power pays. On a FLEX play it HURTS:
// Flex is paid out of the middle of that distribution, and correlation is
// exactly what drains the middle. Independence understates Power and overstates
// Flex, always, and by more the more correlated the legs are.
//
// ---------------------------------------------------------------------------
// THE CONSTRUCTION
//
//   Z ~ MVN(0, R)          latent normals carrying the dependence
//   U_i = Phi(Z_i)         uniforms, by the probability integral transform
//   X_i = F_i^-1(U_i)      the leg's ACTUAL marginal, inverted
//
// The marginals are untouched — that is the point of a copula. Each leg keeps
// whatever distribution tasks 04, 05 and 06 gave it (a de-vigged book price, a
// translated alt-line, a compound negative binomial), and R supplies only the
// dependence between them. Nothing here is a normal approximation to a leg.
//
// Because F^-1 is monotone in u, "X_i beats the line" is an upper set in u, so
// each leg reduces EXACTLY to a pair of thresholds on its own uniform. That is
// not a simplification of the marginal — it is what the marginal implies — and
// it is what makes the whole thing both fast and exact. A whole-number line
// gets a MIDDLE band for the push, which a normal approximation would smear
// away.
//
// PURE. No imports, no I/O, no clock, no Math.random — the generator is seeded
// and passed in, so a price is reproducible.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. The normal distribution, to full double precision

/** Abramowitz-Stegun 7.1.26 is not good enough here; this is Cody's erfc. */
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5,
    -2.0278578112534e-5, -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8,
    -8.5238095915e-8, 6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15];
  let d = 0, dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

export const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/**
 * The inverse normal CDF. Acklam's rational approximation (~1.15e-9) followed
 * by one Halley step against normCdf, which takes it to full double precision.
 *
 * The refinement is not decoration: normInv is applied to every leg's threshold
 * and then fed to a bivariate normal integral, so an error of 1e-9 in the
 * argument is an error of ~4e-10 in a probability that is then compared against
 * hand-computed constants at 1e-12.
 */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

// ---------------------------------------------------------------------------
// 2. The bivariate normal CDF — exact, and the anchor for everything else

// Gauss-Legendre nodes on [-1, 1], computed rather than tabulated so the order
// is a knob and the values cannot be mistyped.
function gaussLegendre(n) {
  const x = new Array(n), w = new Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5));
    let pp = 0;
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 0; j < n; j++) {
        const p3 = p2; p2 = p1;
        p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1);
      }
      pp = n * (z * p1 - p2) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x[i] = -z; w[i] = 2 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
}
const GL = gaussLegendre(64);

/**
 * P(Z1 <= h, Z2 <= k) for a standard bivariate normal with correlation rho.
 *
 * Uses the exact identity
 *
 *   d/drho Phi2(h, k; rho) = phi2(h, k; rho)
 *     => Phi2(h, k; rho) = Phi(h)Phi(k) + integral_0^rho phi2(h, k; t) dt
 *
 * integrated by 64-point Gauss-Legendre. The integrand is analytic on the open
 * interval, so this is spectrally accurate — verified against the two closed
 * forms that exist: Phi2(0, 0; rho) = 1/4 + asin(rho)/(2*pi), and Phi2 at rho=0
 * factorising into the product of marginals.
 *
 * This function is the anchor of the whole module. The correlated correct-count
 * distribution is estimated by simulation, but for two legs it has an exact
 * answer, and the tests check the simulation against THIS rather than against
 * another simulation.
 */
export function bvnCdf(h, k, rho) {
  const r = Math.max(-1, Math.min(1, Number(rho)));
  if (h === -Infinity || k === -Infinity) return 0;
  if (h === Infinity) return normCdf(k);
  if (k === Infinity) return normCdf(h);
  if (r === 0) return normCdf(h) * normCdf(k);
  // At |rho| = 1 the pair is comonotone (or countermonotone) and the integral
  // above is improper. Both have exact answers, so take them rather than
  // integrating up to a singularity.
  if (r >= 1) return Math.min(normCdf(h), normCdf(k));
  if (r <= -1) return Math.max(0, normCdf(h) + normCdf(k) - 1);

  const half = r / 2;
  let sum = 0;
  for (let i = 0; i < GL.x.length; i++) {
    const t = half * (GL.x[i] + 1);
    const om = 1 - t * t;
    sum += GL.w[i] * Math.exp(-(h * h - 2 * t * h * k + k * k) / (2 * om)) / Math.sqrt(om);
  }
  return normCdf(h) * normCdf(k) + (half * sum) / (2 * Math.PI);
}

/**
 * P(both legs win) for two legs, EXACTLY.
 *
 * With "leg i wins when Z_i <= z_i" and z_i = Phi^-1(p_i), this is just
 * Phi2(z1, z2; rho). At p1 = p2 = 0.5 it collapses to 1/4 + asin(rho)/(2*pi),
 * which is where the hand-checkable constants in the tests come from:
 *
 *   rho = 0.5      -> 1/4 + (pi/6)/(2pi)  = 1/4 + 1/12 = 1/3
 *   rho = -0.5     -> 1/4 - 1/12          = 1/6
 *   rho = sqrt3/2  -> 1/4 + (pi/3)/(2pi)  = 1/4 + 1/6  = 5/12
 */
export function pairWinProb(p1, p2, rho) {
  return bvnCdf(normInv(p1), normInv(p2), rho);
}

/**
 * P(all three win) for an equicorrelated triple, EXACTLY, at p = 0.5 each.
 *
 * The trivariate orthant probability has a closed form:
 *   P = 1/8 + (asin(r12) + asin(r13) + asin(r23)) / (4*pi)
 * At r = 0.5 that is 1/8 + 3*(pi/6)/(4pi) = 1/8 + 1/8 = 1/4 — twice the
 * independent 1/8. Exported because it is the strongest available check on the
 * three-leg simulation, and because it IS the headline of this module.
 */
export function tripleWinProbAtHalf(r12, r13, r23) {
  return 1 / 8 + (Math.asin(r12) + Math.asin(r13) + Math.asin(r23)) / (4 * Math.PI);
}

// ---------------------------------------------------------------------------
// 3. Matrices

/** Symmetric eigendecomposition by cyclic Jacobi. Small n, exact enough. */
export function jacobiEigen(A, { maxSweeps = 100, tol = 1e-14 } = {}) {
  const n = A.length;
  const a = A.map((row) => row.slice());
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (Math.sqrt(2 * off) < tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let i = 0; i < n; i++) {
          const aip = a[i][p], aiq = a[i][q];
          a[i][p] = c * aip - s * aiq;
          a[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p][i], aqi = a[q][i];
          a[p][i] = c * api - s * aqi;
          a[q][i] = s * api + c * aqi;
          const vip = v[i][p], viq = v[i][q];
          v[i][p] = c * vip - s * viq;
          v[i][q] = s * vip + c * viq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

/**
 * The nearest valid correlation matrix, by eigenvalue clipping.
 *
 * THIS IS NOT OPTIONAL. The matrix is assembled from PAIRWISE estimates, each
 * fitted on whatever games happened to have both players in them — so nothing
 * makes the result positive semi-definite. A matrix with a negative eigenvalue
 * has no Cholesky factor, and a sampler built on one either crashes or, worse,
 * silently produces draws whose correlation is not the matrix it was given.
 *
 * Clip the negative eigenvalues to a small floor, rebuild, and rescale the
 * diagonal back to 1. `adjusted` records that it happened and by how much, so a
 * slip priced off a repaired matrix says so rather than presenting the repair
 * as a measurement.
 */
export function nearestCorrelation(R, { floor = 1e-8 } = {}) {
  const n = R.length;
  const { values, vectors } = jacobiEigen(R);
  const minEig = Math.min(...values);
  if (minEig >= floor) return { matrix: R.map((r) => r.slice()), adjusted: false, minEigenvalue: minEig };

  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    const lam = Math.max(values[k], floor);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) out[i][j] += lam * vectors[i][k] * vectors[j][k];
    }
  }
  // Rescale to unit diagonal — clipping changes the variances, and a "correlation
  // matrix" whose diagonal is 0.97 would silently shrink every marginal.
  const d = out.map((row, i) => Math.sqrt(row[i]));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i][j] /= (d[i] * d[j]);
    out[i][i] = 1;
  }
  return { matrix: out, adjusted: true, minEigenvalue: minEig };
}

/** Cholesky, repairing the matrix first if it is not positive definite. */
export function cholesky(R) {
  const fixed = nearestCorrelation(R);
  const A = fixed.matrix;
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][j] = Math.sqrt(Math.max(s, 1e-14));
      else L[i][j] = s / L[j][j];
    }
  }
  return { L, adjusted: fixed.adjusted, minEigenvalue: fixed.minEigenvalue };
}

// ---------------------------------------------------------------------------
// 4. Randomness, seeded

/** splitmix64-flavoured 32-bit PRNG. Seeded, so a price is reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, returning one standard normal per call from a cached pair. */
export function normalSampler(random) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do {
      u = 2 * random() - 1;
      v = 2 * random() - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * f;
    return u * f;
  };
}

// ---------------------------------------------------------------------------
// 5. Legs

/**
 * A leg reduced to three bands on its own uniform.
 *
 * From a FULL MARGINAL (a PMF plus a line), because that is what tasks 05 and
 * 06 produce. Since F^-1 is monotone, "the stat beats the line" is an upper set
 * in u, so the marginal collapses to thresholds EXACTLY — no approximation is
 * being made, and in particular the push band on a whole-number line survives
 * intact instead of being smeared by a continuous approximation.
 *
 *   u in [0, loU)      the stat lands under the line
 *   u in [loU, hiU)    the stat lands ON a whole-number line: PUSH
 *   u in [hiU, 1]      the stat lands over the line
 */
export function legFromPmf({ pmf, line, side = 'over' }) {
  const L = Number(line);
  const whole = Number.isInteger(L);
  let under = 0, push = 0;
  for (let k = 0; k < pmf.length; k++) {
    if (whole && k === L) push += pmf[k];
    else if (k < L) under += pmf[k];
  }
  const total = pmf.reduce((s, p) => s + p, 0) || 1;
  return legFromProbs({
    over: 1 - (under + push) / total,
    under: under / total,
    push: push / total,
    side,
  });
}

/** A leg from probabilities that are already known (tasks 04 and 05). */
export function legFromProbs({ over, under, push = 0, side = 'over' }) {
  const o = Number(over) || 0;
  const p = Number(push) || 0;
  const u = under != null ? Number(under) : Math.max(0, 1 - o - p);
  const isUnder = String(side).toLowerCase() === 'under';
  return {
    side: isUnder ? 'under' : 'over',
    pWin: isUnder ? u : o,
    pPush: p,
    pLose: isUnder ? o : u,
    // The bands are always stated in terms of the UNDER->PUSH->OVER ordering of
    // the underlying stat, and the side only decides which end counts as a win.
    // Writing them the other way for an under would break the monotone link
    // between the uniform and the stat, which is the one property the whole
    // copula rests on.
    loU: u,
    hiU: u + p,
  };
}

/** win | push | lose for one leg at one uniform draw. */
export function outcomeAt(leg, u) {
  if (u < leg.loU) return leg.side === 'under' ? 'win' : 'lose';
  if (u < leg.hiU) return 'push';
  return leg.side === 'under' ? 'lose' : 'win';
}

// ---------------------------------------------------------------------------
// 6. The simulation

/**
 * The joint distribution of (pushes, correct) over a slip, under the copula.
 *
 * Returns a matrix `joint[pushes][correct]`, because a push is not a loss — it
 * voids the leg and the slip is re-priced at a smaller size. Collapsing pushes
 * into either bucket would misprice every whole-number line in the book, and
 * the payout tables are step functions, so the error does not average out.
 *
 * When no leg can push, row 0 is the whole distribution and it is directly
 * comparable to correctCountDistribution() in payout-engine.js — which is
 * exactly what the tests check at rho = 0.
 */
export function simulateSlip({ legs, R, paths = 100000, seed = 20260910 }) {
  const n = legs.length;
  if (!n) return null;
  const { L, adjusted, minEigenvalue } = cholesky(R || identity(n));
  const random = rng(seed);
  const randn = normalSampler(random);

  const joint = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  const z = new Array(n);
  const g = new Array(n);

  for (let t = 0; t < paths; t++) {
    for (let i = 0; i < n; i++) g[i] = randn();
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j <= i; j++) s += L[i][j] * g[j];
      z[i] = s;
    }
    let correct = 0, pushes = 0;
    for (let i = 0; i < n; i++) {
      const o = outcomeAt(legs[i], normCdf(z[i]));
      if (o === 'win') correct++;
      else if (o === 'push') pushes++;
    }
    joint[pushes][correct]++;
  }

  for (let p = 0; p <= n; p++) for (let c = 0; c <= n; c++) joint[p][c] /= paths;

  // The marginal over correct-count ignoring pushes, for the common case where
  // nothing can push and this is the whole answer.
  const correctOnly = new Array(n + 1).fill(0);
  for (let p = 0; p <= n; p++) for (let c = 0; c <= n; c++) correctOnly[c] += joint[p][c];

  return {
    joint,
    correctCount: correctOnly,
    paths,
    seed,
    // Monte Carlo standard error on the headline number, so nobody reads the
    // fourth decimal of a simulated probability as if it were measured.
    seAllCorrect: Math.sqrt(Math.max(0, correctOnly[n] * (1 - correctOnly[n])) / paths),
    matrixAdjusted: adjusted,
    minEigenvalue,
    anyPush: legs.some((l) => l.pPush > 0),
  };
}

export function identity(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

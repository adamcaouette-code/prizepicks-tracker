// The Gaussian copula — checked against closed forms, not against itself.
//
// ===========================================================================
// THE HAND-COMPUTABLE ANSWERS
//
// Two standard normals with correlation rho, both truncated at their median:
//
//   P(Z1 <= 0, Z2 <= 0) = 1/4 + asin(rho) / (2*pi)
//
// which is exact and gives round numbers at the obvious angles:
//
//   rho = 0         1/4 + 0        = 1/4      (independence)
//   rho = 1/2       1/4 + (pi/6)/(2pi) = 1/4 + 1/12 = 1/3
//   rho = -1/2      1/4 - 1/12     = 1/6
//   rho = sqrt2/2   1/4 + (pi/4)/(2pi) = 1/4 + 1/8  = 3/8
//   rho = sqrt3/2   1/4 + (pi/3)/(2pi) = 1/4 + 1/6  = 5/12
//
// For THREE equicorrelated coin flips the orthant probability is
//
//   P(all three) = 1/8 + 3*asin(rho) / (4*pi)
//
// and at rho = 1/2 that is 1/8 + 1/8 = 1/4 — EXACTLY DOUBLE the independent
// 1/8. That single number is the whole argument for this module: a three-leg
// Power play built from correlated coin flips goes perfect twice as often as
// naive multiplication says.
//
// The full correct-count distribution in that case is uniform — 1/4, 1/4, 1/4,
// 1/4 — against the binomial's 1/8, 3/8, 3/8, 1/8, and every one of those eight
// numbers is derived below by inclusion-exclusion from the two closed forms
// above. Nothing in this file was produced by running the code.
// ===========================================================================

import * as C from '../../netlify/functions/copula.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const leg = (p, side = 'over') => C.legFromProbs({ over: side === 'over' ? p : 1 - p, under: side === 'over' ? 1 - p : p, push: 0, side });

export default async function ({ t }) {
  // =========================================================================
  // 1. The normal distribution, to full precision
  // =========================================================================
  // 1e-15, not 1e-16: erfc here is a rational approximation good to a few ULP,
  // and 0.5 comes back as 0.5000000000000008. Asserting exact equality would be
  // asserting something about the approximation nobody needs and nothing uses.
  t.ok('Phi(0) is 1/2 to within a few ULP', near(C.normCdf(0), 0.5, 1e-15), String(C.normCdf(0)));
  t.ok('Phi(1) = 0.8413447460685429', near(C.normCdf(1), 0.8413447460685429, 1e-15), String(C.normCdf(1)));
  t.ok('Phi(-1.96) = 0.0249978951482', near(C.normCdf(-1.96), 0.024997895148220435, 1e-15), String(C.normCdf(-1.96)));
  // normInv feeds every threshold in the module, and its error propagates
  // straight into a bivariate integral that the tests then check at 1e-12.
  const worst = [1e-9, 1e-4, 0.01, 0.25, 0.5, 0.75, 0.99, 1 - 1e-9]
    .reduce((m, p) => Math.max(m, Math.abs(C.normCdf(C.normInv(p)) - p) / p), 0);
  t.ok('normInv inverts normCdf to full double precision', worst < 1e-14, `worst relative error ${worst.toExponential(2)}`);

  // =========================================================================
  // 2. THE BIVARIATE NORMAL — against the closed form at every nice angle
  // =========================================================================
  for (const [label, rho, want] of [
    ['0', 0, 1 / 4],
    ['1/2', 0.5, 1 / 3],
    ['-1/2', -0.5, 1 / 6],
    ['sqrt2/2', Math.SQRT1_2, 3 / 8],
    ['sqrt3/2', Math.sqrt(3) / 2, 5 / 12],
  ]) {
    const got = C.bvnCdf(0, 0, rho);
    t.ok(`Phi2(0,0;${label}) = ${want.toFixed(6)}`, near(got, want, 1e-13), `${got.toFixed(15)} (err ${Math.abs(got - want).toExponential(2)})`);
  }
  // The general identity, at arbitrary rho — not just the pretty angles.
  const anyRho = 0.37;
  t.ok('...and at an arbitrary rho too',
    near(C.bvnCdf(0, 0, anyRho), 0.25 + Math.asin(anyRho) / (2 * Math.PI), 1e-13), '');

  t.ok('at rho = 0 it factorises into the product of the marginals',
    near(C.bvnCdf(0.7, -0.3, 0), C.normCdf(0.7) * C.normCdf(-0.3), 1e-15), '');
  t.ok('at rho = 1 it is the minimum of the marginals (comonotone)',
    near(C.bvnCdf(0.7, -0.3, 1), Math.min(C.normCdf(0.7), C.normCdf(-0.3)), 1e-15), '');
  t.ok('at rho = -1 it is the Frechet lower bound',
    near(C.bvnCdf(0.7, -0.3, -1), Math.max(0, C.normCdf(0.7) + C.normCdf(-0.3) - 1), 1e-15), '');
  t.ok('it is symmetric in its two arguments',
    near(C.bvnCdf(1.2, -0.4, 0.6), C.bvnCdf(-0.4, 1.2, 0.6), 1e-15), '');
  // Monotone in rho — the property the latent inversion in correlation.js relies
  // on to bisect without landing on a wrong root.
  let mono = true;
  for (let r = -0.95; r < 0.95; r += 0.05) if (C.bvnCdf(0.3, -0.6, r + 0.05) <= C.bvnCdf(0.3, -0.6, r)) mono = false;
  t.ok('it is strictly increasing in rho, which is what makes the inversion safe', mono, '');

  // =========================================================================
  // 3. TWO LEGS — the simulation against the exact answer
  //
  // 100k paths at p = 1/3 has a standard error of sqrt(1/3 * 2/3 / 1e5) =
  // 0.00149, so a 4-sigma band is 0.006. The assertion is on THAT, not on a
  // loose eyeball tolerance: a tolerance wide enough to pass a broken sampler
  // proves nothing.
  // =========================================================================
  const exactPair = C.pairWinProb(0.5, 0.5, 0.5);
  t.ok('the exact two-leg answer at rho=1/2 is 1/3', near(exactPair, 1 / 3, 1e-13), exactPair.toFixed(15));

  const twoLeg = C.simulateSlip({ legs: [leg(0.5), leg(0.5)], R: [[1, 0.5], [0.5, 1]], paths: 100000, seed: 7 });
  t.ok('...and the simulation lands on it within 4 Monte Carlo sigma',
    Math.abs(twoLeg.correctCount[2] - 1 / 3) < 4 * twoLeg.seAllCorrect,
    `${twoLeg.correctCount[2].toFixed(5)} vs 0.33333, se ${twoLeg.seAllCorrect.toFixed(5)}`);
  t.ok('...which is a long way above the naive 0.25',
    twoLeg.correctCount[2] > 0.31, String(twoLeg.correctCount[2]));

  const twoNeg = C.simulateSlip({ legs: [leg(0.5), leg(0.5)], R: [[1, -0.5], [-0.5, 1]], paths: 100000, seed: 7 });
  t.ok('negative correlation lands on the exact 1/6',
    Math.abs(twoNeg.correctCount[2] - 1 / 6) < 4 * twoNeg.seAllCorrect, twoNeg.correctCount[2].toFixed(5));

  // Unequal marginals, where there is no symmetry to hide behind.
  const uneq = C.simulateSlip({ legs: [leg(0.7), leg(0.4)], R: [[1, 0.3], [0.3, 1]], paths: 200000, seed: 11 });
  t.ok('with unequal marginals it still matches Phi2 exactly',
    Math.abs(uneq.correctCount[2] - C.pairWinProb(0.7, 0.4, 0.3)) < 4 * uneq.seAllCorrect,
    `${uneq.correctCount[2].toFixed(5)} vs ${C.pairWinProb(0.7, 0.4, 0.3).toFixed(5)}`);

  // AN UNDER IS NOT A RELABELLED OVER. The uniform must stay tied to the
  // underlying stat, so that two overs correlate positively and an over against
  // an under correlates negatively — at the SAME matrix.
  const bothOver = C.simulateSlip({ legs: [leg(0.5), leg(0.5)], R: [[1, 0.5], [0.5, 1]], paths: 100000, seed: 3 });
  const overUnder = C.simulateSlip({ legs: [leg(0.5), leg(0.5, 'under')], R: [[1, 0.5], [0.5, 1]], paths: 100000, seed: 3 });
  t.ok('two overs on positively correlated stats hit together more often than chance',
    bothOver.correctCount[2] > 0.31, String(bothOver.correctCount[2]));
  t.ok('an over and an UNDER on the same correlated stats hit together LESS often',
    overUnder.correctCount[2] < 0.19, String(overUnder.correctCount[2]));
  t.ok('...and that is the exact 1/6, because the side flips the sign of the pair',
    Math.abs(overUnder.correctCount[2] - 1 / 6) < 4 * overUnder.seAllCorrect, overUnder.correctCount[2].toFixed(5));

  // =========================================================================
  // 4. THREE LEGS — the headline
  //
  //   P(all 3)     = 1/8 + 3*asin(1/2)/(4pi) = 1/8 + 1/8 = 1/4
  //   P(a pair)    = 1/4 + asin(1/2)/(2pi)   = 1/3
  //   P(exactly 3) = 1/4
  //   P(exactly 2) = sum over pairs of [P(pair) - P(all)] = 3*(1/3 - 1/4) = 1/4
  //   P(exactly 1) = sum P(A_i) - 2*sum P(A_iA_j) + 3*P(all)
  //                = 3*(1/2) - 2*(1) + 3*(1/4) = 1.5 - 2 + 0.75 = 1/4
  //   P(exactly 0) = 1 - 3/4 = 1/4
  //
  // UNIFORM. Against the binomial's 1/8, 3/8, 3/8, 1/8. Every number above is
  // arithmetic on the two closed forms, and none of it came from the code.
  // =========================================================================
  t.ok('the exact three-leg orthant at rho=1/2 is 1/4', near(C.tripleWinProbAtHalf(0.5, 0.5, 0.5), 0.25, 1e-15),
    String(C.tripleWinProbAtHalf(0.5, 0.5, 0.5)));
  t.ok('...which is EXACTLY DOUBLE the independent 1/8', near(C.tripleWinProbAtHalf(0.5, 0.5, 0.5), 2 * 0.125, 1e-15), '');

  const R3 = [[1, 0.5, 0.5], [0.5, 1, 0.5], [0.5, 0.5, 1]];
  const three = C.simulateSlip({ legs: [leg(0.5), leg(0.5), leg(0.5)], R: R3, paths: 400000, seed: 5 });
  const se3 = Math.sqrt(0.25 * 0.75 / 400000);
  for (let k = 0; k <= 3; k++) {
    t.ok(`P(exactly ${k} of 3) is 1/4, not the binomial's ${k === 0 || k === 3 ? '1/8' : '3/8'}`,
      Math.abs(three.correctCount[k] - 0.25) < 4 * se3,
      `${three.correctCount[k].toFixed(5)} (4 sigma = ${(4 * se3).toFixed(5)})`);
  }

  // Independence must reproduce the binomial exactly — the check that the
  // machinery adds nothing when there is nothing to add.
  const indep = C.simulateSlip({ legs: [leg(0.5), leg(0.5), leg(0.5)], R: C.identity(3), paths: 400000, seed: 5 });
  t.ok('at rho = 0 the simulation reproduces the binomial 1/8, 3/8, 3/8, 1/8',
    [0.125, 0.375, 0.375, 0.125].every((w, k) => Math.abs(indep.correctCount[k] - w) < 4 * se3),
    indep.correctCount.map((v) => v.toFixed(4)).join(' '));

  // Unequal legs under independence: the Poisson-binomial, not a binomial on
  // the mean. 0.9 x 0.5 = 0.45, and a binomial at the mean 0.7 would say 0.49.
  const pb = C.simulateSlip({ legs: [leg(0.9), leg(0.5)], R: C.identity(2), paths: 200000, seed: 9 });
  t.ok('independent legs at 0.9 and 0.5 go 2-for-2 exactly 45% of the time',
    Math.abs(pb.correctCount[2] - 0.45) < 0.006, String(pb.correctCount[2]));
  t.ok('...NOT the 0.49 a binomial on the mean would give', Math.abs(pb.correctCount[2] - 0.49) > 0.03, '');

  // =========================================================================
  // 5. Pushes — a whole line has a middle band, and it survives
  //
  // A PMF over 0..4 with mass 0.35 exactly ON a line of 2 must produce a leg
  // with pPush = 0.35, and the simulation must reproduce it. A normal
  // approximation to the marginal would smear that mass across the line and
  // lose the push entirely, which is why the copula uses the real marginal.
  // =========================================================================
  const pmf = [0.10, 0.20, 0.35, 0.25, 0.10];
  const whole = C.legFromPmf({ pmf, line: 2, side: 'over' });
  t.ok('mass exactly on a whole line is a PUSH, not a loss', near(whole.pPush, 0.35), String(whole.pPush));
  t.ok('...the under band is 0.10 + 0.20 = 0.30', near(whole.pLose, 0.30), String(whole.pLose));
  t.ok('...and the over band is 0.25 + 0.10 = 0.35', near(whole.pWin, 0.35), String(whole.pWin));
  const half = C.legFromPmf({ pmf, line: 2.5, side: 'over' });
  t.ok('a half-point line cannot push', half.pPush === 0, '');
  t.ok('...and its over is 0.25 + 0.10 = 0.35', near(half.pWin, 0.35), String(half.pWin));

  const pushSim = C.simulateSlip({ legs: [whole, whole], R: [[1, 0.4], [0.4, 1]], paths: 200000, seed: 13 });
  t.ok('the simulation knows a push happened', pushSim.anyPush === true, '');
  const pushMass = 1 - pushSim.joint[0].reduce((s, v) => s + v, 0);
  //   P(at least one of two pushes) = 1 - P(neither). Under the copula the two
  //   push bands are correlated, so this is NOT 1 - 0.65^2 = 0.5775 — it is
  //   higher, because correlated legs push together.
  t.ok('...on both legs sometimes, and the joint matrix records how often',
    pushSim.joint[2][0] + pushSim.joint[2][1] + pushSim.joint[2][2] > 0.10, String(pushSim.joint[2].reduce((s, v) => s + v, 0)));
  t.ok('the push mass is a real fraction of the slip', pushMass > 0.5 && pushMass < 0.7, String(pushMass));
  const rowsSum = pushSim.joint.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  t.ok('the joint distribution sums to 1', near(rowsSum, 1, 1e-12), String(rowsSum));

  // An under's bands mirror the over's, with the SAME push in the middle.
  const wholeUnder = C.legFromPmf({ pmf, line: 2, side: 'under' });
  t.ok('an under on a whole line pushes on exactly the same mass', near(wholeUnder.pPush, 0.35), '');
  t.ok('...and wins where the over loses', near(wholeUnder.pWin, whole.pLose), '');
  t.ok('...while the uniform bands are unchanged, keeping the copula monotone',
    wholeUnder.loU === whole.loU && wholeUnder.hiU === whole.hiU, '');

  // =========================================================================
  // 6. MATRIX REPAIR — a pairwise-assembled matrix need not be valid
  //
  // Three legs each correlated 0.9 with the other two is fine. Two legs at +0.9
  // to a third but -0.9 to each other is NOT: it asserts that A and B are both
  // nearly C and nearly opposite each other. Such a matrix has a negative
  // eigenvalue and no Cholesky factor, and every pairwise-estimated matrix is
  // at risk of it because nothing in the estimation enforces consistency.
  // =========================================================================
  const bad = [[1, -0.9, 0.9], [-0.9, 1, 0.9], [0.9, 0.9, 1]];
  const { values } = C.jacobiEigen(bad);
  t.ok('the inconsistent matrix really does have a negative eigenvalue',
    Math.min(...values) < -0.1, `min eigenvalue ${Math.min(...values).toFixed(4)}`);
  const fixed = C.nearestCorrelation(bad);
  t.ok('nearestCorrelation reports that it had to repair it', fixed.adjusted === true, '');
  t.ok('...and the repaired matrix is positive semi-definite',
    Math.min(...C.jacobiEigen(fixed.matrix).values) > -1e-9,
    String(Math.min(...C.jacobiEigen(fixed.matrix).values)));
  t.ok('...with a unit diagonal, so no marginal is silently shrunk',
    fixed.matrix.every((row, i) => near(row[i], 1, 1e-12)), '');
  t.ok('...and it stays symmetric',
    fixed.matrix.every((row, i) => row.every((v, j) => near(v, fixed.matrix[j][i], 1e-12))), '');
  t.ok('a valid matrix is passed through untouched', C.nearestCorrelation(R3).adjusted === false, '');
  t.ok('the simulation says when it priced off a repaired matrix',
    C.simulateSlip({ legs: [leg(0.5), leg(0.5), leg(0.5)], R: bad, paths: 1000 }).matrixAdjusted === true, '');

  // Cholesky reproduces the matrix it factored.
  const { L } = C.cholesky(R3);
  let reproduced = true;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k <= Math.min(i, j); k++) s += L[i][k] * L[j][k];
      if (!near(s, R3[i][j], 1e-12)) reproduced = false;
    }
  }
  t.ok('L L^T reproduces the correlation matrix', reproduced, '');

  // =========================================================================
  // 7. Reproducibility — a price must not move for reasons unrelated to the slip
  // =========================================================================
  const a1 = C.simulateSlip({ legs: [leg(0.6), leg(0.55)], R: [[1, 0.3], [0.3, 1]], paths: 20000, seed: 42 });
  const a2 = C.simulateSlip({ legs: [leg(0.6), leg(0.55)], R: [[1, 0.3], [0.3, 1]], paths: 20000, seed: 42 });
  t.eq('the same seed gives the identical distribution', a1.correctCount, a2.correctCount);
  const a3 = C.simulateSlip({ legs: [leg(0.6), leg(0.55)], R: [[1, 0.3], [0.3, 1]], paths: 20000, seed: 43 });
  t.ok('...and a different seed does not', a3.correctCount[2] !== a1.correctCount[2], '');
  // Matched on the CALL, not the name: the module's own header says it uses no
  // Math.random, and the first version of this assertion failed on that comment.
  t.ok('nothing here calls Math.random — a price must be reproducible', !/Math\.random\s*\(/.test(
    await (await import('node:fs/promises')).readFile('netlify/functions/copula.js', 'utf8')), '');
}

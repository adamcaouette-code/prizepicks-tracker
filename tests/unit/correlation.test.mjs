// Estimating the correlation structure — and the step that is easiest to skip.
//
// ===========================================================================
// THE OBSERVED CORRELATION IS NOT THE COPULA PARAMETER
//
// For two Bernoulli(1/2) variables driven by a Gaussian copula with parameter
// rho, the OBSERVED Pearson correlation is exactly
//
//   r = 2 * asin(rho) / pi                       (the tetrachoric relation)
//
// derived in two lines: E[XY] = P(both) = 1/4 + asin(rho)/(2pi), each mean is
// 1/2 and each sd is 1/2, so r = (E[XY] - 1/4) / (1/4) = 2*asin(rho)/pi.
//
//   rho = 1/2  ->  r = 2*(pi/6)/pi = 1/3
//   rho = 1/sqrt2 -> r = 2*(pi/4)/pi = 1/2
//   rho = sqrt3/2 -> r = 2*(pi/3)/pi = 2/3
//
// Feeding an observed 1/3 into the copula as if it were rho understates the
// dependence by a third. On a Power play — which pays only for going perfect —
// that understates the entire slip. So the inversion is checked against this
// closed form at machine precision, in both directions.
// ===========================================================================

import * as K from '../../netlify/functions/correlation.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const bern = [0.5, 0.5];

export default async function ({ t }) {
  // =========================================================================
  // 1. Sample statistics, on data where the answer is obvious
  // =========================================================================
  t.ok('a perfect linear relation is correlation 1',
    near(K.pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-12), '');
  t.ok('...and a perfect inverse is -1',
    near(K.pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1, 1e-12), '');
  //   x = [1,2,3,4], y = [1,3,2,4]: means 2.5 and 2.5,
  //   sum dx*dy = (-1.5)(-1.5)+(-0.5)(0.5)+(0.5)(-0.5)+(1.5)(1.5) = 2.25-0.25-0.25+2.25 = 4
  //   sum dx^2 = sum dy^2 = 2.25+0.25+0.25+2.25 = 5    ->  r = 4/5 = 0.8
  t.ok('and a hand-computed case is 4/5', near(K.pearson([1, 2, 3, 4], [1, 3, 2, 4]), 0.8, 1e-12),
    String(K.pearson([1, 2, 3, 4], [1, 3, 2, 4])));
  t.ok('a constant column has no correlation, rather than 0 or NaN',
    K.pearson([1, 1, 1, 1], [1, 2, 3, 4]) === null, '');
  t.ok('two points are not a correlation', K.pearson([1, 2], [1, 2]) === null, '');

  // Ties get midranks, which is what makes Spearman usable on counts at all.
  t.eq('tied values share the average rank', K.ranks([5, 3, 3, 9]), [3, 1.5, 1.5, 4]);
  t.ok('Spearman sees a monotone but non-linear relation as 1',
    near(K.spearman([1, 2, 3, 4], [1, 10, 100, 1000]), 1, 1e-12), '');
  t.ok('...where Pearson does not', K.pearson([1, 2, 3, 4], [1, 10, 100, 1000]) < 0.9, '');

  // =========================================================================
  // 2. THE TETRACHORIC RELATION — the check this file exists for
  // =========================================================================
  for (const [label, rho, r] of [
    ['1/2', 0.5, 1 / 3],
    ['1/sqrt2', Math.SQRT1_2, 0.5],
    ['sqrt3/2', Math.sqrt(3) / 2, 2 / 3],
    ['-1/2', -0.5, -1 / 3],
    ['0', 0, 0],
  ]) {
    const got = K.impliedPearson(bern, bern, rho);
    t.ok(`a latent rho of ${label} shows as an observed ${r.toFixed(6)}`,
      near(got, r, 1e-12), `${got.toFixed(15)}`);
  }

  const back = K.latentRho(bern, bern, 1 / 3);
  t.ok('...and inverting an observed 1/3 recovers the latent 1/2 exactly',
    near(back.rho, 0.5, 1e-10), back.rho.toFixed(12));
  t.ok('...without clipping', back.clipped === false, '');
  t.ok('THE GAP IS LARGE: taking the observed number as the parameter would lose a third of it',
    Math.abs(back.rho - 1 / 3) > 0.16, `${(1 / 3).toFixed(4)} observed vs ${back.rho.toFixed(4)} latent`);

  //   Round trip at arbitrary rho, on ASYMMETRIC discrete marginals where no
  //   closed form exists — the case the real data is actually made of.
  const pmfA = [0.5, 0.3, 0.15, 0.05];
  const pmfB = [0.2, 0.2, 0.2, 0.2, 0.2];
  for (const rho of [-0.6, -0.2, 0.15, 0.45, 0.8]) {
    const observed = K.impliedPearson(pmfA, pmfB, rho);
    const inv = K.latentRho(pmfA, pmfB, observed);
    t.ok(`the inversion round-trips at rho=${rho}`, near(inv.rho, rho, 1e-8),
      `observed ${observed.toFixed(6)} -> ${inv.rho.toFixed(9)}`);
  }

  //   DISCRETE MARGINALS CANNOT REACH +-1. A count on {0..3} and one on {0..4}
  //   are not comonotone at correlation 1, so the attainable range stops short —
  //   and a target beyond it is reported as clipped rather than silently mapped.
  const ceiling = K.impliedPearson(pmfA, pmfB, 1 - 1e-9);
  t.ok('two different discrete marginals cannot attain correlation 1', ceiling < 0.99, ceiling.toFixed(6));
  const over = K.latentRho(pmfA, pmfB, 0.999);
  t.ok('a target above what the marginals allow is CLIPPED, and says so',
    over.clipped === true && /attain/.test(over.reason), over.reason);
  t.ok('...reporting the range that was actually available',
    Array.isArray(over.attainable) && over.attainable[1] < 1, JSON.stringify(over.attainable?.map((v) => v.toFixed(4))));

  t.ok('a marginal with no variance has no correlation to invert',
    K.latentRho([1], bern, 0.3).rho === null, K.latentRho([1], bern, 0.3).reason);

  //   The empirical PMF is what the estimator feeds the inversion.
  t.eq('the empirical PMF counts the sample', K.empiricalPmf([0, 0, 1, 2]), [0.5, 0.25, 0.25]);

  // =========================================================================
  // 3. SHRINKAGE TOWARD ZERO — requirement 5
  //
  //   weight = tau^2 / (tau^2 + 1/(n-3)),  tau = 0.35 so tau^2 = 0.1225
  //     n = 12:  1/(n-3) = 1/9 = 0.111111 -> 0.1225/0.233611 = 0.524376
  //     n = 28:  1/25 = 0.04             -> 0.1225/0.1625    = 0.753846
  //     n = 103: 1/100 = 0.01            -> 0.1225/0.1325    = 0.924528
  // =========================================================================
  t.ok('at n=12 just over half the estimate survives',
    near(K.shrink(0.6, 12).weight, 0.1225 / (0.1225 + 1 / 9), 1e-12), String(K.shrink(0.6, 12).weight));
  t.ok('at n=28 three quarters does',
    near(K.shrink(0.6, 28).weight, 0.1225 / (0.1225 + 0.04), 1e-12), String(K.shrink(0.6, 28).weight));
  t.ok('at n=103 almost all of it does',
    near(K.shrink(0.6, 103).weight, 0.1225 / (0.1225 + 0.01), 1e-12), String(K.shrink(0.6, 103).weight));

  //   The shrunk value itself: z = atanh(0.6) = 0.6931472 (= ln 2, since
  //   (1+0.6)/(1-0.6) = 4 and atanh = (1/2)ln4 = ln2). At n=12 the weight is
  //   0.524376, so z' = 0.363443 and rho' = tanh(0.363443) = 0.348328.
  t.ok('atanh(0.6) is exactly ln 2', near(K.fisherZ(0.6), Math.LN2, 1e-15), String(K.fisherZ(0.6)));
  t.ok('...so a 0.6 estimate on 12 games shrinks to 0.3483',
    near(K.shrink(0.6, 12).rho, Math.tanh(Math.LN2 * (0.1225 / (0.1225 + 1 / 9))), 1e-12),
    K.shrink(0.6, 12).rho.toFixed(6));

  t.ok('shrinkage is monotone in sample size',
    K.shrink(0.6, 8).rho < K.shrink(0.6, 30).rho && K.shrink(0.6, 30).rho < K.shrink(0.6, 300).rho, '');
  t.ok('...and always toward zero, never past it',
    K.shrink(0.6, 8).rho > 0 && K.shrink(0.6, 8).rho < 0.6, String(K.shrink(0.6, 8).rho));
  t.ok('a negative estimate shrinks toward zero from below',
    near(K.shrink(-0.6, 12).rho, -K.shrink(0.6, 12).rho, 1e-15), '');
  t.ok('too few pairs shrinks the estimate away entirely',
    K.shrink(0.9, 3).rho === 0 && K.shrink(0.9, 3).weight === 0, '');
  t.ok('...and says why', /only 3 paired observations/.test(K.shrink(0.9, 3).reason), K.shrink(0.9, 3).reason);
  t.ok('the RAW interval is kept, so "shrunk to nothing" and "measured as nothing" differ',
    K.shrink(0.6, 12).ci[0] < 0.6 && K.shrink(0.6, 12).ci[1] > 0.6, JSON.stringify(K.shrink(0.6, 12).ci));

  // =========================================================================
  // 3b. THE SAMPLING VARIANCE MUST TRAVEL THROUGH THE INVERSION
  //
  // The number being shrunk is the LATENT correlation, not the observed one,
  // and the inversion has a slope. Where that slope is near 1 the delta-method
  // variance must collapse to the familiar Fisher-z result:
  //
  //   var(observed)  = (1 - r^2)^2 / (n - 1)
  //   var(z_latent)  = var(observed) / (slope^2 * (1 - rho^2)^2)
  //                  -> 1/(n-1)   when slope = 1 and rho = r
  //
  // Where the slope is small it must explode instead — which is what makes a
  // sparse pair shrink itself away without any threshold being written down.
  // =========================================================================
  const wide = [0.05, 0.1, 0.2, 0.3, 0.2, 0.1, 0.05];   // a well-spread count
  const midRho = 0.5;
  const midObs = K.impliedPearson(wide, wide, midRho);
  const wideFit = K.shrinkLatent({ observed: midObs, latent: midRho, n: 40, pmfX: wide, pmfY: wide });
  t.ok('on well-spread marginals the inversion slope is near 1',
    Math.abs(wideFit.inversionSlope - 1) < 0.15, String(wideFit.inversionSlope));
  t.ok('...so the effective sample size is close to the real one',
    Math.abs(wideFit.effectiveN - 40) < 12, `${wideFit.effectiveN.toFixed(1)} against n=40`);
  t.ok('...and the weight lands near the plain Fisher-z one',
    Math.abs(wideFit.weight - K.shrink(midRho, 40).weight) < 0.06,
    `${wideFit.weight.toFixed(4)} vs ${K.shrink(midRho, 40).weight.toFixed(4)}`);

  //   A SPARSE PAIR, IN THE DIRECTION THAT ACTUALLY BREAKS. Two events that each
  //   happen in 2% of games can be strongly correlated POSITIVELY — they simply
  //   co-occur — but they can barely be anti-correlated at all, because two
  //   things that are almost always zero are almost always zero TOGETHER. That
  //   asymmetry is what put an observed -0.09 at a latent -1.0 on real data.
  const rareMarginal = [0.98, 0.02];
  const negObs = K.impliedPearson(rareMarginal, rareMarginal, -0.9);
  t.ok('two 2% events can hardly be anti-correlated at all',
    Math.abs(negObs) < 0.10, `latent -0.9 shows as only ${negObs.toFixed(4)}`);
  t.ok('...while the SAME marginals correlate positively without trouble',
    K.impliedPearson(rareMarginal, rareMarginal, 0.9) > 0.4,
    String(K.impliedPearson(rareMarginal, rareMarginal, 0.9)));
  const sparseFit = K.shrinkLatent({ observed: negObs, latent: -0.9, n: 129, pmfX: rareMarginal, pmfY: rareMarginal });
  t.ok('...so on the negative side the inversion slope is tiny',
    Math.abs(sparseFit.inversionSlope) < 0.35, String(sparseFit.inversionSlope));
  t.ok('...and 129 games are worth a fraction of 129 for this estimate',
    sparseFit.effectiveN < 40, `${sparseFit.effectiveN.toFixed(1)} effective against n=129`);
  const spreadFit = K.shrinkLatent({ observed: K.impliedPearson(wide, wide, -0.9), latent: -0.9, n: 129, pmfX: wide, pmfY: wide });
  t.ok('THE SAME LATENT ESTIMATE IS SHRUNK HARDER ON SPARSE MARGINALS THAN ON SPREAD ONES',
    Math.abs(sparseFit.rho) < Math.abs(spreadFit.rho) / 2,
    `sparse ${sparseFit.rho.toFixed(3)} vs spread ${spreadFit.rho.toFixed(3)}`);
  t.ok('...with no threshold anywhere — it falls out of the derivative',
    sparseFit.latentVarianceZ > spreadFit.latentVarianceZ, '');

  //   THE VARIANCE IS FLOORED AT THE PLAIN FISHER-Z ONE. The asymptotic Pearson
  //   variance (1-r^2)^2/(n-1) vanishes as |r| -> 1, so a perfectly collinear
  //   sample came out with NO sampling variance and therefore no shrinkage at
  //   any n. Six games at r = 1.000 is not proof of anything.
  const collinear = K.shrinkLatent({ observed: 1, latent: 0.95, n: 6, pmfX: wide, pmfY: wide });
  t.ok('a perfect observed correlation on six games is still shrunk',
    collinear.weight < 0.5, `weight ${collinear.weight.toFixed(4)}`);
  t.ok('...to no more than the plain Fisher-z weight at that n',
    collinear.weight <= K.shrink(0.95, 6).weight + 1e-12,
    `${collinear.weight.toFixed(4)} vs ${K.shrink(0.95, 6).weight.toFixed(4)}`);

  // =========================================================================
  // 4. ESTIMATING FROM LOGS — synthetic, with a KNOWN answer
  //
  // Two markets built to be exactly linearly related within a player, so the
  // observed correlation is exactly 1 and the relationship is unambiguous. The
  // point of the test is the plumbing — which relationship each pair lands in,
  // whether the sample size is the OVERLAP, and whether shrinkage is applied.
  // =========================================================================
  const gameIds = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10'];
  const mkRows = (ids, f, g, totals) => ids.map((id, i) => ({
    eventId: id, date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    stats: { strikeouts: f(i), outs: g(i) },
    gameTotal: totals ? totals(i) : 8 + i,
  }));

  const logs = [
    { athleteId: '1', player: 'Ace', team: 'ATL', rows: mkRows(gameIds, (i) => i, (i) => 3 * i) },
    { athleteId: '2', player: 'Deuce', team: 'ATL', rows: mkRows(gameIds, (i) => i, (i) => 3 * i) },
    { athleteId: '3', player: 'Rival', team: 'PHI', rows: mkRows(gameIds, (i) => 9 - i, (i) => 3 * (9 - i)) },
  ];
  const est = K.estimateFromLogs(logs, { config: { min_pairs: 5, prior_sd_fisher_z: 0.35 } });

  const sp = est.pairs[K.pairKey('same_player', 'strikeouts', 'outs')];
  t.ok('a same-player pair is estimated', !!sp, Object.keys(est.pairs).join(' | '));
  t.ok('...at an observed correlation of 1, since outs = 3 x strikeouts here',
    near(sp.observed, 1, 1e-12), String(sp.observed));
  t.eq('...on all ten games', sp.n, 10);
  t.ok('...shrunk below 1, because ten games is not proof of a perfect relation',
    sp.rho < 1 && sp.rho > 0.5, String(sp.rho));
  t.eq('...and labelled with its relationship', sp.relationship, 'same_player');

  const st = est.pairs[K.pairKey('same_team', 'strikeouts', 'strikeouts')];
  t.ok('two players on the same team make a same_team pair', !!st && st.relationship === 'same_team', '');
  t.ok('...positively correlated here, by construction', st.observed > 0.9, String(st.observed));

  const opp = est.pairs[K.pairKey('opposing_player', 'strikeouts', 'strikeouts')];
  t.ok('a player on the other side makes an opposing_player pair', !!opp, '');
  t.ok('...and this one is exactly opposed, by construction', near(opp.observed, -1, 1e-12), String(opp.observed));
  t.ok('...which shrinks toward zero from below', opp.rho < 0 && opp.rho > -1, String(opp.rho));

  const gt = est.pairs[K.pairKey('same_game_total', 'strikeouts', '__game_total__')];
  t.ok('every market gets a loading on the game total', !!gt, '');
  t.ok('...which is the common factor two legs in one game share', near(gt.observed, 1, 1e-12), String(gt.observed));

  // THE SAMPLE SIZE IS THE OVERLAP, not the length of either log. Reporting the
  // longer number is the easiest way to make a guess look like a measurement.
  const short = [
    logs[0],
    { athleteId: '4', player: 'Cameo', team: 'ATL', rows: mkRows(gameIds.slice(0, 6), (i) => i, (i) => 2 * i) },
  ];
  const est2 = K.estimateFromLogs(short, { config: { min_pairs: 5 } });
  const overlap = est2.pairs[K.pairKey('same_team', 'strikeouts', 'strikeouts')];
  t.eq('a 10-game log and a 6-game log give a SIX-game estimate', overlap.n, 6);
  t.ok('...and six games is shrunk hard', overlap.shrinkWeight < 0.35, String(overlap.shrinkWeight));
  t.ok('...so the correlation carried into a matrix is a fraction of the observed one',
    Math.abs(overlap.rho) < Math.abs(overlap.observed) / 2,
    `observed ${overlap.observed.toFixed(3)} -> ${overlap.rho.toFixed(3)}`);

  const est3 = K.estimateFromLogs(short, { config: { min_pairs: 8 } });
  t.ok('below min_pairs no entry is written at all — an absent estimate is not evidence',
    !est3.pairs[K.pairKey('same_team', 'strikeouts', 'strikeouts')], '');

  // =========================================================================
  // 5. Using the table
  // =========================================================================
  const A = { player: 'Ace', team: 'ATL', eventId: 'E1', market: 'strikeouts' };
  const B = { player: 'Deuce', team: 'ATL', eventId: 'E1', market: 'strikeouts' };
  const C2 = { player: 'Rival', team: 'PHI', eventId: 'E1', market: 'strikeouts' };
  t.eq('same player, two markets', K.relationshipOf(A, { ...A, market: 'outs' }), 'same_player');
  t.eq('same team, two players', K.relationshipOf(A, B), 'same_team');
  t.eq('opposite sides of one game', K.relationshipOf(A, C2), 'opposing_player');
  t.eq('DIFFERENT GAMES have no modelled relationship', K.relationshipOf(A, { ...B, eventId: 'E2' }), null);

  const direct = K.correlationFor(A, B, est);
  t.eq('a direct estimate is used when one exists', direct.source, 'direct');
  t.ok('...carrying its sample size', direct.n === 10, String(direct.n));

  //   The estimator pairs EVERY column of one player against every column of
  //   the other, so strikeouts-vs-outs across two players is already direct.
  //   The factor path needs a market pair that genuinely never co-occurred, so
  //   this table is built explicitly: two markets with measured loadings on the
  //   game total and nothing joining them to each other.
  const factorTable = {
    pairs: {
      [K.pairKey('same_game_total', 'shotsOnTarget', '__game_total__')]:
        { relationship: 'same_game_total', rho: 0.40, n: 120, shrinkWeight: 0.93 },
      [K.pairKey('same_game_total', 'foulsCommitted', '__game_total__')]:
        { relationship: 'same_game_total', rho: 0.25, n: 90, shrinkWeight: 0.91 },
    },
  };
  const teamCross = K.correlationFor(
    { player: 'X', team: 'ATL', eventId: 'E1', market: 'shotsOnTarget' },
    { player: 'Y', team: 'ATL', eventId: 'E1', market: 'foulsCommitted' },
    factorTable,
  );
  t.eq('a pair with no direct estimate falls back to the game-total factor', teamCross.source, 'factor');
  //   0.40 * 0.25 = 0.10, same team so no sign flip.
  t.ok('...as the PRODUCT of the two loadings: 0.40 x 0.25 = 0.10',
    near(teamCross.rho, 0.10, 1e-12), String(teamCross.rho));
  t.eq('...carrying the SMALLER of the two samples behind it', teamCross.n, 90);

  const oppCross = K.correlationFor(
    { player: 'X', team: 'ATL', eventId: 'E1', market: 'shotsOnTarget' },
    { player: 'Z', team: 'PHI', eventId: 'E1', market: 'foulsCommitted' },
    factorTable,
  );
  t.ok('...and NEGATED for opposing players, who compete for the same possessions',
    near(oppCross.rho, -0.10, 1e-12), String(oppCross.rho));
  t.ok('...which is a configured structural assumption, not an estimate',
    near(K.correlationFor(
      { player: 'X', team: 'ATL', eventId: 'E1', market: 'shotsOnTarget' },
      { player: 'Z', team: 'PHI', eventId: 'E1', market: 'foulsCommitted' },
      factorTable, { config: { opposing_factor_sign: 1 } },
    ).rho, 0.10, 1e-12), '');
  t.ok('the factor can be switched off entirely, back to independence',
    K.correlationFor(
      { player: 'X', team: 'ATL', eventId: 'E1', market: 'shotsOnTarget' },
      { player: 'Y', team: 'ATL', eventId: 'E1', market: 'foulsCommitted' },
      factorTable, { config: { use_game_total_factor: false } },
    ).source === 'none', '');

  //   Meanwhile the estimator really does pair every column against every other,
  //   which is why the pair above had to be constructed rather than found.
  const crossDirect = K.correlationFor(A, { ...C2, market: 'outs' }, est);
  t.eq('across two players, strikeouts against outs IS directly estimated', crossDirect.source, 'direct');

  //   The factor fallback is NOT applied within one player: two markets on one
  //   player share far more than the game total, and understating that is not
  //   the safe direction on a Power play.
  const sparse = { pairs: { [K.pairKey('same_game_total', 'zzz', '__game_total__')]: { rho: 0.5, n: 50, shrinkWeight: 0.9 } } };
  const samePlayerMissing = K.correlationFor({ ...A, market: 'zzz' }, { ...A, market: 'zzz' }, sparse);
  t.eq('a same-player pair with no estimate is NOT filled in by the factor', samePlayerMissing.source, 'none');
  t.ok('...and names what is missing rather than defaulting quietly',
    /nothing observed for same_player/.test(samePlayerMissing.reason), samePlayerMissing.reason);
  t.eq('...at exactly zero, which is the old independent behaviour, stated', samePlayerMissing.rho, 0);

  t.eq('legs in different games get zero, by construction not by omission',
    K.correlationFor(A, { ...B, eventId: 'E9' }, est).source, 'none');

  // =========================================================================
  // 6. The matrix and its confidence
  // =========================================================================
  const built = K.buildMatrix([A, B, { ...A, market: 'outs' }], est);
  t.ok('the diagonal is 1', built.R.every((row, i) => row[i] === 1), '');
  t.ok('...and it is symmetric', built.R.every((row, i) => row.every((v, j) => v === built.R[j][i])), '');
  t.eq('three legs make three pairs', built.provenance.length, 3);
  t.ok('every pair says where its number came from',
    built.provenance.every((p) => ['direct', 'factor', 'none'].includes(p.source)), '');

  const allMissing = K.buildMatrix([A, B, C2], { pairs: {} });
  t.eq('with nothing estimated, every pair is zero', allMissing.R[0][1], 0);
  t.eq('...and confidence is low', allMissing.confidence.level, 'low');
  t.ok('...naming how many pairs are being priced as independent',
    /3 of 3 leg pairs have no estimate/.test(allMissing.confidence.reason), allMissing.confidence.reason);
  t.eq('...with the count itself, not just a label', allMissing.confidence.unestimatedPairs, 3);

  const rich = {
    pairs: Object.fromEntries(built.provenance.map((p, i) => [
      K.pairKey('same_team', 'strikeouts', 'strikeouts'),
      { relationship: 'same_team', rho: 0.4, n: 400, shrinkWeight: 0.98 },
    ])),
  };
  const richConf = K.buildMatrix([A, B], rich).confidence;
  t.eq('a fully-measured pair on a big sample is high confidence', richConf.level, 'high');
  t.eq('...with one direct pair', richConf.directPairs, 1);

  t.eq('a one-leg slip has no correlation structure at all', K.confidenceOf([]).level, 'n/a');

  // =========================================================================
  // 7. WHAT REAL ESPN LOGS BROKE
  //
  // Both of these were found by running the estimator against three live MLB
  // game logs, not by reading the code. Neither is hypothetical.
  // =========================================================================

  //   (a) ESPN's hitter log carries RATE stats — avg, onBasePct, slugAvg, OPS —
  //   in the same row as the counts. Rounding a batting average of 0.271 to
  //   build a PMF collapses the column, and produced sixteen pairs with no
  //   latent estimate at all plus eight pinned at exactly +-1.000.
  t.ok('a count column is recognised', K.isCountColumn([0, 1, 2, 3, 1, 0, 2]), '');
  t.ok('a batting average is NOT', !K.isCountColumn([0.271, 0.300, 0.255, 0.318, 0.290]), '');
  t.ok('...nor is anything negative', !K.isCountColumn([1, -1, 2, 3]), '');
  const withRates = [{
    athleteId: '9', player: 'Hitter', team: 'ATL',
    rows: gameIds.map((id, i) => ({
      eventId: id, date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      stats: { hits: i % 3, avg: 0.25 + i / 100 }, gameTotal: 7 + i,
    })),
  }];
  const rateEst = K.estimateFromLogs(withRates, { config: { min_pairs: 5 } });
  t.ok('a rate column is excluded from estimation', !rateEst.pairs[K.pairKey('same_player', 'hits', 'avg')], '');
  t.eq('...and named, so the gap is visible rather than silent', rateEst.skipped.avg, 'not a count column');
  t.ok('...while the count column beside it is still used',
    !!rateEst.pairs[K.pairKey('same_game_total', 'hits', '__game_total__')], '');

  //   (b) An observed correlation outside what sparse marginals can attain
  //   inverts to the boundary. Hit-by-pitch and stolen bases can reach +0.6
  //   together but only -0.05 apart, so an observed -0.09 was landing at a
  //   latent -1.0 — near-perfect negative dependence off a 9% observation.
  const rare = gameIds.concat(['g11', 'g12', 'g13', 'g14', 'g15']);
  const rareLog = [{
    athleteId: '10', player: 'Rare', team: 'ATL',
    rows: rare.map((id, i) => ({
      eventId: id, date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      // Two events that almost never happen, and never together.
      stats: { hitByPitch: i === 2 ? 1 : 0, stolenBases: i === 7 ? 1 : 0 },
      gameTotal: 7 + (i % 5),
    })),
  }];
  const rareEst = K.estimateFromLogs(rareLog, { config: { min_pairs: 5 } });
  const rarePair = rareEst.pairs[K.pairKey('same_player', 'hitByPitch', 'stolenBases')];
  //   Either outcome is acceptable and both are safe — what must NOT happen is
  //   a near-+-1 correlation reaching the matrix off a 6% observation. When the
  //   observation falls outside the attainable range the pair is refused by
  //   name; when it falls just inside, the delta-method variance shrinks it to
  //   nothing on its own. The assertion is on the thing that matters.
  t.ok('a sparse pair never reaches the matrix as a strong correlation',
    !rarePair || Math.abs(rarePair.rho) < 0.05,
    rarePair ? `kept at rho ${rarePair.rho.toExponential(2)}, weight ${rarePair.shrinkWeight.toExponential(2)}` : 'refused outright');
  t.ok('...even though the raw inversion wanted a large one',
    !rarePair || Math.abs(rarePair.latent) > 0.5,
    rarePair ? `latent ${rarePair.latent.toFixed(3)} -> rho ${rarePair.rho.toExponential(2)}` : 'refused outright');
}

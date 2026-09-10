// Per-market projection models — the rate, the exposure, and the compound.
//
// THE STRONGEST CHECK IN THIS SUITE IS THE CLOSED FORM. A Poisson conditional
// on a Gamma-distributed exposure is EXACTLY negative binomial — there is no
// approximation in that statement, only in the quadrature this module uses to
// get there. So the compounding can be verified against an answer computed
// independently of the code under test, which is worth more than any number of
// assertions that the output "looks reasonable".
//
// Everything else here is hand arithmetic shown in the comments, in the same
// style as fair-odds and alt-line: a test whose expected value was produced by
// running the code proves only that the code is deterministic.

import fs from 'node:fs';
import path from 'node:path';
// Pure module — nothing to stub, so the harness would only be testing itself.
import * as P from '../../netlify/functions/projection.js';

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('netlify/functions/projection-config.json'), 'utf8'));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// An independent logGamma, so the analytic negative binomial below is not
// computed with the same helper as the code it is checking.
function lgamma(z) {
  // Stirling with the standard correction series.
  const c = [1 / 12, -1 / 360, 1 / 1260, -1 / 1680];
  let x = z, add = 0;
  while (x < 12) { add -= Math.log(x); x += 1; }
  let s = (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI);
  let inv = 1 / x;
  for (let i = 0; i < c.length; i++) { s += c[i] * inv; inv /= x * x; }
  return s + add;
}
const nbPmf = (n, r, p) => Math.exp(lgamma(n + r) - lgamma(r) - lgamma(n + 1) + r * Math.log(p) + n * Math.log(1 - p));

export default async function ({ t }) {
  // =========================================================================
  // 1. Recency weighting
  //
  //   half life 30 days: a game 30 days old counts 0.5, 60 days old 0.25.
  // =========================================================================
  const asOf = '2026-09-10';
  t.ok('a game played today counts 1', near(P.recencyWeight('2026-09-10', asOf, 30), 1), '');
  t.ok('one half-life back counts exactly half',
    near(P.recencyWeight('2026-08-11', asOf, 30), 0.5), String(P.recencyWeight('2026-08-11', asOf, 30)));
  t.ok('two half-lives back counts a quarter',
    near(P.recencyWeight('2026-07-12', asOf, 30), 0.25), String(P.recencyWeight('2026-07-12', asOf, 30)));
  t.ok('an unparseable date weighs nothing rather than everything',
    P.recencyWeight('not-a-date', asOf, 30) === 0, '');

  // =========================================================================
  // 2. THE RATE IS sum(w*stat) / sum(w*exposure), NOT a mean of per-game rates
  //
  // Two games, both today so every weight is 1:
  //   full match:  1 shot on target in 90 minutes -> 0.01111 / min
  //   cameo:       1 shot on target in 10 minutes -> 0.10000 / min
  //
  //   mean of rates       = (0.011111 + 0.1) / 2      = 0.0555556  per minute
  //   pooled (this model) = (1 + 1) / (90 + 10) = 2/100 = 0.02      per minute
  //
  // Over a 90-minute start those differ by a factor of nearly three — 5.0 shots
  // on target against 1.8. The mean-of-rates figure is not a near miss, it is a
  // different bet, and it is what a naive per-game average produces.
  // =========================================================================
  const twoGames = [
    { date: asOf, stats: { shotsOnTarget: 1 }, exposure: { minutes: 90, value: 90 } },
    { date: asOf, stats: { shotsOnTarget: 1 }, exposure: { minutes: 10, value: 10 } },
  ];
  const wr = P.weightedRate(twoGames, { statKey: 'shotsOnTarget', exposureKey: 'minutes', halfLifeDays: 30, asOf });
  t.ok('the rate pools numerator and denominator', near(wr.rate, 2 / 100), String(wr.rate));
  t.ok('...which is NOT the mean of the per-game rates',
    !near(wr.rate, (1 / 90 + 1 / 10) / 2, 1e-3), `pooled ${wr.rate.toFixed(5)} vs mean-of-rates ${((1 / 90 + 1 / 10) / 2).toFixed(5)}`);
  t.ok('effective games is the sum of weights, not the row count', near(wr.effectiveGames, 2), String(wr.effectiveGames));

  //   Aged: same two games, the cameo 30 days ago (weight 0.5).
  //   events   = 1*1 + 0.5*1   = 1.5
  //   exposure = 1*90 + 0.5*10 = 95
  //   rate     = 1.5/95        = 0.0157895
  const aged = P.weightedRate(
    [twoGames[0], { ...twoGames[1], date: '2026-08-11' }],
    { statKey: 'shotsOnTarget', exposureKey: 'minutes', halfLifeDays: 30, asOf },
  );
  t.ok('an older game moves both halves of the ratio', near(aged.rate, 1.5 / 95), String(aged.rate));
  t.ok('...and the effective sample shrinks with it', near(aged.effectiveGames, 1.5), String(aged.effectiveGames));

  const lookback = P.weightedRate(
    [{ date: '2024-01-01', stats: { shotsOnTarget: 9 }, exposure: { value: 90 } }],
    { statKey: 'shotsOnTarget', exposureKey: 'minutes', halfLifeDays: 30, asOf, maxLookbackDays: 400 },
  );
  t.ok('a game past the lookback window is dropped entirely', lookback.rate === null && lookback.rowsUsed === 0, '');

  // =========================================================================
  // 3. Shrinkage, in exposure units
  //
  //   Observed: 12 strikeouts in 9 innings (1.333/inning). Prior 1.05, 18 IP.
  //     posterior = (12 + 1.05*18) / (9 + 18) = (12 + 18.9)/27 = 30.9/27
  //               = 1.1444
  //     shrinkage = 18/27 = 0.6667
  //
  //   The same rate on 90 innings (120 K):
  //     posterior = (120 + 18.9)/(90 + 18) = 138.9/108 = 1.2861
  //     shrinkage = 18/108 = 0.1667
  //
  // ONE KNOB DOES THE WHOLE JOB. Nothing tells the model "trust this player
  // more" — the prior's weight falls out of the exposure ratio automatically,
  // which is precisely why the prior is expressed in innings rather than as an
  // abstract strength.
  // =========================================================================
  const thin = P.shrinkRate({ events: 12, exposure: 9, priorRate: 1.05, priorExposure: 18 });
  const thick = P.shrinkRate({ events: 120, exposure: 90, priorRate: 1.05, priorExposure: 18 });
  t.ok('a 9-inning sample lands at 30.9/27 = 1.1444', near(thin.rate, 30.9 / 27), String(thin.rate));
  t.ok('...two thirds of which is the prior', near(thin.shrinkage, 2 / 3), String(thin.shrinkage));
  t.ok('a 90-inning sample lands at 138.9/108 = 1.2861', near(thick.rate, 138.9 / 108), String(thick.rate));
  t.ok('...only a sixth of which is the prior', near(thick.shrinkage, 1 / 6), String(thick.shrinkage));
  t.ok('shrinkage falls as the sample grows, with no second knob',
    thick.shrinkage < thin.shrinkage, `${thin.shrinkage.toFixed(3)} -> ${thick.shrinkage.toFixed(3)}`);
  t.ok('with no data at all the prior is the whole answer',
    P.shrinkRate({ events: 0, exposure: 0, priorRate: 1.05, priorExposure: 18 }).shrinkage === 1, '');

  // =========================================================================
  // 4. Opponent and venue
  //
  //   weight 0.5 => the SQUARE ROOT of the ratio. A team allowing 20% more
  //   than league average moves the projection by sqrt(1.2) = 9.5%, not 20%,
  //   because a season of team-allowed rates is itself a small sample and
  //   taking it at face value would double-count noise already in the player's
  //   own log.
  // =========================================================================
  const opp = P.opponentFactor(1.2, 1.0, { weight: 0.5, clamp: [0.7, 1.4] });
  t.ok('opponent weight 0.5 is a square root', near(opp.factor, Math.sqrt(1.2)), String(opp.factor));
  t.ok('a full-weight adjustment is the raw ratio',
    near(P.opponentFactor(1.2, 1.0, { weight: 1, clamp: [0.5, 2] }).factor, 1.2), '');
  const wild = P.opponentFactor(4, 1, { weight: 1, clamp: [0.7, 1.4] });
  t.ok('an early-season outlier is clamped', wild.factor === 1.4 && wild.clamped === true, String(wild.factor));
  t.ok('no opponent rate means no adjustment, and it says so',
    P.opponentFactor(null, 1, {}).factor === 1 && P.opponentFactor(null, 1, {}).applied === false, '');

  // =========================================================================
  // 5. Exposure, with its own uncertainty
  //
  // SIX IDENTICAL STARTS DO NOT MAKE THE SEVENTH CERTAIN. The observed sd of
  // six 6-inning outings is exactly zero; the floor is what stops that from
  // being read as knowledge and producing a confidently narrow distribution
  // for entirely the wrong reason.
  // =========================================================================
  const steady = ['2026-09-08', '2026-09-02', '2026-08-27', '2026-08-21', '2026-08-15', '2026-08-09']
    .map((d) => ({ date: d, stats: { strikeouts: 6 }, exposure: { innings: 6, value: 6 } }));
  const ex = P.projectExposure(steady, { exposureKey: 'innings', halfLifeDays: 45, asOf, dispersionFloor: 0.22 });
  t.ok('a steady starter projects to his 6 innings', near(ex.mean, 6), String(ex.mean));
  t.ok('...with an OBSERVED sd of zero', near(ex.observedSd, 0), String(ex.observedSd));
  t.ok('...raised to the 22% floor: 1.32 innings', near(ex.sd, 1.32), String(ex.sd));
  t.ok('...and the floor says so on the record', ex.floorApplied === true, '');

  const varied = [
    { date: '2026-09-08', exposure: { value: 90 }, stats: {} },
    { date: '2026-09-08', exposure: { value: 20 }, stats: {} },
  ];
  const exV = P.projectExposure(varied, { exposureKey: 'minutes', halfLifeDays: 45, asOf, dispersionFloor: 0.3 });
  //   mean 55, sd = 35 (each is 35 from the mean) -> well above the 16.5 floor
  t.ok('a rotation player keeps his observed spread', near(exV.mean, 55) && near(exV.sd, 35), `${exV.mean}/${exV.sd}`);
  t.ok('...so the floor does not bind', exV.floorApplied === false, '');

  // =========================================================================
  // 6. The exposure grid
  // =========================================================================
  const grid = P.exposureGrid(6, 1.32, 96);
  const gw = grid.reduce((s, g) => s + g.weight, 0);
  const gm = grid.reduce((s, g) => s + g.weight * g.exposure, 0);
  const gv = grid.reduce((s, g) => s + g.weight * (g.exposure - gm) ** 2, 0);
  t.ok('the grid is normalised', near(gw, 1, 1e-12), String(gw));
  t.ok('...recovers the mean it was matched to', near(gm, 6, 1e-3), String(gm));
  t.ok('...and the sd', near(Math.sqrt(gv), 1.32, 1e-2), String(Math.sqrt(gv)));

  // =========================================================================
  // 7. THE CLOSED FORM — the check this suite exists for
  //
  //   X | E ~ Poisson(rate * E),  E ~ Gamma(shape k, scale theta)
  //   =>  X ~ NegBin(r = k, p = 1/(1 + rate*theta))     EXACTLY.
  //
  //   Matching the Gamma to (mean 6, sd 1.32):
  //     k     = (6/1.32)^2 = 20.6612
  //     theta = 1.32^2/6   = 0.2904
  //   With rate 1.05 K/inning:
  //     rate*theta = 0.304920
  //     p          = 1/1.304920 = 0.766330
  //     mean       = k*rate*theta   = 6.3
  //     var/mean   = 1 + rate*theta = 1.304920
  //
  // If the quadrature were wrong — wrong Gamma parameterisation, unnormalised
  // weights, too few nodes — this would miss, and no amount of plausible output
  // would have shown it.
  // =========================================================================
  const rate = 1.05, mE = 6, sE = 1.32;
  const k = (mE / sE) ** 2, theta = (sE * sE) / mE;
  const p = 1 / (1 + rate * theta);
  const pmf = P.compoundPmf({ rate, exposureMean: mE, exposureSd: sE, family: 'poisson', nodes: 256 });
  let worst = 0;
  for (let n = 0; n <= 20; n++) worst = Math.max(worst, Math.abs(pmf[n] - nbPmf(n, k, p)));
  t.ok('a Poisson compounded over a Gamma exposure IS the analytic negative binomial',
    worst < 1e-10, `largest disagreement over k=0..20 is ${worst.toExponential(2)}`);

  const s = P.summarize(pmf);
  t.ok('...with the analytic mean k*rate*theta = 6.3', near(s.mean, k * rate * theta, 1e-8), String(s.mean));
  t.ok('...and the analytic overdispersion 1 + rate*theta = 1.30492',
    near(s.variance / s.mean, 1 + rate * theta, 1e-8), String(s.variance / s.mean));

  // THE TOLERANCES ABOVE ARE 1e-10, NOT 1e-6, ON PURPOSE. At 1e-6 they passed
  // while the grid was truncating the Gamma at +6sd and losing ~3e-6 of its
  // upper tail — a bias that renormalisation converted into a mean 4e-6 low on
  // EVERY projection, always in the same direction. Adding nodes did not move
  // it, which is what identified the range rather than the quadrature as the
  // cause. A loose tolerance would have shipped that.

  // COMPOUNDING IS NOT COSMETIC: collapsing exposure to its mean loses that
  // 30% of extra variance, and loses it hardest where exposure is least certain.
  const collapsed = P.compoundPmf({ rate, exposureMean: mE, exposureSd: 0, family: 'poisson' });
  const cs = P.summarize(collapsed);
  t.ok('a fixed exposure gives back a plain Poisson (variance = mean)',
    near(cs.variance / cs.mean, 1, 1e-6), String(cs.variance / cs.mean));
  t.ok('...so the exposure uncertainty is what creates the overdispersion',
    s.variance > cs.variance * 1.25, `${cs.variance.toFixed(3)} -> ${s.variance.toFixed(3)}`);

  // A conditional that is ALREADY overdispersed compounds on top of that.
  const nb = P.summarize(P.compoundPmf({
    rate, exposureMean: mE, exposureSd: sE, family: 'negative_binomial', shape: { dispersion: 1.25 },
  }));
  t.ok('a negative-binomial conditional is wider still', nb.variance > s.variance, `${s.variance.toFixed(3)} -> ${nb.variance.toFixed(3)}`);

  // =========================================================================
  // 8. Probabilities at a line — the same push rule as the rest of the app
  // =========================================================================
  const half = P.probsAtLine(pmf, 5.5);
  t.ok('a half-point line cannot push', half.push === 0, '');
  t.ok('...and the three probabilities sum to 1', near(half.over + half.under + half.push, 1, 1e-9), '');
  const whole = P.probsAtLine(pmf, 6);
  t.ok('a whole line carries the push mass, exactly P(X=6)', near(whole.push, pmf[6], 1e-12), String(whole.push));
  t.ok('...and the over excludes it', near(whole.over, half.over - pmf[6], 1e-12), '');

  // =========================================================================
  // 9. End to end — a real-shaped MLB starter
  //
  // Six starts, 6 innings each, 7 strikeouts each: 42 K in 36 IP = 1.1667/IP.
  // Shrunk against the SP prior (1.05 over 18 IP) on the recency-weighted
  // totals, adjusted for a slightly strikeout-prone opponent, at home.
  // =========================================================================
  const starts = steady.map((r) => ({ ...r, stats: { strikeouts: 7 } }));
  const proj = P.project({
    rows: starts,
    league: 'mlb',
    statKey: 'strikeouts',
    exposureKey: 'innings',
    position: 'SP',
    asOf,
    isHome: true,
    opponentAllowedRate: 1.15,
    leagueAverageRate: 1.05,
    config: CONFIG,
    priorGroup: 'mlb_pitcher',
  });
  t.ok('the projection builds', proj.ok === true, proj.reason || '');
  t.ok('it returns a full PMF, not a number', Array.isArray(proj.pmf) && proj.pmf.length > 10, '');
  t.ok('...that sums to 1', near(proj.pmf.reduce((a, b) => a + b, 0), 1, 1e-9), '');
  t.ok('...with a monotone CDF ending at 1',
    proj.cdf.every((v, i) => i === 0 || v >= proj.cdf[i - 1]) && near(proj.cdf.at(-1), 1, 1e-9), '');
  t.ok('the observed rate is 1.1667 K per inning',
    near(proj.rate_components.observed_rate, 7 / 6, 1e-9), String(proj.rate_components.observed_rate));
  t.ok('the shrunk rate sits between the observation and the 1.05 prior',
    proj.rate_components.shrunk_rate < 7 / 6 && proj.rate_components.shrunk_rate > 1.05,
    String(proj.rate_components.shrunk_rate));
  t.ok('the opponent factor is sqrt(1.15/1.05) = 1.0466',
    near(proj.rate_components.opponent_factor, Math.sqrt(1.15 / 1.05)), String(proj.rate_components.opponent_factor));
  t.ok('the home factor is the configured 1.02', proj.rate_components.home_factor === 1.02, '');
  t.ok('the mean is the rate times the projected innings, within quadrature error',
    near(proj.mean, proj.rate * proj.exposure.mean, 1e-3), `${proj.mean.toFixed(4)} vs ${(proj.rate * proj.exposure.mean).toFixed(4)}`);
  t.ok('strikeouts use the negative-binomial family from the config', proj.family === 'negative_binomial', proj.family);
  t.ok('and the result is overdispersed, as the compound requires', proj.overdispersion > 1.2, String(proj.overdispersion));

  // The confidence flag is a FIELD, not a suppression.
  const oneStart = P.project({
    rows: [starts[0]], league: 'mlb', statKey: 'strikeouts', exposureKey: 'innings',
    position: 'SP', asOf, isHome: true, config: CONFIG, priorGroup: 'mlb_pitcher',
  });
  t.ok('one start still produces a distribution', oneStart.ok === true && oneStart.pmf.length > 0, '');
  t.ok('...flagged low confidence', oneStart.low_confidence === true, '');
  t.ok('...naming the reasons', oneStart.confidence_reasons.length >= 2, JSON.stringify(oneStart.confidence_reasons));
  t.ok('...and six starts are not flagged', proj.low_confidence === false, JSON.stringify(proj.confidence_reasons));

  t.ok('a log with no usable rows refuses rather than inventing a rate',
    P.project({ rows: [], league: 'mlb', statKey: 'strikeouts', exposureKey: 'innings', asOf, config: CONFIG, priorGroup: 'mlb_pitcher' }).ok === false, '');

  // =========================================================================
  // 10. A soccer forward, on IMPUTED minutes
  //
  // Three full matches and two cameos. The rate model reads 2 SOG in 90 as a
  // different player from 2 SOG in 23, and projecting a start scales the rate
  // to ninety minutes rather than averaging games of unequal length.
  // =========================================================================
  const mbeumo = [
    { date: '2026-09-06', stats: { shotsOnTarget: 1 }, exposure: { minutes: 90, value: 90 } },
    { date: '2026-08-30', stats: { shotsOnTarget: 2 }, exposure: { minutes: 90, value: 90 } },
    { date: '2026-08-23', stats: { shotsOnTarget: 0 }, exposure: { minutes: 66, value: 66 } },
    { date: '2026-08-16', stats: { shotsOnTarget: 1 }, exposure: { minutes: 23, value: 23 } },
    { date: '2026-08-09', stats: { shotsOnTarget: 1 }, exposure: { minutes: 90, value: 90 } },
  ];
  const bench = P.project({
    rows: mbeumo, league: 'soccer', statKey: 'shotsOnTarget', exposureKey: 'minutes',
    position: 'F', asOf, isHome: false, config: CONFIG, priorGroup: 'soccer',
  });
  // A CONFIRMED START is knowledge the history does not contain, so it overrides
  // the fitted exposure — with the sd from the appearance table, because a known
  // role is not a known number of minutes.
  const startsFull = P.project({
    rows: mbeumo, league: 'soccer', statKey: 'shotsOnTarget', exposureKey: 'minutes',
    position: 'F', asOf, isHome: false, config: CONFIG, priorGroup: 'soccer',
    exposureOverride: { mean: 90, sd: 4, source: 'confirmed start' },
  });
  t.ok('a confirmed start projects 90 minutes, not his mixed average',
    startsFull.exposure.mean === 90 && bench.exposure.mean < 90, `${bench.exposure.mean.toFixed(1)} -> 90`);
  t.ok('...and so a higher expected count', startsFull.mean > bench.mean, `${bench.mean.toFixed(3)} -> ${startsFull.mean.toFixed(3)}`);
  t.ok('...with the dispersion floor still applied over the supplied sd',
    near(startsFull.exposure.sd, 0.30 * 90), String(startsFull.exposure.sd));
  t.ok('...and the override is on the record', startsFull.exposure.overridden === true, startsFull.exposure.source);
  t.ok('goals use the zero-inflated family', P.project({
    rows: mbeumo.map((r) => ({ ...r, stats: { totalGoals: 0 } })),
    league: 'soccer', statKey: 'totalGoals', exposureKey: 'minutes', position: 'F', asOf, config: CONFIG, priorGroup: 'soccer',
  }).family === 'zero_inflated_poisson', '');

  // =========================================================================
  // 11. Blending with the book
  //
  //   model 0.60, book 0.52, weight 0.80:
  //     0.80*0.52 + 0.20*0.60 = 0.416 + 0.120 = 0.536
  //
  // BOTH INPUTS COME BACK UNBLENDED. That is the entire point of doing this
  // rather than just quoting the book: with the two logged separately against
  // the same outcome, the 0.80 can eventually be replaced by a measurement.
  // =========================================================================
  const b = P.blendWithBook({ modelProb: 0.60, bookProb: 0.52, config: CONFIG });
  t.ok('the blend is 0.8*book + 0.2*model = 0.536', near(b.blended, 0.536), String(b.blended));
  t.ok('...and defaults heavily toward the book', b.book_weight_used === 0.80, '');
  t.ok('the model probability is logged unblended', b.model_prob === 0.60, '');
  t.ok('...and so is the book probability', b.book_prob === 0.52, '');
  t.ok('...with the gap between them stated', near(b.disagreement, 0.08), String(b.disagreement));

  //   Low confidence: weight rises to 0.92, not to 1.
  //     0.92*0.52 + 0.08*0.60 = 0.4784 + 0.048 = 0.5264
  const bLow = P.blendWithBook({ modelProb: 0.60, bookProb: 0.52, config: CONFIG, lowConfidence: true });
  t.ok('a thin model is cut to 8%, not dropped', near(bLow.blended, 0.5264), String(bLow.blended));
  t.ok('...and says it was raised', bLow.raised_for_low_confidence === true, '');

  // The case this module exists for: a market no book prices at all.
  const noBook = P.blendWithBook({ modelProb: 0.61, bookProb: null, config: CONFIG });
  t.ok('with no book price the model stands alone', noBook.blended === 0.61 && noBook.book_weight_used === 0, '');
  t.ok('...and says why', /no book prices this market/.test(noBook.source), noBook.source);
  const noModel = P.blendWithBook({ modelProb: null, bookProb: 0.52, config: CONFIG });
  t.ok('with no model the book stands alone', noModel.blended === 0.52 && noModel.book_weight_used === 1, '');
  t.ok('with neither, nothing is invented', P.blendWithBook({ modelProb: null, bookProb: null }).blended === null, '');

  // =========================================================================
  // 12. The config is the only place numbers live
  // =========================================================================
  t.ok('every knob the code reads exists in projection-config.json',
    CONFIG.recency?.half_life_days != null
    && CONFIG.exposure?.half_life_days != null
    && CONFIG.shrinkage?.prior_exposure_units != null
    && CONFIG.opponent?.weight != null
    && CONFIG.home_away?.home_factor != null
    && CONFIG.book_blend?.book_weight != null
    && CONFIG.distribution?.family_by_market != null, '');
  t.ok('the rate half-life is shorter than the exposure half-life — form moves faster than role',
    CONFIG.recency.half_life_days < CONFIG.exposure.half_life_days,
    `${CONFIG.recency.half_life_days}d rate vs ${CONFIG.exposure.half_life_days}d exposure`);
  t.ok('the book keeps the majority of the weight', CONFIG.book_blend.book_weight >= 0.5, String(CONFIG.book_blend.book_weight));
}

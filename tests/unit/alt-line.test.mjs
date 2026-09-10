// Translating a book's line onto PrizePicks' line.
//
// DraftKings prices Nick Martinez's strikeouts at 3.5 and PrizePicks posts a
// ladder from 1.5 to 6.5. Those are different bets, and every "edge" computed
// across them is meaningless until one is moved onto the other. This module
// does the moving; this suite checks it moves them to the right place.
//
// THE STRONGEST CHECK AVAILABLE IS THE IDENTITY. Translating the book's line to
// ITSELF must return the book's own probability, to machine precision. It is
// the one case where the answer is known independently of the model, and a fit
// that fails it is wrong in a way no amount of plausible-looking output would
// reveal.
//
// The real examples below were captured on 2026-09-10, both sides live:
//   DK  pitcher_strikeouts, Nick Martinez 3.5, Over -116 / Under -110
//       (ATL vs TB, event 3ef6a964abad382c28ff1f91886dc99a)
//   PP  Nick Martinez Pitcher Strikeouts at 1.5, 2.5, 3.5, 4.5, 5.5, 6.5
//   PP  Bryan Mbeumo (Man Utd) Shots On Target at 0.5, 1.5, 2.5, 3.5
//
// The soccer BOOK price is the one number here that is not captured: this app
// has no Odds API sport key for soccer at all (see ODDS_SPORT_KEYS in
// bet-finder-background.js — mlb, nba, wnba, nfl, nhl, cfb, cbb and nothing
// else), so the entire book-comparison pipeline is dark for the 2,014 soccer
// props PrizePicks is posting today. The PrizePicks ladder is real; the book
// price beside it is a representative SOG quote, and is labelled as such rather
// than presented as captured.

import fs from 'node:fs';
import path from 'node:path';
// Pure module — nothing to stub, so the harness would only prove itself.
import * as A from '../../netlify/functions/alt-line.js';

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('netlify/functions/market-models.json'), 'utf8'));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// American -> implied, then additive de-vig (== Shin on a two-way market).
const am = (o) => (o > 0 ? 100 / (o + 100) : -o / (-o + 100));
const noVigOver = (over, under) => am(over) - (am(over) + am(under) - 1) / 2;

export default async function ({ t }) {
  // =========================================================================
  // 1. The distributions themselves, against arithmetic
  //
  //   Poisson(2), P(X=0) = e^-2               = 0.135335
  //               P(X=1) = 2*e^-2             = 0.270671
  //               P(X=2) = 2*e^-2             = 0.270671
  //               P(X>=1) = 1 - 0.135335      = 0.864665
  // =========================================================================
  t.ok('Poisson(2) P(0) = e^-2', near(A.poissonPmf(0, 2), Math.exp(-2)), String(A.poissonPmf(0, 2)));
  t.ok('Poisson(2) P(1) = 2e^-2', near(A.poissonPmf(1, 2), 2 * Math.exp(-2)), String(A.poissonPmf(1, 2)));
  t.ok('Poisson(2) P(2) = 2e^-2 as well', near(A.poissonPmf(2, 2), 2 * Math.exp(-2)), String(A.poissonPmf(2, 2)));
  // Large lambda must not overflow: a naive lambda^k / k! dies around k=170,
  // and pitches-thrown lines run to 90+.
  t.ok('a large mean does not overflow — computed in log space',
    A.poissonPmf(95, 95) > 0 && A.poissonPmf(95, 95) < 0.05, String(A.poissonPmf(95, 95)));

  // Negative binomial with dispersion 1 degenerates to Poisson, which is the
  // continuity that makes the two comparable at all.
  t.ok('negative binomial at dispersion 1 IS Poisson',
    near(A.negBinPmf(3, 4, 1), A.poissonPmf(3, 4)), '');
  // Overdispersion moves mass to the tails, so the mode gets thinner.
  t.ok('...and at dispersion 1.5 the centre thins', A.negBinPmf(4, 4, 1.5) < A.poissonPmf(4, 4), '');
  t.ok('...while the tail fattens', A.negBinPmf(10, 4, 1.5) > A.poissonPmf(10, 4), '');

  //   ZIP(lambda=1, pi=0.2): P(0) = 0.2 + 0.8*e^-1 = 0.2 + 0.294303 = 0.494303
  t.ok('zero-inflated Poisson puts the extra mass exactly at zero',
    near(A.zipPmf(0, 1, 0.2), 0.2 + 0.8 * Math.exp(-1)), String(A.zipPmf(0, 1, 0.2)));
  t.ok('...and scales everything else by (1 - pi)',
    near(A.zipPmf(2, 1, 0.2), 0.8 * A.poissonPmf(2, 1)), '');

  t.ok('the normal CDF is 0.5 at the mean', near(A.normalCdf(10, 10, 3), 0.5, 1e-6), '');
  t.ok('...and ~0.8413 one sd up', near(A.normalCdf(13, 10, 3), 0.841344, 1e-4), String(A.normalCdf(13, 10, 3)));

  // =========================================================================
  // 2. NICK MARTINEZ — real DraftKings price, real PrizePicks ladder
  //
  //   DK 3.5, Over -116 / Under -110
  //     implied over  = 116/216 = 0.5370370
  //     implied under = 110/210 = 0.5238095
  //     sum           = 1.0608466   -> hold 6.0847%
  //     de-vig d      = 0.0608466/2 = 0.0304233
  //     no-vig over   = 0.5370370 - 0.0304233 = 0.5066137
  //
  //   Fitting a POISSON to P(X >= 4) = 0.5066137 gives lambda = 3.703676,
  //   which is checkable by hand:
  //     e^-3.703676 = 0.0246344
  //     sum_{k=0..3} lambda^k/k! = 1 + 3.703676 + 6.858606 + 8.466283 = 20.028565
  //     P(X<=3) = 0.0246344 * 20.028565 = 0.4933862
  //     P(X>=4) = 1 - 0.4933862 = 0.5066138   <- the input, recovered
  // =========================================================================
  const bookProb = noVigOver(-116, -110);
  t.ok('the DK price de-vigs to 0.5066137', near(bookProb, 0.5066137, 1e-6), String(bookProb));

  const pois = (ppLine) => A.translate({
    market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine,
    config: CONFIG, family: 'poisson', maxSigma: 9, maxShapeDisagreement: 9,
  });

  // THE IDENTITY. 3.5 -> 3.5 must give back exactly what went in.
  const same = pois(3.5);
  t.ok('translating the book line to itself returns the book price exactly',
    near(same.prob.over, bookProb, 1e-9), `${same.prob.over} vs ${bookProb}`);
  t.ok('...with a fitted lambda of 3.703676', near(same.fitted_parameter, 3.703676, 1e-5), String(same.fitted_parameter));
  t.eq('...and zero distance, by construction', same.sigmas, 0);
  t.ok('...so the shape assumption contributes nothing at the book line',
    near(same.shape_sensitivity.disagreement, 0, 1e-9), String(same.shape_sensitivity.disagreement));

  // The rest of the real ladder, hand-checked against Poisson(3.703676):
  //   P(X>=2) = 1 - e^-l(1+l)            = 1 - 0.0246344*4.703676 = 0.8841353
  //   P(X>=3) = P(X>=2) - l^2 e^-l/2     = 0.8841353 - 0.1689472 = 0.7151881
  //   P(X>=5) = P(X>=4) - l^3 e^-l/6     = 0.5066138 - 0.1931236 = 0.3134902
  //   P(X>=6) = P(X>=5) - l^4 e^-l/24    = 0.3134902 - 0.1430526 = 0.1704376
  //   P(X>=7) = P(X>=6) - l^5 e^-l/120   = 0.1704376 - 0.0883044 = 0.0821332
  const expected = {
    1.5: 0.8841353, 2.5: 0.7151881, 3.5: 0.5066138,
    4.5: 0.3134902, 5.5: 0.1704376, 6.5: 0.0821332,
  };
  for (const [line, want] of Object.entries(expected)) {
    const got = pois(Number(line)).prob.over;
    t.ok(`PP ${line}: P(over) = ${want}`, near(got, want, 1e-6), String(got));
  }

  // Monotone in the line, which any correct answer must be.
  const ladder = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5].map((l) => pois(l).prob.over);
  t.ok('the probability falls as the line rises', ladder.every((v, i) => i === 0 || v < ladder[i - 1]), ladder.join(' > '));
  t.ok('over and under always sum to 1 on a half-point line',
    [1.5, 4.5, 6.5].every((l) => near(pois(l).prob.over + pois(l).prob.under, 1)), '');

  // The configured family for strikeouts is negative binomial, not Poisson —
  // strikeouts are overdispersed because innings pitched vary. It should give a
  // FATTER tail than Poisson at the same book price.
  const nb = A.translate({ market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 6.5, config: CONFIG });
  t.eq('strikeouts default to negative binomial', nb.distribution, 'negative_binomial');
  t.eq('...with the dispersion from the config', nb.shape_parameter.dispersion, 1.25);
  t.ok('...and an overdispersed tail is fatter than Poisson',
    nb.prob.over > pois(6.5).prob.over, `${nb.prob.over} vs ${pois(6.5).prob.over}`);
  t.ok('...by an amount worth knowing about — 8.2% against 11.2%',
    nb.prob.over - pois(6.5).prob.over > 0.02, String(nb.prob.over - pois(6.5).prob.over));
  t.ok('...which is exactly what shape_sensitivity reports',
    near(nb.shape_sensitivity.disagreement, Math.abs(nb.prob.over - pois(6.5).prob.over), 1e-9), '');

  // =========================================================================
  // 3. Diagnostics (requirement 4)
  // =========================================================================
  const d = pois(5.5);
  t.eq('the distribution used is reported', d.distribution, 'poisson');
  t.ok('...the fitted parameter', near(d.fitted_parameter, 3.703676, 1e-5), String(d.fitted_parameter));
  t.ok('...the implied mean', near(d.implied_mean, 3.703676, 1e-5), String(d.implied_mean));
  //   sd of Poisson(3.703676) = sqrt(3.703676) = 1.924494
  //   (5.5 - 3.5) / 1.924494 = 1.039242
  t.ok('...and the gap in standard deviations', near(d.sigmas, 2 / Math.sqrt(3.703676), 1e-6), String(d.sigmas));
  t.eq('...alongside the raw gap in the stat\'s own units', d.line_gap, 2);
  t.ok('the fit reports that it reproduced its own input',
    near(d.book_prob_reproduced, d.book_prob, 1e-9), '');
  t.eq('...and which config produced it', d.config_id, 'market-models-2026-09');

  // =========================================================================
  // 4. PUSH — a whole-number PrizePicks line
  //
  // PrizePicks refunds a result landing exactly on a whole line (settle() in
  // grade-picks.js already encodes this). So at PP line 4:
  //   over  = P(X >= 5) = 0.3134902
  //   under = P(X <= 3) = 0.4933862
  //   push  = P(X = 4)  = 0.1931236
  // and those must sum to exactly 1.
  //
  // Note the under here equals the book's own P(under 3.5) — "X <= 3" and
  // "under 3.5" are the same event, which is a free consistency check.
  // =========================================================================
  const push = A.translate({
    market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 4,
    config: CONFIG, family: 'poisson', maxSigma: 9, maxShapeDisagreement: 9,
  });
  t.ok('a whole line pushes: over = P(X>=5)', near(push.prob.over, 0.3134902, 1e-6), String(push.prob.over));
  t.ok('...under = P(X<=3)', near(push.prob.under, 0.4933862, 1e-6), String(push.prob.under));
  t.ok('...push = P(X=4)', near(push.prob.push, 0.1931236, 1e-6), String(push.prob.push));
  t.ok('...and the three sum to exactly 1', near(push.prob.over + push.prob.under + push.prob.push, 1, 1e-12), '');
  t.ok('the under at PP 4 is the book\'s own under at 3.5 — the same event',
    near(push.prob.under, 1 - bookProb, 1e-6), '');
  t.eq('the line is flagged as capable of pushing', push.pp_line_can_push, true);

  // The number you would actually bet: conditional on the slip resolving.
  //   0.3134902 / (0.3134902 + 0.4933862) = 0.3885
  t.ok('...and the no-push conditional is reported beside it',
    near(push.prob_no_push.over, 0.3134902 / (0.3134902 + 0.4933862), 1e-6), String(push.prob_no_push.over));
  t.ok('...summing to 1 on its own terms',
    near(push.prob_no_push.over + push.prob_no_push.under, 1, 1e-12), '');

  // The tie rule is a property of the operator, not of the maths, so it is
  // configurable — a book that graded ties as overs would need this.
  const tieOver = A.translate({
    market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 4,
    config: CONFIG, family: 'poisson', maxSigma: 9, maxShapeDisagreement: 9, tieRule: 'over',
  });
  t.ok('under a ties-are-overs rule the push mass moves to the over',
    near(tieOver.prob.over, 0.3134902 + 0.1931236, 1e-6), String(tieOver.prob.over));
  t.eq('...and nothing is left pushing', tieOver.prob.push, 0);

  // A half-point line can never push, whatever the rule says.
  t.eq('a half-point line has no push mass', pois(4.5).prob.push, 0);
  t.eq('...and is flagged as such', pois(4.5).pp_line_can_push, false);

  // =========================================================================
  // 5. A WHOLE-NUMBER BOOK LINE is conditional on no push
  //
  // A book refunds ties too, so a two-way de-vigged price at a whole line is
  // P(over) / (P(over) + P(under)) — NOT P(over). Fitting it as unconditional
  // biases the mean, and the bias is largest where the push mass is largest.
  // The check: fit at a whole book line, then confirm the model reproduces the
  // CONDITIONAL probability rather than the raw tail.
  // =========================================================================
  const wholeBook = A.translate({
    market: 'Pitcher Strikeouts', bookLine: 4, bookProb: 0.55, ppLine: 4,
    config: CONFIG, family: 'poisson', maxSigma: 9, maxShapeDisagreement: 9,
  });
  t.ok('a whole book line is fitted conditional on no push',
    near(wholeBook.prob_no_push.over, 0.55, 1e-6), String(wholeBook.prob_no_push.over));
  t.ok('...so the UNCONDITIONAL over is lower than the quoted 0.55',
    wholeBook.prob.over < 0.55, `${wholeBook.prob.over} vs 0.55`);
  t.ok('...by exactly the push mass it was hiding', wholeBook.prob.push > 0.1, String(wholeBook.prob.push));

  // =========================================================================
  // 6. SOCCER SHOTS ON TARGET
  //
  // PrizePicks ladder is real (Bryan Mbeumo, Man Utd, 2026-09-10: 0.5, 1.5,
  // 2.5, 3.5). The book quote is representative, not captured — this app has no
  // Odds API sport key for soccer, so nothing here can fetch one.
  //
  //   book 1.5, Over +105 / Under -135
  //     implied over  = 100/205 = 0.4878049
  //     implied under = 135/235 = 0.5744681
  //     sum           = 1.0622730  -> hold 6.2273%
  //     no-vig over   = 0.4878049 - 0.0311365 = 0.4566684
  // =========================================================================
  const sog = noVigOver(105, -135);
  t.ok('the SOG quote de-vigs to 0.4566684', near(sog, 0.4566684, 1e-6), String(sog));

  const shots = (ppLine) => A.translate({ market: 'Shots On Target', bookLine: 1.5, bookProb: sog, ppLine, config: CONFIG });
  t.eq('shots on target default to negative binomial — minutes vary, so counts are overdispersed',
    shots(2.5).distribution, 'negative_binomial');
  t.ok('the identity holds here too', near(shots(1.5).prob.over, sog, 1e-9), String(shots(1.5).prob.over));

  const sogLadder = [0.5, 1.5, 2.5, 3.5].map((l) => shots(l));
  t.ok('every rung of the real PrizePicks ladder translates', sogLadder.every((r) => r.ok),
    sogLadder.map((r) => r.ok ? 'ok' : r.reason).join(' | '));
  t.ok('...monotonically', sogLadder.every((r, i) => i === 0 || r.prob.over < sogLadder[i - 1].prob.over),
    sogLadder.map((r) => r.prob.over.toFixed(4)).join(' > '));
  t.ok('the implied mean is plausible for a forward — about 1.6 shots on target',
    shots(2.5).implied_mean > 1.3 && shots(2.5).implied_mean < 2.0, String(shots(2.5).implied_mean));

  // The low-count problem, stated where it bites: one step on a market with a
  // mean of 1.6 is already most of a standard deviation, which is why the
  // default sigma limit is 2.0 rather than something tighter.
  t.ok('one step on a low-count market is already ~0.7 sd',
    Math.abs(shots(2.5).sigmas) > 0.6 && Math.abs(shots(2.5).sigmas) < 0.9, String(shots(2.5).sigmas));

  // =========================================================================
  // 7. Zero-inflation, where the zeros mean two different things
  //
  // Goals: a player can fail to score, or barely play. A plain Poisson folds
  // those into one number. With pi = 0.12 the Poisson component's lambda is
  // HIGHER than the observable mean, because some of the zero mass is
  // structural — mean = (1 - pi) * lambda.
  // =========================================================================
  const goals = A.translate({ market: 'Goals', bookLine: 0.5, bookProb: 0.30, ppLine: 1.5, config: CONFIG });
  t.eq('goals use a zero-inflated model', goals.distribution, 'zero_inflated_poisson');
  t.eq('...with the configured inflation', goals.shape_parameter.zero_inflation, 0.12);
  t.ok('...and the fitted lambda exceeds the observable mean, since some zeros are structural',
    goals.fitted_parameter > goals.implied_mean, `${goals.fitted_parameter} vs ${goals.implied_mean}`);
  t.ok('...related by mean = (1 - pi) * lambda',
    near(goals.implied_mean, 0.88 * goals.fitted_parameter, 1e-9), '');
  t.eq('the parameter is named, since "the parameter" is ambiguous for this family',
    goals.fitted_parameter_name, 'lambda (Poisson component)');

  // =========================================================================
  // 8. Continuous-ish stats
  //
  // Passing yards at a 50/50 book line must fit a mean equal to that line, and
  // the sd scales with the mean (cv 0.32) rather than being absolute — a
  // 300-yard passer is not as variable as a 180-yard passer in absolute terms.
  // Minutes are the opposite: bounded by the game, so an ABSOLUTE sd.
  // =========================================================================
  const yards = A.translate({ market: 'Pass Yards', bookLine: 249.5, bookProb: 0.5, ppLine: 274.5, config: CONFIG });
  t.eq('passing yards use a discretized normal', yards.distribution, 'discrete_normal');
  t.ok('a 50/50 book price fits a mean at the line', near(yards.implied_mean, 249.5, 1e-3), String(yards.implied_mean));
  t.ok('...with sd = cv * mean', near(yards.sd, 0.32 * yards.implied_mean, 1e-3), String(yards.sd));

  const minutes = A.translate({ market: 'Minutes', bookLine: 30.5, bookProb: 0.5, ppLine: 32.5, config: CONFIG });
  t.ok('minutes use an ABSOLUTE sd, not a cv — the game bounds them',
    near(minutes.sd, 7.0, 1e-9), String(minutes.sd));
  t.ok('...so a low-minutes player is not treated as proportionally less variable',
    near(A.translate({ market: 'Minutes', bookLine: 12.5, bookProb: 0.5, ppLine: 14.5, config: CONFIG }).sd, 7.0, 1e-9), '');

  // =========================================================================
  // 9. REFUSALS (requirement 5)
  //
  // A silently wrong number is worse than no number: a wrong one gets bet, a
  // missing one gets noticed.
  // =========================================================================
  const tooFar = A.translate({ market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 9.5, config: CONFIG });
  t.eq('a line far from the book line is refused', tooFar.ok, false);
  t.eq('...returning null rather than a number', tooFar.prob, null);
  t.ok('...with the distance and the limit in the reason',
    /sd from the book line/.test(tooFar.reason) && /limit 2/.test(tooFar.reason), tooFar.reason);
  t.ok('...and the diagnostics kept, so the refusal can be understood',
    tooFar.fitted_mean > 0 && Math.abs(tooFar.sigmas) > 2, JSON.stringify({ m: tooFar.fitted_mean, s: tooFar.sigmas }));

  t.eq('the threshold is configurable, and a looser one allows it',
    A.translate({ market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 9.5, config: CONFIG, maxSigma: 5, maxShapeDisagreement: 9 }).ok,
    true);

  // An unrecognised market is refused rather than defaulted to Poisson —
  // guessing a shape for an unknown stat is the exact failure this exists to
  // prevent, and the refusal names the market so the gap is visible.
  const unknown = A.translate({ market: 'Quarters With 5+ Rush Yards', bookLine: 1.5, bookProb: 0.5, ppLine: 2.5, config: CONFIG });
  t.eq('an unconfigured market is refused', unknown.ok, false);
  t.ok('...naming it, so the gap is visible rather than absorbed',
    unknown.reason.includes('Quarters With 5+ Rush Yards'), unknown.reason);

  // A price of 0 or 1 pins the fit at a boundary and says nothing about shape.
  for (const bad of [0, 1, -0.1, 1.2, NaN]) {
    t.eq(`a book probability of ${bad} is refused`,
      A.translate({ market: 'Hits', bookLine: 0.5, bookProb: bad, ppLine: 1.5, config: CONFIG }).ok, false);
  }
  t.eq('a non-numeric line is refused',
    A.translate({ market: 'Hits', bookLine: 'x', bookProb: 0.5, ppLine: 1.5, config: CONFIG }).ok, false);

  // THE SHAPE GUARD. Two plausible families fitted to the same book price and
  // disagreeing badly at the PrizePicks line means the answer is a statement
  // about the assumption, not about the market. Tightening the limit to
  // almost nothing must refuse a translation that is otherwise fine.
  const shapeRefused = A.translate({
    market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 6.5,
    config: CONFIG, maxShapeDisagreement: 0.005,
  });
  t.eq('a translation whose answer depends on the shape is refused', shapeRefused.ok, false);
  t.ok('...saying so in those terms', /disagree by/.test(shapeRefused.reason), shapeRefused.reason);
  t.ok('...and reporting the two numbers that disagreed',
    shapeRefused.shape_sensitivity.disagreement > 0.005, JSON.stringify(shapeRefused.shape_sensitivity));
  t.eq('...while the same translation passes at the configured default',
    A.translate({ market: 'Pitcher Strikeouts', bookLine: 3.5, bookProb, ppLine: 6.5, config: CONFIG }).ok, true);

  // =========================================================================
  // 10. Every refusal and every success is self-describing
  //
  // A caller must never have to guess which it got, or why.
  // =========================================================================
  for (const r of [tooFar, unknown, shapeRefused]) {
    t.eq('a refusal is marked ok:false with a null probability', [r.ok, r.prob], [false, null]);
    t.ok('...and carries a reason a human can act on', typeof r.reason === 'string' && r.reason.length > 30, r.reason);
  }
  t.ok('a success carries everything needed to reproduce it',
    ['distribution', 'fitted_parameter', 'implied_mean', 'sd', 'sigmas', 'book_prob', 'config_id']
      .every((k) => same[k] !== undefined), '');
}

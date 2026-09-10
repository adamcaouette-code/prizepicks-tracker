// The probability scoreboard — Brier, log loss, reliability, calibration slope.
//
// EVERY EXPECTED VALUE HERE IS COMPUTED INDEPENDENTLY OF THE CODE, and the
// arithmetic is shown. Three kinds:
//
//   hand arithmetic     Brier and log loss on four rows, done longhand.
//   published values    Wilson's interval for 8/10 is (0.4902, 0.9433) in every
//                       textbook that prints one.
//   ANALYTIC RECOVERY   the strongest of the three. Data is generated to be
//                       exactly consistent with a known slope and intercept —
//                       a perfect fit exists inside the model, so the maximum
//                       likelihood estimate must BE that fit. If the IRLS is
//                       wrong in any way, it cannot land on 0.500000000.
//
// That last one is the check that matters, because a calibration slope is
// exactly the kind of number that looks plausible while being wrong.

import * as S from '../../netlify/functions/scoreboard.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
// The rendered report is WRAPPED to a terminal width and the banners are drawn
// inside a box, so a sentence in it is routinely split across lines WITH A
// BORDER CHARACTER IN THE MIDDLE OF IT. Content assertions match against the
// collapsed text — the claim being tested is what the report SAYS, not where it
// happened to break the line or where the box edge landed.
const flat = (s) => s.replace(/[\u2502\u250c\u2510\u2514\u2518]/g, ' ').replace(/\s+/g, ' ');
/** n rows at probability p, of which exactly h are hits. */
const rep = (p, n, h) => Array.from({ length: n }, (_, i) => ({ p, y: i < h ? 1 : 0 }));

export default async function ({ t }) {
  // =========================================================================
  // 1. Brier and log loss, longhand
  //
  //   p=0.8 y=1 -> (0.8-1)^2 = 0.04     ln(0.8) = -0.2231436
  //   p=0.6 y=0 -> (0.6-0)^2 = 0.36     ln(0.4) = -0.9162907
  //   p=0.3 y=1 -> (0.3-1)^2 = 0.49     ln(0.3) = -1.2039728
  //   p=0.9 y=1 -> (0.9-1)^2 = 0.01     ln(0.9) = -0.1053605
  //                          -------              ----------
  //                  sum      0.90        sum     -2.4487676
  //                  /4       0.225       /4       0.6121919
  // =========================================================================
  const four = [{ p: 0.8, y: 1 }, { p: 0.6, y: 0 }, { p: 0.3, y: 1 }, { p: 0.9, y: 1 }];
  t.ok('Brier is the mean squared error: 0.90/4 = 0.225', near(S.brier(four), 0.225), String(S.brier(four)));
  t.ok('log loss is the mean negative log likelihood: 2.4487676/4 = 0.6121919',
    near(S.logLoss(four), 0.6121919007930318, 1e-12), String(S.logLoss(four)));

  // =========================================================================
  // 2. THE COIN IS A FIXED RULER
  //
  // Always-50% scores Brier (0.5-y)^2 = 0.25 and log loss -ln(0.5) = ln 2 for
  // EVERY outcome sequence there has ever been. It is not fitted to anything,
  // which is what makes it an unarguable floor: losing to it is not a subtle
  // finding about sample composition.
  // =========================================================================
  const coinA = S.coinBaseline(four);
  const coinB = S.coinBaseline([{ p: 0.1, y: 0 }, { p: 0.99, y: 0 }, { p: 0.2, y: 1 }]);
  t.ok('the coin scores exactly 0.25 on any rows', near(coinA.brier, 0.25) && near(coinB.brier, 0.25), '');
  t.ok('...and exactly ln 2 = 0.6931472 on log loss',
    near(coinA.logLoss, Math.LN2) && near(coinB.logLoss, Math.LN2), String(coinA.logLoss));

  // =========================================================================
  // 3. Wilson intervals
  //
  //   8/10 at 95%: (0.4902, 0.9433) — the published value.
  //     z^2 = 3.8416,  denom = 1 + 3.8416/10 = 1.38416
  //     centre = (0.8 + 0.19208)/1.38416          = 0.716738
  //     half   = (1.96/1.38416)*sqrt(0.016+0.009604) = 0.226555
  // =========================================================================
  const w = S.wilson(8, 10);
  t.ok('Wilson 8/10 lower bound is 0.4902', near(w.lo, 0.4902, 1e-4), w.lo.toFixed(6));
  t.ok('...and the upper is 0.9433', near(w.hi, 0.9433, 1e-4), w.hi.toFixed(6));

  // THE REASON IT IS WILSON. The normal interval on 12-for-12 is [1.0, 1.0] —
  // certainty from a dozen rows. That would mark the top bucket "meaningful"
  // the moment a lucky streak filled it, which is the exact failure this whole
  // report exists to prevent.
  const perfect = S.wilson(12, 12);
  t.ok('12-for-12 does NOT collapse to a point', perfect.lo < 0.8, `lo ${perfect.lo.toFixed(4)}`);
  t.ok('...and still reaches 1 at the top', near(perfect.hi, 1, 1e-9), String(perfect.hi));
  t.ok('an empty bucket has no interval at all, rather than a zero-width one',
    S.wilson(0, 0).lo === null, '');

  // =========================================================================
  // 4. How much data a bucket needs — requirement 5
  //
  //   n = z^2 p(1-p) / w^2
  //   at p=0.50, w=0.05: 3.8416*0.25/0.0025   = 384.16 -> 385
  //   at p=0.85, w=0.05: 3.8416*0.1275/0.0025 = 195.92 -> 196
  //
  // Evaluated at the BUCKET'S OWN probability, not at 0.5. Holding an 85%
  // bucket to the 50% bucket's bar would say it needs twice the data it does.
  // =========================================================================
  t.eq('a 50% bucket needs 385 rows for a ±5pp read', S.requiredN({}), 385);
  t.eq('an 85% bucket needs only 196', S.requiredN({ p: 0.85 }), 196);
  t.eq('a looser ±10pp target needs a quarter as many', S.requiredN({ halfWidth: 0.10 }), 97);
  t.ok('the numbers are large on purpose — separating 65% from 70% is expensive',
    S.requiredN({ p: 0.675, halfWidth: 0.025 }) > 1000, String(S.requiredN({ p: 0.675, halfWidth: 0.025 })));

  // =========================================================================
  // 5. The reliability curve
  // =========================================================================
  const curve = S.reliabilityCurve([
    ...rep(0.25, 40, 16),    // predicted 25%, observed 40% — under-called
    ...rep(0.85, 30, 21),    // predicted 85%, observed 70% — over-called
  ]);
  const b2 = curve[2], b8 = curve[8];
  t.eq('a 0.25 prediction lands in the 20-30% bucket', b2.label, '20-30%');
  t.eq('...with its n', b2.n, 40);
  t.ok('...predicted 25%, observed 40%', near(b2.predicted, 0.25) && near(b2.observed, 0.4), '');
  t.ok('...so the gap is +15.0pp', near(b2.gapPP, 15), String(b2.gapPP));
  t.eq('a 0.85 prediction lands in the 80-90% bucket', b8.label, '80-90%');
  t.ok('...with a negative gap: predicted 85%, observed 70%', near(b8.gapPP, -15), String(b8.gapPP));
  t.ok('empty buckets are still listed, so a hole in the curve is visible',
    curve.length === 10 && curve[0].n === 0 && curve[0].observed === null, '');

  // MEANINGFUL IS THE ACHIEVED INTERVAL, NOT THE ROW COUNT. 40 rows is nowhere
  // near the 385 a ±5pp read needs, and the flag has to say so.
  t.ok('40 rows in a bucket is not yet meaningful at ±5pp', b2.meaningful === false, '');
  //   at p=0.25: 3.8416 * 0.1875 / 0.0025 = 288.12 -> 289, so 249 short of 40.
  t.eq('...and the report says how far short it is: 289 needed, 249 to go', b2.requiredN - b2.n, 249);
  const big = S.reliabilityCurve(rep(0.45, 2000, 900))[4];
  t.ok('2000 rows in one bucket IS meaningful', big.meaningful === true, `half-width ${big.ci.halfWidth.toFixed(4)}`);

  // =========================================================================
  // 6. CALIBRATION SLOPE — ANALYTIC RECOVERY
  //
  // Data generated so that logit(true rate) = a + b*logit(predicted) holds
  // EXACTLY at every distinct prediction. A perfect fit then exists inside the
  // model, so the maximum likelihood estimate is that fit and nothing else.
  //
  //   b = 1, a = 0   predictions 0.25/0.50/0.75 hitting 25%/50%/75%
  //   b = 0.5        predictions 0.10/0.50/0.90 hitting 25%/50%/75%
  //                  because sigmoid(0.5*logit(0.9)) = sigmoid(1.0986) = 0.75
  //   b = 2          predictions 0.40/0.50/0.60 hitting 4/13, 1/2, 9/13
  //                  because sigmoid(2*ln(1.5)) = 2.25/3.25 = 9/13
  //   a = ln 2       predictions 0.20/0.50/0.80 hitting 1/3, 2/3, 8/9
  //                  because logit(2p/(1+p)) = ln 2 + logit(p)
  // =========================================================================
  const fitPerfect = S.calibrationFit([...rep(0.25, 100, 25), ...rep(0.5, 100, 50), ...rep(0.75, 100, 75)]);
  t.ok('a perfectly calibrated forecaster recovers slope 1.000000000',
    near(fitPerfect.slope, 1, 1e-8), fitPerfect.slope.toFixed(9));
  t.ok('...and intercept 0.000000000', near(fitPerfect.intercept, 0, 1e-8), fitPerfect.intercept.toFixed(9));
  t.ok('...and the fit converges', fitPerfect.converged === true, `${fitPerfect.iterations} iterations`);

  const over = S.calibrationFit([...rep(0.1, 200, 50), ...rep(0.5, 200, 100), ...rep(0.9, 200, 150)]);
  t.ok('a forecaster whose numbers are twice as extreme as reality recovers slope 0.5',
    near(over.slope, 0.5, 1e-8), over.slope.toFixed(9));
  t.ok('...with intercept 0', near(over.intercept, 0, 1e-8), over.intercept.toFixed(9));
  // REQUIREMENT 4: the interpretation must be in plain language, in the output.
  t.ok('...and the output says OVERCONFIDENT in plain words',
    /BELOW 1.*OVERCONFIDENT/.test(over.interpretation[0]), over.interpretation[0].slice(0, 60));
  t.ok('...and states what to do about it',
    /toward the base rate/.test(over.interpretation[0]), '');
  t.ok('...naming the corrected number: 75% really means 63%',
    /the truth is nearer 63%/.test(over.interpretation[0]), over.interpretation[0]);

  const under = S.calibrationFit([...rep(0.4, 1300, 400), ...rep(0.5, 1300, 650), ...rep(0.6, 1300, 900)]);
  t.ok('a timid forecaster recovers slope 2', near(under.slope, 2, 1e-8), under.slope.toFixed(9));
  t.ok('...and the output says UNDERCONFIDENT', /ABOVE 1.*UNDERCONFIDENT/.test(under.interpretation[0]), '');

  const biased = S.calibrationFit([...rep(0.2, 300, 100), ...rep(0.5, 300, 200), ...rep(0.8, 900, 800)]);
  t.ok('a flat upward bias recovers slope 1', near(biased.slope, 1, 1e-8), biased.slope.toFixed(9));
  t.ok('...and intercept ln 2 = 0.693147181', near(biased.intercept, Math.LN2, 1e-8), biased.intercept.toFixed(9));
  t.ok('...reported as a directional bias, not as overconfidence',
    biased.interpretation.some((l) => /flat UPWARD bias/.test(l)), '');

  // THE STANDARD ERROR IS THE POINT, and it is not a formality: on 30 rows a
  // slope of 0.479 has a 95% interval of [-0.58, 1.53], which contains both
  // "twice as overconfident as it looks" and "underconfident". The point
  // estimate on its own would read as a finding; the interval says there is
  // nothing here yet.
  //
  //   predictions 0.30/0.50/0.70 hitting 4/10, 5/10, 6/10 -> slope 0.479
  const thin = S.calibrationFit([...rep(0.3, 10, 4), ...rep(0.5, 10, 5), ...rep(0.7, 10, 6)]);
  t.ok('a thin sample gets a much wider interval on the slope',
    thin.slopeSe > over.slopeSe * 3, `${thin.slopeSe.toFixed(3)} vs ${over.slopeSe.toFixed(3)}`);
  t.ok('...so despite a slope of 0.479, 1.0 is inside the interval and nothing is claimed',
    thin.oneInsideCI === true, `CI [${thin.slopeCI.map((v) => v.toFixed(2)).join(', ')}]`);
  t.ok('...which the plain-language output says out loud',
    thin.interpretation.some((l) => /NOT yet distinguishable from perfect/.test(l)), '');
  t.ok('the 600-row sample IS distinguishable, and says so', over.oneInsideCI === false, '');
  t.ok('...naming it a real miscalibration',
    over.interpretation.some((l) => /real miscalibration, not sampling noise/.test(l)), '');

  t.ok('a single prediction repeated has no slope to fit, and refuses',
    S.calibrationFit(rep(0.5, 50, 25)).ok === false, S.calibrationFit(rep(0.5, 50, 25)).reason);
  t.ok('...naming the reason rather than returning a number',
    /no slope to fit/.test(S.calibrationFit(rep(0.5, 50, 25)).reason), '');
  t.ok('two rows will not be fitted either', S.calibrationFit([{ p: 0.4, y: 1 }, { p: 0.6, y: 0 }]).ok === false, '');

  // =========================================================================
  // 7. Murphy's decomposition — and the term the textbook version hides
  //
  // Brier = uncertainty - resolution + reliability is EXACT only for forecasts
  // taking finitely many values. Binning continuous ones leaves a residual, and
  // a decomposition whose parts do not sum to the whole is worse than none.
  // =========================================================================
  const mixed = [...rep(0.23, 50, 15), ...rep(0.27, 50, 12), ...rep(0.71, 60, 44), ...rep(0.88, 40, 35)];
  const d = S.decompose(mixed);
  t.ok('the printed decomposition actually sums to the Brier score it decomposes',
    near(d.brier, d.uncertainty - d.resolution + d.reliability + d.residual, 1e-12),
    `residual ${d.residual.toExponential(2)}`);
  t.ok('uncertainty is the base-rate variance', near(d.uncertainty, d.baseRate * (1 - d.baseRate)), '');
  // A forecaster who says one number about everything has zero resolution no
  // matter how well calibrated it is — the failure Brier alone cannot name.
  const flatModel = S.decompose(rep(0.5, 200, 100));
  t.ok('a model that says the same number about everything has zero resolution',
    near(flatModel.resolution, 0, 1e-12), String(flatModel.resolution));
  t.ok('...while being perfectly calibrated', near(flatModel.reliability, 0, 1e-12), String(flatModel.reliability));

  // =========================================================================
  // 8. The book baseline — requirement 6
  //
  // Scored on the INTERSECTION, with the model re-scored on those same rows.
  // The subset a book prices is not random: it is the liquid, heavily-modelled
  // markets, which are the hardest ones to beat. Scoring the model over
  // everything and the book over its subset would compare two different
  // questions and flatter whichever had the easier props.
  // =========================================================================
  const paired = [
    { p: 0.70, bookP: 0.55, y: 1 },
    { p: 0.30, bookP: 0.45, y: 0 },
    { p: 0.80, bookP: 0.60, y: 1 },
    { p: 0.20, bookP: 0.40, y: 0 },
    { p: 0.60, bookP: 0.50, y: 1 },
    { p: 0.65, bookP: 0.52, y: 1 },
    { p: 0.55, bookP: 0.90, y: 0 },     // the book was confidently wrong here
    { p: 0.50, bookP: 0.50, y: 1 },     // an exact tie, dropped from the sign test
  ];
  const bb = S.bookBaseline(paired);
  t.ok('the book baseline is available when prices exist', bb.available === true, '');
  t.eq('...scored on all eight paired rows', bb.n, 8);
  t.ok('...with the model winning here', bb.beatsBook === true, `${bb.model.brier.toFixed(4)} vs ${bb.book.brier.toFixed(4)}`);
  t.ok('...and a NEGATIVE delta meaning the model won, since Brier is a loss',
    bb.brierDelta < 0, String(bb.brierDelta));
  // The sign test is the guard against a mean carried by one row.
  t.eq('the sign test drops exact ties rather than splitting them', bb.signTest.decided, 7);
  t.eq('...counting the model better on 7 of 7 decided', bb.signTest.modelBetter, 7);

  //   Model on the intersection only: rows with no book price are excluded from
  //   BOTH sides, so the two numbers always describe the same props.
  const partial = [...paired, { p: 0.99, bookP: null, y: 0 }, { p: 0.98, y: 0 }];
  const bp = S.bookBaseline(partial);
  t.eq('rows with no book price are excluded from the head-to-head', bp.n, 8);
  t.ok('...so the model is not punished on the comparison for props no book covers',
    near(bp.model.brier, bb.model.brier), '');
  t.ok('...and the coverage shortfall is reported', near(bp.coverage, 8 / 10), String(bp.coverage));

  const none = S.bookBaseline([{ p: 0.6, y: 1 }, { p: 0.4, y: 0 }]);
  t.ok('with no book prices at all the baseline is unavailable, not zero',
    none.available === false && none.n === 0, '');
  t.ok('...and says why', /no graded prop has an archived book price/.test(none.reason), none.reason);

  // =========================================================================
  // 9. Breakdowns — requirement 3
  // =========================================================================
  const tagged = [
    ...rep(0.6, 40, 24).map((r) => ({ ...r, league: 'mlb', tier: 'standard', market: 'Strikeouts', date: '2026-09-10', loggedAt: '2026-09-10T12:00:00Z' })),
    ...rep(0.7, 10, 4).map((r) => ({ ...r, league: 'soccer', tier: 'demon', market: 'Shots On Target', date: '2026-09-12', loggedAt: '2026-09-10T12:00:00Z' })),
  ];
  const bySport = S.breakdown(tagged, (r) => r.league, { minN: 30 });
  t.eq('sports split out, biggest first', bySport.groups.map((g) => g.key), ['mlb', 'soccer']);
  t.ok('a group under the threshold is KEPT and marked thin, not dropped',
    bySport.groups[1].thin === true && bySport.groups[1].n === 10, '');
  t.ok('...because "this sport has 10 graded props" is itself the finding',
    bySport.groups[0].thin === false, '');

  //   Lead time comes from the game date minus the date the forecast was made.
  t.eq('a same-day forecast is 0 days out',
    S.daysToGame({ date: '2026-09-10', loggedAt: '2026-09-10T12:00:00Z' }), 0);
  t.eq('...and a Friday slate judged on Wednesday is 2',
    S.daysToGame({ date: '2026-09-12', loggedAt: '2026-09-10T12:00:00Z' }), 2);
  t.eq('which buckets as expected', S.leadTimeBucket(2), '2 days ahead');
  t.eq('...with everything further out together', S.leadTimeBucket(9), '3+ days ahead');
  t.eq('a forecast made after the game date is not negative days, it is same day',
    S.leadTimeBucket(S.daysToGame({ date: '2026-09-10', loggedAt: '2026-09-11T02:00:00Z' })), 'same day');
  const byLead = S.breakdown(tagged, (r) => S.leadTimeBucket(S.daysToGame(r)), { minN: 30 });
  t.eq('lead time splits', byLead.groups.map((g) => g.key).sort(), ['2 days ahead', 'same day']);

  // =========================================================================
  // 10. Ungraded rows are excluded everywhere, silently and consistently
  // =========================================================================
  const withPending = [...four, { p: 0.7, y: null }, { p: 0.7, y: undefined }, { p: null, y: 1 }];
  t.ok('a pending row does not change the Brier score', near(S.brier(withPending), 0.225), '');
  t.ok('...and is counted as not-yet-graded rather than dropped from the record',
    S.buildReport(withPending).counts.ungraded === 3, '');
  t.ok('a push (hit = null) cannot be scored as either outcome',
    S.scoreSet([{ p: 0.5, y: null }]).n === 0, '');

  // =========================================================================
  // 11. THE BANNER — requirement 6's "say so loudly at the top"
  // =========================================================================
  const losing = [
    { p: 0.90, bookP: 0.55, y: 0 }, { p: 0.85, bookP: 0.50, y: 0 },
    { p: 0.10, bookP: 0.48, y: 1 }, { p: 0.15, bookP: 0.52, y: 1 },
    { p: 0.88, bookP: 0.51, y: 0 }, { p: 0.12, bookP: 0.49, y: 1 },
  ];
  const losingText = flat(S.renderReport(S.buildReport(losing)));
  const firstBlock = flat(S.renderReport(S.buildReport(losing)).split('\n').slice(0, 14).join('\n'));
  t.ok('losing to the book is announced at the TOP, before any softening number',
    /THE MODEL DOES NOT BEAT THE BOOK/.test(firstBlock), '');
  t.ok('...and spells out the consequence for sizing',
    /sizing on it loses money faster/.test(losingText), '');
  t.ok('...stating both Brier scores so it can be checked', /0\.7\d{3}/.test(losingText), '');

  const winningText = flat(S.renderReport(S.buildReport(paired)));
  t.ok('beating the book gets a single quiet line, not a banner',
    /✓ Beats the book/.test(winningText) && !/DOES NOT BEAT/.test(winningText), '');

  const noBookText = flat(S.renderReport(S.buildReport([{ p: 0.6, y: 1 }, { p: 0.4, y: 0 }, { p: 0.7, y: 1 }])));
  t.ok('NO book baseline is its own loud warning — silence would read as a pass',
    /NO BOOK BASELINE/.test(noBookText), '');
  t.ok('...saying the central question is unanswered rather than implying success',
    /central question of this project is unanswered/.test(noBookText), '');
  t.ok('...and explicitly that beating a coin proves nothing',
    /Beating a coin is not evidence/.test(noBookText), '');

  // =========================================================================
  // 12. The report renders, end to end, without a clock
  // =========================================================================
  const full = S.buildReport(tagged, { meta: { pickLogRows: 60, afterDedupe: 50, joined: 50, mode: 'contemporaneous', captureCount: 0, closingCount: 0, bookPriced: 0, bookReasons: { 'no archived capture covers this prop': 50 }, ledger: { checked: 0, agreed: 0, disagreed: 0 } } });
  const text = S.renderReport(full);
  const flatText = flat(text);
  t.ok('the module has no clock of its own — the caller stamps the time',
    full.generated_at === null, '');
  t.ok('every section renders', ['SAMPLE', 'HEADLINE', 'CALIBRATION SLOPE', 'RELIABILITY CURVE',
    'BY SPORT', 'BY MARKET', 'BY LINE TYPE', 'BY DAYS UNTIL GAME', 'DATA INTEGRITY']
    .every((h) => text.includes(h)), '');
  t.ok('no line blows out the terminal width', text.split('\n').every((l) => l.length <= 100),
    String(Math.max(...text.split('\n').map((l) => l.length))));
  t.ok('the reasons a book price is missing are itemised, not just counted',
    /no archived capture covers this prop/.test(flatText), '');
  t.ok('and progress toward a meaningful bucket is shown as a bar',
    /█|░/.test(text), '');
}

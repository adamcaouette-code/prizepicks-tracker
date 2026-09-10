// Fair probability from bookmaker prices.
//
// Every expected value below is worked out by hand in the comment beside it,
// from the American odds, with no reference to what the code returns. That is
// the point: a de-vig test that asserts the function equals itself passes just
// as happily when the arithmetic is wrong, and a fair-probability module that
// is quietly 2 points off makes every edge in the app look better than it is.
//
// NO NETWORK. The module has no imports and no I/O; these are numbers in,
// numbers out.

// Imported directly — nothing to stub, so the harness would only prove itself.
import * as F from '../../netlify/functions/fair-odds.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export default async function ({ t }) {
  // =========================================================================
  // 1. American odds -> implied probability
  //
  //   negative:  -110  ->  110 / (110 + 100) = 110/210 = 0.5238095238…
  //   positive:  +150  ->  100 / (150 + 100) = 100/250 = 0.4
  //   even:      +100  ->  100 / (100 + 100) = 0.5
  // =========================================================================
  t.ok('-110 -> 110/210', near(F.americanToProb(-110), 110 / 210), String(F.americanToProb(-110)));
  t.ok('+150 -> 100/250 = 0.4', near(F.americanToProb(150), 0.4), String(F.americanToProb(150)));
  t.ok('+100 -> exactly 0.5', near(F.americanToProb(100), 0.5), String(F.americanToProb(100)));
  t.ok('-200 -> 200/300 = 0.6666…', near(F.americanToProb(-200), 2 / 3), String(F.americanToProb(-200)));

  // NULL, NEVER ZERO. A book that has not posted a side is not a book saying
  // the side cannot happen. bet-finder-background.js used to return 0 here and
  // clv.js returned null — the same function, two meanings, and a 0 flowing
  // into a probability sum is a silent certainty of losing.
  for (const bad of [null, undefined, '', 'x', 0, NaN, Infinity]) {
    t.eq(`a non-price (${JSON.stringify(bad)}) is null, not 0`, F.americanToProb(bad), null);
  }

  // Round trip: 0.4 -> +150 -> 0.4
  t.eq('probability -> American, favourite side', F.probToAmerican(2 / 3), -200);
  t.eq('...and longshot side', F.probToAmerican(0.4), 150);
  t.ok('...round trips', near(F.americanToProb(F.probToAmerican(0.4)), 0.4), '');
  t.eq('a probability of 0 or 1 has no American price', F.probToAmerican(0), null);

  // =========================================================================
  // 2. Hold
  //
  //   -110 / -110:  110/210 + 110/210 = 0.5238095 + 0.5238095 = 1.0476190
  //                 hold = 1.0476190 - 1 = 0.0476190  (4.7619%)
  // =========================================================================
  t.ok('a -110/-110 market holds 4.7619%',
    near(F.hold([110 / 210, 110 / 210]), 2 * (110 / 210) - 1), String(F.hold([110 / 210, 110 / 210])));

  // =========================================================================
  // 3. THE THREE METHODS ON A SYMMETRIC MARKET
  //
  //   -110 / -110, quoted 0.5238095 each, sum 1.0476190
  //
  //   multiplicative: 0.5238095 / 1.0476190 = 0.5
  //   additive:       0.5238095 - 0.0476190/2 = 0.5238095 - 0.0238095 = 0.5
  //   shin:           by symmetry, 0.5
  //
  // A fair coin priced with vig must come back a fair coin under every method.
  // =========================================================================
  const sym = [110 / 210, 110 / 210];
  for (const m of F.METHODS) {
    const d = F.devig(sym, m);
    t.ok(`${m}: a symmetric market is 50/50`, near(d.probs[0], 0.5) && near(d.probs[1], 0.5), JSON.stringify(d.probs));
    t.ok(`${m}: ...and sums to exactly 1`, near(d.probs[0] + d.probs[1], 1, 1e-12), '');
  }

  // =========================================================================
  // 4. THE THREE METHODS ON A FAVOURITE / LONGSHOT
  //
  //   -200 / +170
  //   quoted over  = 200/300 = 0.6666667
  //   quoted under = 100/270 = 0.3703704
  //   sum          = 1.0370370      hold = 3.70370%
  //
  //   multiplicative:
  //     over  = 0.6666667 / 1.0370370 = 0.6428571   (= 9/14)
  //     under = 0.3703704 / 1.0370370 = 0.3571429   (= 5/14)
  //
  //   additive: d = 0.0370370 / 2 = 0.0185185
  //     over  = 0.6666667 - 0.0185185 = 0.6481481   (= 35/54)
  //     under = 0.3703704 - 0.0185185 = 0.3518519   (= 19/54)
  //
  //   shin: identical to additive on a two-way market — see §5.
  //
  // The favourite is HIGHER under additive/Shin than under multiplicative
  // (0.6481 vs 0.6429). That gap is the favourite-longshot correction: taking
  // the same absolute margin off both sides shades the longshot down harder in
  // relative terms, which is why the default is shin.
  // =========================================================================
  const q = [F.americanToProb(-200), F.americanToProb(170)];
  const mult = F.devig(q, 'multiplicative');
  const add = F.devig(q, 'additive');
  const shin = F.devig(q, 'shin');

  t.ok('multiplicative: favourite = 9/14 = 0.642857', near(mult.probs[0], 9 / 14), String(mult.probs[0]));
  t.ok('multiplicative: longshot = 5/14 = 0.357143', near(mult.probs[1], 5 / 14), String(mult.probs[1]));
  t.ok('additive: favourite = 35/54 = 0.648148', near(add.probs[0], 35 / 54), String(add.probs[0]));
  t.ok('additive: longshot = 19/54 = 0.351852', near(add.probs[1], 19 / 54), String(add.probs[1]));
  t.ok('the hold is reported as 3.7037%, before removal', near(mult.hold, 1 / 27), String(mult.hold));

  t.ok('additive/Shin give the favourite MORE than multiplicative does',
    add.probs[0] - mult.probs[0] > 0.005, `${add.probs[0]} vs ${mult.probs[0]}`);
  t.ok('...which is the favourite-longshot correction, so the longshot gets less',
    add.probs[1] < mult.probs[1], `${add.probs[1]} vs ${mult.probs[1]}`);

  // Shin's z is reported, because a Shin number without its z cannot be checked.
  t.ok('shin reports the insider parameter it solved for', shin.z > 0 && shin.z < 1, String(shin.z));

  // =========================================================================
  // 5. SHIN === ADDITIVE ON ANY TWO-WAY MARKET
  //
  // Not an approximation — the same number. Shin's condition rearranges to
  //     p_i^2 + z*p_i*(1 - p_i) = pi_i^2 / PI
  // Writing the additive solution p_i = pi_i - d with d = (PI - 1)/2, and using
  // 1 - a + d = b - d for two outcomes, subtracting the two conditions gives
  //     (a - b) = (a - b) * PI / PI
  // which is an identity, true for any z. The remaining equation then fixes z.
  //
  // EVERY PLAYER PROP IS TWO-WAY. So on the only markets this app touches,
  // choosing Shin over additive changes nothing whatsoever, and the real choice
  // is multiplicative against the other two.
  // =========================================================================
  const sweep = [[-110, -110], [-150, 130], [-200, 170], [-350, 280], [-600, 425],
    [-1200, 800], [-2000, 1200], [105, -125], [130, -155]];
  let worst = 0;
  for (const [o1, o2] of sweep) {
    const qq = [F.americanToProb(o1), F.americanToProb(o2)];
    if (qq[0] + qq[1] <= 1) continue;
    const a = F.devig(qq, 'additive').probs;
    const s = F.devig(qq, 'shin').probs;
    worst = Math.max(worst, Math.abs(a[0] - s[0]), Math.abs(a[1] - s[1]));
  }
  t.ok('Shin and additive agree to machine precision on every two-way price tested',
    worst < 1e-12, `worst divergence ${worst.toExponential(3)}`);

  // =========================================================================
  // 6. THREE-WAY: where the methods genuinely part company
  //
  //   -110 / +240 / +280  (a soccer 1X2)
  //   quoted = 0.5238095, 0.2941176, 0.2631579   sum 1.0810851
  //
  //   multiplicative: 0.5238095/1.0810851 = 0.4845…
  //   additive: d = 0.0810851/3 = 0.0270284
  //             0.5238095 - 0.0270284 = 0.4967811
  //   shin:     0.4935…  — between the two, and equal to neither
  // =========================================================================
  const three = [F.americanToProb(-110), F.americanToProb(240), F.americanToProb(280)];
  const m3 = F.devig(three, 'multiplicative').probs;
  const a3 = F.devig(three, 'additive').probs;
  const s3 = F.devig(three, 'shin').probs;
  t.ok('multiplicative: 0.5238095/1.0810851 = 0.484522',
    near(m3[0], three[0] / three.reduce((x, y) => x + y, 0)), String(m3[0]));
  t.ok('additive: 0.5238095 - 0.0810851/3 = 0.496781', near(a3[0], three[0] - (three.reduce((x, y) => x + y, 0) - 1) / 3), String(a3[0]));
  t.ok('shin is a THIRD answer here, not a copy of either',
    Math.abs(s3[0] - a3[0]) > 1e-4 && Math.abs(s3[0] - m3[0]) > 1e-4,
    `shin ${s3[0]} vs add ${a3[0]} vs mult ${m3[0]}`);
  t.ok('...and it lies between them', s3[0] > m3[0] && s3[0] < a3[0], String(s3[0]));
  for (const [label, p] of [['mult', m3], ['add', a3], ['shin', s3]]) {
    t.ok(`${label}: three-way still sums to 1`, near(p.reduce((x, y) => x + y, 0), 1, 1e-12), '');
  }

  // =========================================================================
  // 7. Failure modes, each reported rather than guessed at
  // =========================================================================
  t.eq('a single outcome is not a market', F.devig([0.6], 'shin'), null);
  t.eq('a zero or negative quoted probability is refused', F.devig([0.6, 0], 'shin'), null);
  t.ok('an unknown method throws rather than silently picking one',
    (() => { try { F.devig(sym, 'kelly'); return false; } catch (e) { return /unknown de-vig method/.test(e.message); } })(), '');

  // Additive is the only method that can produce a negative probability: a fat
  // hold spread over a short longshot. It must not return one, and the fallback
  // must not masquerade as additive.
  //   three outcomes at 0.04, 0.04, 1.07 -> sum 1.15, d = 0.05 -> two go negative
  const breaks = F.devig([0.04, 0.04, 1.07], 'additive');
  t.eq('additive falls back rather than returning a negative probability', breaks.method, 'multiplicative');
  t.eq('...and says what was actually asked for', breaks.requestedMethod, 'additive');
  t.ok('...and why it could not deliver it', /non-positive/.test(breaks.fallback), breaks.fallback);
  t.ok('...with every probability positive', breaks.probs.every((p) => p > 0), JSON.stringify(breaks.probs));

  // A market with no overround has nothing to strip.
  const flat = F.devig([0.5, 0.5], 'shin');
  t.ok('a vig-free market comes back unchanged', near(flat.probs[0], 0.5), String(flat.probs[0]));
  t.ok('...with a hold of zero', near(flat.hold, 0), String(flat.hold));

  // =========================================================================
  // 8. WEIGHTED CONSENSUS
  //
  // Two books at the same line, de-vigged individually then averaged by weight.
  //
  //   pinnacle  -105 / -115   quoted 0.5121951 / 0.5348837  sum 1.0470788
  //             additive d = 0.0235394
  //             over = 0.5121951 - 0.0235394 = 0.4886557
  //
  //   draftkings -120 / +100  quoted 0.5454545 / 0.5        sum 1.0454545
  //             additive d = 0.0227273
  //             over = 0.5454545 - 0.0227273 = 0.5227273
  //
  //   weights pinnacle 1.0, draftkings 0.55  -> total 1.55
  //   consensus = (0.4886557*1.0 + 0.5227273*0.55) / 1.55
  //             = (0.4886557 + 0.2875000) / 1.55
  //             = 0.7761557 / 1.55 = 0.5007456
  // =========================================================================
  const config = {
    id: 'test-weights',
    default_method: 'shin',
    disagreement_threshold: 0.04,
    line_disagreement_threshold: 0.5,
    weights: { pinnacle: 1.0, draftkings: 0.55, fanduel: 0.55, prizepicks: 0 },
    unknown_book_weight: 0.3,
  };
  const pinOver = F.americanToProb(-105) - (F.americanToProb(-105) + F.americanToProb(-115) - 1) / 2;
  const dkOver = F.americanToProb(-120) - (F.americanToProb(-120) + F.americanToProb(100) - 1) / 2;
  const expected = (pinOver * 1.0 + dkOver * 0.55) / 1.55;

  const cons = F.fairFromBooks([
    { book: 'pinnacle', line: 1.5, over_price: -105, under_price: -115 },
    { book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 },
  ], { config });

  t.ok('the consensus is the weight-weighted mean of the de-vigged books',
    near(cons.fairProb, expected), `${cons.fairProb} vs ${expected}`);
  t.eq('...at the line they agree on', cons.fairLine, 1.5);
  t.eq('...counting the books that contributed', cons.bookCount, 2);
  t.ok('...and reporting the raw hold before removal', cons.hold > 0.04 && cons.hold < 0.05, String(cons.hold));
  t.eq('...with a fair American price', cons.fairAmerican, F.probToAmerican(cons.fairProb));
  t.eq('...and which weight table produced it, so it can be rebuilt', cons.configId, 'test-weights');

  // The sharp book must actually move the answer more than the soft one.
  const dkOnly = F.fairFromBooks([{ book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 }], { config });
  t.ok('the consensus sits nearer the higher-weighted book than the unweighted mean would',
    Math.abs(cons.fairProb - pinOver) < Math.abs(cons.fairProb - dkOnly.fairProb),
    `${cons.fairProb}: pin ${pinOver}, dk ${dkOnly.fairProb}`);

  // A book weighted 0 is EXCLUDED and says so — PrizePicks has no two-way
  // price and is the thing being measured, so folding it into the consensus it
  // is measured against would put the answer inside the question.
  const withPP = F.fairFromBooks([
    { book: 'pinnacle', line: 1.5, over_price: -105, under_price: -115 },
    { book: 'prizepicks', line: 1.5, over_price: -119, under_price: -119 },
  ], { config });
  t.eq('a zero-weighted book does not enter the consensus', withPP.bookCount, 1);
  t.ok('...and is listed with the reason',
    withPP.perBook.find((b) => b.book === 'prizepicks').excluded === 'weight 0 in config', '');

  // An unrecognised book counts, at a low weight, and is visible.
  const unknown = F.fairFromBooks([
    { book: 'pinnacle', line: 1.5, over_price: -105, under_price: -115 },
    { book: 'brandnewbook', line: 1.5, over_price: -120, under_price: 100 },
  ], { config });
  t.eq('an unknown book still contributes', unknown.bookCount, 2);
  t.eq('...at the configured unknown weight',
    unknown.perBook.find((b) => b.book === 'brandnewbook').weight, 0.3);

  // A one-sided quote has no vig to remove, so no fair probability — recorded,
  // not dropped, because "was there but half-priced" differs from "not there".
  const oneSided = F.fairFromBooks([
    { book: 'pinnacle', line: 1.5, over_price: -105, under_price: -115 },
    { book: 'fanduel', line: 1.5, over_price: -120, under_price: null },
  ], { config });
  t.eq('a one-sided book is excluded from the consensus', oneSided.bookCount, 1);
  t.ok('...with its reason on the record',
    /one side/.test(oneSided.perBook.find((b) => b.book === 'fanduel').excluded), '');

  t.eq('no two-way price anywhere means no fair probability, and a reason',
    F.fairFromBooks([{ book: 'fanduel', line: 1.5, over_price: -120, under_price: null }], { config }).unpriced,
    'no book posted a two-way price');

  // =========================================================================
  // 9. LINES ARE NOT INTERCHANGEABLE
  //
  // Two books quoting 1.5 and 2.5 are pricing different questions. Averaging
  // their probabilities produces a number that answers neither, so each line
  // gets its own consensus and the heaviest-weighted line is the headline.
  // =========================================================================
  const split = F.fairFromBooks([
    { book: 'pinnacle', line: 1.5, over_price: -105, under_price: -115 },
    { book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 },
    { book: 'fanduel', line: 2.5, over_price: 180, under_price: -220 },
  ], { config });
  t.eq('the headline line is the one carrying the most weight', split.fairLine, 1.5);
  t.eq('...priced only from the books actually on it', split.bookCount, 2);
  t.eq('...with the others counted separately, not blended in', split.bookCountOtherLines, 1);
  t.ok('...and each line reported on its own terms',
    split.byLine.length === 2 && split.byLine.every((g) => g.fairProb > 0), JSON.stringify(split.byLine.map((g) => g.line)));
  t.ok('the 1.5 consensus is unchanged by the presence of a 2.5 book',
    near(split.fairProb, expected), `${split.fairProb} vs ${expected}`);

  // =========================================================================
  // 10. DISAGREEMENT — surfaced, never smoothed
  //
  // A book several points off the rest is either a stale quote nobody has taken
  // down or a book that knows something. Those need opposite responses, so the
  // flag reports which books and by how much and leaves the judgement alone.
  // =========================================================================
  const calm = F.fairFromBooks([
    { book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 },
    { book: 'fanduel', line: 1.5, over_price: -122, under_price: 102 },
  ], { config });
  t.eq('books that agree raise no flag', calm.disagrees, false);
  t.eq('...and the flag field is null rather than an empty array', calm.disagreement, null);

  // -120/+100 de-vigs to ~0.5227 and +140/-170 to ~0.4098 — about 11 points
  // apart, far past the 0.04 threshold.
  const wild = F.fairFromBooks([
    { book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 },
    { book: 'fanduel', line: 1.5, over_price: 140, under_price: -170 },
  ], { config });
  t.eq('books that disagree past the threshold are flagged', wild.disagrees, true);
  const probFlag = wild.disagreement.find((f) => f.kind === 'probability');
  t.ok('...with the size of the gap', probFlag.spread > 0.10, String(probFlag.spread));
  t.eq('...the threshold it broke', probFlag.threshold, 0.04);
  t.eq('...and which books, so a stale quote can be told from a sharp one',
    probFlag.detail.map((d) => d.book).sort(), ['draftkings', 'fanduel']);

  // The threshold is configurable, and per call.
  t.eq('a looser threshold quiets the same market',
    F.fairFromBooks([
      { book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 },
      { book: 'fanduel', line: 1.5, over_price: 140, under_price: -170 },
    ], { config, threshold: 0.5 }).disagrees, false);

  // Books on different lines is its own kind of disagreement.
  const lineFlag = split.disagreement?.find((f) => f.kind === 'line');
  t.ok('books sitting on different lines is flagged separately', !!lineFlag, JSON.stringify(split.disagreement));
  t.eq('...reporting the spread between them', lineFlag.spread, 1);

  // A single book cannot disagree with itself.
  t.eq('one book raises no probability flag', dkOnly.disagrees, false);

  // =========================================================================
  // 11. Method is configurable, and the default comes from the config
  // =========================================================================
  t.eq('the config supplies the default method', cons.method, 'shin');
  t.eq('...and an explicit method overrides it',
    F.fairFromBooks([{ book: 'draftkings', line: 1.5, over_price: -120, under_price: 100 }],
      { config, method: 'multiplicative' }).method, 'multiplicative');
  t.ok('...and the answer actually changes with it',
    !near(
      F.fairFromBooks([{ book: 'pinnacle', line: 1.5, over_price: -300, under_price: 240 }], { config, method: 'multiplicative' }).fairProb,
      F.fairFromBooks([{ book: 'pinnacle', line: 1.5, over_price: -300, under_price: 240 }], { config, method: 'shin' }).fairProb,
    ), '');

  // =========================================================================
  // 12. The archive shape
  //
  // Rows keep their raw book prices AND gain a fair block. The stored number is
  // a cache of a pure function; the raw prices are what make the computation
  // reconstructible with a different method or a corrected weight table later.
  // =========================================================================
  const rows = F.fairForRows([
    { player: 'A', market: 'Hits', pp_line: 0.5, books: [
      { book: 'draftkings', line: 0.5, over_price: -160, under_price: 130 },
      { book: 'fanduel', line: 0.5, over_price: -155, under_price: 125 },
    ] },
    { player: 'B', market: 'Pitches Thrown', pp_line: 88.5, books: [] },
  ], { config });

  t.ok('a priced row gets a fair probability', rows[0].fair.prob > 0 && rows[0].fair.prob < 1, String(rows[0].fair.prob));
  t.eq('...the line it belongs to', rows[0].fair.line, 0.5);
  t.eq('...how many books contributed', rows[0].fair.book_count, 2);
  t.ok('...the raw hold', rows[0].fair.hold > 0, String(rows[0].fair.hold));
  t.eq('...and the method and weight table used, so it can be rebuilt exactly',
    [rows[0].fair.method, rows[0].fair.config_id], ['shin', 'test-weights']);
  t.ok('the raw book prices are still on the row — the real reconstructibility',
    rows[0].books.length === 2 && rows[0].books[0].over_price === -160, '');

  t.eq('a row no book priced still appears, with a null and a reason',
    [rows[1].fair.prob, rows[1].fair.unpriced], [null, 'no book posted a two-way price']);
  t.eq('...and its PrizePicks line is untouched', rows[1].pp_line, 88.5);

  // Recomputing from the archived row must reproduce the stored number exactly
  // — that is what "reconstructible later" has to mean.
  t.ok('recomputing from the archived prices reproduces the stored value',
    near(F.fairFromBooks(rows[0].books, { config }).fairProb, rows[0].fair.prob), '');
  t.ok('...and a different method against the same instant gives a real, different answer',
    !near(F.fairFromBooks(rows[0].books, { config, method: 'multiplicative' }).fairProb, rows[0].fair.prob), '');
}

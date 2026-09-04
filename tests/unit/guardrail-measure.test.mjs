// Making the edge guardrail answerable.
//
// v4.34.0 stopped the auto-slip taking a leg whose own edge is negative — a bet
// the payout says loses even when the judge's probability is exactly right.
// That is a real behaviour change made on an argument, and nothing on the
// calibration page could score it. Worse, waiting for `edgeVerdict` rows to
// accumulate would have meant months before the change could be checked.
//
// It doesn't have to wait. Edge is a function of the probability and the tier,
// both of which every row in the log already carries, so the split runs over the
// whole graded history as a counterfactual: of everything the engine ever called
// a play or a lean, how did the ones the guardrail would have KEPT do against
// the ones it would have REFUSED?
//
// What is pinned here is that the reconstruction is EXACT where it claims to be
// and REFUSES where it isn't — a guessed edge would invent the very quantity
// being tested, and the guardrail would then be measuring its own assumption.

import { loadFn } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

const DAY = '2026-08-14';
const BE = { goblin: 2 ** (-1 / 3), standard: 4.75 ** (-1 / 3), demon: 12 ** (-1 / 3) };

let seq = 0;
const mk = (o) => ({
  date: DAY, loggedAt: `${DAY}T18:00:00Z`, league: 'mlb', source: 'board',
  projectionId: `p${seq}`, player: `P${seq++}`, stat: 'Hits', line: 0.5,
  verdict: 'play', oddsType: 'standard', gradedAt: `${DAY}T23:00:00Z`,
  result: o.hit ? 1 : 0, ...o,
});
const many = (n, o) => Array.from({ length: n }, (_, i) => mk({ ...o, hit: i < (o.hits ?? 0) }));

const runCal = async (rows) => {
  reset();
  seed('pick-log', DAY, rows);
  const cal = await loadFn('calibration.js');
  return {
    json: JSON.parse((await cal.handler({ queryStringParameters: { format: 'json' } })).body),
    html: (await cal.handler({ queryStringParameters: {} })).body,
  };
};

export default async function ({ t }) {
  // ---- 1. the counterfactual split ---------------------------------------
  // 100 goblins at 0.70 — above the flat 0.62 cutoff that made them plays, and
  // 9.4 points BELOW the 79.4% a goblin needs. The guardrail refuses all of
  // them. 100 standards at 0.70, which clears 59.5%, it keeps.
  const { json, html } = await runCal([
    ...many(100, { oddsType: 'goblin', prob: 0.70, hits: 66 }),
    ...many(100, { oddsType: 'standard', prob: 0.70, hits: 66 }),
    // A demon UNDER. PrizePicks' odds_type prices the OVER only, so this side's
    // payout — and therefore its edge — is genuinely unknown.
    ...many(20, { oddsType: 'demon', side: 'under', prob: 0.30, hits: 6 }),
    // Passes must not enter the split at all: a bet never made is not money
    // saved, and counting them would flatter whichever side they landed in.
    ...many(50, { oddsType: 'goblin', prob: 0.20, verdict: 'pass', hits: 40 }),
  ]);
  const g = json.guardrail;

  t.eq('every play and lean is sorted, and nothing else is',
    g.kept.n + g.refused.n + g.unpriced.n, 220);
  t.eq('a goblin at 70% is refused — it needs 79.4%', g.refused.n, 100);
  t.eq('a standard at the same 70% is kept — it needs 59.5%', g.kept.n, 100);
  t.eq('a side whose payout is unknown is neither', g.unpriced.n, 20);

  // The bar, not the raw rate, is what makes the two rows comparable: both
  // buckets hit exactly 66%, and one is a catastrophe while the other is money.
  t.eq('both buckets hit the identical 66%', [g.kept.rate, g.refused.rate], [0.66, 0.66]);
  t.ok('...but each is scored against its own break-even',
    Math.abs(g.refused.needed - BE.goblin) < 1e-9 && Math.abs(g.kept.needed - BE.standard) < 1e-9,
    `${g.refused.needed} / ${g.kept.needed}`);
  t.ok('the refused legs are far under their bar', g.refused.deltaPP < -13, String(g.refused.deltaPP));
  t.ok('the kept legs are comfortably over theirs', g.kept.deltaPP > 6, String(g.kept.deltaPP));

  // The number that says whether the guardrail earns its keep.
  t.ok('refusing them avoids a heavily losing slip', g.refused.ev < -0.35, String(g.refused.ev));
  t.ok('...while what it keeps is a winning one', g.kept.ev > 0.35, String(g.kept.ev));

  // Significance is measured against "these hit exactly break-even", not against
  // the observed rate — otherwise an 0-for-40 run would look infinitely certain.
  const se = Math.sqrt((BE.goblin * (1 - BE.goblin)) / 100);
  t.ok('sigma is computed under the break-even null',
    Math.abs(g.refused.sigma - (0.66 - BE.goblin) / se) < 1e-9, String(g.refused.sigma));

  // ---- 2. the reconstruction refuses to guess ----------------------------
  // The one case that must stay null. A goblin/demon UNDER has no known payout,
  // so filling in a break-even would manufacture the answer.
  t.eq('an unpriced side is never assigned an edge', g.unpriced.needed, null);
  t.eq('...and gets no verdict from a bar it does not have', g.unpriced.deltaPP, null);

  // ---- 2b. a recommended UNDER is scored on the under -------------------
  // `prob` is P(over) and `hit` is "the over cleared" throughout this file. A
  // recommended under that LANDS shows up in the log as hit=false, and counting
  // that as a loss inverts the measurement on exactly the picks being judged.
  // 60 standard unders at sideProb 0.70, of which 45 landed — so the over
  // cleared only 15 times.
  const unders = await runCal(
    many(60, { oddsType: 'standard', side: 'under', prob: 0.30, sideProb: 0.70,
      edge: 0.70 - BE.standard, hits: 15 }),
  );
  const u = unders.json.guardrail.kept;
  t.eq('a landed under counts as a win, not a loss', u.hits, 45);
  t.eq('...at the rate the under actually hit', Math.round(u.rate * 100) / 100, 0.75);
  t.ok('...against the under\'s own break-even, derived from its logged edge',
    Math.abs(u.needed - BE.standard) < 1e-9, String(u.needed));

  // A row that carries a REAL edge uses it rather than being reconstructed —
  // that is the whole point of logging the field.
  const explicit = await runCal([
    // prob says this standard is a keep; the logged edge says otherwise, and the
    // logged edge is the one the app actually acted on.
    ...many(60, { oddsType: 'standard', prob: 0.70, edge: -0.04, hits: 40 }),
  ]);
  t.eq('a logged edge beats reconstructing one from the probability',
    explicit.json.guardrail.refused.n, 60);
  t.eq('...so nothing lands in kept', explicit.json.guardrail.kept.n, 0);

  // ---- 3. the forward-looking field, kept separate ------------------------
  // A reconstruction is evidence about a decision, not a measurement of one.
  const fwd = await runCal([
    ...many(30, { oddsType: 'standard', prob: 0.70, edge: 0.10, edgeVerdict: 'play', hits: 20 }),
    ...many(30, { oddsType: 'goblin', prob: 0.70, edge: -0.09, edgeVerdict: 'pass', hits: 20 }),
    ...many(40, { oddsType: 'standard', prob: 0.70, hits: 25 }),   // pre-v4.34.0
  ]);
  t.eq('rows carrying the field are split by it',
    [fwd.json.byEdgeVerdict.play?.n, fwd.json.byEdgeVerdict.pass?.n], [30, 30]);
  t.eq('rows logged before the field existed say so rather than reading as passes',
    fwd.json.byEdgeVerdict.untagged?.n, 40);

  // ---- 4. deep dive, scored on Brier ------------------------------------
  // The deep dive's claim is that an undivided look produces a BETTER
  // probability, so the number that settles it is Brier. Its hit rate can't:
  // deep-dive rows are the picks the screen already liked most.
  const deep = await runCal([
    ...many(50, { oddsType: 'standard', prob: 0.90, deepDive: false, hits: 25 }),  // wildly overconfident
    ...many(50, { oddsType: 'standard', prob: 0.55, deepDive: true, hits: 25 }),   // honest
  ]);
  t.ok('the honest stage scores the better Brier even at the same hit rate',
    deep.json.byDeepDive.deep.brier < deep.json.byDeepDive.shallow.brier,
    `${deep.json.byDeepDive.deep.brier} vs ${deep.json.byDeepDive.shallow.brier}`);
  t.eq('both stages hit identically, which is exactly why hit rate cannot decide it',
    [deep.json.byDeepDive.deep.rate, deep.json.byDeepDive.shallow.rate], [0.5, 0.5]);
  t.eq('a row with no deepDive field reads as the stage-1 screen it was',
    (await runCal(many(10, { oddsType: 'standard', prob: 0.6, hits: 5 })))
      .json.byDeepDive.shallow.n, 10);

  // ---- 4b. the paired test, which is the only one that can decide it ------
  // Deep vs shallow ROWS compares two different sets of picks, and not a fair
  // pair — the deep set exists because the screen liked it most. Same pick,
  // same game, two probabilities is immune to that.
  const paired = await runCal([
    // 40 picks the screen called 0.80 and the second look cut to 0.55. 20 hit.
    // The second look is much closer to the truth on every one of them.
    ...many(40, { oddsType: 'standard', prob: 0.55, shallowProb: 0.80, deepDive: true, hits: 20 }),
    // Shallow rows carry no shallowProb and must not enter the pair.
    ...many(60, { oddsType: 'standard', prob: 0.55, deepDive: false, hits: 30 }),
  ]);
  const dp = paired.json.deepPaired;
  t.eq('only deep-dive rows carrying both numbers are paired', dp.n, 40);
  t.ok('the second look scores the better Brier on the same picks',
    dp.deepBrier < dp.shallowBrier, `${dp.deepBrier} vs ${dp.shallowBrier}`);
  t.eq('...and the move it made is reported, not just the result',
    Math.round(dp.meanMove * 1000) / 1000, 0.25);
  // The sign test answers a DIFFERENT question from the Brier gap, and this
  // case is the clearest illustration of why both are reported.
  //
  // Cutting 0.80 to 0.55 is pure honesty about the level: it improves the
  // average penalty a lot. But per pick it helps on exactly the ones that miss
  // and hurts on exactly the ones that hit, so at a true rate of 50% it lands
  // closer on precisely half. 20 of 40 is the CORRECT answer here, not a bug —
  // "better calibrated" and "right more often" are not the same claim, and a
  // page that collapsed them would let either one launder the other.
  t.eq('a pure honesty correction wins on Brier and ties on the sign test',
    [dp.closer, dp.decided], [20, 40]);
  t.ok('...so the sign test correctly reports no per-pick edge',
    Math.abs(dp.sigma) < 1e-9, String(dp.sigma));

  // Real discrimination — the second look moving toward the actual outcome
  // rather than just toward the middle — is what the sign test does detect.
  const sharp = await runCal(Array.from({ length: 40 }, (_, i) => mk({
    oddsType: 'standard', deepDive: true, shallowProb: 0.50,
    prob: i < 20 ? 0.90 : 0.10, hit: i < 20,
  })));
  t.eq('a second look that actually discriminates lands closer on every pick',
    [sharp.json.deepPaired.closer, sharp.json.deepPaired.decided], [40, 40]);
  t.ok('...which a coin flip does not do 40 times running',
    sharp.json.deepPaired.sigma > 6, String(sharp.json.deepPaired.sigma));

  // The honest case: a second look that moves numbers the WRONG way must show
  // as worse, not be smoothed into a null result.
  const worse = await runCal(Array.from({ length: 40 }, (_, i) => mk({
    oddsType: 'standard', deepDive: true, shallowProb: 0.50,
    prob: i < 20 ? 0.10 : 0.90, hit: i < 20,
  })));
  t.ok('a second look that makes the number worse is reported as worse',
    worse.json.deepPaired.brierDelta > 0, String(worse.json.deepPaired.brierDelta));
  t.eq('...and lands closer on none of them', worse.json.deepPaired.closer, 0);
  t.ok('...at the same strength, in the other direction',
    worse.json.deepPaired.sigma < -6, String(worse.json.deepPaired.sigma));

  // Ties are excluded rather than counted as half — a pick the second look
  // didn't move is not evidence either way.
  const tied = await runCal(
    many(20, { oddsType: 'standard', prob: 0.60, shallowProb: 0.60, deepDive: true, hits: 10 }),
  );
  t.eq('a pick the second look left alone is not counted as evidence',
    [tied.json.deepPaired.n, tied.json.deepPaired.decided], [20, 0]);
  t.eq('...so no verdict is manufactured from it', tied.json.deepPaired.sigma, null);

  // An UNDER's shallowProb is P(over) exactly as prob is, so it takes the same
  // flip — otherwise the pair compares two different sides of the same line.
  const pairedUnder = await runCal(
    many(30, { oddsType: 'standard', side: 'under', prob: 0.20, sideProb: 0.80,
      shallowProb: 0.45, edge: 0.80 - BE.standard, deepDive: true, hits: 6 }),
  );
  // shallow said P(under)=0.55, deep said 0.80, and the under landed 24/30.
  t.ok('an under is paired on the under, not the over',
    pairedUnder.json.deepPaired.deepBrier < pairedUnder.json.deepPaired.shallowBrier,
    `${pairedUnder.json.deepPaired.deepBrier} vs ${pairedUnder.json.deepPaired.shallowBrier}`);

  // With no paired rows yet, the page must say so rather than let the confounded
  // row comparison read as the answer.
  t.ok('an empty paired test is flagged, not quietly omitted',
    deep.html.includes('The paired test has no rows yet'), '');

  // ---- 5. the page says all of it out loud -------------------------------
  t.ok('the page shows the guardrail split', html.includes('The edge guardrail'), '');
  t.ok('...states what the picks needed, not just what they hit',
    html.includes('<th>needed</th>'), '');
  t.ok('...and names it a counterfactual rather than a measurement',
    /counterfactual/i.test(html), '');
  t.ok('the deep dive section leads with Brier, not win rate',
    html.includes('Deep dive — is the second look worth it?')
    && /read the\s+Brier gap, not the hit rate/.test(html), '');

  // A verdict on a handful of rows is a claim the sample can't support.
  const thin = await runCal(many(12, { oddsType: 'goblin', prob: 0.70, hits: 4 }));
  t.ok('a thin bucket is greyed rather than coloured as a finding',
    thin.html.includes('color:var(--dim)'), '');

  // The page must not let the two deep-dive statistics launder each other.
  t.ok('the page states that Brier and the sign test can honestly disagree',
    /answer different questions and can honestly disagree/.test(paired.html), '');
  t.ok('...and says which one is evidence of extra knowledge',
    /right more often/.test(paired.html) && /less overconfident/.test(paired.html), '');
}

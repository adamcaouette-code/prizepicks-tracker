// The buyer-facing performance report.
//
// This one is held to a different standard than the rest of the suite. Everything
// else here is for the user; this output goes in front of someone deciding
// whether to buy the app. An overstated number is not a bug you notice later —
// it is a claim someone acts on. So the tests below are mostly about what the
// report must REFUSE to imply.

import {
  wilson, rate, breakEvenPerLeg, flattenPicks, weekKey, analyse, renderMarkdown,
} from '../../scripts/generate-buyer-report.mjs';

const pick = (o = {}) => ({
  date: '2026-08-10', loggedAt: '2026-08-10T18:00:00Z', league: 'mlb', source: 'board',
  projectionId: `p${Math.random()}`, player: 'A Player', stat: 'Hits', line: 0.5,
  prob: 0.65, verdict: 'play', oddsType: 'standard',
  result: 1, hit: true, gradedAt: '2026-08-10T23:00:00Z', gradedVia: 'mlb', ...o,
});

export default async function ({ t }) {
  // ---- Wilson, because the normal approximation lies at these sample sizes --
  const perfect = wilson(10, 10);
  t.ok('a 10-for-10 record does NOT report as certainty', perfect.lo < 0.95,
    `lower bound ${(perfect.lo * 100).toFixed(1)}%`);
  t.eq('...and never exceeds 1', perfect.hi, 1);
  const none = wilson(0, 10);
  t.ok('0-for-10 does not report a floor of zero either', none.hi > 0.05);
  t.ok('...and never drops below 0', none.lo >= 0);
  t.ok('a bigger sample gives a tighter interval — the whole point',
    wilson(60, 100).width < wilson(6, 10).width);
  t.ok('a 50% rate on n=4 is essentially uninformative', wilson(2, 4).width > 0.6,
    `width ${(wilson(2, 4).width * 100).toFixed(0)}pts`);

  // ---- break-even, so a raw percentage is never read as good on its own ----
  t.ok('a 3-pick goblin Power needs ~79% per leg to break even',
    Math.abs(breakEvenPerLeg('goblin', 3) - 0.7937) < 0.001, String(breakEvenPerLeg('goblin', 3)));
  t.ok('a 3-pick standard Power needs only ~59%',
    Math.abs(breakEvenPerLeg('standard', 3) - 0.5946) < 0.001);
  t.ok('goblin break-even is far higher than standard — a 65% goblin rate LOSES money',
    breakEvenPerLeg('goblin', 3) > breakEvenPerLeg('standard', 3));
  t.eq('an unpriced combination returns null rather than a guess', breakEvenPerLeg('demon', 2), null);

  // ---- the low-confidence gate --------------------------------------------
  t.eq('a small sample is flagged', rate(8, 10, 30).lowConfidence, true);
  t.eq('...and a large one is not', rate(80, 100, 30).lowConfidence, false);
  t.eq('no data is flagged, not reported as zero percent', rate(0, 0, 30).rate, null);

  // ---- dedupe: a re-run must not inflate the sample ------------------------
  // The engine re-logs a whole day when it runs again. Counting those twice
  // would double the apparent sample size, which is the most flattering
  // possible error and therefore the one to guard hardest.
  const dupes = flattenPicks({
    '2026-08-10': [
      pick({ projectionId: 'X1', hit: true }),
      pick({ projectionId: 'X1', hit: true }),
      pick({ projectionId: 'X1', hit: null, result: null }),
      pick({ projectionId: 'X2', hit: false, result: 0 }),
    ],
  });
  t.eq('re-logged copies of one pick collapse to a single row', dupes.length, 2);
  t.eq('...keeping the graded copy over the ungraded one',
    dupes.filter((p) => p.hit === true).length, 1);

  t.eq('ISO weeks are Monday-anchored', weekKey('2026-08-10'), weekKey('2026-08-16'));
  t.ok('...and roll to the next week on Monday', weekKey('2026-08-17') !== weekKey('2026-08-16'));

  // ---- unders are not silently counted as losses --------------------------
  // `hit` means the OVER cleared. A recommended under that came in has hit=false
  // and is a WIN. Counting raw hits would understate the engine on every under.
  const withUnders = analyse({
    pickLog: { '2026-08-10': [
      pick({ projectionId: 'U1', prob: 0.30, hit: false, result: 0 }),   // under, won
      pick({ projectionId: 'U2', prob: 0.30, hit: true, result: 3 }),    // under, lost
      pick({ projectionId: 'O1', prob: 0.70, hit: true, result: 3 }),    // over, won
      pick({ projectionId: 'O2', prob: 0.70, hit: false, result: 0 }),   // over, lost
    ] },
    savedSlips: {}, costLog: {},
  }, { minN: 30 });
  t.eq('a directional win rate counts a winning under as a win', withUnders.legLevel.all.rate, 0.5);
  t.eq('...while the raw over-hit rate is reported separately, not conflated',
    withUnders.legLevel.overHitRate.rate, 0.5);
  const allUnders = analyse({
    pickLog: { '2026-08-10': [
      pick({ projectionId: 'A', prob: 0.2, hit: false }),
      pick({ projectionId: 'B', prob: 0.2, hit: false }),
    ] },
    savedSlips: {}, costLog: {},
  }, { minN: 30 });
  t.eq('two winning unders read as 100% directionally', allUnders.legLevel.all.rate, 1);
  t.eq('...and as 0% on the raw over measure — the two must never be swapped',
    allUnders.legLevel.overHitRate.rate, 0);

  // ---- ungraded picks are excluded, and coverage is surfaced --------------
  const partial = analyse({
    pickLog: { '2026-08-10': [
      pick({ projectionId: 'G1', hit: true }),
      pick({ projectionId: 'G2', hit: false, result: 0 }),
      pick({ projectionId: 'N1', hit: null, result: null, gradedAt: null }),
      pick({ projectionId: 'N2', hit: null, result: null, gradedAt: null, league: 'tennis' }),
    ] },
    savedSlips: {}, costLog: {},
  }, { minN: 30 });
  t.eq('ungraded picks are not counted as losses', partial.legLevel.all.n, 2);
  t.eq('...and coverage is reported so the gap is visible', partial.coverage.picksLogged, 4);
  t.ok('...at 50%', Math.abs(partial.coverage.gradingCoverage - 0.5) < 1e-9);
  t.eq('a league that never grades is shown with zero coverage',
    partial.coverage.byLeague.tennis.coverage, 0);

  // ---- recommendations vs everything scanned ------------------------------
  const mixed = analyse({
    pickLog: { '2026-08-10': [
      pick({ projectionId: 'P1', verdict: 'play', hit: true }),
      pick({ projectionId: 'P2', verdict: 'lean', hit: true }),
      pick({ projectionId: 'P3', verdict: 'pass', hit: false, result: 0 }),
    ] },
    savedSlips: {}, costLog: {},
  }, { minN: 30 });
  t.eq('a passed prop does not count toward the recommended rate', mixed.legLevel.recommended.n, 2);
  t.eq('...though it still appears in the all-graded figure', mixed.legLevel.all.n, 3);
  t.eq('high-conviction plays are separable from leans', mixed.legLevel.playsOnly.n, 1);

  // ---- the report must not present a thin sample as a track record --------
  const thin = analyse({
    pickLog: { '2026-08-10': [pick({ projectionId: 'T1' }), pick({ projectionId: 'T2' })] },
    savedSlips: {}, costLog: {},
  }, { minN: 30 });
  const thinMd = renderMarkdown(thin);
  t.eq('a 2-for-2 record is 100% on the arithmetic', thin.legLevel.all.rate, 1);
  t.ok('...but the interval published beside it is honest about the range',
    thin.legLevel.all.lo < 0.5, `lower bound ${(thin.legLevel.all.lo * 100).toFixed(1)}%`);
  t.ok('...and it is explicitly marked LOW CONFIDENCE', /LOW CONFIDENCE/.test(thinMd));
  t.ok('...with the caveat stated before any number is shown',
    thinMd.indexOf('Read this first') < thinMd.indexOf('## 1.'));
  t.ok('the reconstructed-side limitation is disclosed', /side is not stored/i.test(thinMd));
  t.ok('the retention limit on slips is disclosed', /deleted after/i.test(thinMd));
  t.ok('grading coverage is stated up front, not buried', /Grading coverage is/.test(thinMd));

  // ---- slips: retention makes this a snapshot, and it must say so ---------
  const noSlips = renderMarkdown(analyse({ pickLog: {}, savedSlips: {}, costLog: {} }, { minN: 30 }));
  t.ok('with no retained slips, the section says why rather than showing nothing',
    /cannot be used as a historical slip record/i.test(noSlips));

  const slipped = analyse({
    pickLog: {}, costLog: {},
    savedSlips: {
      a: { id: 'a', slateDate: '2026-08-14', entry: 'power', stake: 10, payout: 47.5, status: 'won',
        legs: [{}, {}, {}] },
      b: { id: 'b', slateDate: '2026-08-14', entry: 'power', stake: 10, payout: 0, status: 'lost',
        legs: [{}, {}, {}] },
      c: { id: 'c', slateDate: '2026-08-15', entry: 'power', stake: 10, payout: null, status: 'pending',
        legs: [{}, {}] },
      d: { id: 'd', slateDate: '2026-08-15', entry: 'power', stake: 10, payout: null, status: 'ungradeable',
        legs: [{}, {}] },
    },
  }, { minN: 30 });
  t.eq('only settled slips count toward a slip win rate', slipped.slipLevel.settled, 2);
  t.eq('...pending ones are not counted as losses', slipped.slipLevel.pending, 1);
  t.eq('...nor are ungradeable ones', slipped.slipLevel.ungradeable, 1);
  t.eq('slips are broken out by parlay size', slipped.slipLevel.bySize['3'].n, 2);
  t.eq('...with real money in and out', slipped.slipLevel.bySize['3'].staked, 20);
  t.eq('...and net computed from actual payouts', slipped.slipLevel.bySize['3'].net, 27.5);
  t.ok('...and ROI stated as a rate', Math.abs(slipped.slipLevel.bySize['3'].roi - 1.375) < 1e-9);
  t.ok('...against the break-even that size needs',
    slipped.slipLevel.bySize['3'].breakEvenPerLeg > 0.59);

  // ---- cost ----------------------------------------------------------------
  const costed = analyse({
    pickLog: {}, savedSlips: {},
    costLog: {
      '2026-08-14': [
        { at: '2026-08-14T10:00Z', feature: 'bet-finder', model: 'claude-opus-4-8', inTok: 50000, outTok: 4000, searches: 3, usd: 0.38 },
        { at: '2026-08-14T10:01Z', feature: 'bet-finder-research', model: 'claude-sonnet-5', inTok: 20000, outTok: 2000, searches: 1, usd: 0.09 },
      ],
      '2026-08-15': [
        { at: '2026-08-15T10:00Z', feature: 'bet-finder', model: 'claude-opus-4-8', inTok: 60000, outTok: 5000, searches: 2, usd: 0.44 },
      ],
    },
  }, { minN: 30 });
  t.ok('total spend adds up', Math.abs(costed.cost.totalUsd - 0.91) < 1e-6);
  t.eq('calls are counted', costed.cost.calls, 3);
  t.ok('cost is grouped per feature', costed.cost.byFeature['bet-finder'].calls === 2);
  // The one that matters: an "analysis" is a RUN, not an API call. The engine
  // makes several calls per run, so per-call cost understates a run badly.
  t.eq('cost per analysis is measured per run-day, not per API call', costed.cost.analysisDays, 2);
  t.ok('...so it exceeds the naive per-call figure',
    costed.cost.avgPerAnalysisDayUsd > costed.cost.avgPerCallUsd,
    `run ${costed.cost.avgPerAnalysisDayUsd} vs call ${costed.cost.avgPerCallUsd}`);
  t.ok('token totals are carried through', costed.cost.tokens.in === 130000);
  const costMd = renderMarkdown(costed);
  t.ok('the pricing table is disclosed as hand-maintained, not authoritative',
    /Verify against the Anthropic console/i.test(costMd));

  // ---- the report is read-only over its inputs ----------------------------
  const input = { pickLog: { '2026-08-10': [pick({ projectionId: 'Z1' })] }, savedSlips: {}, costLog: {} };
  const before = JSON.stringify(input);
  analyse(input, { minN: 30 });
  t.eq('analysing does not mutate the data it was given', JSON.stringify(input), before);

  // ---- a full render survives real-shaped data ---------------------------
  const full = analyse({
    pickLog: {
      '2026-08-03': Array.from({ length: 40 }, (_, i) =>
        pick({ projectionId: `w1-${i}`, date: '2026-08-03', hit: i % 3 !== 0, oddsType: i % 5 === 0 ? 'goblin' : 'standard' })),
      '2026-08-10': Array.from({ length: 40 }, (_, i) =>
        pick({ projectionId: `w2-${i}`, date: '2026-08-10', league: i % 2 ? 'nba' : 'mlb', hit: i % 2 === 0 })),
    },
    savedSlips: {}, costLog: {},
  }, { minN: 30 });
  const fullMd = renderMarkdown(full);
  t.eq('a realistic sample aggregates', full.legLevel.all.n, 80);
  t.ok('the trend shows both weeks separately so variance is visible',
    Object.keys(full.byWeek).length === 2, Object.keys(full.byWeek).join(', '));
  t.ok('a usable sample is NOT flagged low-confidence', !full.legLevel.all.lowConfidence);
  t.ok('every requested section is present', ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.']
    .every((h) => fullMd.includes(h)));
  t.ok('tier break-even sits beside the tier win rate', /Break-even \(3-pick Power\)/.test(fullMd));
  t.ok('...and the goblin row carries its own higher bar', /GOBLIN/.test(fullMd));
  t.ok('the markdown has no unresolved template holes', !/undefined|NaN|\[object/.test(fullMd));
}

// The variant-test analysis (Phase 1 of THEMIS, or any future tail-only
// variant): standout replication, move distribution, tier-calibration
// survival, and rank correlation against the real original. All pure
// functions — the live k-call path is exercised in
// tests/unit/judge-variant-endpoint.test.mjs.

import {
  runVariant, pairwiseAll, standoutReplication, standoutMoveDistribution,
  tierCalibration, rankCorrelation,
} from '../../netlify/functions/variant-lib.js';
import { comparePair } from '../../netlify/functions/replay-lib.js';

const TIER_RATES = { goblin: 0.70, standard: 0.45, demon: 0.20 };

const pick = (player, prob, tier, standout) => ({
  player, stat: 'Hits', line: 0.5, prob, oddsType: tier, standout,
});
const run = (label, picks) => ({ label, picks });

export default async function ({ t }) {
  // ---- standout replication: perfect agreement -----------------------------
  const sameThree = () => [
    pick('A', 0.85, 'goblin', true), pick('B', 0.30, 'demon', true), pick('C', 0.60, 'standard', true),
    pick('D', 0.70, 'goblin', false), pick('E', 0.45, 'standard', false),
  ];
  const perfectRuns = Array.from({ length: 5 }, (_, i) => run(`run-${i + 1}`, sameThree()));
  const perfect = standoutReplication(perfectRuns, 60);
  t.eq('identical standout sets give Jaccard 1 on every pair', perfect.pairJaccard, Array(10).fill(1));
  t.eq('...and the mean is 1', perfect.meanPairJaccard, 1);
  t.eq('...every flagged prop appears in the k/k bucket', perfect.histogram[5], 3);
  t.eq('...and nowhere else', perfect.histogram[1] + perfect.histogram[2] + perfect.histogram[3] + perfect.histogram[4], 0);
  t.eq('the verdict calls it well above chance', perfect.verdict, 'replicates well above the chance baseline');

  // ---- standout replication: disjoint sets (chance-level) ------------------
  const disjointRuns = Array.from({ length: 5 }, (_, i) => run(`run-${i + 1}`, [
    pick(`P${i}`, 0.85, 'goblin', true),          // a DIFFERENT single prop flagged each run
    pick('Common', 0.50, 'standard', false),
  ]));
  const disjoint = standoutReplication(disjointRuns, 60);
  t.eq('disjoint standout sets give Jaccard 0 on every pair', disjoint.pairJaccard, Array(10).fill(0));
  t.eq('...flagged props each appear in exactly the 1/k bucket', disjoint.histogram[1], 5);
  t.ok('the verdict does not overclaim replication', disjoint.verdict.includes('chance baseline'));

  // ---- standout replication: nobody flagged anything -----------------------
  const flatRuns = Array.from({ length: 5 }, (_, i) => run(`run-${i + 1}`, [
    pick('A', 0.70, 'goblin', false), pick('B', 0.45, 'standard', false),
  ]));
  const flat = standoutReplication(flatRuns, 60);
  t.eq('no standouts anywhere gives no pairwise Jaccard to average', flat.meanPairJaccard, null);
  t.eq('...an honest, explicit verdict, not a fabricated number', flat.verdict, 'no standouts flagged in any run — nothing to replicate');

  // ---- the random baseline is the ratio of expectations, disclosed as one --
  // n=3 flagged out of N=60 candidates each run: E[|A∩B|] = n²/N = 9/60 = 0.15,
  // E[|A∪B|] = 2n − 0.15 = 5.85, so expectedRandomJaccard = 0.15/5.85.
  t.ok('the random baseline matches the stated hypergeometric approximation',
    Math.abs(perfect.expectedRandomJaccard - (0.15 / 5.85)) < 1e-9, String(perfect.expectedRandomJaccard));

  // ---- standout move distribution ------------------------------------------
  const moveRuns = [run('r1', [
    pick('A', 0.85, 'goblin', true),    // |0.85-0.70| = 0.15
    pick('B', 0.10, 'demon', true),     // |0.10-0.20| = 0.10
    pick('C', 0.72, 'goblin', false),   // not a standout — excluded
    pick('D', 0.50, 'unknownTier', true), // unmapped tier rate — excluded
  ])];
  const moves = standoutMoveDistribution(moveRuns, TIER_RATES);
  t.eq('only flagged standouts with a known tier rate are counted', moves.n, 2);
  t.ok('the mean move is between the two observed values',
    Math.abs(moves.mean - 0.125) < 1e-9, String(moves.mean));
  t.ok('min and max bracket the observed moves',
    Math.abs(moves.min - 0.10) < 1e-9 && Math.abs(moves.max - 0.15) < 1e-9, JSON.stringify([moves.min, moves.max]));

  // The judge's OWN output never carries a tier — it is not in the requested
  // schema — so the real call site always falls back to the snapshot's
  // player+stat+line -> tier map. A fixture with oddsType already set would
  // never exercise that fallback, which is exactly how this shipped broken
  // the first time: every real move came back excluded, silently, with n=0.
  const bareRun = [run('r1', [
    { player: 'E', stat: 'Hits', line: 0.5, prob: 0.85, standout: true },   // no oddsType at all
  ])];
  const tiersMap = { 'E|Hits|0.5': 'goblin' };
  const viaTiersMap = standoutMoveDistribution(bareRun, TIER_RATES, tiersMap);
  t.eq('a tier resolved from the snapshot map is still counted', viaTiersMap.n, 1);
  t.ok('...at the right distance from that tier\'s rate',
    Math.abs(viaTiersMap.mean - 0.15) < 1e-9, String(viaTiersMap.mean));
  t.eq('...and without the map, the same picks resolve to nothing',
    standoutMoveDistribution(bareRun, TIER_RATES, {}).n, 0);

  // ---- tier calibration survival -------------------------------------------
  const calRuns = [run('r1', [
    pick('A', 0.72, 'goblin', false), pick('B', 0.68, 'goblin', false),   // mean 0.70, dead on
    pick('C', 0.30, 'demon', false),                                      // 0.10 above the 0.20 rate
  ])];
  const cal = tierCalibration(calRuns, TIER_RATES, {});
  t.ok('goblin mean matches the tier rate almost exactly', Math.abs(cal[0].byTier.goblin.diff) < 0.01, String(cal[0].byTier.goblin.diff));
  t.ok('demon shows the drift above its rate', Math.abs(cal[0].byTier.demon.diff - 0.10) < 1e-9, String(cal[0].byTier.demon.diff));
  t.eq('a tier with nothing logged this run reports zero, not a guess', cal[0].byTier.standard.n, 0);
  t.eq('...and no fabricated mean', cal[0].byTier.standard.meanProb, null);

  // ---- rank correlation, on RANKS not raw values ----------------------------
  const original = run('original', [pick('A', 0.90), pick('B', 0.60), pick('C', 0.30)]);
  const sameOrder = run('themis', [pick('A', 0.55), pick('B', 0.52), pick('C', 0.10)]); // different values, same order
  const reversed = run('themis-rev', [pick('A', 0.10), pick('B', 0.50), pick('C', 0.90)]);
  t.eq('the same rank order correlates perfectly, even with different raw values',
    rankCorrelation(original, sameOrder).spearman, 1);
  t.eq('a fully reversed order anti-correlates', rankCorrelation(original, reversed).spearman, -1);
  t.eq('only shared props are compared', rankCorrelation(original,
    run('partial', [pick('A', 0.9), pick('B', 0.6)])).n, 2);

  // ---- pairwiseAll: every pair exactly once ---------------------------------
  const five = Array.from({ length: 5 }, (_, i) => run(`r${i}`, [pick('A', 0.5 + i * 0.01)]));
  const all = pairwiseAll(five);
  t.eq('5 runs give C(5,2)=10 pairs', all.length, 10);
  t.eq('...matching what comparePair itself would report for that pair',
    JSON.stringify(all[0]), JSON.stringify(comparePair(five[0], five[1])));

  // ---- runVariant: fixed payload/search, system swapped to the variant -----
  const snap = { league: 'mlb', userContent: 'PAYLOAD', search: [], maxSearches: 2, model: 'claude-haiku-4-5-20251001' };
  const fakeVariant = { name: 'testvariant', promptFor: (league) => `SYSTEM FOR ${league}` };
  let sentReq = null, calls = 0;
  const out = await runVariant(snap, fakeVariant, { k: 3, key: 'x', call: async (req) => {
    sentReq = req; calls++;
    return { content: [{ type: 'text', text: JSON.stringify({ picks: [{ player: 'A', stat: 'Hits', line: 0.5, prob: 0.6 }] }) }], usage: {} };
  } });
  t.eq('k independent calls are made', calls, 3);
  t.eq('the system prompt comes from the VARIANT, not the snapshot', sentReq.system, 'SYSTEM FOR mlb');
  t.eq('...while the payload is carried over unchanged', sentReq.messages[0].content, 'PAYLOAD');
  t.eq('none of the k runs is privileged as "original"', out.runs.map((r) => r.label), ['run-1', 'run-2', 'run-3']);
  t.eq('the variant name rides along in the result', out.variant, 'testvariant');

  // ---- runVariant excludes a run that broke offline replay -----------------
  // This is the exact failure THEMIS hit live: run-2 issued a search instead
  // of using the replayed context. It must not become a silent data point in
  // standoutReplication/tierCalibration/rankCorrelation — it measures the
  // harness breaking, not the variant.
  let n2 = 0;
  const withLeak = await runVariant(snap, fakeVariant, { k: 3, key: 'x', call: async () => {
    n2++;
    const okContent = [{ type: 'text', text: JSON.stringify({ picks: [{ player: 'A', stat: 'Hits', line: 0.5, prob: 0.6 }] }) }];
    const leakedContent = [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
      ...okContent,
    ];
    return { content: n2 === 2 ? leakedContent : okContent, usage: {} };
  } });
  t.eq('the leaking run is dropped from runs', withLeak.runs.map((r) => r.label), ['run-1', 'run-3']);
  t.eq('...named in excluded, with why', withLeak.excluded, [{ label: 'run-2', reason: 'issued 1 live search(es) — not an offline replay' }]);
  t.ok('...and warned about too', /run-2 issued 1 live search/.test(withLeak.warnings[0] || ''));
  t.eq('kRequested still reflects what was actually asked for', withLeak.kRequested, 3);
}

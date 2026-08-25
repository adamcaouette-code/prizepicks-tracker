// The replay harness, and specifically the A/A test it has to pass first.
//
// Task 3's objective is within-tier discrimination and the realized hit rate of
// the picks a run would actually have selected. Both are measured through this
// harness, so the harness has to be measured first — and the two things worth
// knowing are whether it reproduces the original call at all, and how far two
// IDENTICAL runs drift from each other. A variant difference smaller than that
// drift is not a finding.
//
// Everything here runs against a stubbed API. The point is the analysis: given
// runs that differ in a known way, does the report say so.

import {
  buildRequest, analyse, comparePair, behaviour, topN, recommendK, replay, searchesIssued,
} from '../../netlify/functions/replay-lib.js';

const SEARCH = [
  { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'CIN lineup' } },
  { type: 'web_search_tool_result', tool_use_id: 'srv_1',
    content: [{ encrypted_content: 'LINEUP-TEXT' }] },
];

const PROPS = {
  'pp-0': { matchup: 'CIN vs PIT', entry: { player: 'Alpha', stat: 'Hits', line: 0.5, tier: 'goblin' } },
  'pp-1': { matchup: 'CIN vs PIT', entry: { player: 'Beta', stat: 'Hits', line: 1.5, tier: 'demon' } },
  'pp-2': { matchup: 'CIN vs PIT', entry: { player: 'Gamma', stat: 'Hits', line: 1.5, tier: 'standard' } },
};

const picksText = (probs) => JSON.stringify({ picks: [
  { player: 'Alpha', stat: 'Hits', line: 0.5, prob: probs[0], cleared: 4, key_risk: 'k', reasoning: 'r' },
  { player: 'Beta', stat: 'Hits', line: 1.5, prob: probs[1], cleared: 1, key_risk: 'k', reasoning: 'r' },
  { player: 'Gamma', stat: 'Hits', line: 1.5, prob: probs[2], cleared: 3, key_risk: 'k', reasoning: 'r' },
] });

const SNAP = {
  runId: 'aa-1', at: '2026-08-25T18:00:00Z', league: 'mlb',
  promptVersion: 'aphrodite', model: 'claude-haiku-4-5-20251001', maxSearches: 2,
  system: 'SYSTEM PROMPT', userContent: 'League: MLB\n{...}',
  props: PROPS, search: SEARCH, searchBytes: 100, searchTruncated: 0, replayable: true,
  responseText: picksText([0.72, 0.18, 0.55]),
};

const run = (label, probs) => ({ label, picks: JSON.parse(picksText(probs)).picks });

export default async function ({ t }) {
  // ---- the call is rebuilt, not re-issued --------------------------------
  const req = buildRequest(SNAP);
  t.eq('the replay sends the stored system prompt, not a fresh one', req.system, SNAP.system);
  t.eq('...and the exact payload bytes', req.messages[0].content, SNAP.userContent);
  t.eq('...at the model the original ran on', req.model, SNAP.model);
  // The search turn is prefilled so the model continues from the same point
  // with the same text. Re-running the searches live would read different pages
  // — which is the whole reason the snapshot exists.
  t.eq('the search turn is replayed as an assistant prefill, not searched again',
    req.messages[1].role, 'assistant');
  t.eq('...carrying the query and its result, in order',
    req.messages[1].content.map((b) => b.type), ['server_tool_use', 'web_search_tool_result']);
  t.ok('the tool stays declared so the prefilled blocks validate',
    req.tools[0].name === 'web_search' && req.tools[0].max_uses === 2);
  t.eq('a new live search is detectable, since it would not be a replay',
    searchesIssued([...SEARCH, { type: 'text', text: 'x' }]), 1);

  // ---- ITEM H: a truncated snapshot is refused, not degraded --------------
  let refused = null;
  try {
    await replay({ ...SNAP, searchTruncated: 4, replayable: false }, { k: 1, key: 'x', call: async () => { throw new Error('should never be called'); } });
  } catch (e) { refused = e.message; }
  t.ok('a snapshot that hit the search cap is refused', /not replayable/.test(refused || ''), refused);
  t.ok('...saying how much context is missing', /4 search blocks/.test(refused || ''), refused);
  // ...and on the truncation count alone, for snapshots written before the flag
  // existed. The flag is a convenience; the count is the fact.
  let untagged = null;
  try {
    await replay({ ...SNAP, searchTruncated: 4, replayable: undefined },
      { k: 1, key: 'x', call: async () => { throw new Error('should never be called'); } });
  } catch (e) { untagged = e.message; }
  t.ok('a snapshot from before the flag is refused on its truncation count',
    /not replayable/.test(untagged || ''), untagged);

  // A snapshot with no stored response has nothing to compare a replay to.
  let noBase = null;
  try {
    await replay({ ...SNAP, responseText: '' }, { k: 1, key: 'x', call: async () => ({ content: [] }) });
  } catch (e) { noBase = e.message; }
  t.ok('a snapshot with no stored response is refused too',
    /no parseable responseText/.test(noBase || ''), noBase);

  // ---- per-pick comparison ------------------------------------------------
  const same = comparePair(run('a', [0.72, 0.18, 0.55]), run('b', [0.72, 0.18, 0.55]));
  t.eq('two identical runs differ by nothing', same.meanAbsDiff, 0);
  t.eq('...and rank the same props in the same order', same.topN[0].churn, 0);
  t.eq('...on every prop, none missing', [same.shared, same.onlyInA, same.onlyInB], [3, 0, 0]);

  const drift = comparePair(run('a', [0.72, 0.18, 0.55]), run('b', [0.70, 0.22, 0.53]));
  t.ok('a small drift is reported as a small mean absolute difference',
    Math.abs(drift.meanAbsDiff - 0.02667) < 1e-4, String(drift.meanAbsDiff));
  t.ok('...and the ordering survives it', drift.topN[0].churn === 0);

  // Ranking churn is the number that matters for selection: the probabilities
  // can move a little and still change which props get bet.
  const flipped = comparePair(run('a', [0.72, 0.18, 0.55]), run('b', [0.50, 0.60, 0.55]));
  const top1 = flipped.topN.find((x) => x.n === 3);
  t.eq('a reordering with the same three props still shares all three', top1.shared, 3);
  // ...but the pick a 1-leg cut would have taken is a different prop, which is
  // what ranking churn is actually about: the probabilities moved a little and
  // the bet changed.
  t.eq('the best pick of one run', topN(run('a', [0.9, 0.1, 0.5]).picks, 1), ['Alpha|Hits|0.5']);
  t.eq('...is not the best pick of the other', topN(run('b', [0.1, 0.9, 0.5]).picks, 1), ['Beta|Hits|1.5']);

  // A run that dropped a prop is counted, not folded into the spread — a
  // missing answer is a different failure from a distant one.
  const short = comparePair(run('a', [0.72, 0.18, 0.55]),
    { label: 'b', picks: JSON.parse(picksText([0.72, 0.18, 0.55])).picks.slice(0, 2) });
  t.eq('a prop one run never answered is reported as missing', [short.shared, short.onlyInA], [2, 1]);
  t.eq('...and does not move the difference between the ones both answered', short.meanAbsDiff, 0);

  // ---- behaviour, on the same axis calibration uses -----------------------
  const tiers = {};
  for (const e of Object.values(PROPS)) tiers[`${e.entry.player}|${e.entry.stat}|${Number(e.entry.line)}`] = e.entry.tier;
  const b = behaviour(run('a', [0.72, 0.18, 0.55]).picks, tiers);
  t.ok('mean probability is reported', Math.abs(b.meanProb - 0.48333) < 1e-4, String(b.meanProb));
  t.ok('...and the tier gap, goblin minus demon, as calibration defines it',
    Math.abs(b.tierGap - 0.54) < 1e-9, String(b.tierGap));
  // 0.55 lands on a multiple of 0.05; 0.72 and 0.18 do not.
  t.ok('...and the share of round numbers', Math.abs(b.roundShare - (1 / 3)) < 1e-9, String(b.roundShare));

  // ---- FIDELITY: replay-vs-original against replay-vs-replay -------------
  // The replays here agree closely with each other and sit well away from the
  // original — the signature of a harness that is reproducing SOMETHING
  // consistently, just not the original call.
  const broken = analyse([
    run('original', [0.72, 0.18, 0.55]),
    run('replay-1', [0.50, 0.50, 0.50]),
    run('replay-2', [0.51, 0.49, 0.50]),
  ], tiers);
  t.ok('a harness that reproduces itself but not the original is flagged',
    broken.fidelity.verdict.startsWith('SUSPECT'), broken.fidelity.verdict);
  t.ok('...with the two spreads side by side, so the claim is checkable',
    broken.fidelity.replayVsOriginal > broken.fidelity.replayVsReplay,
    `${broken.fidelity.replayVsOriginal} vs ${broken.fidelity.replayVsReplay}`);

  const honest = analyse([
    run('original', [0.72, 0.18, 0.55]),
    run('replay-1', [0.74, 0.16, 0.57]),
    run('replay-2', [0.70, 0.20, 0.53]),
  ], tiers);
  t.eq('scatter of the same size in both directions is called noise, not a fault',
    honest.fidelity.verdict, 'consistent with sampling noise');

  // ---- the noise floor, and what k it implies ----------------------------
  t.ok('the floor is measured replay-against-replay, never against the original',
    honest.noiseFloor.meanAbsDiffPerPick > 0);
  t.eq('...over every pair of replays', honest.vsEachOther.length, 1);
  t.eq('...and k is reported as the number of replays actually run', honest.k, 2);

  // k >= 8 * (sd/target)^2. The arithmetic is the whole claim: chasing an effect
  // the same size as the noise costs eight runs an arm, and halving the target
  // quadruples that.
  t.eq('a noise floor equal to the target needs eight runs an arm', recommendK(0.02, 0.02), 8);
  t.eq('...half the target, four times the runs', recommendK(0.02, 0.01), 32);
  t.eq('...and a floor well under the target needs one', recommendK(0.002, 0.02), 1);
  t.eq('an unmeasurable floor recommends nothing rather than guessing', recommendK(0, 0.02), null);

  // ---- end to end against a stubbed API ----------------------------------
  let sentReq = null, n = 0;
  const report = await replay(SNAP, { k: 3, key: 'test-key', call: async (req2) => {
    sentReq = req2; n++;
    // A little jitter, as a real judge at default temperature would produce.
    const j = [0, 0.02, -0.02][n - 1];
    return { content: [{ type: 'text', text: picksText([0.72 + j, 0.18 - j, 0.55 + j]) }], usage: {} };
  } });
  t.eq('k replays means k calls', n, 3);
  t.eq('...all sending the identical rebuilt request', sentReq.system, SNAP.system);
  t.eq('the original is the baseline, not a fourth replay', report.behaviour[0].label, 'original');
  t.eq('...and every replay is reported beside it', report.behaviour.length, 4);
  t.eq('the run being replayed is named in the report', report.runId, 'aa-1');
  t.eq('...along with which judge and model it was', [report.promptVersion, report.model],
    ['aphrodite', 'claude-haiku-4-5-20251001']);
  t.eq('three replays give three pairs to measure the floor from', report.vsEachOther.length, 3);
  t.ok('a k is recommended from the measured floor', report.recommendedK.k >= 1,
    JSON.stringify(report.recommendedK));

  // A replay that goes and searches again has read text the original never saw.
  const warned = await replay(SNAP, { k: 1, key: 'test-key', call: async () => ({
    content: [...SEARCH, { type: 'text', text: picksText([0.72, 0.18, 0.55]) }], usage: {},
  }) });
  t.ok('a replay that issued a live search is reported, not quietly averaged in',
    /issued 1 live search/.test(warned.warnings[0] || ''), JSON.stringify(warned.warnings));
}

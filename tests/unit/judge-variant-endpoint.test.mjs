// The server-side wrapper around variant-lib.js's Phase 1 test —
// judge-variant-background.js / judge-variant-status.js. Same platform
// constraint as judge-replay-background.js: Netlify discards this handler's
// return value for any *-background function, so every exit path (a bad
// variant name, a missing snapshot, an unreplayable one) has to be observable
// through the job store, not the HTTP response.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const props = (rows) => ({
  data: rows.map((r, i) => ({
    id: `pp-${i}`, type: 'projection',
    attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: r.line,
      odds_type: r.tier || 'standard', description: r.opp || 'OPP',
      start_time: new Date().toISOString(), today: true },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team, position: 'OF', market: r.team } })),
  meta: { total_pages: 1 },
});
const ROWS = [
  { player: 'Alpha', team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' },
  { player: 'Beta', team: 'PIT', line: 1.5, opp: 'CIN', tier: 'demon' },
];
const ORIGINAL_PICKS = [
  { player: 'Alpha', stat: 'Hits', line: 0.5, prob: 0.72, cleared: 3, key_risk: 'k', reasoning: 'r' },
  { player: 'Beta', stat: 'Hits', line: 1.5, prob: 0.22, cleared: 1, key_risk: 'k', reasoning: 'r' },
];

async function seedRealSnapshot(runId) {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ picks: ORIGINAL_PICKS }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    // tiers must be explicit: the default candidate filter is goblin/standard
    // only, and Beta (demon) would otherwise be silently dropped before it ever
    // reaches the judge — which is exactly the bug this fixture exists to avoid
    // reproducing.
    await handler({ httpMethod: 'POST',
      body: JSON.stringify({ jobId: runId, league: 'mlb', legs: 2, prompt: 'aphrodite', tiers: ['goblin', 'standard', 'demon'] }) });
  } finally { mock.restore(); }
}

async function pollJob(store, jobId, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const j = read(store, jobId);
    if (j && (j.status === 'done' || j.status === 'error')) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

export default async function ({ t }) {
  // ---- an unknown variant name is refused, not silently run as Aphrodite ---
  reset();
  await seedRealSnapshot('v-run-1');
  const bg0 = await loadFn('judge-variant-background.js');
  await bg0.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'bad-variant', runId: 'v-run-1', variant: 'hermes' }) });
  const badVariant = await pollJob('replay-jobs', 'bad-variant');
  t.eq('an unknown variant name ends the job in error', badVariant.status, 'error');
  t.ok('...naming the variant and what IS known', /hermes/.test(badVariant.message) && /themis/.test(badVariant.message));

  // ---- missing runId ---------------------------------------------------
  await bg0.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'no-run', variant: 'themis' }) });
  const noRun = await pollJob('replay-jobs', 'no-run');
  t.eq('a missing runId ends the job in error', noRun.status, 'error');

  // ---- the whole path: THEMIS, k=3, against a real snapshot ----------------
  let calls = 0;
  const variantMock = mockFetch([
    ['api.anthropic.com', async (_u, init) => {
      calls++;
      const sent = JSON.parse(init.body);
      // Each call gets a slightly different answer, as a real judge would.
      const bump = calls * 0.01;
      const picks = [
        { player: 'Alpha', stat: 'Hits', line: 0.5, prob: 0.70 + bump, cleared: 3, key_risk: 'k', reasoning: 'r', standout: false },
        { player: 'Beta', stat: 'Hits', line: 1.5, prob: 0.05 + bump, cleared: 1, key_risk: 'k', reasoning: 'moved for a stated fact', standout: true },
      ];
      return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {},
        _sentSystem: sent.system };   // stashed for the assertion below, harmless extra key
    }],
  ]);
  let result;
  try {
    const bg = await loadFn('judge-variant-background.js');
    const post = await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'v-1', runId: 'v-run-1', variant: 'THEMIS', k: 3 }) });
    t.eq('the handler answers 202, matching the other background functions', post.statusCode, 202);
    result = await pollJob('replay-jobs', 'v-1');
  } finally { variantMock.restore(); }

  t.eq('the job settles as done', result.status, 'done');
  t.eq('k independent calls were made', calls, 3);
  t.eq('...case-insensitively resolving the variant name', result.result.variant, 'themis');
  t.eq('the baseline (original) prompt version is recorded for context', result.result.baselinePromptVersion, 'aphrodite');
  t.eq('pairwise gives C(3,2)=3 comparisons', result.result.pairwise.length, 3);
  t.ok('standout replication is reported', 'meanPairJaccard' in result.result.standoutReplication);
  // Beta is flagged standout in all 3 runs, at increasing distance from the
  // demon tier rate (0.20) as `bump` grows — every run answers the same way.
  t.eq('standouts replicate perfectly across identical flagging', result.result.standoutReplication.pairJaccard, [1, 1, 1]);
  t.ok('the move distribution reports the flagged prop, not the unflagged one', result.result.standoutMoveDistribution.n === 3);
  t.ok('tier calibration is reported per run', result.result.tierCalibration.length === 3);
  t.eq('rank correlation against the REAL original is reported per run', result.result.vsOriginal.length, 3);
  t.ok('...and it is well-defined, since both runs rank Alpha above Beta',
    result.result.vsOriginal.every((v) => v.spearman === 1));

  // rawRuns: the real Aphrodite original plus every THEMIS run, with tier
  // re-attached — the judge's own output never carries one. Item K's whole
  // computation depends on this existing; it didn't, the first time it ran.
  t.eq('rawRuns includes the baseline original ahead of the k variant runs',
    result.result.rawRuns.map((r) => r.label), ['aphrodite', 'run-1', 'run-2', 'run-3']);
  t.eq('...with tier resolved from the snapshot, not left blank',
    result.result.rawRuns[0].picks.map((p) => p.tier).sort(), ['demon', 'goblin']);

  // ---- the status endpoint reads back what the background job wrote -------
  // Checked here, before the next reset() wipes this job out of the store.
  const st = await loadFn('judge-variant-status.js');
  const viaStatus = JSON.parse((await st.handler({ queryStringParameters: { jobId: 'v-1' } })).body);
  t.eq('the status endpoint reports the same outcome', viaStatus.status, 'done');
  t.eq('...with the identical variant name', viaStatus.result.variant, 'themis');

  // ---- an unreplayable snapshot is refused before a single call -----------
  reset();
  await seedRealSnapshot('v-run-2');
  const ctx = await loadFn('judge-context.js');
  const found = await ctx.findByRunId('v-run-2');
  await ctx.saveContext({ ...found, searchTruncated: 5 });
  let calledDuringRefusal = 0;
  const refuseMock = mockFetch([['api.anthropic.com', async () => { calledDuringRefusal++; return { content: [], usage: {} }; }]]);
  let refused;
  try {
    const bg = await loadFn('judge-variant-background.js');
    await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'v-2', runId: 'v-run-2', variant: 'themis', k: 2 }) });
    refused = await pollJob('replay-jobs', 'v-2');
  } finally { refuseMock.restore(); }
  t.eq('a truncated snapshot ends the job in error', refused.status, 'error');
  t.eq('...and never reaches the API', calledDuringRefusal, 0);

  // ---- k is bounded, not trusted verbatim from the request body -----------
  reset();
  await seedRealSnapshot('v-run-3');
  let calls3 = 0;
  const boundMock = mockFetch([['api.anthropic.com', async () => {
    calls3++;
    return { content: [{ type: 'text', text: JSON.stringify({ picks: ORIGINAL_PICKS }) }], usage: {} };
  }]]);
  let bounded;
  try {
    const bg = await loadFn('judge-variant-background.js');
    await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'v-3', runId: 'v-run-3', variant: 'themis', k: 999 }) });
    bounded = await pollJob('replay-jobs', 'v-3', { timeoutMs: 5000 });
  } finally { boundMock.restore(); }
  t.eq('an oversized k is capped rather than trusted verbatim', calls3, 10);
  t.eq('the report reflects the capped count', bounded.result.k, 10);

  // ---- a run that leaks a live search is excluded end to end ---------------
  reset();
  await seedRealSnapshot('v-run-4');
  let n4 = 0;
  const leakMock = mockFetch([['api.anthropic.com', async () => {
    n4++;
    const picks = [{ player: 'Alpha', stat: 'Hits', line: 0.5, prob: 0.7, standout: false },
      { player: 'Beta', stat: 'Hits', line: 1.5, prob: 0.2, standout: false }];
    const ok = [{ type: 'text', text: JSON.stringify({ picks }) }];
    const leaked = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }, ...ok];
    return { content: n4 === 2 ? leaked : ok, usage: {} };
  }]]);
  let leaky;
  try {
    const bg = await loadFn('judge-variant-background.js');
    await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'v-4', runId: 'v-run-4', variant: 'themis', k: 3 }) });
    leaky = await pollJob('replay-jobs', 'v-4');
  } finally { leakMock.restore(); }
  t.eq('k reflects only the clean runs, not what was requested', leaky.result.k, 2);
  t.eq('kRequested keeps the original ask', leaky.result.kRequested, 3);
  t.eq('the excluded run is named end to end, all the way to the stored job', leaky.result.excluded,
    [{ label: 'run-2', reason: 'issued 1 live search(es) — not an offline replay' }]);
  t.eq('pairwise comparisons only cover the 2 clean runs', leaky.result.pairwise.length, 1);
  t.eq('tier calibration is reported for only the clean runs', leaky.result.tierCalibration.length, 2);
}

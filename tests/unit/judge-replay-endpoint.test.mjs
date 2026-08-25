// The server-side wrapper around the replay harness — judge-replay-background.js
// / judge-replay-status.js — not the harness itself (see replay.test.mjs).
//
// WHY THIS ENDPOINT EXISTS
// scripts/replay.mjs needs ANTHROPIC_API_KEY to make its k calls, and that key
// never leaves the server. This wraps replay-lib.js in the same POST-202-then-
// poll job pattern as bet-finder-background, so the harness can be run without
// distributing the key: POST a runId, poll for the report.
//
// What THIS file has to prove, since it is pure transport around code already
// tested elsewhere: the job is found by runId, an unreplayable snapshot is
// refused before a single call is made, the status endpoint actually reads back
// what the background job wrote (not a coincidence of sharing a store), and a
// snapshot missing entirely is reported rather than left "running" forever.
//
// ONE MORE THING, learned by hitting it live: Netlify treats any *-background
// function as fire-and-forget. The platform answers the ORIGINAL caller with an
// empty 202 the instant the invocation is accepted, and discards whatever this
// handler's own `return` says — a live probe confirmed the response is
// `content-length: 0` on every call, success or failure alike. So the
// handler's OWN return value asserted here is not what a real caller ever
// sees; the job store is. Every assertion below reads the store, the same way
// judge-replay-status.js (a real caller) has to.

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
const ROWS = [{ player: 'Alpha', team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' }];
const PICKS = [{ player: 'Alpha', stat: 'Hits', line: 0.5, prob: 0.7, cleared: 3, key_risk: 'k', reasoning: 'r' }];

// Produces a REAL, compressed snapshot via the actual saveContext — a hand-built
// fixture could accidentally diverge from what the real write shape is, which
// is exactly the kind of gap this session's mutation audit went looking for.
async function seedRealSnapshot(runId, { truncated = false } = {}) {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: runId, league: 'mlb', legs: 2 }) });
  } finally { mock.restore(); }
  if (truncated) {
    // Simulate a snapshot that hit the cap by re-saving it with searchTruncated
    // set, through the SAME saveContext write path a real truncation takes.
    const ctx = await loadFn('judge-context.js');
    const found = await ctx.findByRunId(runId);
    await ctx.saveContext({ ...found, searchTruncated: 7 });
  }
}

async function pollJob(store, jobId, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const j = read(store, jobId);
    if (j && (j.status === 'done' || j.status === 'error')) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

export default async function ({ t }) {
  reset();

  // ---- missing runId: the platform's 202 is not the answer, the store is --
  const bg0 = await loadFn('judge-replay-background.js');
  await bg0.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'x' }) });
  const badJob = await pollJob('replay-jobs', 'x');
  t.eq('a request with no runId ends the job in error, not stuck running', badJob.status, 'error');
  t.ok('...saying why', /runId is required/.test(badJob.message || ''), badJob.message);

  // ---- the whole path: seed a real snapshot, replay it server-side --------
  reset();
  await seedRealSnapshot('replay-run-1');
  let n = 0;
  const replayMock = mockFetch([
    ['api.anthropic.com', async () => {
      n++;
      return { content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: {} };
    }],
  ]);
  let result;
  try {
    const bg = await loadFn('judge-replay-background.js');
    // In this loadFn harness the handler's promise is awaited synchronously —
    // unlike production, where the platform answers 202 before the handler
    // even starts. So this checks the handler's OWN contract (matching
    // bet-finder-background: always 202, success or failure), not a claim
    // about round-trip timing, which only the job-store poll below can show.
    const post = await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'rj-1', runId: 'replay-run-1', k: 2 }) });
    t.eq('the handler always answers 202, matching bet-finder-background', post.statusCode, 202);
    result = await pollJob('replay-jobs', 'rj-1');
  } finally { replayMock.restore(); }

  t.eq('the job settles as done', result.status, 'done');
  t.eq('k replays means k calls to the API', n, 2);
  t.eq('the report names the run it replayed', result.result?.runId, 'replay-run-1');
  t.eq('...and reports k as the number of replays actually run', result.result?.k, 2);
  t.ok('behaviour is reported for the original plus every replay',
    result.result?.behaviour?.length === 3, JSON.stringify(result.result?.behaviour?.map((b) => b.label)));

  // ---- the status endpoint reads back what the background job wrote -------
  // Loaded as a SEPARATE function instance, so this is a real round trip
  // through the shared store, not the same in-memory object.
  const st = await loadFn('judge-replay-status.js');
  const viaStatus = JSON.parse((await st.handler({ queryStringParameters: { jobId: 'rj-1' } })).body);
  t.eq('the status endpoint reports the same outcome the background job wrote',
    viaStatus.status, 'done');
  t.eq('...with the identical report', viaStatus.result?.runId, result.result?.runId);

  const stMissing = JSON.parse((await st.handler({ queryStringParameters: {} })).body);
  t.eq('the status endpoint refuses a request with no jobId', stMissing.error != null, true);

  const stUnknown = JSON.parse((await st.handler({ queryStringParameters: { jobId: 'never-existed' } })).body);
  t.eq('an unknown jobId reads as still running, not an error',
    stUnknown.status, 'running');

  // ---- item H, enforced here too: refused before a call is made -----------
  reset();
  await seedRealSnapshot('replay-run-2', { truncated: true });
  let calledDuringRefusal = 0;
  const refuseMock = mockFetch([['api.anthropic.com', async () => { calledDuringRefusal++; return { content: [], usage: {} }; }]]);
  let refused;
  try {
    const bg = await loadFn('judge-replay-background.js');
    await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'rj-2', runId: 'replay-run-2', k: 3 }) });
    refused = await pollJob('replay-jobs', 'rj-2');
  } finally { refuseMock.restore(); }
  t.eq('a snapshot that hit the search cap ends the job in error', refused.status, 'error');
  t.ok('...saying it is not replayable', /not replayable/.test(refused.message || ''), refused.message);
  t.eq('...and never reaches the API', calledDuringRefusal, 0);

  // ---- a runId with no snapshot at all -------------------------------------
  reset();
  const bg3 = await loadFn('judge-replay-background.js');
  await bg3.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'rj-3', runId: 'never-ran', k: 1 }) });
  const missing = await pollJob('replay-jobs', 'rj-3');
  t.eq('a runId with no stored snapshot ends the job in error, not stuck running', missing.status, 'error');
  t.ok('...naming the runId that could not be found', /never-ran/.test(missing.message || ''), missing.message);

  // ---- k is bounded, not trusted from the request body ---------------------
  reset();
  await seedRealSnapshot('replay-run-4');
  let calls4 = 0;
  const boundMock = mockFetch([['api.anthropic.com', async () => { calls4++; return { content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: {} }; }]]);
  let bounded;
  try {
    const bg = await loadFn('judge-replay-background.js');
    await bg.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'rj-4', runId: 'replay-run-4', k: 999 }) });
    bounded = await pollJob('replay-jobs', 'rj-4', { timeoutMs: 5000 });
  } finally { boundMock.restore(); }
  t.eq('an oversized k is capped rather than trusted verbatim', calls4, 10);
  t.eq('the report reflects the capped count', bounded.result?.k, 10);
}

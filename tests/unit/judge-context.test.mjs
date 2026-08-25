// The judge's INPUT, persisted.
//
// The pick log records what the judge said. It records nothing about what it was
// told — the payload, the prompt, the live search text it read. Those are
// irreproducible: search is live, so the same query on the same slate returns
// different text tomorrow. Without them the only way to test a prompt variant is
// to ship it and wait ~2 weeks for slates to settle.
//
// The acceptance test for all of this is one sentence: given a projectionId, can
// I get back the exact bytes the judge saw for that prop?

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';
import { gunzipSync } from 'node:zlib';

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
  { player: 'Alpha One', team: 'CIN', line: 0.5, opp: 'PIT', tier: 'goblin' },
  { player: 'Beta Two', team: 'PIT', line: 1.5, opp: 'CIN', tier: 'standard' },
];
const PICKS = ROWS.map((r, i) => ({ player: r.player, stat: 'Hits', line: r.line, prob: 0.6 + i * 0.05, cleared: 3, key_risk: 'none', reasoning: 'r' }));

// A response carrying live search results, which is the part that cannot be
// reconstructed later.
const SEARCH = [
  { type: 'web_search_tool_result', tool_use_id: 'srv_1',
    content: [{ type: 'web_search_result', title: 'CIN lineup', url: 'https://x/1', page_age: null,
      encrypted_content: 'CONFIRMED-LINEUP-TEXT-FOR-CIN' }] },
];

async function run(body = {}) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async () => ({
      content: [...SEARCH, { type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: { input_tokens: 9 },
    })],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'ctx-run-1', league: 'mlb', legs: 2, ...body }) });
  } finally { mock.restore(); }
  const call = mock.calls.find((c) => c.url.includes('api.anthropic.com'));
  return { sent: call ? JSON.parse(call.init.body) : null };
}

export default async function ({ t }) {
  const { sent } = await run();

  // ---- it was written, under a date-prefixed key ------------------------
  const day = new Date().toISOString().slice(0, 10);
  const stored = read('judge-context', `${day}/ctx-run-1`);
  t.ok('a snapshot is written for the run', !!stored);
  t.ok('...compressed, because search text dominates the size', !!stored.gz);
  const snap = JSON.parse(gunzipSync(Buffer.from(stored.gz, 'base64')).toString('utf8'));

  // ---- it is what was SENT, not a reconstruction of it ------------------
  t.eq('the stored system prompt is byte-identical to the one sent', snap.system, sent.system);
  t.eq('...as is the user message', snap.userContent, sent.messages[0].content);
  t.eq('the resolved version and model are recorded, not just requested',
    [snap.promptVersion, snap.model], ['aphrodite', 'claude-haiku-4-5-20251001']);
  t.eq('the search budget is recorded', snap.maxSearches, sent.tools[0].max_uses);

  // ---- THE ACCEPTANCE: projectionId -> exact bytes ----------------------
  const ctx = await loadFn('judge-context.js');
  const got = JSON.parse((await ctx.handler({ queryStringParameters: { projectionId: 'pp-0' } })).body);
  t.eq('a projectionId resolves to its run', got.runId, 'ctx-run-1');
  t.eq('...and to the exact entry that prop contributed',
    got.prop.entry.player, 'Alpha One');
  t.eq('...with the tier it was judged under', got.prop.entry.tier, 'goblin');
  t.eq('...and the game it was grouped into', got.prop.matchup, 'CIN vs PIT');
  t.eq('...alongside the full payload bytes', got.userContent, sent.messages[0].content);
  t.eq('...and the prompt that framed them', got.system, sent.system);

  // The irreproducible part. Search is live; this text does not exist tomorrow.
  t.ok('the live search results are retained verbatim',
    JSON.stringify(got.search).includes('CONFIRMED-LINEUP-TEXT-FOR-CIN'));
  t.eq('...and nothing was dropped to fit the cap', got.searchTruncated, 0);

  // Every candidate is indexed, not only the ones the judge returned picks for.
  t.eq('every prop sent is retrievable', Object.keys(snap.props).sort(), ['pp-0', 'pp-1']);

  // ---- retrieval by run, and the index ----------------------------------
  const byRun = JSON.parse((await ctx.handler({ queryStringParameters: { runId: 'ctx-run-1' } })).body);
  t.eq('a whole run can be fetched', byRun.runId, 'ctx-run-1');
  const index = JSON.parse((await ctx.handler({ queryStringParameters: {} })).body);
  t.eq('the index lists retained runs without reading their bodies', index.runs, 1);

  const missing = await ctx.handler({ queryStringParameters: { projectionId: 'nope' } });
  t.eq('an unknown projectionId 404s rather than returning something wrong', missing.statusCode, 404);

  // ---- the cap is honest about itself -----------------------------------
  // Truncating silently would produce replays that look faithful and are not.
  const big = Array.from({ length: 40 }, (_, i) => ({
    type: 'web_search_tool_result', tool_use_id: `s${i}`,
    content: [{ encrypted_content: 'x'.repeat(50_000) }],
  }));
  const capped = ctx.capSearch(big);
  t.ok('an oversized search payload is trimmed', capped.blocks.length < big.length);
  t.ok('...and says how many blocks it dropped', capped.dropped > 0, String(capped.dropped));
  t.ok('...staying under the cap', capped.bytes <= 800_000, String(capped.bytes));

  // ---- a failed snapshot must never take the run down --------------------
  // A missing snapshot costs one replay. A thrown error costs the slate.
  const broken = { ...global };
  t.eq('saving is best-effort and swallows its own failure',
    await ctx.saveContext({ runId: null, at: 'not-a-date', props: { get bad() { throw new Error('boom'); } } }), false);
  t.ok('...and the process is still standing afterwards', true);
  void broken;

  // ---- retention actually removes things --------------------------------
  // Snapshots are the biggest thing this app writes — a slate's search text
  // compresses to tens of kilobytes and every run makes one. Pruning that counts
  // what it WOULD delete and deletes nothing looks identical from the return
  // value, and the store grows without bound until a write fails months later.
  const { seed: seedBlob, read: readBlob } = await import('../helpers/blobs.mjs');
  const old = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const fresh = new Date().toISOString().slice(0, 10);
  seedBlob('judge-context', ctx.keyFor(old, 'ancient'), { v: 1, gz: 'x' });
  seedBlob('judge-context', ctx.keyFor(fresh, 'today'), { v: 1, gz: 'y' });
  const removed = await ctx.pruneOld(30);
  t.eq('a snapshot past the retention window is deleted', removed, 1);
  t.eq('...and is really gone from the store, not just counted',
    readBlob('judge-context', ctx.keyFor(old, 'ancient')), null);
  t.ok("...while today's is untouched",
    readBlob('judge-context', ctx.keyFor(fresh, 'today')) != null);

  // ---- search blocks are picked out of a mixed response -----------------
  t.eq('only search blocks are kept, not the model text',
    ctx.searchBlocks([{ type: 'text', text: 'hello' }, ...SEARCH]).length, 1);
  t.eq('an empty response yields none', ctx.searchBlocks(undefined).length, 0);
}

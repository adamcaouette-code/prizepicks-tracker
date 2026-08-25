// netlify/functions/judge-context.js
//
// What the judge actually SAW — persisted, so a prompt change can be evaluated
// by replaying it instead of by shipping it and waiting a fortnight.
//
// THE PROBLEM THIS SOLVES
// The pick log records the judge's OUTPUT: a probability, a verdict, a tier. It
// records nothing about the INPUT — the slim payload, the system prompt, the
// live web search results the model read. Those are irreproducible: search is
// live, so the same query on the same slate returns different text tomorrow.
// Without them the only way to test a prompt variant is to run it on tomorrow's
// board and wait ~2 weeks for slates to settle, which makes the iteration loop
// two weeks long for a change that takes five minutes to write.
//
// With them, a variant can be replayed against the EXACT context that produced
// a graded outcome — same props, same prompt, same search text, search itself
// disabled — and scored against results already in the log. Two weeks becomes
// one API call.
//
// WHAT IS STORED, per run: the resolved system prompt, the exact user-message
// bytes, every slim entry indexed by projectionId, the search budget, and the
// web_search_tool_result blocks the API returned.
//
// Retrieval:
//   /api/judge-context?projectionId=14086787   the context behind one pick
//   /api/judge-context?runId=<jobId>           a whole run
//   /api/judge-context                         index of retained runs

import { getStore } from '@netlify/blobs';
import { gzipSync, gunzipSync } from 'node:zlib';

const STORE = () => getStore({
  name: 'judge-context',           // deliberately NOT pick-log: the hot path
  siteID: process.env.NETLIFY_SITE_ID,   // reads and writes the pick log on
  token: process.env.NETLIFY_BLOBS_TOKEN, // every grade, and this is 100x larger
});

// Search results dominate the size — a measured run reads ~98k input tokens and
// almost all of it is retrieved page text. Capped so one pathological slate
// cannot fill the store; the cap is recorded in the snapshot so a truncated
// replay is never mistaken for a faithful one.
const MAX_SEARCH_BYTES = Number(process.env.JUDGE_CONTEXT_MAX_SEARCH) || 800_000;
const RETAIN_DAYS = Number(process.env.JUDGE_CONTEXT_DAYS) || 30;

export const keyFor = (day, runId) => `${day}/${runId}`;

/**
 * Pull the search turn out of an Anthropic response — BOTH halves of it.
 *
 * A web search leaves two kinds of block in the assistant turn: the
 * `server_tool_use` that issued the query, and the `web_search_tool_result` that
 * came back. Only the results used to be kept, which was enough to READ what the
 * judge saw and not enough to replay it: reconstructing the assistant turn for a
 * replay needs the tool_use block its result answers, or the turn is malformed.
 * Kept in response order, because the turn has to be rebuilt in that order.
 */
export function searchBlocks(content) {
  return (content || [])
    .filter((b) => b && typeof b.type === 'string'
      && (b.type.includes('web_search') || (b.type === 'server_tool_use' && b.name === 'web_search')))
    .map((b) => (b.type === 'server_tool_use'
      ? { type: b.type, id: b.id, name: b.name, input: b.input ?? null }
      : { type: b.type, tool_use_id: b.tool_use_id, content: b.content ?? b.input ?? null }));
}

/** The id that ties a server_tool_use to the web_search_tool_result answering it. */
const pairId = (b) => b.tool_use_id || b.id || null;

/**
 * Trim search results to fit the cap, oldest-last, and say so.
 * Truncating silently would produce replays that look faithful and are not.
 */
export function capSearch(blocks) {
  // Sized in PAIRS. A result kept without the tool_use it answers — or the other
  // way round — is a malformed assistant turn, so half a search is worth nothing
  // and storing it only makes the truncation harder to read.
  const groups = new Map();
  const order = [];
  for (const b of blocks) {
    const id = pairId(b) || `anon-${order.length}`;
    if (!groups.has(id)) { groups.set(id, []); order.push(id); }
    groups.get(id).push(b);
  }
  const out = [];
  let bytes = 0, dropped = 0;
  for (const id of order) {
    const pair = groups.get(id);
    const size = JSON.stringify(pair).length;
    if (bytes + size > MAX_SEARCH_BYTES) { dropped += pair.length; continue; }
    bytes += size; out.push(...pair);
  }
  return { blocks: out, bytes, dropped };
}

/**
 * Can this snapshot reproduce the call it recorded?
 *
 * A snapshot that lost search blocks to the cap CANNOT. Replaying it would send
 * the model less context than the original call had, and every difference in the
 * output would be attributed to whatever the replay was testing. That is a
 * measurement that reads as a finding, which is worse than no measurement.
 *
 * Written into the snapshot at save time so readers do not each re-derive it,
 * and re-derived here anyway for snapshots written before the field existed —
 * same discipline as `psyche (untagged)` in calibration.
 */
export const isReplayable = (snap) => !!snap
  && snap.replayable !== false
  && !snap.searchTruncated
  && typeof snap.system === 'string'
  && typeof snap.userContent === 'string';

/**
 * Best-effort, exactly like recordCost: a snapshot that fails to write must
 * never take a run down with it. A missing snapshot costs one replay; a thrown
 * error costs the slate.
 */
export async function saveContext(snap) {
  try {
    const day = (snap.at || new Date().toISOString()).slice(0, 10);
    // Stamped at save time, in the one place that knows what was dropped.
    const record = { ...snap, replayable: !snap.searchTruncated };
    const gz = gzipSync(Buffer.from(JSON.stringify(record), 'utf8')).toString('base64');
    await STORE().setJSON(keyFor(day, snap.runId), { v: 1, gz });
    // Pruning rides along with the write rather than needing its own schedule.
    // Failing to prune is harmless; failing to write is what matters, so it is
    // deliberately after.
    pruneOld().catch(() => {});
    return true;
  } catch { return false; }
}

export async function pruneOld(days = RETAIN_DAYS) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const store = STORE();
  const { blobs } = await store.list();
  let removed = 0;
  for (const b of blobs) {
    if (String(b.key).slice(0, 10) >= cutoff) continue;
    try { await store.delete(b.key); removed++; } catch { /* ignore */ }
  }
  return removed;
}

export async function readContext(key) {
  const raw = await STORE().get(key, { type: 'json' });
  if (!raw) return null;
  if (!raw.gz) return raw;                       // tolerate an uncompressed write
  return JSON.parse(gunzipSync(Buffer.from(raw.gz, 'base64')).toString('utf8'));
}

/**
 * The full snapshot for a runId, by the same key search the handler's ?runId=
 * branch uses. Exported so a caller that needs the SNAPSHOT — the replay
 * harness, not just a rendered response — is not left re-deriving the key
 * format or the list-then-find logic.
 */
export async function findByRunId(runId) {
  const store = STORE();
  let keys = [];
  try { keys = (await store.list()).blobs.map((b) => b.key).sort().reverse(); } catch { keys = []; }
  const key = keys.find((k) => k.endsWith(`/${runId}`));
  return key ? readContext(key) : null;
}

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    const store = STORE();
    let keys = [];
    try { keys = (await store.list()).blobs.map((b) => b.key).sort().reverse(); } catch { keys = []; }

    if (q.runId) {
      const key = keys.find((k) => k.endsWith(`/${q.runId}`));
      if (!key) return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'no snapshot for that runId', runs: keys.length }) };
      const snap = await readContext(key);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ...snap, replayable: isReplayable(snap) }, null, 2) };
    }

    if (q.projectionId) {
      // Newest first, so a prop re-judged across runs returns its latest context
      // unless an explicit runId asks otherwise.
      for (const key of keys.slice(0, Number(q.scan) || 60)) {
        const snap = await readContext(key).catch(() => null);
        const entry = snap?.props?.[q.projectionId];
        if (!entry) continue;
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          runId: snap.runId, at: snap.at, league: snap.league,
          promptVersion: snap.promptVersion, model: snap.model, maxSearches: snap.maxSearches,
          // The exact entry this prop contributed to the payload...
          prop: entry,
          // ...the exact bytes the whole payload was sent as, and the system
          // prompt that framed them. Both are needed to reproduce the call.
          userContent: snap.userContent,
          system: snap.system,
          // Search text is per-run, not per-prop — the judge runs one search per
          // GAME and applies it to every player in it.
          search: snap.search,
          searchTruncated: snap.searchTruncated,
          // Stated, not implied: a truncated snapshot is not a replayable one.
          replayable: isReplayable(snap),
        }, null, 2) };
      }
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'no snapshot carries that projectionId', scanned: Math.min(keys.length, Number(q.scan) || 60) }) };
    }

    // Index. Cheap: reads no bodies.
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      runs: keys.length,
      retainDays: RETAIN_DAYS,
      keys: keys.slice(0, 100),
      usage: 'add ?runId=<jobId> or ?projectionId=<id>',
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

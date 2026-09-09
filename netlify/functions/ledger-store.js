// netlify/functions/ledger-store.js
//
// The append-only bet ledger and line-snapshot archive.
//
// Four stores, and the rules that make them trustworthy:
//
//   line-snapshots   every capture of the board. Never overwritten.
//   bets             one row per slip, written once. Never overwritten.
//   bet-results      grading, keyed by LEG id, in its own store so settling a
//                    bet cannot touch the bet.
//   ledger-meta      schema version + migration bookkeeping.
//
// ---------------------------------------------------------------------------
// WHY NETLIFY BLOBS AND NOT POSTGRES
//
// The brief said "cheapest to run on Netlify". Blobs wins on cost outright: it
// is included with the site, bills nothing at idle, needs no provisioning step,
// and the credentials are already in this project's environment — every other
// store here runs on it. Netlify DB (Neon) has a free tier too, but it is a
// separate service to provision and keep alive, it suspends when idle, and its
// free row/storage caps are the kind of thing this archive would grow into.
// A snapshot every 10 minutes is ~144 captures a day and this data is written
// once and read rarely, which is object-store shaped, not query shaped.
//
// WHAT THAT COSTS, STATED PLAINLY, because the brief asked for tables, foreign
// keys and a view and this is not a relational database:
//
//   - No SQL. The CLV "view" is a function over two stores (see clv.js), not a
//     `CREATE VIEW`. It is recomputed per request rather than maintained.
//   - No referential integrity. `leg.snapshot_id` is a foreign key by
//     convention; nothing at the storage layer refuses a dangling one, so
//     appendBet() verifies each referenced snapshot exists before writing, and
//     verifyIntegrity() re-checks the whole ledger on demand.
//   - No `REVOKE UPDATE`. Append-only is enforced one layer up — see below.
//
// The one place this ISN'T weaker than Postgres is the append-only guarantee
// itself. Blobs supports a conditional write (`onlyIfNew`), which is a
// compare-and-set performed BY THE STORAGE SERVICE: a second write to an
// existing key comes back `{ modified: false }` and the stored bytes are
// untouched. That is a real concurrency-safe guarantee, not an app-level "check
// then write" race. This module turns that refusal into a thrown
// AppendOnlyViolation so a caller cannot ignore a falsy return value.
//
// If this ever needs SQL — cross-slip aggregation, or CLV over tens of
// thousands of legs where recomputation stops being cheap — the migration is
// mechanical: every row here is already flat, typed and id-keyed. That is the
// reason for the schema below rather than storing whatever shape was handy.

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

export const STORES = {
  snapshots: 'line-snapshots',
  bets: 'bets',
  results: 'bet-results',
  meta: 'ledger-meta',
};

const store = (name) => getStore({
  name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN,
});

/** Thrown when something tries to change a row that has already been written. */
export class AppendOnlyViolation extends Error {
  constructor(storeName, key) {
    super(`${storeName}/${key} already exists — this store is append-only and rows are never rewritten. `
      + `To correct a row, append a new one that supersedes it.`);
    this.name = 'AppendOnlyViolation';
    this.store = storeName;
    this.key = key;
  }
}

/**
 * The only writer. Every append in this module goes through it.
 *
 * `onlyIfNew` makes the STORE refuse the second write; this turns the refusal
 * into an exception. Both halves matter: without the flag two concurrent
 * appends could both pass a "does it exist?" check and the later one would win
 * silently, and without the throw a caller that ignores the return value would
 * believe it had written.
 */
async function appendOnce(storeName, key, value) {
  const res = await store(storeName).setJSON(key, value, { onlyIfNew: true });
  if (!res || res.modified !== true) throw new AppendOnlyViolation(storeName, key);
  return { key, etag: res.etag };
}

const iso = (d = new Date()) => new Date(d).toISOString();
const short = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// ---------------------------------------------------------------------------
// IDs
//
// Deterministic and content-derived, never random. A snapshot row's id is a
// pure function of (capture time, book-neutral prop identity), so the same prop
// in the same capture always lands on the same id — which is what lets a bet
// reference a snapshot row that was written by a completely separate process,
// and lets a re-run of a capture be detected as a duplicate rather than
// silently doubling the archive.

/** Book-neutral identity of a prop: who, what, which line. */
export const propKey = ({ league, player, market, line }) =>
  [String(league || '').toLowerCase(), String(player || '').trim().toLowerCase(),
    String(market || '').trim().toLowerCase(), Number(line)].join('|');

export const legId = (slipId, index) => `${slipId}#L${index}`;

// A capture is one blob holding every row from that instant. Rows are written
// and read as a set — nothing ever asks for one prop at one time without
// wanting its neighbours — so a blob per row would be ~3,000 objects per
// capture and 144 times that a day, for no gain.
//
// TWO KINDS OF KEY, and the difference does real work:
//
//   capture/<iso>        a routine capture, one per instant
//   closing/<eventId>    the closing capture for an event
//
// Keying the close by EVENT rather than by time makes "have we already closed
// this event?" a property of the store instead of a check someone has to
// remember to write. A second attempt hits the same key, the conditional write
// refuses it, and the first close — the one actually taken at kickoff — is the
// one that survives. A time-keyed close would have quietly written a second,
// later "closing" line every time the cron overlapped a slow run.
export const captureKey = (capturedAt) => `capture/${iso(capturedAt)}`;
export const closingKey = (eventId) => `closing/${eventId}`;

// The id embeds its own capture key, so a foreign key can be resolved without
// knowing which capture to look in or scanning every one of them.
export const snapshotId = (capKey, prop) => `${capKey}#${short(propKey(prop))}`;

// ---------------------------------------------------------------------------
// Snapshots

/**
 * Append one capture of the board.
 *
 * `rows` are already-shaped snapshot rows (see snapshot-background.js). This
 * stamps ids and the capture time, and refuses to write over an existing
 * capture — so re-running a capture for an instant that already has one is an
 * error, not a silent replacement.
 */
export async function appendCapture({ capturedAt, isClosing = false, eventId = null, rows, meta = {} }) {
  const at = iso(capturedAt);
  // A closing capture that claims to be closing must say which event it closes,
  // or "the closing line" cannot be resolved for anything.
  if (isClosing && !eventId) throw new Error('a closing capture must name the event it closes');
  const key = isClosing ? closingKey(eventId) : captureKey(at);
  const stamped = rows.map((r) => ({
    id: snapshotId(key, r),
    captured_at: at,
    is_closing: !!isClosing,
    schema_version: SCHEMA_VERSION,
    ...r,
  }));
  const payload = {
    key,
    captured_at: at, is_closing: !!isClosing, event_id: eventId,
    schema_version: SCHEMA_VERSION, count: stamped.length, meta, rows: stamped,
  };
  await appendOnce(STORES.snapshots, key, payload);
  return payload;
}

/** One capture, by its key. */
export async function getCapture(key) {
  return store(STORES.snapshots).get(key, { type: 'json' });
}

/** Capture keys. `kind` narrows to routine captures or closes. */
export async function listCaptures({ kind = 'all' } = {}) {
  const prefix = kind === 'routine' ? 'capture/' : kind === 'closing' ? 'closing/' : undefined;
  const { blobs } = await store(STORES.snapshots).list(prefix ? { prefix } : {});
  return blobs.map((b) => b.key).filter(isRow).sort();
}

/** Routine capture timestamps, newest first. */
export async function listCaptureTimes() {
  return (await listCaptures({ kind: 'routine' })).map((k) => k.slice('capture/'.length)).sort().reverse();
}

export async function hasClosing(eventId) {
  return !!(await getCapture(closingKey(eventId)));
}

/**
 * Resolve a foreign key. The capture key is the part of the id before the last
 * '#', which is why ids are built that way — a leg written months ago resolves
 * in one read rather than a scan of every capture since.
 */
export async function snapshotRow(id) {
  const s = String(id);
  const cut = s.lastIndexOf('#');
  if (cut < 0) return null;
  const cap = await getCapture(s.slice(0, cut));
  return (cap?.rows || []).find((r) => r.id === s) || null;
}

/**
 * The capture that was CURRENT at an instant — the most recent one at or before
 * it, never a later one.
 *
 * A bet placed at 14:07 is priced against the 14:00 board, because that is what
 * was on screen. Resolving forward to 14:10 would silently credit the bettor
 * with information they did not have, which is the one error that would make
 * every CLV number in this ledger flattering.
 */
export async function captureCurrentAt(when) {
  const t = iso(when);
  const all = await listCaptureTimes();
  const at = all.find((c) => c <= t) || null;
  return at ? captureKey(at) : null;
}

// ---------------------------------------------------------------------------
// Bets

/**
 * Append a slip. Written once; never updated, by anything, ever.
 *
 * Grading does not live here — see appendResult. A bet row records what was
 * believed and staked at a moment, and a row that can be edited after the fact
 * is not a record of anything.
 */
export async function appendBet(bet) {
  const errs = validateBet(bet);
  if (errs.length) throw new Error(`invalid bet: ${errs.join('; ')}`);

  // Foreign keys are checked HERE because the store cannot check them. A
  // dangling snapshot_id would produce a leg with no closing line to compare
  // against, and it would be discovered months later as a hole in the CLV.
  for (const [i, leg] of bet.legs.entries()) {
    if (leg.snapshot_id == null) continue;      // explicitly unpriced, allowed
    // eslint-disable-next-line no-await-in-loop
    const row = await snapshotRow(leg.snapshot_id);
    // Identified by INDEX as well as leg_id: leg_id is assigned below, during
    // the write, so an inbound leg that omits it would otherwise be reported as
    // "leg undefined" — which names nothing in a six-leg slip.
    if (!row) {
      throw new Error(`leg ${i}${leg.leg_id ? ` (${leg.leg_id})` : ''}: snapshot_id ${leg.snapshot_id} does not exist`);
    }
  }

  const row = {
    schema_version: SCHEMA_VERSION,
    slip_id: bet.slip_id,
    placed_at: iso(bet.placed_at),
    slip_type: bet.slip_type,
    stake: Number(bet.stake),
    payout_multiplier: bet.payout_multiplier ?? null,
    book: bet.book || 'prizepicks',
    legs: bet.legs.map((l, i) => ({
      leg_id: l.leg_id || legId(bet.slip_id, i),
      player: l.player,
      team: l.team ?? null,
      opponent: l.opponent ?? null,
      market: l.market,
      line: Number(l.line),
      side: l.side,
      tier: l.tier ?? null,
      // The foreign key the brief asked for: the exact archived row that was
      // current when this was placed.
      snapshot_id: l.snapshot_id ?? null,
    })),
    // Free-form, never read by anything here. Somewhere to keep provenance
    // (which import, which spreadsheet row) without polluting typed fields.
    source: bet.source ?? null,
    appended_at: iso(),
  };
  await appendOnce(STORES.bets, row.slip_id, row);
  return row;
}

export function validateBet(bet) {
  const e = [];
  if (!bet || typeof bet !== 'object') return ['not an object'];
  if (!bet.slip_id) e.push('slip_id is required');
  if (!bet.placed_at || isNaN(Date.parse(bet.placed_at))) e.push('placed_at must be a timestamp');
  if (!bet.slip_type) e.push('slip_type is required');
  if (!(Number(bet.stake) >= 0)) e.push('stake must be a non-negative number');
  if (!Array.isArray(bet.legs) || !bet.legs.length) e.push('legs must be a non-empty array');
  (bet.legs || []).forEach((l, i) => {
    if (!l.player) e.push(`leg ${i}: player is required`);
    if (!l.market) e.push(`leg ${i}: market is required`);
    if (!isFinite(Number(l.line))) e.push(`leg ${i}: line must be a number`);
    if (l.side !== 'over' && l.side !== 'under') e.push(`leg ${i}: side must be "over" or "under"`);
  });
  return e;
}

export async function getBet(slipId) {
  return store(STORES.bets).get(slipId, { type: 'json' });
}

// Keys beginning with '_' are bookkeeping, not rows — the migration's
// `_created` marker is the only one today. Without this filter it comes back
// from listBets() as a bet with no slip_id, verifyIntegrity reports it as a
// schema violation forever, and any consumer counting rows is off by one from
// the day the ledger is initialised.
const isRow = (key) => !key.startsWith('_');

export async function listBets() {
  const { blobs } = await store(STORES.bets).list();
  return blobs.map((b) => b.key).filter(isRow).sort();
}

export async function allBets() {
  const ids = await listBets();
  return (await Promise.all(ids.map((id) => getBet(id)))).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Results — grading, in its own store, keyed by LEG
//
// Separate from `bets` so that settling a leg physically cannot rewrite the bet
// row. This is the structural half of the requirement: even a bug that meant to
// write a grade into the bet has nowhere to put it.

export async function appendResult(result) {
  if (!result?.leg_id) throw new Error('leg_id is required');
  if (!result.slip_id) throw new Error('slip_id is required');
  if (!['won', 'lost', 'push', 'void'].includes(result.outcome)) {
    throw new Error('outcome must be won | lost | push | void');
  }
  const row = {
    schema_version: SCHEMA_VERSION,
    leg_id: result.leg_id,
    slip_id: result.slip_id,
    outcome: result.outcome,
    actual: result.actual ?? null,
    graded_at: iso(result.graded_at || new Date()),
    source: result.source ?? null,
  };
  await appendOnce(STORES.results, row.leg_id, row);
  return row;
}

export async function getResult(legIdent) {
  return store(STORES.results).get(legIdent, { type: 'json' });
}

export async function allResults() {
  const { blobs } = await store(STORES.results).list();
  return (await Promise.all(blobs.filter((b) => isRow(b.key))
    .map((b) => store(STORES.results).get(b.key, { type: 'json' })))).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Meta / migrations

export async function readMeta() {
  return (await store(STORES.meta).get('schema', { type: 'json' })) || { version: 0, history: [] };
}

/**
 * The one key in this module that is deliberately mutable. Migration
 * bookkeeping is not a ledger row — it describes the ledger, and it has to be
 * updatable or a second migration could never be recorded.
 */
export async function writeMeta(meta) {
  await store(STORES.meta).setJSON('schema', meta);
  return meta;
}

/**
 * Walk the whole ledger and report anything the storage layer cannot enforce.
 * Cheap to run, and the only way a dangling foreign key gets found before it
 * turns into a silently missing CLV row.
 */
export async function verifyIntegrity() {
  const bets = await allBets();
  const problems = [];
  let legs = 0, priced = 0;
  for (const b of bets) {
    if (b.schema_version !== SCHEMA_VERSION) {
      problems.push({ slip_id: b.slip_id, problem: `schema_version ${b.schema_version} != ${SCHEMA_VERSION}` });
    }
    const seen = new Set();
    for (const l of b.legs || []) {
      legs++;
      if (seen.has(l.leg_id)) problems.push({ slip_id: b.slip_id, problem: `duplicate leg_id ${l.leg_id}` });
      seen.add(l.leg_id);
      if (l.snapshot_id == null) continue;
      priced++;
      // eslint-disable-next-line no-await-in-loop
      if (!(await snapshotRow(l.snapshot_id))) {
        problems.push({ slip_id: b.slip_id, leg_id: l.leg_id, problem: `dangling snapshot_id ${l.snapshot_id}` });
      }
    }
  }
  const results = await allResults();
  const legIds = new Set(bets.flatMap((b) => (b.legs || []).map((l) => l.leg_id)));
  for (const r of results) {
    if (!legIds.has(r.leg_id)) problems.push({ leg_id: r.leg_id, problem: 'result references a leg that does not exist' });
  }
  return { bets: bets.length, legs, legsWithSnapshot: priced, results: results.length, problems };
}

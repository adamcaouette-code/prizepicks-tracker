// scripts/ledger-migrate.mjs
//
// Migrations for the append-only bet ledger.
//
//   node scripts/ledger-migrate.mjs           apply anything outstanding
//   node scripts/ledger-migrate.mjs --dry     say what would happen, change nothing
//   node scripts/ledger-migrate.mjs --status  current version and history
//
// ---------------------------------------------------------------------------
// WHAT A MIGRATION CAN AND CANNOT DO HERE
//
// In a relational store a migration rewrites rows in place. In an append-only
// ledger that is exactly the operation that must never happen, so migrations
// here are restricted to two shapes:
//
//   CREATE    write rows or keys that do not exist yet (a new store, a
//             backfilled index, a derived rollup)
//   FORWARD   record that all rows from version N onward carry a new field,
//             leaving older rows alone and readable
//
// A migration that needs to CHANGE the meaning of an existing field does not
// get to rewrite history. It bumps SCHEMA_VERSION and the readers learn to
// handle both — which is more work, and is the price of a record that can be
// trusted. Every row carries its own `schema_version` for exactly this.
//
// The one mutable key in the whole system is `ledger-meta/schema`, and it holds
// bookkeeping ABOUT the ledger rather than any part of it.

import { SCHEMA_VERSION, readMeta, writeMeta, STORES, verifyIntegrity } from '../netlify/functions/ledger-store.js';
import { getStore } from '@netlify/blobs';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');

const store = (name) => getStore({
  name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN,
});

/**
 * Each migration is `{ version, name, describe, up }`.
 *
 * `up` must be idempotent — re-running it after a partial failure has to be
 * safe, because an append-only store has no transaction to roll back. Every one
 * below achieves that by only ever creating keys that do not exist.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'create-ledger-stores',
    describe: 'Initialise the four ledger stores and stamp schema v1.',
    async up({ dry }) {
      // Blobs has no CREATE TABLE — a store exists once something is in it. So
      // this writes a marker rather than pretending to create anything, and the
      // marker is what makes "has the ledger been initialised?" answerable
      // instead of being inferred from an empty list.
      const notes = [];
      for (const [label, name] of Object.entries(STORES)) {
        if (name === STORES.meta) continue;
        const key = '_created';
        const existing = await store(name).get(key, { type: 'json' });
        if (existing) { notes.push(`${label}: already initialised at ${existing.at}`); continue; }
        if (!dry) await store(name).setJSON(key, { at: new Date().toISOString(), schema_version: 1 });
        notes.push(`${label}: ${dry ? 'would initialise' : 'initialised'}`);
      }
      return notes;
    },
  },
];

/**
 * Fail with a sentence rather than a stack.
 *
 * Without credentials @netlify/blobs throws MissingBlobsEnvironmentError from
 * three frames deep, which reads as a bug in this script rather than as two
 * unset variables. This is the first thing anyone runs against a fresh ledger,
 * so it is the worst possible place for an unexplained trace.
 */
function requireCredentials() {
  const missing = ['NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN'].filter((k) => !process.env[k]);
  if (!missing.length) return;
  console.error(`Cannot reach the ledger: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n`);
  console.error('  These are the same two variables every other store in this project uses.');
  console.error('  Netlify sets them automatically in a deployed function; locally, export them');
  console.error('  from your site settings (Site configuration -> Environment variables), or run');
  console.error('  the migration through `netlify dev` so the runtime supplies them.\n');
  console.error('  Nothing was read and nothing was written.');
  process.exitCode = 1;
  throw new Error('missing Netlify Blobs credentials');
}

async function main() {
  requireCredentials();
  const meta = await readMeta();
  const current = meta.version || 0;

  if (args.has('--status')) {
    const integrity = await verifyIntegrity().catch((e) => ({ error: String(e.message || e) }));
    console.log(JSON.stringify({
      schema_version_in_code: SCHEMA_VERSION,
      schema_version_in_store: current,
      pending: MIGRATIONS.filter((m) => m.version > current).map((m) => m.name),
      history: meta.history || [],
      integrity,
    }, null, 2));
    return;
  }

  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (!pending.length) {
    console.log(`up to date at v${current} (code is v${SCHEMA_VERSION})`);
    return;
  }

  const history = [...(meta.history || [])];
  for (const m of pending) {
    console.log(`\n== v${m.version} ${m.name}${DRY ? ' [dry run]' : ''}`);
    console.log(`   ${m.describe}`);
    const notes = await m.up({ dry: DRY });
    for (const n of notes) console.log(`   - ${n}`);
    history.push({ version: m.version, name: m.name, at: new Date().toISOString(), dry: DRY });
  }

  if (DRY) {
    console.log('\ndry run — nothing was written, and the version was not advanced');
    return;
  }
  const top = Math.max(current, ...pending.map((m) => m.version));
  await writeMeta({ version: top, history });
  console.log(`\nnow at v${top}`);
}

main().catch((e) => {
  // The credential check has already explained itself; anything else is a real
  // fault and gets its full trace.
  if (e?.message !== 'missing Netlify Blobs credentials') console.error(e);
  process.exitCode = 1;
});

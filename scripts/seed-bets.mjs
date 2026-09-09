// scripts/seed-bets.mjs
//
// Seed the append-only ledger with bets that were placed before it existed.
//
//   node scripts/seed-bets.mjs --file=docs/bets.csv        from a spreadsheet
//   node scripts/seed-bets.mjs --from=saved-slips          from this app's own slips
//   node scripts/seed-bets.mjs --file=... --dry            parse and report only
//
// ---------------------------------------------------------------------------
// NO SPREADSHEET IS COMMITTED TO THIS REPO as of 2026-09-09. The brief said to
// seed from one "if one is committed", and `git ls-files` turns up no .csv,
// .tsv or .xlsx anywhere. So this runs, finds nothing, and says so rather than
// appearing to have imported something.
//
// Export the tracking sheet to CSV, commit it, and point --file at it. Expected
// columns (case- and space-insensitive, extras ignored, order irrelevant):
//
//   slip_id, placed_at, slip_type, stake, payout_multiplier
//   leg1_player, leg1_market, leg1_line, leg1_side, leg1_tier
//   leg2_player, ...   (up to leg6_)
//
// The second source is real and already in this project: `saved-slips`, which
// is what the app writes when a slip is saved. It is NOT the same thing as a
// bet — a saved slip may never have been staked — so importing from it stamps
// every row `source: 'saved-slips'` and it is opt-in rather than the default.
//
// ---------------------------------------------------------------------------
// SNAPSHOT FOREIGN KEYS ON HISTORICAL ROWS
//
// A bet placed before the archive existed has no snapshot to point at, and
// there is no honest way to invent one: the line that was on the board at 19:04
// last April was not recorded and cannot be reconstructed. Those legs are
// written with `snapshot_id: null`, which the CLV view reports as unpriced.
//
// The alternative — attaching the nearest snapshot we do have — would silently
// compare a bet against a line from a different day and produce a CLV number
// that looks real. A visible hole is worth more than a plausible fiction.

import fs from 'node:fs';
import { appendBet, legId, AppendOnlyViolation } from '../netlify/functions/ledger-store.js';
import { getStore } from '@netlify/blobs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const DRY = !!args.dry;

/** Minimal RFC-4180 CSV: quoted fields, embedded commas, doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** One spreadsheet row -> a ledger bet. Pure, so it can be tested directly. */
export function rowToBet(row, i) {
  const slipId = row.slip_id || `sheet-${String(i + 1).padStart(4, '0')}`;
  const legs = [];
  for (let n = 1; n <= 6; n++) {
    const player = row[`leg${n}_player`];
    if (!player) continue;
    legs.push({
      leg_id: legId(slipId, legs.length),
      player,
      market: row[`leg${n}_market`] || '',
      line: Number(row[`leg${n}_line`]),
      side: String(row[`leg${n}_side`] || 'over').toLowerCase() === 'under' ? 'under' : 'over',
      tier: row[`leg${n}_tier`] || null,
      team: row[`leg${n}_team`] || null,
      // See the note at the top: a bet from before the archive has no snapshot
      // and gets no invented one.
      snapshot_id: null,
    });
  }
  return {
    slip_id: slipId,
    placed_at: row.placed_at || row.date || '',
    slip_type: row.slip_type || row.type || 'power',
    stake: Number(row.stake || 0),
    payout_multiplier: row.payout_multiplier ? Number(row.payout_multiplier) : null,
    legs,
    source: { import: 'spreadsheet', row: i + 2 },   // +2: 1-indexed, past the header
  };
}

/** A saved slip -> a ledger bet. */
export function slipToBet(slip) {
  const legs = (slip.legs || []).map((l, i) => ({
    leg_id: legId(slip.id, i),
    player: l.player,
    market: l.stat,
    line: Number(l.line),
    side: l.pick === 'under' ? 'under' : 'over',
    tier: l.oddsType || null,
    team: l.team || null,
    opponent: null,
    snapshot_id: null,
  }));
  return {
    slip_id: slip.id,
    placed_at: slip.createdAt,
    slip_type: slip.entry || 'power',
    stake: Number(slip.stake || 0),
    payout_multiplier: null,
    legs,
    source: { import: 'saved-slips', name: slip.name ?? null, slate: slip.slateDate ?? null },
  };
}

async function loadSavedSlips() {
  const s = getStore({ name: 'saved-slips', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  const { blobs } = await s.list();
  const out = [];
  for (const b of blobs) {
    if (b.key.startsWith('_')) continue;
    // eslint-disable-next-line no-await-in-loop
    const slip = await s.get(b.key, { type: 'json' });
    if (slip?.legs?.length) out.push(slip);
  }
  return out;
}

async function main() {
  let bets = [];
  if (args.file) {
    if (!fs.existsSync(args.file)) {
      console.error(`no such file: ${args.file}`);
      process.exitCode = 1;
      return;
    }
    bets = parseCsv(fs.readFileSync(args.file, 'utf8')).map(rowToBet);
    console.log(`parsed ${bets.length} slip(s) from ${args.file}`);
  } else if (args.from === 'saved-slips') {
    bets = (await loadSavedSlips()).map(slipToBet);
    console.log(`found ${bets.length} saved slip(s)`);
  } else {
    console.log('Nothing to seed.\n');
    console.log('  No tracking spreadsheet is committed to this repo — `git ls-files` finds no');
    console.log('  .csv, .tsv or .xlsx anywhere, so there is nothing for --file to point at.\n');
    console.log('  Export the sheet to CSV, commit it, then:');
    console.log('    node scripts/seed-bets.mjs --file=docs/bets.csv --dry\n');
    console.log('  Or import the slips this app has already saved:');
    console.log('    node scripts/seed-bets.mjs --from=saved-slips --dry');
    return;
  }

  let ok = 0, dup = 0;
  const failed = [];
  for (const bet of bets) {
    if (DRY) { console.log(`  would append ${bet.slip_id} (${bet.legs.length} legs, $${bet.stake})`); ok++; continue; }
    try {
      await appendBet(bet);
      ok++;
    } catch (err) {
      // Already imported. Re-running a seed is expected — it is how you finish
      // an import that died halfway — so a duplicate is progress, not a failure.
      if (err instanceof AppendOnlyViolation) { dup++; continue; }
      failed.push({ slip_id: bet.slip_id, error: String(err.message || err) });
    }
  }
  console.log(`\n${DRY ? 'would append' : 'appended'}: ${ok}   already present: ${dup}   failed: ${failed.length}`);
  for (const f of failed) console.log(`  ! ${f.slip_id}: ${f.error}`);
  if (failed.length) process.exitCode = 1;
}

// Only run when invoked directly, so the parsers above can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

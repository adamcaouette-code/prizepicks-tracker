#!/usr/bin/env node
// CLI wrapper around netlify/functions/replay-lib.js — the actual harness.
//
//   node scripts/replay.mjs --run <runId> --k 5 [--base https://atombets.netlify.app]
//   node scripts/replay.mjs --snapshot ./snap.json --k 5
//
// This file owns argv parsing, fetching a snapshot (by runId over HTTP, or from
// a local file), calling the Anthropic API with a real key from the
// environment, and writing/printing the report. It carries no analysis logic —
// see replay-lib.js for that, and for why it lives in netlify/functions/
// instead of here (judge-replay-background.js, the production endpoint,
// imports it directly and needs a plain `./` relative import).
//
// For running the harness WITHOUT a local ANTHROPIC_API_KEY, see
// /api/judge-replay-background — it runs this same logic server-side, where
// the key already lives, and is polled like every other job in this app.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../netlify/functions/replay-lib.js';

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const snapFile = arg('snapshot');
  const runId = arg('run');
  const base = arg('base', process.env.ATOMBETS_BASE || 'https://atombets.netlify.app');
  const k = Number(arg('k', 5));

  let snap;
  if (snapFile) snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  else if (runId) {
    const res = await fetch(`${base}/api/judge-context?runId=${encodeURIComponent(runId)}`);
    snap = await res.json();
    if (snap.error) throw new Error(`${snap.error} (runId ${runId})`);
  } else {
    console.error('usage: replay.mjs (--run <runId> | --snapshot <file>) [--k 5] [--base <url>] [--out <file>]');
    process.exit(2);
  }

  const report = await replay(snap, { k });
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const w of report.warnings) console.error(`WARNING: ${w}`);
  if (report.fidelity?.verdict?.startsWith('SUSPECT')) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
}

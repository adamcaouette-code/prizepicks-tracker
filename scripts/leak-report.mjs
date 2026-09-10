// scripts/leak-report.mjs
//
//   npm run leaks                    the whole report
//   npm run leaks -- --json          as JSON
//   npm run leaks -- --min-slips=10  loosen the "too small to conclude" bar
//
// Ranked by what each slice has COST, not by ROI. A slice at -60% on four
// slips has cost almost nothing; one at -8% across two hundred is the leak.

import { readFile } from 'node:fs/promises';
import { loadReport, renderLeakReport } from '../netlify/functions/leak-report.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};

function requireCredentials() {
  const missing = ['NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN'].filter((k) => !process.env[k]);
  if (!missing.length) return;
  console.error(`Cannot reach the ledger: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n`);
  console.error('  Netlify sets them automatically in a deployed function; locally, export them');
  console.error('  from your site settings, or run through `netlify dev`.\n');
  console.error('  Nothing was read.');
  process.exitCode = 1;
  throw new Error('missing Netlify Blobs credentials');
}

async function main() {
  requireCredentials();
  const payoutConfigs = JSON.parse(
    await readFile(new URL('../netlify/functions/payout-tables.json', import.meta.url), 'utf8'),
  ).configs;
  const rep = await loadReport({
    payoutConfigs,
    minSlips: flag('min-slips') ? Number(flag('min-slips')) : undefined,
    minLegs: flag('min-legs') ? Number(flag('min-legs')) : undefined,
  });
  if (flag('json')) { console.log(JSON.stringify(rep, null, 2)); return; }
  console.log(renderLeakReport(rep));
  console.log(`\nread ${rep.source.bets} bets and ${rep.source.results} results · also at /api/leak-report`);
}

main().catch((err) => {
  if (!/missing Netlify Blobs credentials/.test(String(err.message || err))) console.error(String(err.stack || err));
  process.exitCode = process.exitCode || 1;
});

// scripts/build-correlations.mjs
//
// Estimate the correlation table from ESPN game logs and store it.
//
//   npm run correlations -- --league=mlb --athletes=33840,41261,...
//   npm run correlations -- --league=soccer --athletes=271170,... --dry
//   npm run correlations -- --list          which versions have been built
//
// One HTTP request per athlete (cached by game-logs.js), then everything else
// is arithmetic. The output is a table keyed by relationship and market pair,
// each entry carrying the sample size it was estimated on — see correlation.js.
//
// ATHLETES ARE SUPPLIED, NOT DISCOVERED. Which players matter is a question
// about tonight's board, and this script's job is estimation rather than
// selection: handing it a roster keeps "who did we measure" an explicit,
// reviewable input instead of something a scraper decided.

import { readFile } from 'node:fs/promises';
import { fetchGameLog } from '../netlify/functions/game-logs.js';
import { estimateFromLogs } from '../netlify/functions/correlation.js';
import { saveTable, listVersions } from '../netlify/functions/correlation-store.js';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};

function requireCredentials() {
  const missing = ['NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN'].filter((k) => !process.env[k]);
  if (!missing.length) return;
  console.error(`Cannot reach the store: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n`);
  console.error('  These are the same two variables every other store in this project uses.');
  console.error('  Netlify sets them automatically in a deployed function; locally, export them');
  console.error('  from your site settings, or run this through `netlify dev`.\n');
  console.error('  Nothing was read and nothing was written.');
  process.exitCode = 1;
  throw new Error('missing Netlify Blobs credentials');
}

async function main() {
  if (flag('list')) {
    requireCredentials();
    const v = await listVersions();
    console.log(v.length ? v.join('\n') : 'no correlation table has been built yet');
    return;
  }

  const league = flag('league', 'mlb');
  const athletes = String(flag('athletes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!athletes.length) {
    console.error('Nothing to estimate from: pass --athletes=<espn id>,<espn id>,...\n');
    console.error('  Correlation is measured BETWEEN players, so a single athlete can only');
    console.error('  produce same-player and game-total estimates. Team-mates and opponents');
    console.error('  need at least two ids that actually played each other.');
    process.exitCode = 1;
    return;
  }
  const dry = !!flag('dry');
  if (!dry) requireCredentials();

  const config = JSON.parse(await readFile(new URL('../netlify/functions/correlation-config.json', import.meta.url), 'utf8'));
  const projConfig = JSON.parse(await readFile(new URL('../netlify/functions/projection-config.json', import.meta.url), 'utf8'));

  const logs = [];
  for (const id of athletes) {
    // eslint-disable-next-line no-await-in-loop
    const got = await fetchGameLog({ league, athleteId: id, config: projConfig });
    if (!got.ok) { console.error(`  skipped ${id}: ${got.reason}`); continue; }
    logs.push({
      athleteId: got.athleteId,
      player: String(id),
      team: got.rows[0]?.team?.abbreviation || null,
      league,
      position: got.position,
      rows: got.rows,
    });
    console.error(`  ${id}: ${got.rows.length} games, team ${got.rows[0]?.team?.abbreviation || '?'}`);
  }

  if (logs.length < 2) {
    console.error('\nFewer than two usable logs — only same-player and game-total pairs are possible.');
  }

  const table = estimateFromLogs(logs, { config });
  const pairs = Object.values(table.pairs);
  const byRel = {};
  for (const p of pairs) (byRel[p.relationship] ||= []).push(p);

  console.error('');
  for (const [rel, list] of Object.entries(byRel)) {
    const ns = list.map((p) => p.n);
    console.error(`  ${rel.padEnd(18)} ${String(list.length).padStart(4)} pairs, `
      + `n ${Math.min(...ns)}-${Math.max(...ns)}, `
      + `|rho| up to ${Math.max(...list.map((p) => Math.abs(p.rho))).toFixed(3)}`);
  }
  console.error(`  ${'total'.padEnd(18)} ${String(pairs.length).padStart(4)} pairs from ${logs.length} logs`);

  if (dry) {
    console.log(JSON.stringify(table, null, 2));
    return;
  }
  const saved = await saveTable(table, flag('id') ? { id: String(flag('id')) } : {});
  console.error(`\nstored as ${saved.id}; "current" now points at it`);
}

main().catch((err) => {
  if (!/missing Netlify Blobs credentials/.test(String(err.message || err))) {
    console.error(String(err.stack || err));
  }
  process.exitCode = process.exitCode || 1;
});

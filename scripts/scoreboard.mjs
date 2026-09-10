// scripts/scoreboard.mjs
//
// THE PRIMARY SCOREBOARD. Grades the model's probabilities, not its results.
//
//   npm run scoreboard                    everything ever graded
//   npm run scoreboard -- --days=30       the last 30 days
//   npm run scoreboard -- --league=mlb    one sport
//   npm run scoreboard -- --json          the whole report as JSON
//   npm run scoreboard -- --closing       price against the CLOSING line
//   npm run scoreboard -- --half-width=10 a looser ±10pp target for "meaningful"
//   npm run scoreboard -- --no-book       skip the archive scan (fast)
//
// A win rate tells you whether the picks landed. This tells you whether the
// PROBABILITIES are right, which is the thing every other number in this app is
// computed from.

import { joinRows } from '../netlify/functions/scoreboard-join.js';
import { buildReport, renderReport } from '../netlify/functions/scoreboard.js';
import { readFile } from 'node:fs/promises';

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
  console.error(`Cannot reach the pick log: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n`);
  console.error('  These are the same two variables every other store in this project uses.');
  console.error('  Netlify sets them automatically in a deployed function; locally, export them');
  console.error('  from your site settings (Site configuration -> Environment variables), or run');
  console.error('  this through `netlify dev` so the runtime supplies them.\n');
  console.error('  Nothing was read and nothing was written.');
  process.exitCode = 1;
  throw new Error('missing Netlify Blobs credentials');
}

const json = async (path, fallback = {}) => {
  try { return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')); }
  catch { return fallback; }
};

async function main() {
  requireCredentials();

  const weights = await json('../netlify/functions/book-weights.json');
  const models = await json('../netlify/functions/market-models.json');

  const { rows, meta } = await joinRows({
    days: flag('days') ? Number(flag('days')) : null,
    mode: flag('closing') ? 'closing' : 'contemporaneous',
    skipBook: !!flag('no-book'),
    weights,
    models,
  });

  const league = flag('league');
  const filtered = league ? rows.filter((r) => r.league === league) : rows;

  const halfWidth = flag('half-width') ? Number(flag('half-width')) / 100 : 0.05;
  const report = buildReport(filtered, {
    bins: Number(flag('bins', 10)),
    halfWidth,
    minN: Number(flag('min-n', 30)),
    meta: { ...meta, league: league || 'all' },
  });
  report.generated_at = new Date().toISOString();

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderReport(report));
  console.log(`generated ${report.generated_at}${league ? ` · league=${league}` : ''}`);

  // A non-zero exit when the book is being lost to, so this can gate a deploy
  // or a cron without anyone having to read the output. Silence is not the same
  // as passing, and a scoreboard nobody reads should still be able to shout.
  const b = report.baselines.book;
  if (b.available && !b.beatsBook) process.exitCode = 2;
}

main().catch((err) => {
  if (!/missing Netlify Blobs credentials/.test(String(err.message || err))) {
    console.error(String(err.stack || err));
  }
  process.exitCode = process.exitCode || 1;
});

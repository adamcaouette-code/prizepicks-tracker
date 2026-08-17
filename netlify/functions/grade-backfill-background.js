// netlify/functions/grade-backfill-background.js
//
// Grades EVERY day in the pick log, oldest first.
//
// The cron only ever targets the last four days (grade-cron.js: day(1)..day(4)).
// That is correct for keeping up, but it means anything older than four days is
// permanently out of reach — and the log goes back weeks. When the graders
// change, as they just have, the whole history needs one sweep to catch up. The
// cron cannot do that by design.
//
// A background function because this is minutes of work, not seconds: 15 minutes
// of budget instead of the ~10s a synchronous function gets.
//
// TWO THINGS ABOUT BACKGROUND FUNCTIONS THAT ARE EASY TO GET WRONG:
//   - The work must happen INSIDE the handler. Netlify ends the invocation when
//     the handler returns, so kicking off a detached promise and returning early
//     gets that promise killed. The 202 the caller sees is synthesised by the
//     platform, not by this return value.
//   - Same v1 signature as every other function here. Mixing the v2
//     (export default + Response) style into this directory is a needless
//     inconsistency, and a bundling failure takes down the WHOLE deploy — which
//     leaves the previous one live and makes every new endpoint 404.
//
// Progress goes to run-stats/backfill, readable at /api/grade-backfill-status.
//
// Usage: /api/grade-backfill-background
//        ?from=2026-07-01   only days on or after this
//        ?dry=1             report what WOULD grade, write nothing

import { getStore } from '@netlify/blobs';
import { handler as gradePicks } from './grade-picks.js';

const PROGRESS_KEY = 'backfill';

async function writeProgress(state) {
  try {
    const store = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    await store.setJSON(PROGRESS_KEY, { ...state, at: new Date().toISOString() });
  } catch { /* progress is best-effort; never let it stop the work */ }
}

export const handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const from = q.from || '';
  const dry = q.dry === '1';
  const started = Date.now();

  let dates = [];
  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    dates = (await store.list()).blobs.map((b) => b.key).sort();
  } catch (e) {
    await writeProgress({ state: 'error', error: String(e.message || e) });
    return { statusCode: 500 };
  }
  if (from) dates = dates.filter((d) => d >= from);

  await writeProgress({ state: 'running', days: dates.length, done: 0, graded: 0 });

  let graded = 0, revived = 0, done = 0;
  const perDay = {};
  for (const date of dates) {
    // Each day may need several passes: grade-picks works to an ~8s budget and
    // reports what it could not reach, so a heavy day is drained rather than
    // half-done and abandoned.
    for (let pass = 0; pass < 12; pass++) {
      let out;
      try {
        const res = await gradePicks({ queryStringParameters: { date, ...(dry ? { dry: '1' } : {}) } });
        out = JSON.parse(res.body);
      } catch (e) {
        perDay[date] = { error: String(e.message || e) };
        break;
      }
      graded += out.newlyGraded || 0;
      revived += out.revived || 0;
      perDay[date] = {
        graded: (perDay[date]?.graded || 0) + (out.newlyGraded || 0),
        pending: out.stillPending ?? null,
      };
      // Nothing left to reach, or nothing moved — either way this day is done.
      if (!out.timedOut && !out.remaining) break;
      if (!out.newlyGraded && pass > 0) break;
    }
    done++;
    if (done % 3 === 0) await writeProgress({ state: 'running', days: dates.length, done, graded, revived });
  }

  await writeProgress({
    state: 'done', days: dates.length, done, graded, revived, dry,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    perDay,
  });

  return { statusCode: 200, body: JSON.stringify({ days: dates.length, graded, revived }) };
};

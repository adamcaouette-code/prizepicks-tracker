// netlify/functions/grade-cron.js
//
// The SCHEDULED half of automatic grading. All it does is fire the background
// function and record that it fired. The actual draining lives in
// grade-cron-background.js.
//
// WHY THIS FILE EXISTS — a 5-day outage, caused by the fix for the last one.
//
// Grading used to be one scheduled function, and it kept getting killed at the
// sync timeout (~10-26s) partway through draining a real backlog, going silent
// for days at a time. The fix on 2026-08-29 renamed it to
// `grade-cron-background.js` for the 15-minute budget — and moved
// `export const config = { schedule }` along with it.
//
// Those are two DIFFERENT KINDS of function on Netlify and a file cannot be
// both:
//   - a background function is defined by the `-background` filename suffix,
//     is invoked over HTTP, returns 202 immediately, and gets 15 minutes
//   - a scheduled function is defined by `config.schedule`, is invoked by
//     Netlify's cron, and gets 30 seconds
// A `-background` file's `schedule` is simply never registered. So the rename
// bought the execution budget and silently threw away the trigger: grading ran
// for the last time at 2026-08-29T21:08Z and did not run again. 1,159 picks
// across five days went ungraded, which is 1,159 picks missing from the
// calibration sample — the numbers on /api/calibration were being computed off
// a log that had quietly stopped being filled in.
//
// The scheduler-shim split is the supported way to have both: this function is
// scheduled and finishes in well under a second; the background function it
// pokes keeps the long budget.
//
// WHY THE OUTAGE WAS INVISIBLE, which is the part worth not repeating. The
// verification at the time was "trigger it and watch for a heartbeat" — which
// tests the FUNCTION, not the SCHEDULE, and the heartbeat it produced was
// stamped `trigger: 'schedule'` because that label was hardcoded for anything
// not running under `netlify dev`. A manual poke was therefore indistinguishable
// from a real cron fire in the only record that existed. Two things fix that:
// this function writes its own `schedule-dispatch` entry when the CRON fires
// (so "did the scheduler run" is answerable on its own), and the background
// function now reports the trigger it was actually given instead of asserting
// one.
export const config = { schedule: '0 10,11,14 * * *' };

import { heartbeat } from './grade-cron-background.js';

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';
  let ok = false, status = null, error = null;
  try {
    // Background functions answer 202 and keep working, so this resolves in
    // roughly the time of one round trip — nowhere near the 30s ceiling.
    const res = await fetch(`${base}/api/grade-cron-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'schedule' }),
    });
    status = res.status;
    ok = res.status === 202 || res.ok;
  } catch (e) {
    error = String(e.message || e);
  }
  // Recorded whether or not the dispatch worked. A dispatch entry with no
  // matching completion entry after it is the signature of the background
  // function dying mid-drain; NO dispatch entry at all is the signature of the
  // scheduler itself not firing. Those had been the same observation.
  await heartbeat({ trigger: 'schedule-dispatch', dispatched: ok, status, error });
  return { statusCode: 200, body: JSON.stringify({ dispatched: ok, status, error }) };
};

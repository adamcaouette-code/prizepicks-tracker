// netlify/functions/grade-cron.js
//
// The SCHEDULED half of automatic grading. All it does is fire the background
// function and record that it fired. The actual draining lives in
// grade-cron-background.js.
//
// WHY THIS FILE EXISTS — grading was never actually scheduled. Ever.
//
// The schedule for this function is declared in netlify.toml, and that is the
// only place it takes effect. The `export const config` below is kept so the
// intent is readable next to the code, but it does NOT register anything: this
// function uses the legacy `export const handler` signature
// (runtimeAPIVersion 1), and in-code config is a v2-functions feature. A test
// asserts the two agree so they cannot drift.
//
// FOUND 2026-09-03, while auditing why the judge was not beating the tier
// baseline: the graded log had stopped growing after 2026-08-28, leaving 1,159
// picks ungraded. The obvious suspect was the 2026-08-29 rename of
// grade-cron.js to grade-cron-background.js (for the 15-minute budget), which
// carried `config.schedule` onto a `-background` file where Netlify certainly
// never registers it. That was the wrong diagnosis, and the evidence says so:
//
//   - the deploy API reported `function_schedules: []` BOTH before and after
//     that rename — there was no registered schedule to break
//   - all 16 recorded heartbeats are manual invocations. The gaps between them
//     are 6, 9, 10, 12, 14, 17, 18, 21, 41, 42 seconds — testing bursts on one
//     afternoon — then 2500s, 1.7h, 80.5h, 114.9h. A cron firing at 10/11/14
//     UTC daily would leave a 1h / 3h / 20h pattern repeating for two months.
//     There is no such pattern anywhere in the history.
//
// So every pick that ever got graded was graded by hand, and grading "stopped"
// simply because nobody ran it. The rename didn't break the schedule; the
// schedule had never worked.
//
// WHY IT STAYED INVISIBLE, which is the part worth not repeating:
//   1. verification was "trigger it and watch for a heartbeat" — that tests the
//      FUNCTION, not the SCHEDULE, and passes identically either way;
//   2. the heartbeat lied about its own trigger, stamping every deployed
//      invocation `'schedule'` regardless of what invoked it, so a manual poke
//      was indistinguishable from a cron fire in the only record kept;
//   3. the schedule test read the cron string out of the source and checked it
//      was well-formed — asserting the schedule was CORRECT, never that it was
//      REGISTERED.
// All three are fixed. The real confirmation is `function_schedules` coming
// back non-empty from the deploy API; nothing observable from inside the app
// can tell you a schedule is registered.
//
// The scheduler-shim split is the supported way to get a long-running job onto
// a cron: this function is scheduled and finishes in well under the 30s
// scheduled-function limit; the background function it pokes keeps the
// 15-minute budget.
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

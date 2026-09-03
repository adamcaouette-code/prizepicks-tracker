// netlify/functions/grade-cron-background.js
//
// Automatic daily grading — no manual clicks. Netlify runs this on the schedule
// below; it fully DRAINS yesterday and the day before by calling the grader
// repeatedly until each day stops making progress (large slates need multiple
// passes since each grader call is time-budgeted).
//
// Manual grading via /api/grade-picks and the dev console still works anytime;
// this just makes it unnecessary.
//
// RENAMED from grade-cron.js (2026-08-29): this loop can run up to 4 days x 15
// passes, each pass a real HTTP round trip to /api/grade-picks. A standard
// Netlify function is killed at the sync timeout (~10-26s depending on plan)
// long before that finishes with any real backlog — which is exactly what
// happened: the heartbeat below went silent for 3 days because the function
// kept getting killed before ever reaching its own heartbeat() call at the
// end, with no error surfaced anywhere (a killed function isn't a caught
// exception). The `-background` suffix is what tells Netlify to give this up
// to 15 minutes instead — same mechanism every other `*-background.js` file
// in this repo already relies on, just never applied here because nothing
// user-facing was waiting on this one's response. Nothing about the draining
// LOOP changed, only how much wall time it's allowed.
//
// THE SCHEDULE DOES NOT LIVE HERE, and must never be moved back (2026-09-03).
// The rename above also carried `export const config = { schedule }` onto this
// file, where Netlify certainly never registers it: `-background` and scheduled
// are two different kinds of function and a file cannot be both. (As it turned
// out that wasn't what broke grading — the deploy API shows no schedule was
// ever registered for this site, on any deploy, and every heartbeat in two
// months of history is a manual invocation. The schedule now lives in
// netlify.toml, which is the only thing that registers one. See grade-cron.js
// for the evidence.) grade-cron.js is a scheduled shim that pokes this
// function over HTTP so it keeps the 15-minute budget.

import { getStore } from '@netlify/blobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Heartbeat. Without a record of when this last fired, "did the cron run?" is
// unanswerable — you can only observe that nothing got graded, which looks the
// same whether the schedule never fired or there was simply nothing to settle.
export async function heartbeat(payload) {
  try {
    const store = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let log = [];
    try { log = (await store.get('cron-heartbeat', { type: 'json' })) || []; } catch {}
    log.push({ at: new Date().toISOString(), ...payload });
    await store.setJSON('cron-heartbeat', log.slice(-30));
  } catch { /* never let bookkeeping break the job */ }
}

export const handler = async (event) => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';
  // REPORT the trigger, never assert it. This used to be
  // `process.env.NETLIFY_DEV ? 'local' : 'schedule'`, which stamped every
  // deployed invocation as 'schedule' — including a hand-fired one. That is
  // precisely how a broken schedule passed verification on 2026-08-29: the
  // manual poke used to confirm the fix wrote a heartbeat labelled 'schedule',
  // so the record showed a cron that had in fact already stopped running.
  // grade-cron.js (the scheduled shim) sends trigger:'schedule'; anything else
  // reaching this function is a manual or dev invocation and says so.
  let trigger = process.env.NETLIFY_DEV ? 'local' : 'manual';
  try {
    const body = JSON.parse(event?.body || '{}');
    if (body && typeof body.trigger === 'string' && body.trigger) trigger = body.trigger;
  } catch { /* no body, or not JSON — it was not the scheduler */ }
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  // Four days back, not two. A day that didn't fully drain in its first 48h was
  // previously never revisited, so those picks stayed pending forever — and a
  // pick that never grades is a pick silently missing from the calibration
  // sample. A day with nothing left returns immediately, so the extra passes
  // cost a blob read each.
  const targets = [day(1), day(2), day(3), day(4)];

  const ran = [];
  for (const d of targets) {
    let passes = 0, last = null, prevPending = Infinity, stalled = 0;
    while (passes < 15) {                       // hard cap on passes per day
      passes++;
      try {
        const res = await fetch(`${base}/api/grade-picks?date=${d}`);
        last = await res.json().catch(() => null);
      } catch (e) {
        last = { error: String(e.message || e) };
      }
      const pending = last && typeof last.pendingSingles === 'number' ? last.pendingSingles : null;
      const remaining = last && typeof last.remaining === 'number' ? last.remaining : null;

      // fully drained: nothing left in the queue for this pass
      if (pending === 0 || (remaining === 0 && (last?.newlyGraded ?? 0) === 0)) break;
      // stop if we're not making progress (e.g. all that's left is stillPending retries)
      if (pending !== null) {
        if (pending >= prevPending) { stalled++; if (stalled >= 2) break; }
        else stalled = 0;
        prevPending = pending;
      }
      await sleep(500);
    }
    ran.push({
      date: d, passes,
      totalGraded: last?.totalGraded ?? null,
      pendingSingles: last?.pendingSingles ?? null,
      givenUp: last?.givenUp ?? null,
      combos: last?.combos ?? null,
      error: last?.error ?? null,
    });
  }
  // Saved slips settle from the same history data, so grade them right after the
  // pick log — that's what makes a saved slip update itself instead of sitting
  // "pending" until you happen to open the page. Time-budgeted like the grader,
  // so loop until it stops settling anything.
  const slips = [];
  for (let pass = 0; pass < 6; pass++) {
    let out = null;
    try {
      const res = await fetch(`${base}/api/grade-slips`);
      out = await res.json().catch(() => null);
    } catch (e) {
      out = { error: String(e.message || e) };
    }
    slips.push({ pass: pass + 1, legsGraded: out?.legsGraded ?? null, slipsSettled: out?.slipsSettled ?? null, error: out?.error ?? null });
    if (out?.error || (!out?.legsGraded && !out?.timedOut)) break;
    await sleep(500);
  }

  const summary = {
    trigger,
    picks: ran.map((r) => ({ date: r.date, graded: r.totalGraded, pending: r.pendingSingles, error: r.error })),
    slipLegsGraded: slips.reduce((a, s) => a + (s.legsGraded || 0), 0),
    slipsSettled: slips.reduce((a, s) => a + (s.slipsSettled || 0), 0),
  };
  await heartbeat(summary);
  return { statusCode: 200, body: JSON.stringify({ ran, slips, summary }) };
};

// netlify/functions/grade-cron.js
//
// Automatic daily grading — no manual clicks. Netlify runs this on the schedule
// below; it fully DRAINS yesterday and the day before by calling the grader
// repeatedly until each day stops making progress (large slates need multiple
// passes since each grader call is time-budgeted).
//
// Manual grading via /api/grade-picks and the dev console still works anytime;
// this just makes it unnecessary.

// Netlify cron is UTC and has no idea about daylight saving, so "3am Pacific" is
// a different UTC hour depending on the season:
//   10:00 UTC = 3am PDT (Mar-Nov)   11:00 UTC = 3am PST (Nov-Mar)
// Firing at both hits 3am Pacific year-round; the off-season one lands at 2am or
// 4am and simply finds nothing left to do. 14:00 UTC stays as a late backstop for
// anything whose box score wasn't final at 3am. Grading is idempotent — a pass
// with nothing to settle costs a blob list and exits — so extra runs are cheap
// and none of this touches a model.
export const config = { schedule: '0 10,11,14 * * *' };

import { getStore } from '@netlify/blobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Heartbeat. Without a record of when this last fired, "did the cron run?" is
// unanswerable — you can only observe that nothing got graded, which looks the
// same whether the schedule never fired or there was simply nothing to settle.
async function heartbeat(payload) {
  try {
    const store = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let log = [];
    try { log = (await store.get('cron-heartbeat', { type: 'json' })) || []; } catch {}
    log.push({ at: new Date().toISOString(), ...payload });
    await store.setJSON('cron-heartbeat', log.slice(-30));
  } catch { /* never let bookkeeping break the job */ }
}

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const targets = [day(1), day(2)];

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
    trigger: process.env.NETLIFY_DEV ? 'local' : 'schedule',
    picks: ran.map((r) => ({ date: r.date, graded: r.totalGraded, pending: r.pendingSingles, error: r.error })),
    slipLegsGraded: slips.reduce((a, s) => a + (s.legsGraded || 0), 0),
    slipsSettled: slips.reduce((a, s) => a + (s.slipsSettled || 0), 0),
  };
  await heartbeat(summary);
  return { statusCode: 200, body: JSON.stringify({ ran, slips, summary }) };
};

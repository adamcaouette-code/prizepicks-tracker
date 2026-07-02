// netlify/functions/grade-cron.js
//
// Automatic daily grading — no manual clicks. Netlify runs this on the schedule
// below; it fully DRAINS yesterday and the day before by calling the grader
// repeatedly until each day stops making progress (large slates need multiple
// passes since each grader call is time-budgeted).
//
// Manual grading via /api/grade-picks and the dev console still works anytime;
// this just makes it unnecessary.

export const config = { schedule: '0 14 * * *' }; // 14:00 UTC daily (~6-7am Pacific)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { statusCode: 200, body: JSON.stringify({ ran }) };
};

// netlify/functions/grade-cron.js
//
// Runs the grader automatically once a day so logged picks actually get hit/miss
// filled in. It just calls the existing /api/grade-picks endpoint for the last two
// days (yesterday + the day before, to catch late-posting west-coast results).
//
// No manual action needed once deployed — Netlify runs it on the schedule below.
// You can still hit /api/grade-picks?date=YYYY-MM-DD by hand anytime.

export const config = { schedule: '0 14 * * *' }; // 14:00 UTC daily (~6-7am Pacific)

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const targets = [day(1), day(2)];

  const ran = [];
  for (const d of targets) {
    try {
      const res = await fetch(`${base}/api/grade-picks?date=${d}`);
      let info = null;
      try { info = await res.json(); } catch { /* non-JSON is fine */ }
      ran.push({ date: d, status: res.status, newlyGraded: info?.newlyGraded ?? null, totalGraded: info?.totalGraded ?? null });
    } catch (e) {
      ran.push({ date: d, error: String(e.message || e) });
    }
  }
  return { statusCode: 200, body: JSON.stringify({ ran }) };
};

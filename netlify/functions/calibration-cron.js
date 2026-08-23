// netlify/functions/calibration-cron.js
//
// One balanced calibration run a day, in the morning, so the measurement sample
// grows without anyone remembering to click.
//
// WHY MORNING. An evening run is close to free — lineups are posted by then, so
// the search budget drops to its floor — but by evening most of the day's slate
// has already started and those props are gone. A calibration run is only worth
// what it samples, and the morning board is the whole day.
//
// WHAT THAT COSTS. The saving in bet-finder comes from skipping a web search for
// any game whose lineup the official feed already confirmed. In the morning
// nothing is confirmed yet, so the run buys a search per game and is roughly 4x
// an evening run — about $0.25 against $0.06 on Vilifiant. That is the price of
// sampling the full slate, and it is deliberate rather than an oversight: making
// the morning run search less would change what the judge knows, and a sample
// judged on less information is not comparable with the picks it is being
// measured against.
//
// WHY THIS IS SEPARATE FROM A BETTING RUN. A balanced run takes the tiers evenly
// instead of letting the tier ranking fill the board with goblins. That is the
// right sample for measuring — the headline diagnostic is the gap between what
// the judge says about goblins and about demons, and it cannot be computed
// without both — and the wrong board to bet from, because the judge then ranks
// ~20 goblins instead of ~44 and you bet the best of a smaller pool.
//
// Env:
//   CALIBRATION_CRON_DISABLE=1   turn it off without a deploy
//   CALIBRATION_LEAGUES          comma-separated, default "mlb". EACH league is
//                                a separate run and a separate charge, so this
//                                is deliberately not "all of them".

// Netlify cron is UTC and does not know about daylight saving, so 10am Eastern
// is a different UTC hour by season:
//   14:00 UTC = 10am EDT (Mar-Nov)    15:00 UTC = 10am EST (Nov-Mar)
// Both fire year-round and the off-season one lands at 9am or 11am. Unlike
// grading, a judge run is NOT idempotent — every firing spends real money — so
// the second one is stopped by the once-a-day guard below rather than by being
// harmless.
export const config = { schedule: '0 14,15 * * *' };

import { getStore } from '@netlify/blobs';

const STORE = () => getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

/** Today in US Eastern, which is the day the slate belongs to. */
export const easternDay = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const leaguesFrom = (raw) => String(raw || 'mlb')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 4);

async function note(payload) {
  try {
    const store = STORE();
    let log = [];
    try { log = (await store.get('calibration-cron', { type: 'json' })) || []; } catch {}
    log.push({ at: new Date().toISOString(), ...payload });
    await store.setJSON('calibration-cron', log.slice(-30));
  } catch { /* bookkeeping must never break the job */ }
}

export const handler = async () => {
  if (process.env.CALIBRATION_CRON_DISABLE === '1') {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'disabled' }) };
  }

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';
  const day = easternDay();

  // THE GUARD. The schedule fires twice so one of them lands at 10am Eastern
  // whatever the season, but a judge run costs money every time — so the day is
  // recorded and the second firing does nothing. Read before spending, always.
  let last = null;
  try { last = await STORE().get('calibration-cron-day', { type: 'json' }); } catch {}
  if (last?.day === day) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'already ran today', day }) };
  }
  // Claim the day BEFORE launching. If the two firings overlap, or a retry
  // arrives while the first is still in flight, claiming afterwards would let
  // both through and charge twice. A crash after this point costs one skipped
  // day, which is the cheaper failure.
  try { await STORE().setJSON('calibration-cron-day', { day, at: new Date().toISOString() }); } catch {}

  const leagues = leaguesFrom(process.env.CALIBRATION_LEAGUES);
  const started = [];
  for (const league of leagues) {
    const jobId = `cal-${day}-${league}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await fetch(`${base}/api/bet-finder-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId, league, today: true, legs: 3,
          // The three things that make this a measurement rather than a board:
          // every tier present, taken evenly, at the widest board allowed.
          tiers: ['goblin', 'standard', 'demon'],
          balance: true,
        }),
      });
      started.push({ league, jobId, status: res.status });
    } catch (e) {
      started.push({ league, jobId, error: String(e.message || e) });
    }
  }

  // An empty slate is not a failure and does not cost a model call — bet-finder
  // returns before the judge when there are no candidates — so an off-season
  // morning is simply a cheap no-op.
  await note({ day, leagues, started });
  return { statusCode: 200, body: JSON.stringify({ day, started }, null, 2) };
};

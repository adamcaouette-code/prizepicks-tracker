// The daily balanced calibration run.
//
// The thing that makes this different from every other cron here: grading is
// idempotent, so grade-cron can fire three times a day and the extra passes
// cost a blob read. A judge run is NOT — every firing spends real money. The
// schedule fires twice so one lands at 10am Eastern in either half of the year,
// which means the guard is not a nicety, it is the whole safety of the design.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

async function fire(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  const posts = [];
  const mock = mockFetch([
    ['bet-finder-background', async (url, init) => { posts.push(JSON.parse(init.body)); return {}; }],
  ]);
  let out;
  try {
    const { handler } = await loadFn('calibration-cron.js');
    out = JSON.parse((await handler({})).body);
  } finally {
    mock.restore();
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
  return { out, posts };
}

export default async function ({ t }) {
  const { easternDay, leaguesFrom } = await loadFn('calibration-cron.js');

  // ---- the day is the SLATE's day, not UTC's -----------------------------
  // A 10pm Eastern moment is already tomorrow in UTC. Keying the once-a-day
  // guard on the UTC date would let a late-evening manual run and the next
  // morning's cron count as the same day, or split one slate across two.
  t.eq('the day is Eastern, where the slate lives',
    easternDay(new Date('2026-08-24T02:30:00Z')), '2026-08-23');
  t.eq('...and a morning firing lands on the same day it samples',
    easternDay(new Date('2026-08-23T14:00:00Z')), '2026-08-23');

  t.eq('leagues default to mlb alone, since each one is a separate charge',
    leaguesFrom(undefined), ['mlb']);
  t.eq('...and are parsed, trimmed and lowercased', leaguesFrom(' MLB , wnba '), ['mlb', 'wnba']);
  t.eq('...and capped, so a typo cannot launch twenty paid runs',
    leaguesFrom('a,b,c,d,e,f,g').length, 4);

  // ---- it actually asks for a MEASUREMENT run ----------------------------
  reset();
  const first = await fire({ CALIBRATION_CRON_DISABLE: null, CALIBRATION_LEAGUES: null });
  t.eq('one run is launched', first.posts.length, 1);
  t.eq('...balanced, which is what makes it a sample rather than a board',
    first.posts[0].balance, true);
  t.eq('...with every tier present, since the tier gap needs both ends',
    first.posts[0].tiers.slice().sort(), ['demon', 'goblin', 'standard']);
  t.eq('...for today\'s slate', first.posts[0].today, true);

  // ---- the guard: firing twice must not charge twice ---------------------
  const second = await fire({ CALIBRATION_CRON_DISABLE: null, CALIBRATION_LEAGUES: null });
  t.eq('the second firing of the day launches nothing', second.posts.length, 0);
  t.ok('...and says why', /already ran/.test(second.out.skipped || ''), JSON.stringify(second.out));

  // The day is claimed BEFORE the run is launched. Claiming afterwards would let
  // an overlapping second firing through and charge twice, which is the exact
  // failure the guard exists to prevent.
  t.eq('the day was recorded', read('run-stats', 'calibration-cron-day')?.day, easternDay());

  // ---- a new day releases it ---------------------------------------------
  reset();
  const fresh = await fire({ CALIBRATION_CRON_DISABLE: null, CALIBRATION_LEAGUES: null });
  t.eq('a new day runs again', fresh.posts.length, 1);

  // ---- kill switch --------------------------------------------------------
  reset();
  const off = await fire({ CALIBRATION_CRON_DISABLE: '1' });
  t.eq('the kill switch stops it without a deploy', off.posts.length, 0);
  t.ok('...and does not consume the day, so turning it back on still runs',
    !read('run-stats', 'calibration-cron-day'));

  // ---- more than one league ----------------------------------------------
  reset();
  const two = await fire({ CALIBRATION_CRON_DISABLE: null, CALIBRATION_LEAGUES: 'mlb,nfl' });
  t.eq('each league is its own run', two.posts.map((p) => p.league), ['mlb', 'nfl']);
  t.eq('...each with its own job id', new Set(two.posts.map((p) => p.jobId)).size, 2);

  // ---- a launch failure must not wedge the schedule ----------------------
  reset();
  const boom = mockFetch([['bet-finder-background', async () => { throw new Error('network down'); }]]);
  let res;
  try {
    const { handler } = await loadFn('calibration-cron.js');
    res = JSON.parse((await handler({})).body);
  } finally { boom.restore(); }
  t.ok('a failed launch is reported rather than thrown', /network down/.test(JSON.stringify(res)), JSON.stringify(res));
  t.ok('...and the heartbeat records the attempt, so a silent cron is visible',
    (read('run-stats', 'calibration-cron') || []).length > 0);
}

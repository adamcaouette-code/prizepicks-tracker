// Scanning the next game day when there isn't one today.
//
// MLB plays every day, so "today" was always the right board and nothing else
// was ever needed. CFB plays Saturday plus a Thursday/Friday game or two; NFL
// plays Sunday, Monday and Thursday. On every other morning their whole posted
// board is dated forward, "today" is empty, and scanning was simply unavailable
// — the app's answer was to come back in three days.
//
// Measured on the live board while writing this: all 658 posted CFB props were
// for 2026-09-11 and 2026-09-12, none for the 09-08 the question was asked on.
//
// NEXT, NOT TOMORROW. Asked on a Tuesday against that board, this has to return
// Friday. Stepping forward one day at a time lands on Wednesday, finds nothing,
// and is exactly the behaviour being replaced.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// `today` is PrizePicks' own boolean, which the row parser trusts over the
// string compare — so a fixture has to set it the way PrizePicks does.
const proj = (rows) => ({
  data: rows.map((r, i) => ({
    id: `pp-${i}`, type: 'projection',
    attributes: {
      stat_type: r.stat, stat_display_name: r.stat, line_score: r.line,
      odds_type: r.tier || 'standard', description: r.opp || 'OPP',
      allowed_wager_types: 'over', start_time: `${r.day}T20:00:00.000-04:00`,
      today: r.day === TODAY,
    },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({
    id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team || 'AAA', position: r.pos || 'WR', market: r.team || 'AAA' },
  })),
  meta: { total_pages: 1 },
});

const answer = async (init) => {
  const payload = String(JSON.parse(init.body).messages[0].content);
  const sent = JSON.parse(payload.slice(payload.indexOf('{')));
  const picks = Object.values(sent).flat().map((e) => ({
    player: e.player, stat: e.stat, line: e.line, prob: 0.66, key_risk: 'k', reasoning: 'r',
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {} };
};

async function run(rows, body) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    // MLB's id is pinned in code; every other league is resolved live from the
    // catalog, so a CFB run needs this before it can fetch a single prop.
    ['partner-api.prizepicks.com/leagues', async () => ({
      data: [{ id: '15', type: 'league', attributes: { name: 'CFB', projections_count: 658, active: true } }],
    })],
    ['partner-api.prizepicks.com/projections', async () => proj(rows)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => answer(init)],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({
      jobId: 'ns', league: 'cfb', legs: 3, today: true,
      tiers: ['goblin', 'standard', 'demon'], ...body }) });
  } finally { mock.restore(); }
  return read('bet-jobs', 'ns')?.result || {};
}

export default async function ({ t }) {
  // The live shape: nothing today, a small Friday slate, a big Saturday one,
  // and a Wednesday with nothing at all in between.
  const FRI = plus(3), SAT = plus(4);
  const FUTURE = [
    { player: 'Friday Guy', stat: 'Rec TDs', line: 0.5, day: FRI },
    { player: 'Friday Gal', stat: 'Rush Yards', line: 55.5, day: FRI },
    { player: 'Saturday Guy', stat: 'Receiving Yards', line: 70.5, day: SAT },
    { player: 'Saturday Gal', stat: 'Player Touchdowns', line: 0.5, day: SAT },
  ];

  // ---- 1. the default is unchanged ----------------------------------------
  const today = await run(FUTURE, {});
  t.eq('without asking, an empty day is still an empty day', (today.board || []).length, 0);
  t.ok('...and it names the next date', /next posted slate is/.test(today.emptyMessage || ''), today.emptyMessage);
  t.eq('...as a field the page can act on', today.slate?.nextAvailable, FRI);

  // ---- 2. the next game day, not the next day -----------------------------
  const next = await run(FUTURE, { slate: 'next' });
  const names = (next.board || []).map((p) => p.player).sort();
  t.eq('asked for the next slate, it judges Friday', names, ['Friday Gal', 'Friday Guy']);
  t.ok('...and does NOT reach past it into Saturday, which is a different slate',
    !names.includes('Saturday Guy'), names.join(', '));
  t.eq('the result says which day it actually scanned', next.slate?.date, FRI);
  t.eq('...and that it had to reach forward to find it', next.slate?.usedNext, true);

  // ---- 3. THE TRAP: picks must log under the GAME day ----------------------
  // Every grader looks a box score up by date. A Friday slate logged under the
  // Tuesday it was judged on is a slate no grader will ever look for — it would
  // sit permanently ungraded and permanently outside calibration, which is the
  // exact failure mode that cost 08-31 its whole day.
  const log = read('pick-log', FRI) || [];
  t.eq('the picks are logged under the day the games are played', log.length, 2);
  t.eq('...not under the day the scan ran', (read('pick-log', TODAY) || []).length, 0);
  t.ok('...while loggedAt still records when the forecast was really made',
    log.every((p) => String(p.loggedAt).slice(0, 10) === TODAY), JSON.stringify(log.map((p) => p.loggedAt)));

  // ---- 4. 'next' never skips a live slate ---------------------------------
  // This is what makes the option safe to leave switched on: it reaches forward
  // only when there is nothing else to look at.
  const mixed = [{ player: 'Today Guy', stat: 'Rush Yards', line: 40.5, day: TODAY }, ...FUTURE];
  const live = await run(mixed, { slate: 'next' });
  t.eq('with games today, "next" still judges today', (live.board || []).map((p) => p.player), ['Today Guy']);
  t.eq('...and says it did not need to reach forward', live.slate?.usedNext, false);
  t.eq('...so those picks log under today, as they always did',
    (read('pick-log', TODAY) || []).length, 1);

  // ---- 5. nothing posted at all ------------------------------------------
  // Asking for a slate that does not exist must not invent one.
  const bare = await run([], { slate: 'next' });
  t.eq('an entirely unposted board still reports nothing', (bare.board || []).length, 0);
  t.eq('...and offers no date, because there isn\'t one', bare.slate?.nextAvailable, null);
}

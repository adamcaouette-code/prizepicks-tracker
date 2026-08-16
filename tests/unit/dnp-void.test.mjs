// Props that will VOID must never reach the judge, let alone the board.
//
// PrizePicks refunds a DNP — it does NOT settle the prop at 0. Treating a
// non-appearance as a zero makes any low line look like a near-lock under, and
// that is exactly what happened: the judge returned 90-92% on pitcher unders
// BECAUSE the pitcher wasn't starting. Those were the best-looking numbers on
// the board and every one of them was worthless.
//
// The rule: only a CONFIRMED absence removes a prop. "No probable posted yet" is
// not a confirmation, and an unverifiable prop stays.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const slateWith = (starters) => ({
  games: [{
    home: { abbr: 'TOR', probablePitcher: starters.TOR ? { name: starters.TOR } : null },
    away: { abbr: 'NYY', probablePitcher: starters.NYY ? { name: starters.NYY } : null },
  }],
});

export default async function ({ t }) {
  reset();
  const mod = await loadFn('bet-finder-background.js');

  // ---- the reported case --------------------------------------------------
  const cands = [
    { player: 'Dylan Cease',  team: 'TOR', stat: 'Pitcher Fantasy Score', statDisplay: 'Pitcher FS', position: 'P', line: 35.5 },
    { player: 'Dylan Cease',  team: 'TOR', stat: 'Pitcher Strikeouts',    statDisplay: 'Ks',         position: 'P', line: 5.5 },
    { player: 'Kevin Gausman', team: 'TOR', stat: 'Pitcher Strikeouts',   statDisplay: 'Ks',         position: 'P', line: 6.5 },
    { player: 'A Hitter',     team: 'TOR', stat: 'Hits',                  statDisplay: 'Hits',       position: 'OF', line: 0.5 },
  ];
  const counts = mod.markVoids(cands, slateWith({ TOR: 'Kevin Gausman', NYY: 'Carlos Rodon' }));

  const cease = cands.filter((c) => c.player === 'Dylan Cease');
  t.eq('every prop on a pitcher who is not the confirmed starter is voided',
    cease.filter((c) => c.voidReason).length, 2);
  t.ok('...and says WHY, in the terms that matter',
    /voids this, it does not settle at 0/.test(cease[0].voidReason), cease[0].voidReason);
  t.eq('the actual starter keeps his props',
    cands.find((c) => c.player === 'Kevin Gausman').voidReason, undefined);
  t.eq('a HITTER prop is untouched — starters only apply to pitching',
    cands.find((c) => c.player === 'A Hitter').voidReason, undefined);
  t.eq('the count is reported', counts.notStarting, 2);

  // ---- an inactive player, whatever the prop ------------------------------
  const injured = [
    { player: 'Hurt Bat', team: 'TOR', stat: 'Hits', statDisplay: 'Hits', position: 'OF', line: 0.5, injured: '10-Day Injured List' },
    { player: 'Fine Bat', team: 'TOR', stat: 'Hits', statDisplay: 'Hits', position: 'OF', line: 0.5 },
  ];
  const c2 = mod.markVoids(injured, slateWith({}));
  t.ok('an inactive player is voided even on a hitting prop', !!injured[0].voidReason, injured[0].voidReason);
  t.eq('...counted separately from the starter rule', [c2.inactive, c2.notStarting], [1, 0]);
  t.eq('a healthy teammate is untouched', injured[1].voidReason, undefined);

  // ---- what must NOT be voided -------------------------------------------
  // No probable posted is not a confirmation of absence.
  const unknown = [{ player: 'Some Pitcher', team: 'TOR', stat: 'Pitcher Strikeouts', position: 'P', line: 5.5 }];
  t.eq('with no probable posted, a pitcher prop stays on the board',
    mod.markVoids(unknown, slateWith({})).total, 0);

  // A combo names two players; there is no single starter to confirm.
  const combo = [{ player: 'A Guy + B Guy', team: 'TOR', stat: 'Pitcher Strikeouts', position: 'P', line: 5.5 }];
  t.eq('a combo prop is never auto-voided', mod.markVoids(combo, slateWith({ TOR: 'Someone Else' })).total, 0);

  // ESPN's starter is used when MLB hasn't posted one.
  const espnOnly = [{ player: 'Not Him', team: 'TOR', stat: 'Pitcher Strikeouts', position: 'P', line: 5.5,
    selfSP: { name: 'Actual Starter' } }];
  t.eq('the ESPN starter is a valid confirmation when MLB has none',
    mod.markVoids(espnOnly, { games: [] }).notStarting, 1);

  // ---- end to end: a voided prop never reaches the judge ------------------
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const rows = [
    { player: 'Dylan Cease', team: 'TOR', stat: 'Pitcher Strikeouts', line: 5.5, pos: 'P' },
    { player: 'Kevin Gausman', team: 'TOR', stat: 'Pitcher Strikeouts', line: 6.5, pos: 'P' },
  ];
  let judged = null;
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => ({
      data: rows.map((r, i) => ({ id: `pp-${i}`, type: 'projection',
        attributes: { stat_type: r.stat, stat_display_name: r.stat, line_score: r.line, odds_type: 'standard',
          description: 'NYY', start_time: new Date().toISOString(), today: true },
        relationships: { new_player: { data: { id: `n${i}` } } } })),
      included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
        attributes: { display_name: r.player, team: r.team, position: r.pos, market: r.team } })),
      meta: { total_pages: 1 } })],
    ['statsapi.mlb.com/api/v1/teams?sportId=1', async () => ({ teams: [{ id: 141, name: 'Toronto Blue Jays', abbreviation: 'TOR' }] })],
    ['statsapi.mlb.com/api/v1/schedule', async () => ({ dates: [{ games: [{ gamePk: 1, teams: {
      home: { team: { id: 141, abbreviation: 'TOR', name: 'Toronto Blue Jays' }, probablePitcher: { id: 7, fullName: 'Kevin Gausman' } },
      away: { team: { id: 147, abbreviation: 'NYY', name: 'New York Yankees' } } } }] }] })],
    [/statsapi\.mlb\.com.*roster/, async () => ({ roster: [
      { person: { id: 1, fullName: 'Dylan Cease' }, position: { abbreviation: 'P' }, status: { code: 'A', description: 'Active' } },
      { person: { id: 7, fullName: 'Kevin Gausman' }, position: { abbreviation: 'P' }, status: { code: 'A', description: 'Active' } },
    ] })],
    [/espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => {
      judged = JSON.parse(init.body).messages[0].content;
      return { content: [{ type: 'text', text: JSON.stringify({ picks: [
        { player: 'Kevin Gausman', stat: 'Pitcher Strikeouts', line: 6.5, verdict: 'lean', prob: 0.6, key_risk: 'k', reasoning: 'r' },
      ] }) }], usage: {} };
    }],
  ]);
  try {
    await mod.handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'v1', league: 'mlb', legs: 2 }) });
  } finally { mock.restore(); }

  const out = read('bet-jobs', 'v1')?.result || {};
  t.ok('the judge never saw the non-starter — no tokens spent rating a refund',
    judged != null && !/Dylan Cease/.test(judged), (judged || '').slice(0, 80));
  t.ok('...but did see the real starter', /Kevin Gausman/.test(judged || ''));
  t.eq('the voided prop is absent from the board',
    (out.board || []).filter((p) => p.player === 'Dylan Cease').length, 0);
  t.eq('the run reports how many it hid, rather than dropping them silently', out.voidedCount, 1);
  t.eq('...broken down by reason', out.mlbStatus?.voided?.notStarting, 1);

  const logged = read('pick-log', new Date().toISOString().slice(0, 10)) || [];
  t.eq('a voided prop is never logged for calibration either',
    logged.filter((l) => l.player === 'Dylan Cease').length, 0);
}

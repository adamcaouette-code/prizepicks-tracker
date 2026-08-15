// MLB Stats API enrichment.
//
// Two things matter most here:
//
//  1. The injury read. It decides whether a card says "not expected to play",
//     which is the difference between a bet and a wasted leg. MLB's status codes
//     drift (D7/D10/D15/D60/DL/RM/BRV...), so the rule is allow-list ACTIVE
//     rather than deny-list injuries — an unrecognised code must read as OUT,
//     because that's the safe direction for money.
//  2. Cost. This is raw data. It must never call a model, and the deep
//     per-player numbers must never be fetched during a run.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const SCHEDULE = { dates: [{ games: [{
  gamePk: 1, gameDate: '2026-08-14T23:10:00Z', status: { detailedState: 'Scheduled' }, venue: { name: 'GABP' },
  teams: {
    home: { team: { id: 113, name: 'Cincinnati Reds', abbreviation: 'CIN' }, probablePitcher: { id: 9001, fullName: 'Hunter Greene' } },
    away: { team: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT' }, probablePitcher: { id: 9002, fullName: 'Paul Skenes' } },
  } }] }] };

const TEAMS = { teams: [
  { id: 113, name: 'Cincinnati Reds', abbreviation: 'CIN' },
  { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
]};

const roster = (entries) => ({ roster: entries.map((e) => ({
  person: { id: e.id, fullName: e.name }, position: { abbreviation: e.pos || 'OF' }, status: e.status })) });

export default async function ({ t }) {
  reset();
  const mod = await loadFn('mlb-stats.js');

  // ---- the status rule ----------------------------------------------------
  t.eq('an active player is not out', mod.isOut({ code: 'A', description: 'Active' }), false);
  t.eq('a rehab assignment is not out', mod.isOut({ code: 'RM', description: 'Rehab Assignment' }), false);
  t.eq('the 10-day IL is out', mod.isOut({ code: 'D10', description: '10-Day Injured List' }), true);
  t.eq('the 60-day IL is out', mod.isOut({ code: 'D60', description: '60-Day Injured List' }), true);
  t.eq('the old DL code is out', mod.isOut({ code: 'DL', description: 'Disabled List' }), true);
  t.eq('paternity leave counts as not playing', mod.isOut({ code: 'PL', description: 'Paternity Leave' }), true);
  t.eq('a restricted list counts as not playing', mod.isOut({ code: 'RL', description: 'Restricted List' }), true);
  t.eq('an empty status is not treated as an injury', mod.isOut({}), false);

  // ---- deterministic artwork ---------------------------------------------
  t.ok('a headshot is derivable from a personId', /people\/12345\/headshot/.test(mod.headshotUrl(12345)));
  t.eq('no id means no headshot, not a broken URL', mod.headshotUrl(null), null);
  t.ok('team art uses the CAP mark, which stays legible small',
    /team-cap-on-dark\/113\.svg$/.test(mod.teamLogoUrl(113)), mod.teamLogoUrl(113));
  t.ok('and has an ESPN PNG fallback', /teamlogos\/mlb\/500\/cin\.png$/.test(mod.espnLogoUrl('CIN')), mod.espnLogoUrl('CIN'));

  // ---- the slate: injuries + personIds from one roster call per team -------
  const mock = mockFetch([
    ['/api/v1/teams?sportId=1', async () => TEAMS],
    ['/schedule', async () => SCHEDULE],
    ['/teams/113/roster', async () => roster([
      { id: 5001, name: 'Elly De La Cruz', pos: 'SS', status: { code: 'A', description: 'Active' } },
      { id: 5002, name: 'Hurt Guy', pos: 'OF', status: { code: 'D10', description: '10-Day Injured List' } },
      { id: 5003, name: 'Mystery Code Guy', pos: 'C', status: { code: 'ZZ', description: 'Some New Injury Status' } },
    ])],
    ['/teams/134/roster', async () => roster([
      { id: 5004, name: 'Paul Skenes', pos: 'P', status: { code: 'A', description: 'Active' } },
    ])],
  ]);

  let out;
  try { out = await mod.slate('2026-08-14'); } finally { mock.restore(); }

  t.eq('the slate has the game', out.games.length, 1);
  t.eq('probable pitchers come along', out.games[0].away.probablePitcher.name, 'Paul Skenes');
  t.ok('each side carries its cap logo', /team-cap-on-dark\/113/.test(out.games[0].home.logo));

  t.eq('every rostered player is resolvable by name', Object.keys(out.people).length, 4);
  t.eq('an active player resolves to a personId', out.people[mod.normKey('Elly De La Cruz')].id, 5001);
  t.eq('...and therefore to a headshot', /people\/5001\/headshot/.test(out.people[mod.normKey('Elly De La Cruz')].headshot), true);
  t.eq('an active player is not flagged out', out.people[mod.normKey('Elly De La Cruz')].out, false);
  t.eq('an injured player IS flagged', out.people[mod.normKey('Hurt Guy')].out, true);
  t.eq('an UNKNOWN status code errs toward out — the safe direction for a bet',
    out.people[mod.normKey('Mystery Code Guy')].out, true);

  t.eq('the injury report is grouped by team', Object.keys(out.injuries).sort(), ['CIN']);
  t.eq('...and lists both flagged players', out.injuries.CIN.map((x) => x.name).sort(), ['Hurt Guy', 'Mystery Code Guy']);
  t.eq('...carrying the reason, not just a flag', out.injuries.CIN.find((x) => x.name === 'Hurt Guy').status, '10-Day Injured List');
  t.eq('the healthy team has no entry', out.injuries.PIT, undefined);

  // ---- cost -------------------------------------------------------------
  reset();
  const mock2 = mockFetch([
    ['/api/v1/teams?sportId=1', async () => TEAMS],
    ['/schedule', async () => SCHEDULE],
    [/roster/, async () => roster([{ id: 1, name: 'A B', status: { code: 'A', description: 'Active' } }])],
    ['api.anthropic.com', async () => { throw new Error('MLB enrichment must never call a model'); }],
  ]);
  try { await mod.slate('2026-08-14'); } finally { mock2.restore(); }
  const urls = mock2.calls.map((c) => c.url);
  t.eq('building the slate makes zero model calls', urls.filter((u) => /anthropic|\/v1\/messages/.test(u)), []);
  t.ok('every call goes to statsapi.mlb.com', urls.every((u) => /statsapi\.mlb\.com/.test(u)), urls.join(' '));
  t.ok('one roster call per playing team and no more',
    urls.filter((u) => /roster/.test(u)).length === 2, urls.filter((u) => /roster/.test(u)).join(' '));
  t.eq('the deep per-player endpoint is NOT touched while building a slate',
    urls.filter((u) => /\/stats\?stats=/.test(u)), []);

  // ---- an upstream outage degrades, never throws --------------------------
  reset();
  const dead = mockFetch([[/statsapi/, async () => ({ status: 503, body: 'down' })]]);
  let degraded;
  try { degraded = await mod.slate('2026-08-14'); } finally { dead.restore(); }
  t.eq('a dead upstream yields an empty slate rather than an error', degraded.games, []);
  t.eq('...with no people', Object.keys(degraded.people).length, 0);
  t.eq('...and no injuries invented', Object.keys(degraded.injuries).length, 0);
}

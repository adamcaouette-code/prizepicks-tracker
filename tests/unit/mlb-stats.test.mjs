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
      { id: 5005, name: 'Day To Day Guy', pos: '1B', status: { code: 'DTD', description: 'Day-To-Day' } },
      { id: 5006, name: 'Long Gone', pos: 'RP', status: { code: 'D60', description: '60-Day Injured List' } },
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

  t.ok('the 40-man is requested, not the whole organisation — fullRoster returned ~90 names a team',
    true);
  t.eq('every rostered player is resolvable by name', Object.keys(out.people).length, 6);
  t.eq('an active player resolves to a personId', out.people[mod.normKey('Elly De La Cruz')].id, 5001);
  t.eq('...and therefore to a headshot', /people\/5001\/headshot/.test(out.people[mod.normKey('Elly De La Cruz')].headshot), true);
  t.eq('an active player is not flagged out', out.people[mod.normKey('Elly De La Cruz')].out, false);
  t.eq('an injured player IS flagged', out.people[mod.normKey('Hurt Guy')].out, true);
  t.eq('an UNKNOWN status code errs toward out — the safe direction for a bet',
    out.people[mod.normKey('Mystery Code Guy')].out, true);

  t.eq('the injury report is grouped by team', Object.keys(out.injuries).sort(), ['CIN']);
  // Ordered by how much the absence bears on TONIGHT, not alphabetically —
  // alphabetical buried the day-to-day names under the season-enders.
  t.eq('day-to-day sorts first, 60-day last',
    out.injuries.CIN.map((x) => x.name), ['Day To Day Guy', 'Hurt Guy', 'Mystery Code Guy', 'Long Gone']);
  t.eq('a day-to-day absence outranks a 10-day', mod.absenceRank({ description: 'Day-To-Day' }) < mod.absenceRank({ description: '10-Day Injured List' }), true);
  t.eq('a 10-day outranks a 60-day', mod.absenceRank({ description: '10-Day Injured List' }) < mod.absenceRank({ description: '60-Day Injured List' }), true);
  t.eq('a full-season absence sorts last', mod.absenceRank({ description: 'Injured - Full Season' }), 5);
  t.eq('...carrying the reason, not just a flag', out.injuries.CIN.find((x) => x.name === 'Hurt Guy').status, '10-Day Injured List');
  t.eq('the healthy team has no entry', out.injuries.PIT, undefined);

  // ---- the slate cache is a round trip ------------------------------------
  // Building a slate is a teams call, a schedule call and one roster call per
  // playing team — repeated for every run of the night. The cache is the only
  // thing stopping that, and a cache whose write goes nowhere reports exactly
  // the same slate while quietly paying full price every time. The second call
  // has to make NO requests and say it came from cache.
  const mockCached = mockFetch([[/statsapi/, async () => { throw new Error('cache miss: refetched a slate it already had'); }]]);
  let again;
  try { again = await mod.slate('2026-08-14'); } finally { mockCached.restore(); }
  t.eq('a second slate for the same day comes from cache', again.cached, true);
  t.eq('...and it makes no requests at all', mockCached.calls.length, 0);
  t.eq('...serving the same game', again.games[0].away.probablePitcher.name, 'Paul Skenes');
  t.eq('...and the same injury report', Object.keys(again.injuries).sort(), ['CIN']);

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
  t.ok('and it asks for the 40-man, not fullRoster',
    urls.filter((u) => /roster/.test(u)).every((u) => /rosterType=40Man/.test(u)),
    urls.find((u) => /roster/.test(u)));
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

  // ---- one player, against the REAL live shapes --------------------------
  // Captured from production (Ohtani, 660271). Three things this exposed that
  // the documented-shape guess got wrong, all fixed and pinned here:
  //   1. /people/{id} returns a NULL currentTeam without hydrate=currentTeam,
  //      which left every player with no team and no logo.
  //   2. gameLog names opponents in FULL ("Milwaukee Brewers"); the card cell is
  //      ~60px, so they have to be resolved to abbreviations.
  //   3. A two-way player's position is TWP, not "Pitcher" — the old test
  //      (/pitcher/i on the name) would have mis-grouped him.
  reset();
  const PEOPLE_NO_TEAM = { people: [{
    id: 660271, fullName: 'Shohei Ohtani', currentAge: 32,
    primaryPosition: { abbreviation: 'TWP', name: 'Two-Way Player' },
    batSide: { code: 'L' }, pitchHand: { code: 'R' },
    currentTeam: null,                       // exactly what the live API returned
  }] };
  const SEASON = { stats: [{ splits: [{ team: { id: 119, name: 'Los Angeles Dodgers' },
    stat: { avg: '.292', obp: '.391', slg: '.544', ops: '.935', homeRuns: 27, rbi: 74, stolenBases: 7, strikeOuts: 118, atBats: 432, gamesPlayed: 116 } }] }] };
  const GAMELOG = { stats: [{ splits: [
    { date: '2026-08-03', isHome: false, opponent: { id: 112, name: 'Chicago Cubs' }, stat: { atBats: 4, hits: 2, homeRuns: 0, rbi: 0, strikeOuts: 0, totalBases: 2 } },
    { date: '2026-08-13', isHome: true, opponent: { id: 158, name: 'Milwaukee Brewers' }, stat: { atBats: 4, hits: 1, homeRuns: 0, rbi: 0, strikeOuts: 1, totalBases: 2 } },
  ] }] };
  const SPLITS = { stats: [{ splits: [
    { split: { code: 'vl' }, stat: { avg: '.301', ops: '.954', homeRuns: 12, atBats: 153 } },
    { split: { code: 'vr' }, stat: { avg: '.287', ops: '.924', homeRuns: 15, atBats: 279 } },
  ] }] };

  const pm = mockFetch([
    ['/api/v1/teams?sportId=1', async () => ({ teams: [
      { id: 119, name: 'Los Angeles Dodgers', abbreviation: 'LAD' },
      { id: 158, name: 'Milwaukee Brewers', abbreviation: 'MIL' },
      { id: 112, name: 'Chicago Cubs', abbreviation: 'CHC' },
    ] })],
    [/\/people\/660271\?/, async () => PEOPLE_NO_TEAM],
    [/stats=season/, async () => SEASON],
    [/stats=gameLog/, async () => GAMELOG],
    [/stats=statSplits/, async () => SPLITS],
  ]);
  let pl, pUrls;
  try { pl = await mod.player('660271', '2026'); pUrls = pm.calls.map((c) => c.url); } finally { pm.restore(); }

  t.ok('the people lookup asks for currentTeam to be hydrated',
    pUrls.some((u) => /\/people\/660271\?hydrate=currentTeam/.test(u)), pUrls.find((u) => /people\/660271/.test(u)));
  t.eq('a null currentTeam falls back to the team on the season split', pl.teamId, 119);
  t.eq('...which yields an abbreviation', pl.teamAbbr, 'LAD');
  t.ok('...and therefore a cap logo instead of null', /team-cap-on-dark\/119/.test(pl.teamLogo || ''), pl.teamLogo);
  t.ok('...with the ESPN fallback resolved too', /lad\.png/.test(pl.teamLogoFallback || ''), pl.teamLogoFallback);

  t.eq('full opponent names are resolved to abbreviations that fit a card cell',
    pl.last10.map((g) => g.opp), ['MIL', 'CHC']);
  t.eq('the log is newest-first', pl.last10[0].date, '2026-08-13');

  t.eq('a two-way player is flagged as such', pl.twoWay, true);
  t.eq('...and defaults to hitting, which is where his prop board lives', pl.group, 'hitting');
  t.eq('...keeping the real position', pl.position, 'TWP');
  t.eq('season line parsed', [pl.season.avg, pl.season.hr, pl.season.ops], ['.292', 27, '.935']);
  t.eq('platoon splits parsed', [pl.splits.vsLHP.avg, pl.splits.vsRHP.avg], ['.301', '.287']);
  t.eq('handedness kept — the reason splits matter', [pl.bats, pl.throws], ['L', 'R']);

  // The pitching side of a two-way player is reachable on demand.
  reset();
  const pm2 = mockFetch([
    ['/api/v1/teams?sportId=1', async () => ({ teams: [{ id: 119, name: 'Los Angeles Dodgers', abbreviation: 'LAD' }] })],
    [/\/people\/660271\?/, async () => PEOPLE_NO_TEAM],
    [/stats=season/, async () => ({ stats: [{ splits: [{ team: { id: 119 }, stat: { era: '2.87', whip: '1.05', strikeOuts: 62, inningsPitched: '47.0' } }] }] })],
    [/stats=gameLog/, async () => ({ stats: [{ splits: [] }] })],
    [/stats=statSplits/, async () => ({ stats: [{ splits: [] }] })],
  ]);
  let pitch, purls;
  try { pitch = await mod.player('660271', '2026', 'pitching'); purls = pm2.calls.map((c) => c.url); } finally { pm2.restore(); }
  t.eq('a group override switches a two-way player to his pitching line', pitch.group, 'pitching');
  t.eq('...and parses pitching stats, not hitting ones', [pitch.season.era, pitch.season.so], ['2.87', 62]);
  t.ok('...asking MLB for the pitching group', purls.some((u) => /group=pitching/.test(u)));
  t.eq('the player lookup still calls no model', pUrls.filter((u) => /anthropic/.test(u)), []);
}

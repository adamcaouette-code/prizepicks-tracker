// ESPN game-log ingestion — the parse, the exposure term, and the caching.
//
// The payloads below are REAL, captured live on 2026-09-10 and trimmed to the
// fields this module reads:
//
//   MLB pitcher   athletes/33840/gamelog   (baseball/mlb)
//   Soccer        athletes/271170/gamelog  (soccer/eng.1, Bryan Mbeumo)
//   Match summary summary?event=401879291 (Man Utd 2-2 Everton)
//
// Captured rather than invented because the two things most likely to be wrong
// here are both properties of ESPN's real shape: that the stats arrive as a
// POSITIONAL ARRAY that only means something zipped against `names`, and that
// THE SOCCER LOG HAS NO MINUTES COLUMN AT ALL. A hand-written fixture would
// have quietly given itself both.
//
// No network: every fetch is mocked.

import fs from 'node:fs';
import path from 'node:path';
import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('netlify/functions/projection-config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Captured payloads (trimmed)

const MLB_NAMES = ['innings', 'hits', 'runs', 'earnedRuns', 'homeRuns', 'walks', 'strikeouts',
  'groundBalls', 'flyBalls', 'pitches', 'battersFaced', 'avgGameScore', 'wins-losses', 'saves-blownSaves-holds', 'ERA'];

const mlbGamelog = {
  names: MLB_NAMES,
  labels: ['IP', 'H', 'R', 'ER', 'HR', 'BB', 'K', 'GB', 'FB', 'P', 'TBF', 'GSC', 'Dec', 'Rel', 'ERA'],
  events: {
    401816843: {
      id: '401816843', atVs: '@', gameDate: '2026-09-07T17:05:00.000+00:00',
      opponent: { id: '22', abbreviation: 'PHI', displayName: 'Philadelphia Phillies' },
      team: { id: '15', abbreviation: 'ATL' },
    },
    401816700: {
      id: '401816700', atVs: 'vs', gameDate: '2026-09-01T23:15:00.000+00:00',
      opponent: { id: '16', abbreviation: 'CHC', displayName: 'Chicago Cubs' },
      team: { id: '15', abbreviation: 'ATL' },
    },
    401816550: {
      id: '401816550', atVs: 'vs', gameDate: '2026-08-26T23:15:00.000+00:00',
      opponent: { id: '19', abbreviation: 'NYM', displayName: 'New York Mets' },
      team: { id: '15', abbreviation: 'ATL' },
    },
  },
  seasonTypes: [{
    displayName: '2026 Regular Season',
    categories: [{
      displayName: 'September', type: 'month', splitType: 'month',
      events: [
        // 6.0 IP, 6 K, 22 batters faced, 89 pitches — the real line.
        { eventId: '401816843', stats: ['6.0', '3', '0', '0', '0', '2', '6', '4', '10', '89', '22', '70.0', '-', '-', '3.46'] },
        // 5.2 IP: five and TWO THIRDS, not five and a half.
        { eventId: '401816700', stats: ['5.2', '6', '3', '3', '1', '1', '8', '5', '6', '96', '24', '55.0', '-', '-', '3.55'] },
        // 6.1 IP: six and one third.
        { eventId: '401816550', stats: ['6.1', '4', '1', '1', '0', '3', '7', '7', '5', '92', '25', '64.0', '-', '-', '3.40'] },
      ],
    }],
  }],
};

const SOCCER_NAMES = ['totalGoals', 'goalAssists', 'totalShots', 'shotsOnTarget',
  'foulsCommitted', 'foulsSuffered', 'offsides', 'yellowCards', 'redCards'];

const soccerGamelog = {
  names: SOCCER_NAMES,
  labels: ['G', 'A', 'SHOT', 'SOG', 'FC', 'FA', 'OF', 'YC', 'RC'],
  events: {
    401879291: {
      id: '401879291', atVs: '@', gameDate: '2026-09-06T13:00:00.000+00:00',
      opponent: { id: '368', abbreviation: 'EVE', displayName: 'Everton' },
      team: { id: '360', abbreviation: 'MAN' },
    },
    401879270: {
      id: '401879270', atVs: 'vs', gameDate: '2026-08-30T14:00:00.000+00:00',
      opponent: { id: '359', abbreviation: 'ARS', displayName: 'Arsenal' },
      team: { id: '360', abbreviation: 'MAN' },
    },
    401879255: {
      id: '401879255', atVs: 'vs', gameDate: '2026-08-23T16:30:00.000+00:00',
      opponent: { id: '331', abbreviation: 'BUR', displayName: 'Burnley' },
      team: { id: '360', abbreviation: 'MAN' },
    },
  },
  seasonTypes: [{
    displayName: '2026-27 English Premier League',
    categories: [{
      displayName: 'Premier League', type: 'league', splitType: 'league',
      events: [
        { eventId: '401879291', stats: ['1', '0', '2', '1', '2', '1', '0', '0', '0'] },
        { eventId: '401879270', stats: ['0', '1', '3', '2', '1', '0', '1', '0', '0'] },
        { eventId: '401879255', stats: ['0', '0', '1', '0', '0', '1', '0', '1', '0'] },
      ],
    }],
  }],
};

// starter / subbedIn / subbedOut, and NOT A MINUTE ANYWHERE. This is the whole
// reason soccer minutes have to be imputed.
const summaryFor = (state) => ({
  rosters: [
    { team: { abbreviation: 'EVE' }, roster: [{ athlete: { id: '159443' }, starter: true, subbedIn: false, subbedOut: false }] },
    { team: { abbreviation: 'MAN' }, roster: [{ athlete: { id: '271170' }, ...state }] },
  ],
});

const SUMMARIES = {
  401879291: summaryFor({ starter: true, subbedIn: false, subbedOut: true }),    // started, subbed off
  401879270: summaryFor({ starter: true, subbedIn: false, subbedOut: false }),   // started, finished
  401879255: summaryFor({ starter: false, subbedIn: true, subbedOut: false }),   // came on
};

const routes = () => [
  ['baseball/mlb/athletes/33840/gamelog', () => mlbGamelog],
  ['baseball/mlb/athletes/33840', () => ({ athlete: { position: { abbreviation: 'SP', name: 'Starting Pitcher' } } })],
  ['soccer/eng.1/athletes/271170/gamelog', () => soccerGamelog],
  ['soccer/eng.1/athletes/271170', () => ({ athlete: { position: { abbreviation: 'F', name: 'Forward' } } })],
  [/soccer\/eng\.1\/summary\?event=(\d+)/, (u) => SUMMARIES[u.match(/event=(\d+)/)[1]] || null],
];

export default async function ({ t }) {
  reset();
  const G = await loadFn('game-logs.js');

  // =========================================================================
  // 1. BASEBALL INNINGS ARE NOT DECIMAL
  //
  //   "5.2" is five and TWO THIRDS = 5.6667, not five point two.
  //   "6.1" is six and ONE third   = 6.3333, not six point one.
  //
  // Read as decimals, a starter's exposure comes in low by up to a third of an
  // inning per outing — and low SYSTEMATICALLY, because the fractional endings
  // are common and both err in the same direction. A rate that is 2% high in
  // one direction on every start is not noise the projection can absorb.
  // =========================================================================
  t.ok('6.0 is six innings', G.parseInnings('6.0') === 6, '');
  t.ok('5.2 is five and TWO THIRDS', Math.abs(G.parseInnings('5.2') - 17 / 3) < 1e-12, String(G.parseInnings('5.2')));
  t.ok('6.1 is six and ONE third', Math.abs(G.parseInnings('6.1') - 19 / 3) < 1e-12, String(G.parseInnings('6.1')));
  t.ok('...and NOT the decimal 5.2', G.parseInnings('5.2') !== 5.2, '');
  t.ok('a dash is missing, not zero', G.parseInnings('-') === null, '');
  t.ok('an empty cell is missing too', G.parseInnings('') === null, '');

  // =========================================================================
  // 1b. The league map is LAYERED, not copied
  //
  // Two copies of a table is the bug this repo has already been bitten by (see
  // one-source-of-truth.test.mjs). espn-grade's SLUGS has no `mlb` because MLB
  // grades off MLB's own API — that is the one gap this module fills, and every
  // other league must still resolve through the shared map, so a league added
  // there is picked up here without a second edit.
  // =========================================================================
  const { SLUGS } = await import('../../netlify/functions/espn-grade.js');
  const disagreements = Object.entries(SLUGS).filter(([k, v]) => G.slugFor(k) !== v);
  t.eq('every league in the shared map resolves to the same slug here', disagreements, []);
  t.ok('the shared map genuinely has no mlb entry — which is why this module adds one',
    SLUGS.mlb === undefined && G.slugFor('mlb') === 'baseball/mlb', '');
  t.eq('a league in neither map is null, not a guess', G.slugFor('kabaddi'), null);

  // =========================================================================
  // 2. Parsing the positional stats array
  // =========================================================================
  const rows = G.parseGameLog(mlbGamelog, { slug: 'baseball/mlb' });
  t.eq('three games parse out', rows.length, 3);
  t.eq('most recent first', rows.map((r) => r.date), ['2026-09-07', '2026-09-01', '2026-08-26']);

  const last = rows[0];
  t.eq('the stats zip against `names`, not against position luck',
    { k: last.stats.strikeouts, h: last.stats.hits, bf: last.stats.battersFaced, p: last.stats.pitches },
    { k: 6, h: 3, bf: 22, p: 89 });
  t.ok("ESPN's '@' means away", last.home === false, String(last.home));
  t.ok("...and 'vs' means home", rows[1].home === true, String(rows[1].home));
  t.eq('the opponent comes through', last.opponent.abbreviation, 'PHI');
  t.eq('and so does the player\'s own team', last.team.abbreviation, 'ATL');
  t.ok('a column that is a dash is dropped rather than parsed as zero',
    last.stats['wins-losses'] === undefined && last.raw['wins-losses'] === '-', '');

  // =========================================================================
  // 3. THE EXPOSURE TERM — the field the whole projection scales by
  // =========================================================================
  t.ok('innings are the primary exposure for a pitcher', Math.abs(last.exposure.value - 6) < 1e-12, String(last.exposure.value));
  t.ok('...with batters faced kept alongside', last.exposure.battersFaced === 22, '');
  t.ok('...and pitches too', last.exposure.pitches === 89, '');
  // Different markets scale by different things: strikeouts per inning, hits
  // allowed per batter faced. Keeping one and discarding the rest would force
  // every market through whichever denominator the parser happened to pick.
  t.ok('more than one candidate denominator survives the parse',
    Object.keys(last.exposure).filter((k) => k !== 'value').length >= 3, Object.keys(last.exposure).join(','));

  // A hitter's log: PA, not AB, because a walk is an opportunity that produced
  // no at-bat, and counting it as no opportunity inflates a patient hitter's rate.
  const hitterRow = G.exposureFrom({ atBats: 4, walks: 1, hitByPitch: 0, hits: 2 }, 'baseball/mlb');
  t.ok('a hitter gets plate appearances = AB + BB + HBP + sacs', hitterRow.plateAppearances === 5, String(hitterRow.plateAppearances));

  // =========================================================================
  // 4. REST DAYS
  //
  //   2026-08-26 -> 2026-09-01 is 6 days; 09-01 -> 09-07 is 6 days.
  //   The OLDEST game has no predecessor, so its rest is null — "unknown" and
  //   "played yesterday" are different facts and only one of them is true.
  // =========================================================================
  t.eq('rest days come off consecutive game dates', rows.map((r) => r.restDays), [6, 6, null]);
  const unsorted = G.withRestDays([
    { date: '2026-09-07', exposure: {}, stats: {} },
    { date: '2026-09-01', exposure: {}, stats: {} },
  ]);
  t.ok('...computed after sorting, so they are never negative',
    unsorted.every((r) => r.restDays === null || r.restDays > 0), JSON.stringify(unsorted.map((r) => r.restDays)));

  // =========================================================================
  // 5. THE SOCCER LOG HAS NO MINUTES. Say so, do not invent one.
  // =========================================================================
  const soccerRaw = G.parseGameLog(soccerGamelog, { slug: 'soccer/eng.1' });
  t.ok('ESPN ships nine soccer columns and minutes is not among them',
    !SOCCER_NAMES.includes('minutes'), SOCCER_NAMES.join(','));
  t.ok('so a freshly parsed soccer row has NO exposure', soccerRaw[0].exposure.value === undefined, JSON.stringify(soccerRaw[0].exposure));
  t.eq('...and says so rather than defaulting to 90', soccerRaw[0].exposure_source, 'unresolved');
  t.eq('the stats themselves parse fine', soccerRaw[0].stats.shotsOnTarget, 1);

  t.eq('a starter who was subbed off is "started_subbed"',
    G.appearanceType({ starter: true, subbedOut: true }), 'started_subbed');
  t.eq('a starter who saw it out is "started_finished"',
    G.appearanceType({ starter: true, subbedOut: false }), 'started_finished');
  t.eq('a substitute is "came_on"', G.appearanceType({ starter: false, subbedIn: true }), 'came_on');
  t.eq('an unused body is "unused"', G.appearanceType({ didNotPlay: true }), 'unused');
  t.eq('and an entry that says none of those is not guessed at', G.appearanceType({}), null);

  const imp = G.imputeMinutes('came_on', CONFIG);
  t.eq('a substitute is imputed at the configured 23 minutes', imp.minutes, 23);
  t.ok('...WITH the uncertainty attached, not just the mean', imp.sd === 12, String(imp.sd));
  const impStart = G.imputeMinutes('started_finished', CONFIG);
  t.ok('a full ninety is far more certain than a cameo', impStart.sd < imp.sd, `${impStart.sd} vs ${imp.sd}`);
  t.ok('an unknown appearance type refuses rather than picking a number',
    G.imputeMinutes(null, CONFIG).minutes === null, '');

  // =========================================================================
  // 6. End to end, through the cache
  // =========================================================================
  const m = mockFetch(routes());
  try {
    const mlb = await G.fetchGameLog({ league: 'mlb', athleteId: '33840', config: CONFIG });
    t.ok('the MLB log ingests', mlb.ok === true, mlb.reason || '');
    t.eq('...with the position for the positional prior', mlb.position, 'SP');
    t.eq('...and every row carrying an exposure', mlb.exposure_coverage, 1);
    t.eq('...marked as measured, not imputed', mlb.rows[0].exposure_source, 'espn');

    // The rows are the shape projection.js consumes — checked by projecting.
    const P = await import('../../netlify/functions/projection.js');
    const proj = P.project({
      rows: mlb.rows, league: 'mlb', statKey: 'strikeouts', exposureKey: 'innings',
      position: mlb.position, asOf: '2026-09-10', isHome: true, config: CONFIG, priorGroup: 'mlb_pitcher',
    });
    t.ok('and they project without any reshaping', proj.ok === true, proj.reason || '');
    //   21 K over 6 + 5.6667 + 6.3333 = 18 innings, before recency weighting,
    //   is 1.1667 per inning — comfortably above the 1.05 SP prior.
    t.ok('...to a rate above the SP prior, as this line deserves',
      proj.rate_components.observed_rate > 1.05, String(proj.rate_components.observed_rate));

    const before = m.calls.length;
    await G.fetchGameLog({ league: 'mlb', athleteId: '33840', config: CONFIG });
    t.ok('a second call is served from the blob cache, with no new fetches',
      m.calls.length === before, `${m.calls.length - before} extra requests`);
    t.ok('...and the cache really holds it', read('game-logs', 'gamelog/baseball/mlb/33840') != null, '');

    // ---- soccer: the imputation path ------------------------------------
    const soc = await G.fetchGameLog({ league: 'soccer', athleteId: '271170', config: CONFIG });
    t.ok('the soccer log ingests', soc.ok === true, soc.reason || '');
    t.eq('...and the position picks the forward prior', soc.position, 'F');
    t.eq('minutes are imputed from appearance type, match by match',
      soc.rows.map((r) => r.exposure.minutes), [66, 90, 23]);
    t.eq('...and every row is stamped with which guess it was',
      soc.rows.map((r) => r.exposure_source),
      ['imputed:started_subbed', 'imputed:started_finished', 'imputed:came_on']);
    t.ok('...never mistakable for a measured minute',
      soc.rows.every((r) => r.exposure_source !== 'espn'), '');
    t.ok('the per-appearance sd rides along with each row',
      soc.rows.map((r) => r.exposure_sd).join(',') === '14,4,12', soc.rows.map((r) => r.exposure_sd).join(','));

    //   THE RATE MODEL EARNS ITS KEEP HERE. 3 SOG in 66+90+23 = 179 minutes is
    //   0.01676 per minute; over a full 90 that is 1.51 shots on target. The
    //   per-GAME average is 3/3 = 1.0, which would price a starting forward as
    //   though he were the bench player he sometimes is.
    const soccerProj = P.project({
      rows: soc.rows, league: 'soccer', statKey: 'shotsOnTarget', exposureKey: 'minutes',
      position: soc.position, asOf: '2026-09-10', isHome: true, config: CONFIG, priorGroup: 'soccer',
      exposureOverride: { mean: 90, sd: 4, source: 'confirmed start' },
    });
    t.ok('a soccer projection builds on imputed minutes', soccerProj.ok === true, soccerProj.reason || '');
    t.ok('...and a confirmed start prices above the raw per-game average of 1.0',
      soccerProj.mean > 1.0, String(soccerProj.mean));

    const summaryCalls = m.calls.filter((c) => c.url.includes('summary?event=')).length;
    t.ok('each match summary was fetched once, not per row', summaryCalls === 3, String(summaryCalls));
    const soc2Before = m.calls.length;
    await G.fetchGameLog({ league: 'soccer', athleteId: '271170', config: CONFIG });
    t.ok('and a repeat soccer ingest hits the cache for all of it', m.calls.length === soc2Before, '');

    // ---- refusals ---------------------------------------------------------
    const noLeague = await G.fetchGameLog({ league: 'kabaddi', athleteId: '1' });
    t.ok('an unmapped league is refused by name', noLeague.ok === false && /kabaddi/.test(noLeague.reason), noLeague.reason);
    const dead = await G.fetchGameLog({ league: 'mlb', athleteId: '999999' });
    t.ok('an ESPN miss is a missing projection, not a thrown error',
      dead.ok === false && Array.isArray(dead.rows), dead.reason);
  } finally {
    m.restore();
  }

  // =========================================================================
  // 7. An unfetched soccer match stays unresolved rather than getting a default
  //
  // The recency half-life is 30 days, so a match from last season contributes
  // almost nothing and is not worth an HTTP request. But "not worth fetching"
  // is not "safe to assume ninety minutes" — an invented exposure on an
  // unfetched match would flow straight into the rate's denominator.
  // =========================================================================
  const m2 = mockFetch(routes());
  try {
    reset();
    const capped = await G.fetchGameLog({ league: 'soccer', athleteId: '271170', config: CONFIG, soccerLimit: 1 });
    t.eq('only the newest match was resolved', capped.rows.map((r) => r.exposure_source),
      ['imputed:started_subbed', 'unresolved', 'unresolved']);
    t.ok('...and coverage says so out loud', Math.abs(capped.exposure_coverage - 1 / 3) < 1e-9, String(capped.exposure_coverage));
    // weightedRate skips a row with no exposure, so an unresolved match is
    // absent from the rate rather than silently dragging it.
    const P = await import('../../netlify/functions/projection.js');
    const wr = P.weightedRate(capped.rows, { statKey: 'shotsOnTarget', exposureKey: 'minutes', halfLifeDays: 30, asOf: '2026-09-10' });
    t.eq('an unresolved row contributes nothing to the rate', wr.rowsUsed, 1);
  } finally {
    m2.restore();
  }
}

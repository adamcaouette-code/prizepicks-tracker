// Getting coverage up: why basic props were failing to grade.
//
// The complaint was specific and correct — combos not grading is understood,
// but ordinary single-player props should. Each block below is one real cause,
// with the fix pinned so it can't silently come back.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read, seed } from '../helpers/blobs.mjs';

const FINAL = { status: { type: { completed: true, state: 'post', name: 'STATUS_FINAL' } } };
const ev = (id, date = '2026-08-14T23:00Z') => ({ id, date, ...FINAL });

const NBA_KEYS = ['minutes', 'points', 'fieldGoalsMade-fieldGoalsAttempted',
  'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted',
  'rebounds', 'assists', 'turnovers', 'steals', 'blocks',
  'offensiveRebounds', 'defensiveRebounds', 'fouls', 'plusMinus'];
const box = (athletes, keys = NBA_KEYS) => ({
  boxscore: { players: [{ statistics: [{ keys, athletes }] }] },
});
const ath = (displayName, stats) => ({ athlete: { displayName }, stats });
//            MIN  PTS  FG      3PT    FT     REB AST TO STL BLK OR DR PF  +/-
const LINE = ['30', '22', '8-15', '2-5', '4-4', '7', '5', '2', '1', '1', '2', '5', '3', '+6'];

export default async function ({ t }) {
  // ---- 1. player names that don't match exactly ---------------------------
  // The single biggest silent loss. PrizePicks and the box score disagree about
  // suffixes and short first names constantly, and an exact-only match drops
  // every one of those picks without explanation.
  const pm = await loadFn('player-match.js');
  const idx = pm.buildIndex([
    ['Michael Porter Jr.', 'MPJ'],
    ['Nathaniel Lowe', 'LOWE'],
    ['Luka Dončić', 'LUKA'],
    ['De\'Aaron Fox', 'FOX'],
  ]);
  t.eq('an exact name still matches', pm.matchPlayer(idx, 'Nathaniel Lowe')?.value, 'LOWE');
  t.eq('a missing suffix matches — "Luis Robert" vs "Luis Robert Jr."',
    pm.matchPlayer(idx, 'Michael Porter')?.value, 'MPJ');
  t.eq('...and is labelled as the looser match it is',
    pm.matchPlayer(idx, 'Michael Porter')?.how, 'suffix');
  t.eq('a short first name matches — "Nate Lowe" vs "Nathaniel Lowe"',
    pm.matchPlayer(idx, 'Nate Lowe')?.value, 'LOWE');
  t.eq('...labelled too', pm.matchPlayer(idx, 'Nate Lowe')?.how, 'initial');
  t.eq('accents are irrelevant either way', pm.matchPlayer(idx, 'Luka Doncic')?.value, 'LUKA');
  t.eq('punctuation is irrelevant', pm.matchPlayer(idx, 'DeAaron Fox')?.value, 'FOX');
  t.eq('a genuinely different player still refuses', pm.matchPlayer(idx, 'Jalen Green'), null);

  // The guardrail: widening must never resolve an ambiguous name.
  const twins = pm.buildIndex([['Josh Allen', 'QB'], ['Jordan Allen', 'LB']]);
  t.eq('two players sharing an initial and surname REFUSE rather than guess',
    pm.matchPlayer(twins, 'J. Allen'), null);
  t.eq('...while an exact name among them still resolves',
    pm.matchPlayer(twins, 'Josh Allen')?.value, 'QB');

  // End to end through the real grader.
  reset();
  const espn = await loadFn('espn-grade.js');
  const nameMock = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('1')] })],
    [/summary/, async () => box([ath('Michael Porter Jr.', LINE)])],
  ]);
  let suffixed;
  try {
    suffixed = await espn.gradeFromEspn({ league: 'nba', player: 'Michael Porter', date: '2026-08-14', stat: 'Points', line: 19.5 });
  } finally { nameMock.restore(); }
  t.eq('a suffix mismatch no longer costs the grade', suffixed?.result, 22);
  t.eq('...and the loose match is recorded', suffixed?.matchedVia, 'suffix');

  // ---- 2. combos silently grading WRONG -----------------------------------
  // Pts+Rebs+Asts was N(pts) + N(rebs) + N(asts). If ESPN stopped sending
  // `rebounds`, N(null) is 0 and the combo graded as Pts+Asts — confidently
  // wrong, which is worse than ungraded.
  reset();
  const noRebs = NBA_KEYS.filter((k) => k !== 'rebounds');
  const dropped = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('2')] })],
    [/summary/, async () => box([ath('Some Guard', LINE.filter((_, i) => NBA_KEYS[i] !== 'rebounds'))], noRebs)],
  ]);
  let brokenCombo, stillFine;
  try {
    brokenCombo = await espn.gradeFromEspn({ league: 'nba', player: 'Some Guard', date: '2026-08-14', stat: 'Pts+Rebs+Asts', line: 30.5 });
    stillFine = await espn.gradeFromEspn({ league: 'nba', player: 'Some Guard', date: '2026-08-14', stat: 'Points', line: 19.5 });
  } finally { dropped.restore(); }
  t.eq('a combo missing one of its parts REFUSES instead of grading short', brokenCombo, null);
  t.eq('...while the stats that are present still grade', stillFine?.result, 22);

  // The other side of it: a player legitimately absent from a stat group (a RB
  // with no catches) must still grade, because the key exists that day.
  reset();
  const FKEYS = ['rushingAttempts', 'rushingYards', 'rushingTouchdowns', 'receptions', 'receivingYards'];
  const nflMock = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('3')] })],
    [/summary/, async () => ({ boxscore: { players: [{ statistics: [
      { keys: ['rushingAttempts', 'rushingYards', 'rushingTouchdowns'], athletes: [ath('Pure Runner', ['18', '96', '1'])] },
      { keys: ['receptions', 'receivingYards'], athletes: [ath('Some Receiver', ['6', '81'])] },
    ] }] } })],
  ]);
  let rbCombo;
  try {
    rbCombo = await espn.gradeFromEspn({ league: 'nfl', player: 'Pure Runner', date: '2026-08-14', stat: 'Rush+Rec Yards', line: 90.5 });
  } finally { nflMock.restore(); }
  t.eq('a back with no receiving line still grades — that is a real zero, not a gap', rbCombo?.result, 96);
  t.eq('...and grades the over correctly', rbCombo?.hit, true);

  // ---- 3. stat names that were never mapped -------------------------------
  const mlb = await loadFn('mlb-grade.js');
  for (const [lg, stat] of [
    ['nfl', 'Pass+Rush Yards'], ['nfl', 'Targets'], ['nfl', 'Longest Rush'],
    ['nfl', 'Kicking Points'], ['nfl', 'Fumbles Lost'],
    ['nhl', 'Hits'], ['nhl', 'Penalty Minutes'], ['nhl', 'Faceoffs Won'],
    ['nba', 'Offensive Rebounds'], ['nba', 'Personal Fouls'],
  ]) {
    t.ok(`${lg} "${stat}" now resolves`, !!espn.resolveStat(lg, stat));
  }
  for (const stat of ['Runs+RBIs', 'Batter Strikeouts', 'Hitter Walks', 'Extra Base Hits',
    'Pitcher Walks', 'Home Runs Allowed', 'Innings Pitched', 'Hits+Runs']) {
    t.ok(`MLB "${stat}" now resolves`, !!mlb.resolveStat(stat));
  }
  t.eq('a stat with no honest mapping still refuses', espn.resolveStat('nba', 'Dunks'), null);

  // ---- 4. picks excluded for having no projection id ----------------------
  // The gate required a PrizePicks id before ANY grader ran, but MLB and ESPN
  // settle from player + date + stat. Every pick logged without an id was
  // therefore unreachable by the sources that actually work.
  reset();
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  seed('pick-log', day, [
    { date: day, loggedAt: day + 'T18:00:00Z', league: 'nba', projectionId: null,
      player: 'Some Guard', stat: 'Points', line: 19.5, prob: 0.6, verdict: 'play',
      result: null, hit: null, gradedAt: null },
  ]);
  const gp = await loadFn('grade-picks.js');
  const noId = mockFetch([
    [/scoreboard/, async () => ({ events: [ev('4', day + 'T23:00Z')] })],
    [/summary/, async () => box([ath('Some Guard', LINE)])],
  ]);
  try { await gp.handler({ queryStringParameters: { date: day } }); } finally { noId.restore(); }
  t.eq('a pick with no projection id now grades off the box score',
    (read('pick-log', day) || [])[0].hit, true);
  t.eq('...with the real value', (read('pick-log', day) || [])[0].result, 22);

  // ---- 5. the backlog abandoned before these graders existed --------------
  reset();
  seed('pick-log', day, [
    { date: day, loggedAt: day + 'T18:00:00Z', league: 'nba', projectionId: 'X',
      player: 'Some Guard', stat: 'Points', line: 19.5, prob: 0.6, verdict: 'play',
      // gave up back when PrizePicks was the only source
      gradeAttempts: 3, lastAttemptDay: '2026-01-01',
      result: null, hit: null, gradedAt: null },
  ]);
  const gp2 = await loadFn('grade-picks.js');
  const revive = mockFetch([
    [/api\.prizepicks\.com/, async () => ({ status: 403, body: 'no' })],
    [/scoreboard/, async () => ({ events: [ev('5', day + 'T23:00Z')] })],
    [/summary/, async () => box([ath('Some Guard', LINE)])],
  ]);
  let out;
  try { out = JSON.parse((await gp2.handler({ queryStringParameters: { date: day } })).body); } finally { revive.restore(); }
  t.ok('a pick that gave up under the old sources is revived', out.revived >= 1);
  t.eq('...and grades on the retry', (read('pick-log', day) || [])[0].hit, true);

  // ---- 6. the audit names what is still missing ---------------------------
  const audit = await loadFn('grade-audit.js');
  const a = audit.auditPicks([
    { league: 'nba', stat: 'Points', player: 'A', hit: true, gradedVia: 'espn' },
    { league: 'nba', stat: 'Points', player: 'B', hit: false, gradedVia: 'espn', matchedVia: 'suffix' },
    { league: 'nba', stat: 'Nonsense Stat', player: 'C', hit: null },
    { league: 'esports', stat: 'Maps Won', player: 'D', hit: null },
    { league: 'mlb', stat: 'Hits', player: 'E + F', hit: null },
    { league: 'mlb', stat: 'Hits', player: 'G', hit: null },
  ]);
  t.eq('graded picks are counted', a.graded, 2);
  t.ok('an unmapped stat is named exactly, ready to paste into the table',
    !!a.unmappedStats['nba :: Nonsense Stat']);
  t.ok('a league with no source is named', !!a.unroutedLeagues.esports);
  t.ok('a combo is separated out as expected, not reported as a defect',
    Object.keys(a.reasons).some((k) => /combo/.test(k)));
  t.ok('a pick whose mapping is fine is not blamed on the mapping',
    Object.keys(a.reasons).some((k) => /player lookup/.test(k)));
  t.ok('loose name matches are counted so they stay auditable', a.matchedVia.suffix === 1);
  t.ok('period props are recognised as permanently unsettleable',
    audit.isPeriodProp({ league: 'nba1h', stat: 'Points' }));
  t.ok('...and a normal prop is not mistaken for one',
    !audit.isPeriodProp({ league: 'nba', stat: 'Points' }));

  // ---- 6b. unmappedStatsAllTime: the historical footprint, not just today's
  // backlog. Some of these graded successfully in the past via the old
  // PrizePicks-history fallback (`gradedVia: 'prizepicks'`), before it started
  // 403ing everything — so counting only CURRENTLY ungraded picks (what
  // `unmappedStats` does) undercounts how many logged picks actually carry an
  // unmapped stat type.
  reset();
  const auditDay1 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const auditDay2 = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  seed('pick-log', auditDay1, [
    // graded historically via the dead prizepicks fallback — still unmapped
    { date: auditDay1, league: 'tennis', stat: 'Total Games', player: 'A',
      hit: true, gradedVia: 'prizepicks' },
    // currently ungraded for the same reason
    { date: auditDay1, league: 'tennis', stat: 'Total Games', player: 'B', hit: null },
    // a normal, gradeable pick — must not be swept in
    { date: auditDay1, league: 'mlb', stat: 'Hits', player: 'C', hit: true, gradedVia: 'mlb' },
  ]);
  seed('pick-log', auditDay2, [
    { date: auditDay2, league: 'tennis', stat: 'Total Games', player: 'D', hit: null },
  ]);
  const auditFn = await loadFn('grade-audit.js');
  const wide = JSON.parse((await auditFn.handler({ queryStringParameters: { days: '10' } })).body);
  t.eq('unmappedStats (current backlog only) misses the one that already graded',
    wide.unmappedStats['tennis :: Total Games'], 2);
  t.eq('unmappedStatsAllTime counts every logged pick of that stat, graded or not',
    wide.unmappedStatsAllTime['tennis :: Total Games'], 3);
  t.eq('...rolled up into one total', wide.unmappedStatsAllTimeTotal, 3);
  t.ok('a gradeable pick is not counted toward either', !('mlb :: Hits' in wide.unmappedStatsAllTime));

  // ---- 7. Fantasy Score: the single biggest hole ------------------------
  // 367 of 1060 logged picks — 35% of everything — were Fantasy Score props
  // that no mapping could touch. It is a weighted FORMULA, not a column, so a
  // wrong weight grades hundreds of picks confidently wrong.
  const fs = await loadFn('fantasy-score.js');
  t.eq('basketball fantasy score follows the standard weights',
    fs.basketballFantasy({ points: 30, rebounds: 10, assists: 5, steals: 2, blocks: 1, turnovers: 3 }), 55.5);
  t.eq('...turnovers subtract',
    fs.basketballFantasy({ points: 10, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 4 }), 6);
  t.eq('a missing component REFUSES rather than treating it as zero',
    fs.basketballFantasy({ points: 30, rebounds: 10, assists: 5, steals: 2, blocks: 1 }), null);
  t.eq('...because that would silently inflate every score',
    fs.basketballFantasy({ points: 30, rebounds: null, assists: 5, steals: 2, blocks: 1, turnovers: 3 }), null);

  t.eq('a hitter prop routes to the hitter formula', fs.fantasyKind('mlb', 'Hitter Fantasy Score'), 'mlb-hitter');
  t.eq('a pitcher prop routes to the pitcher formula', fs.fantasyKind('mlb', 'Pitcher Fantasy Score'), 'mlb-pitcher');
  t.eq('a basketball prop routes to basketball', fs.fantasyKind('wnba', 'Fantasy Score'), 'basketball');
  t.eq('tennis fantasy has no formula wired and says so', fs.fantasyKind('tennis', 'Fantasy Score'), null);
  t.eq('a non-fantasy stat is not swept in', fs.fantasyKind('mlb', 'Hits'), null);

  // The gate existed while the weights were inferred. They now come from
  // PrizePicks' published scoring chart, so it is open — and the escape hatch
  // stays for the day that chart changes.
  t.eq('MLB fantasy grades now the weights are sourced, not guessed', fs.MLB_VERIFIED, true);
  reset();
  const mlbFs = mockFetch([
    [/\/sports\/1\/players/, async () => ({ people: [{ id: 900, fullName: 'Some Hitter' }] })],
    [/people\/900\/stats/, async () => ({ stats: [{ splits: [{ date: '2026-08-14', stat: {
      hits: 2, doubles: 1, triples: 0, homeRuns: 1, runs: 2, rbi: 3, baseOnBalls: 1 } }] }] })],
  ]);
  let gated, allowed;
  try {
    gated = await mlb.gradeFromMlb({ player: 'Some Hitter', date: '2026-08-14', stat: 'Hitter Fantasy Score', line: 20.5 });
    allowed = await mlb.gradeFromMlb({ player: 'Some Hitter', date: '2026-08-14', stat: 'Hitter Fantasy Score', line: 20.5, allowUnverifiedFantasy: true });
  } finally { mlbFs.restore(); }
  t.ok('an MLB fantasy prop now grades', gated?.result != null, `computed ${gated?.result}`);
  t.eq('...to the same number the checker sees', gated?.result, allowed?.result);

  // ---- 8. the rest of the audit's list ------------------------------------
  t.ok('MLB "Plate Appearances" now resolves', !!mlb.resolveStat('Plate Appearances'));
  t.ok('MLB "Pitches Seen" now resolves', !!mlb.resolveStat('Pitches Seen'));

  // The audit only ever asked the COLUMN tables, so it kept reporting Fantasy
  // Score picks as an unmapped stat long after they were grading fine — sending
  // me hunting for a mapping that was never the problem. Fantasy routes through
  // its own weighted formula, and the audit has to know that to be believed.
  t.eq('the audit knows Fantasy Score resolves via its formula, not a column',
    audit.statResolves('mlb', 'Hitter Fantasy Score'), true);
  t.eq('...for NFL too', audit.statResolves('nfl', 'Fantasy Score'), true);
  t.eq('...while a genuinely unknown stat is still reported unmapped',
    audit.statResolves('mlb', 'Strikes Counted'), false);
  t.ok('the World Cup routes to ESPN soccer', !!espn.SLUGS.world_cup);
  t.eq('esports still has no source, honestly reported', espn.resolveStat('lol', 'Kills'), null);
}

// College football, and the NFL map it shares.
//
// "Does CFB work?" looked like a yes: the app said "No CFB games today — the
// next posted slate starts 2026-09-11", which was exactly true (all 658 posted
// CFB props were for 09-11 and 09-12). The failure was one layer down and
// completely silent — 225 of those 658 props, 34% of the slate, had NO STAT
// MAPPING, so they would have been judged, logged, and then never graded. They
// would never have reached calibration and never counted against anything.
//
// The same map serves the NFL, where it was 1,561 of 7,037 posted props (22%).
//
// Almost all of it was naming. The NFL slate says "Receiving TDs" and the CFB
// slate says "Rec TDs"; only the first was mapped. Same for Pass+Rush Yds,
// Rush+Rec Yds, INT, PAT Made, Rec Targets and Tackles+Ast.
//
// Every key asserted below was read off a REAL box score, not inferred:
//   CFB event 401858210 (2026-09-06) and NFL event 401874394 (2026-08-29),
//   via /api/espn-grade?mode=probe. The two leagues do NOT send the same keys,
//   which is the trap this file is guarding: NFL sends receivingTargets and
//   sacks-sackYardsLost, CFB sends neither, and NEITHER sends longPassing.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const DATE = '2026-09-06';
const FINAL = { status: { type: { completed: true, state: 'post', name: 'STATUS_FINAL' } } };

// The real group shapes, key for key, from the probe above.
const CFB_GROUPS = {
  passing: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions', 'adjQBR'],
  rushing: ['rushingAttempts', 'rushingYards', 'yardsPerRushAttempt', 'rushingTouchdowns', 'longRushing'],
  receiving: ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception'],
  defensive: ['totalTackles', 'soloTackles', 'sacks', 'tacklesForLoss', 'passesDefended', 'hurries', 'defensiveTouchdowns'],
  interceptions: ['interceptions', 'interceptionYards', 'interceptionTouchdowns'],
  kicking: ['fieldGoalsMade/fieldGoalAttempts', 'fieldGoalPct', 'longFieldGoalMade', 'extraPointsMade/extraPointAttempts', 'totalKickingPoints'],
  punting: ['punts', 'puntYards', 'grossAvgPuntYards', 'touchbacks', 'puntsInside20', 'longPunt'],
};
// NFL differs in exactly two places that matter here.
const NFL_GROUPS = {
  ...CFB_GROUPS,
  passing: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions', 'sacks-sackYardsLost', 'adjQBR', 'QBRating'],
  receiving: ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'],
};

// groups: { groupName: [ [playerName, ...stats], ... ] }
const box = (groups, schema) => ({
  boxscore: {
    players: [{
      statistics: Object.entries(groups).map(([name, rows]) => ({
        name, keys: schema[name],
        athletes: rows.map(([athlete, ...stats]) => ({ athlete: { displayName: athlete }, stats })),
      })),
    }],
  },
});

const gradeAll = async (espn, league, schema, groups, picks) => {
  reset();
  const m = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '401858210', date: `${DATE}T20:00Z`, ...FINAL }] })],
    [/summary/, async () => box(groups, schema)],
  ]);
  try {
    const out = {};
    for (const [label, p] of Object.entries(picks)) {
      out[label] = await espn.gradeFromEspn({ league, date: DATE, ...p });
    }
    return out;
  } finally { m.restore(); }
};

export default async function ({ t }) {
  const espn = await loadFn('espn-grade.js');
  const { resolveStat } = espn;

  // ---- 1. every stat the live CFB slate actually posts --------------------
  // Counts are the real ones from the 2026-09-11/12 slate.
  const CFB_SLATE = [
    [146, 'Receiving Yards'], [98, 'Player Touchdowns'], [91, 'Rush Yards'], [76, 'Rec TDs'],
    [45, 'Pass Yards'], [38, 'Rush TDs'], [28, 'Longest Reception'], [22, 'Receptions'],
    [19, 'Pass TDs'], [17, 'Longest Rush'], [17, 'Pass+Rush Yds'], [13, 'Rush+Rec Yds'],
    [11, 'INT'], [7, 'Rush Attempts'], [6, 'FG Made'], [5, 'Kicking Points'],
    [5, 'Pass Completions'], [4, 'Pass Attempts'], [4, 'PAT Made'],
  ];
  const unmapped = CFB_SLATE.filter(([, s]) => !resolveStat('cfb', s));
  t.eq('every stat on the real CFB slate resolves, bar the one with no source',
    unmapped.map(([, s]) => s), []);
  const covered = CFB_SLATE.reduce((a, [n]) => a + n, 0);
  t.eq('...which is 652 of the 658 posted props', covered, 652);

  // ---- 2. the ones that were silently missing, end to end -----------------
  const g = await gradeAll(espn, 'cfb', CFB_GROUPS, {
    //                    comp/att  yds  ypa   TD  INT  qbr
    passing: [['Gio Lopez', '24/41', '271', '6.6', '2', '2', '62.5']],
    //                        att   yds   ypc   TD  long
    rushing: [['Gio Lopez', '9', '61', '6.8', '1', '20'],
      ['Jamal Roberts', '28', '120', '4.3', '1', '20']],
    //                          rec  yds   ypr    TD  long
    receiving: [['Jamal Roberts', '4', '38', '9.5', '1', '15'],
      ['Ben Black III', '6', '104', '17.3', '2', '43']],
    defensive: [['Sammy Omosigho', '14', '7', '1', '2', '0', '0', '0']],
    interceptions: [['Ta\'Shawn James', '2', '19', '0']],
    //                              fg    pct   long  xp    pts
    kicking: [['Trey Butkowski', '1/1', '100.0', '38', '6/6', '9']],
    punting: [['Curtis Gerrand', '5', '215', '43.0', '0', '3', '46']],
  }, {
    recTds: { player: 'Ben Black III', stat: 'Rec TDs', line: 1.5 },
    // 1 rushing + 1 receiving = 2 TDs scored.
    playerTds: { player: 'Jamal Roberts', stat: 'Player Touchdowns', line: 0.5 },
    // A QB's Player Touchdowns is his RUSHING TDs — every such line on the live
    // slate is 0.5, which is a rushing line; his 2 passing TDs are not his.
    qbPlayerTds: { player: 'Gio Lopez', stat: 'Player Touchdowns', line: 1.5 },
    passRush: { player: 'Gio Lopez', stat: 'Pass+Rush Yds', line: 299.5 },
    rushRec: { player: 'Jamal Roberts', stat: 'Rush+Rec Yds', line: 98.5 },
    int: { player: 'Gio Lopez', stat: 'INT', line: 0.5 },
    patMade: { player: 'Trey Butkowski', stat: 'PAT Made', line: 5.5 },
    inside20: { player: 'Curtis Gerrand', stat: 'Punts Inside 20', line: 2.5 },
    tacklesAst: { player: 'Sammy Omosigho', stat: 'Tackles+Ast', line: 10.5 },
  });

  t.eq('"Rec TDs" grades — the CFB slate\'s name for Receiving TDs', g.recTds?.result, 2);
  t.eq('...and settles against the line', g.recTds?.hit, true);
  t.eq('"Player Touchdowns" is rushing plus receiving', g.playerTds?.result, 2);
  t.eq('...a QB\'s is his rushing TDs, not the 2 he threw', g.qbPlayerTds?.result, 1);
  t.eq('...so a 1.5 line on him is a miss', g.qbPlayerTds?.hit, false);
  t.eq('"Pass+Rush Yds" sums both', g.passRush?.result, 332);
  t.eq('"Rush+Rec Yds" sums both', g.rushRec?.result, 158);
  t.eq('"PAT Made" reads the made half of "6/6"', g.patMade?.result, 6);
  t.eq('"Punts Inside 20" grades', g.inside20?.result, 3);
  t.eq('"Tackles+Ast" is ESPN\'s totalTackles', g.tacklesAst?.result, 14);

  // ---- 3. the interception trap ------------------------------------------
  // ESPN sends `interceptions` under TWO groups: passing (thrown) and
  // interceptions (caught). A player's groups merge first-wins, so a QB gets
  // the thrown count — but a defender would get the caught count under the
  // identical key, which is a different stat and a confidently wrong grade.
  t.eq('a QB\'s INT is the 2 he threw', g.int?.result, 2);
  const pick = await gradeAll(espn, 'cfb', CFB_GROUPS, {
    interceptions: [['Ta\'Shawn James', '2', '19', '0']],
  }, { d: { player: 'Ta\'Shawn James', stat: 'INT', line: 0.5 } });
  t.eq('a defender who never passed REFUSES rather than grading picks caught as picks thrown',
    pick.d, null);

  // ---- 4. what stays unmapped, and why ------------------------------------
  // Refusing is the correct answer when no source exists. A guess here writes a
  // false result into the calibration log, which is worse than a missing one.
  t.eq('"Longest Completion" stays unmapped — ESPN sends no longPassing, in either league',
    resolveStat('cfb', 'Longest Completion'), null);
  t.eq('...and neither does the NFL box score', resolveStat('nfl', 'Longest Completion'), null);
  for (const s of ['Rush Yards in First 5 Attempts', 'Quarters with 5+ Rush Yards',
    'Completions in First 10 Pass Attempts', 'Yards on First Rush Attempt']) {
    t.eq(`a within-game sequence prop stays unmapped — "${s}" needs play-by-play`,
      resolveStat('nfl', s), null);
  }

  // ---- 5. the two leagues do not send the same keys -----------------------
  // Both are mapped, and the mapping must resolve on the league that sends the
  // key and REFUSE on the one that doesn't — rather than falling through to a
  // similarly-named stat that means something else.
  const nfl = await gradeAll(espn, 'nfl', NFL_GROUPS, {
    passing: [['Sack Taker', '20/30', '250', '8.3', '2', '0', '3-21', '90.0', '95.1']],
    receiving: [['Target Guy', '5', '70', '14.0', '1', '30', '9']],
  }, {
    targets: { player: 'Target Guy', stat: 'Rec Targets', line: 6.5 },
    sacked: { player: 'Sack Taker', stat: 'Sacks Taken', line: 2.5 },
  });
  t.eq('"Rec Targets" grades on NFL, which sends receivingTargets', nfl.targets?.result, 9);
  t.eq('"Sacks Taken" reads the QB\'s own "3-21", not the defensive sacks column',
    nfl.sacked?.result, 3);

  const cfbSame = await gradeAll(espn, 'cfb', CFB_GROUPS, {
    receiving: [['Target Guy', '5', '70', '14.0', '1', '30']],
    passing: [['Sack Taker', '20/30', '250', '8.3', '2', '0', '90.0']],
    defensive: [['Sack Taker', '4', '2', '3', '1', '0', '0', '0']],
  }, {
    targets: { player: 'Target Guy', stat: 'Rec Targets', line: 6.5 },
    sacked: { player: 'Sack Taker', stat: 'Sacks Taken', line: 2.5 },
  });
  t.eq('the same prop REFUSES on CFB, whose box score has no targets column',
    cfbSame.targets, null);
  t.eq('...and Sacks Taken refuses rather than grading sacks MADE',
    cfbSame.sacked, null);

  // ---- 6. derived rather than read ---------------------------------------
  // ESPN sends yardsPerRushAttempt, but rounded to one decimal, and PrizePicks
  // settles on the real quotient — so reading the column would grade a 4.5 line
  // against a rounded 4.5 when the true figure is 4.28, turning a clear miss
  // into a push. Yards and attempts are both exact.
  const derived = await gradeAll(espn, 'cfb', CFB_GROUPS, {
    rushing: [['Rounder', '7', '30', '4.5', '0', '12']],
    passing: [['Passer', '13/20', '150', '7.5', '1', '0', '80.0']],
  }, {
    ypc: { player: 'Rounder', stat: 'Rush Yards Per Carry', line: 4.5 },
    cmp: { player: 'Passer', stat: 'Completion Percentage', line: 60.5 },
  });
  t.ok('yards per carry is computed from the exact yards and attempts',
    Math.abs(derived.ypc.result - 30 / 7) < 1e-9, String(derived.ypc?.result));
  t.eq('...so a line ESPN\'s rounded column would have pushed is settled correctly',
    derived.ypc?.hit, false);
  t.eq('completion percentage is derived from "13/20"', derived.cmp?.result, 65);

  // ---- 6b. the trap gate now covers CFB too -------------------------------
  // It always covered NFL, and college football is the same sport with the same
  // position codes and the same stat vocabulary — so half the football props
  // this app serves were exempt from it. Measured against the real posted CFB
  // slate this blocks nothing today (PrizePicks is posting no defensive CFB
  // props); it matters the week they do.
  const bf = await loadFn('bet-finder-background.js');
  {
    t.eq('a QB with a passing line is fine on CFB, as on NFL',
      bf.positionAllows('QB', 'Pass Yards', 'cfb'), true);
    t.eq('a kicker with a receiving line is refused on CFB',
      bf.positionAllows('K', 'Receiving Yards', 'cfb'), false);
    t.eq('...and a linebacker with a rushing line',
      bf.positionAllows('LB', 'Rush Yards', 'cfb'), false);
    t.eq('a WR with a passing line is refused — the classic trap',
      bf.positionAllows('WR', 'Pass Yards', 'cfb'), false);
    t.eq('a RB who catches passes is untouched, because that is real',
      bf.positionAllows('RB', 'Rec TDs', 'cfb'), true);
    t.eq('an ambiguous stat never blocks anyone',
      bf.positionAllows('WR', 'Player Touchdowns', 'cfb'), true);
    t.eq('the CFB gate is the identical NFL one, not a second copy that can drift',
      ['QB::Pass Yards', 'K::Rush Yards', 'DB::Receiving Yards', 'TE::Receptions']
        .map((k) => { const [p2, st] = k.split('::'); return bf.positionAllows(p2, st, 'cfb'); }),
      ['QB::Pass Yards', 'K::Rush Yards', 'DB::Receiving Yards', 'TE::Receptions']
        .map((k) => { const [p2, st] = k.split('::'); return bf.positionAllows(p2, st, 'nfl'); }));
  }

  // ---- 7. a stat that vanishes from the box score refuses, never zeroes ----
  // The oldest trap in this file: a combo built as N(a)+N(b) reads a missing key
  // as 0 and grades confidently wrong. Both halves must be in the day's schema.
  const partial = await gradeAll(espn, 'cfb', { rushing: CFB_GROUPS.rushing }, {
    rushing: [['Only Rushed', '10', '55', '5.5', '1', '20']],
  }, { combo: { player: 'Only Rushed', stat: 'Rush+Rec Yds', line: 50.5 } });
  t.eq('a combo whose other half is absent from the whole slate refuses',
    partial.combo, null);
}

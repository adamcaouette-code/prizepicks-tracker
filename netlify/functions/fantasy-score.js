// netlify/functions/fantasy-score.js
//
// PrizePicks Fantasy Score, which turns out to be the single biggest hole in
// grading: 367 of 1060 logged picks — 35% of everything — are a Fantasy Score
// prop, and none of them could grade because no mapping existed.
//
// It was left unmapped deliberately. Fantasy Score is not a column in any box
// score; it is a WEIGHTED FORMULA, and a wrong weight grades every one of those
// picks confidently wrong, which is the failure this pipeline exists to avoid.
// But refusing forever is not a neutral choice either — it silently discards a
// third of the sample. So: implement the formulas, and verify them against data
// instead of trusting them.
//
// THE VERIFICATION IDEA
// We have no external truth to check against (PrizePicks won't serve results).
// But we have something almost as good: the LINES. PrizePicks sets a line near
// the middle of the expected distribution, so across a few hundred picks the
// median computed score should land close to the median line. If the weights are
// wrong — a factor of two out, a missing term — the computed values sit visibly
// off the lines, and the ratio says so. That check runs in /api/fantasy-check.
//
// Basketball is enabled: its formula is standard and stable across DFS sites,
// and it is only 28 picks either way. MLB is GATED behind a verified flag,
// because 335 picks ride on weights I am not certain of. Turn it on only once
// fantasy-check reports a ratio near 1.

const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);

// ---------------------------------------------------------------------------
// Basketball (NBA / WNBA). Standard PrizePicks scoring, stable across sites.
export const BASKETBALL_WEIGHTS = {
  points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, turnovers: -1,
};

/**
 * @param {{points,rebounds,assists,steals,blocks,turnovers}} s
 */
export function basketballFantasy(s) {
  if (!s) return null;
  // Every component must be present. A missing turnover count silently inflates
  // the score, which is exactly the class of error that makes a combo lie.
  for (const k of Object.keys(BASKETBALL_WEIGHTS)) {
    if (s[k] == null || !isFinite(Number(s[k]))) return null;
  }
  let total = 0;
  for (const [k, w] of Object.entries(BASKETBALL_WEIGHTS)) total += num(s[k]) * w;
  return Math.round(total * 100) / 100;
}

// ---------------------------------------------------------------------------
// MLB — taken from PrizePicks' own published scoring chart. Four of my nine
// hitter weights were wrong and the pitcher formula was wrong in both
// directions at once:
//
//   Double        was 6, is 5
//   Walk          was 3, is 2
//   Hit By Pitch  was 3, is 2
//   Stolen Base   was 4, is 5
//   Win           MISSING — worth 6
//   Quality Start MISSING — worth 4
//   Hits allowed  INVENTED at -0.6; no such category exists
//   Walks allowed INVENTED at -0.6; no such category exists
//
// The invented penalties and the missing bonuses partly cancelled, which is
// why the pitcher scale test read only 1.21x low rather than obviously broken.
// That is the case for reading the actual rulebook rather than inferring from
// a proxy: a formula can be wrong in several places and still produce a
// plausible-looking aggregate.
export const MLB_HITTER_WEIGHTS = {
  singles: 3, doubles: 5, triples: 8, homeRuns: 10,
  runs: 2, rbi: 2, baseOnBalls: 2, hitByPitch: 2, stolenBases: 5,
};
export const MLB_PITCHER_WEIGHTS = {
  outs: 1,            // 3 per inning pitched, applied per out
  strikeOuts: 3,
  earnedRuns: -3,
  wins: 6,
  qualityStarts: 4,
};

// Now sourced from the published chart rather than inferred, so it is ON.
// FANTASY_MLB_DISABLE=1 turns it back off without a code change if the chart
// ever moves.
export const MLB_VERIFIED = process.env.FANTASY_MLB_DISABLE !== '1';

export function mlbHitterFantasy(s) {
  if (!s) return null;
  // A game log row with zero plate appearances means he did not bat — a late
  // defensive replacement, or listed but never used. PrizePicks VOIDS a prop on
  // a player who does not appear; it does not settle it at 0. Scoring it 0 writes
  // a false loss into calibration. Corey Seager showed up in a live sample
  // exactly this way: "0-0", 0 AB, 0 PA, scored 0.
  if (Number(s.plateAppearances) === 0) return null;
  const hits = s.hits, doubles = s.doubles, triples = s.triples, hr = s.homeRuns;
  if ([hits, doubles, triples, hr, s.runs, s.rbi, s.baseOnBalls].some((v) => v == null)) return null;
  const singles = num(hits) - num(doubles) - num(triples) - num(hr);
  const parts = {
    singles, doubles: num(doubles), triples: num(triples), homeRuns: num(hr),
    runs: num(s.runs), rbi: num(s.rbi), baseOnBalls: num(s.baseOnBalls),
    hitByPitch: num(s.hitByPitch), stolenBases: num(s.stolenBases),
  };
  let total = 0;
  for (const [k, w] of Object.entries(MLB_HITTER_WEIGHTS)) total += parts[k] * w;
  return Math.round(total * 100) / 100;
}

/** A quality start is 6+ innings with 3 or fewer earned runs — 18 outs. */
export const isQualityStart = (s) => (Number(s?.outs) >= 18 && Number(s?.earnedRuns) <= 3 ? 1 : 0);

export function mlbPitcherFantasy(s) {
  if (!s) return null;
  // Same rule on the mound: no outs recorded means he never pitched.
  if (Number(s.outs) === 0 && Number(s.battersFaced || 0) === 0) return null;
  if ([s.outs, s.strikeOuts, s.earnedRuns].some((v) => v == null)) return null;
  const parts = {
    outs: num(s.outs), strikeOuts: num(s.strikeOuts), earnedRuns: num(s.earnedRuns),
    // The game log carries wins directly. Quality start it does not, but the
    // definition is fixed — 6 innings, 3 earned runs or fewer — so it is derived
    // rather than guessed.
    wins: num(s.wins),
    qualityStarts: isQualityStart(s),
  };
  let total = 0;
  for (const [k, w] of Object.entries(MLB_PITCHER_WEIGHTS)) total += parts[k] * w;
  return Math.round(total * 100) / 100;
}

/**
 * What the formula produces for a LEAGUE-AVERAGE game.
 *
 * This is the check that finally settled the weights question, and it is better
 * than the median-vs-line ratio for one reason: it does not touch the pick log
 * at all. The logged picks are ones the engine CHOSE, so their outcomes beat
 * their lines even with perfect weights, and no amount of care separates that
 * bias from a weight error without a control — which never resolved, because
 * every basketball fantasy pick in the log turned out to be goblin or demon.
 *
 * A bookmaker sets a line near the middle of the distribution, so the formula's
 * output for an average game should land near the typical line. If it does not,
 * the weights are wrong by roughly that factor — and nothing about selection can
 * explain it away.
 *
 * Rates are per-game for a qualified regular / a starting pitcher.
 */
export const AVERAGE_HITTER_GAME = {
  hits: 0.955, doubles: 0.18, triples: 0.015, homeRuns: 0.13,
  runs: 0.55, rbi: 0.53, baseOnBalls: 0.35, hitByPitch: 0.045, stolenBases: 0.05,
  plateAppearances: 4.1,
};
export const AVERAGE_PITCHER_START = {
  outs: 15.6, strikeOuts: 5.5, earnedRuns: 2.6, battersFaced: 22, wins: 0.33,
};

// What the VERIFIED weights produce for these average lines. Recorded so the
// scale test becomes a regression guard: once the weights come from the
// published chart it is no longer evidence about what they SHOULD be, but a
// sharp move here still means someone changed one.
//
// The residual gap for hitters (7.4 against a typical 5.5 line) is not an error.
// The average modelled here is a qualified regular, while the line pool includes
// rookies and platoon players with lower expected output.
export const EXPECTED_SCALE = { 'mlb-hitter': 7.41, 'mlb-pitcher': 26.28, basketball: 23.01 };

export function scaleCheck(kind) {
  if (kind === 'mlb-hitter') return mlbHitterFantasy(AVERAGE_HITTER_GAME);
  if (kind === 'mlb-pitcher') return mlbPitcherFantasy(AVERAGE_PITCHER_START);
  if (kind === 'nfl') {
    return nflFantasy({ passingYards: 0, rushingYards: 45, receivingYards: 30, receptions: 3,
      rushingTouchdowns: 0.3, receivingTouchdowns: 0.2, passingTouchdowns: 0, interceptions: 0, fumblesLost: 0.05 });
  }
  if (kind === 'basketball') {
    return basketballFantasy({ points: 11.5, rebounds: 4.3, assists: 2.6, steals: 0.75, blocks: 0.5, turnovers: 1.3 });
  }
  return null;
}

// NFL, from the same published chart. Full PPR.
// Kicker fantasy is deliberately absent: it scores field goals by DISTANCE
// (3/4/5 for 0-39, 40-49, 50+), and an ESPN box score reports makes and
// attempts without the yardage, so it cannot be computed honestly.
export const NFL_WEIGHTS = {
  passingYards: 0.04, passingTouchdowns: 4, interceptions: -1,
  rushingYards: 0.1, rushingTouchdowns: 6,
  receptions: 1, receivingYards: 0.1, receivingTouchdowns: 6,
  fumblesLost: -1,
};

export function nflFantasy(s) {
  if (!s) return null;
  // Yardage is the backbone here; without it nothing else is worth summing.
  if (s.passingYards == null && s.rushingYards == null && s.receivingYards == null) return null;
  let total = 0;
  for (const [k, w] of Object.entries(NFL_WEIGHTS)) total += num(s[k]) * w;
  return Math.round(total * 100) / 100;
}

/** Which fantasy variant a PrizePicks stat name refers to, if any. */
export function fantasyKind(league, stat) {
  const s = String(stat || '').toLowerCase();
  if (!/fantasy/.test(s)) return null;
  const lg = String(league || '').toLowerCase();
  if (lg === 'mlb') {
    if (/pitcher/.test(s)) return 'mlb-pitcher';
    if (/hitter|batter/.test(s)) return 'mlb-hitter';
    return 'mlb-hitter';      // bare "Fantasy Score" on a hitter's board
  }
  if (['nba', 'wnba', 'cbb', 'college_basketball'].includes(lg)) return 'basketball';
  if (['nfl', 'cfb', 'college_football'].includes(lg)) {
    // Kicker scoring needs field goals by distance, which the box score does
    // not carry — refuse rather than score it wrong.
    if (/kicker/.test(s)) return null;
    return 'nfl';
  }
  return null;                // tennis and everything else: no formula wired
}

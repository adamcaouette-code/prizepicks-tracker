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
// MLB. UNVERIFIED — these weights are my best understanding of PrizePicks'
// published scoring, not something I have confirmed against a settled prop.
// 335 picks depend on them, so they stay off until fantasy-check says the
// computed values track the lines.
export const MLB_HITTER_WEIGHTS = {
  singles: 3, doubles: 6, triples: 8, homeRuns: 10,
  runs: 2, rbi: 2, baseOnBalls: 3, hitByPitch: 3, stolenBases: 4,
};
export const MLB_PITCHER_WEIGHTS = {
  outs: 1,           // 3 per inning pitched, applied per out
  strikeOuts: 3,
  earnedRuns: -3,
  hits: -0.6,
  baseOnBalls: -0.6,
};

// Flip to true ONLY after /api/fantasy-check reports lineRatio near 1.0.
// Set FANTASY_MLB_VERIFIED=1 in the Netlify environment to enable without a
// redeploy once you have checked it.
export const MLB_VERIFIED = process.env.FANTASY_MLB_VERIFIED === '1';

export function mlbHitterFantasy(s) {
  if (!s) return null;
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

export function mlbPitcherFantasy(s) {
  if (!s) return null;
  if ([s.outs, s.strikeOuts, s.earnedRuns].some((v) => v == null)) return null;
  const parts = {
    outs: num(s.outs), strikeOuts: num(s.strikeOuts), earnedRuns: num(s.earnedRuns),
    hits: num(s.hits), baseOnBalls: num(s.baseOnBalls),
  };
  let total = 0;
  for (const [k, w] of Object.entries(MLB_PITCHER_WEIGHTS)) total += parts[k] * w;
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
  return null;                // tennis and everything else: no formula wired
}

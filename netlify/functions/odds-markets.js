// netlify/functions/odds-markets.js
//
// PrizePicks stat name -> The Odds API player-prop market key. THE canonical
// map, moved here out of judge-slip-background.js.
//
// It was a private copy inside that one file, which was fine while exactly one
// caller needed it. The line-snapshot archive needs the same mapping for every
// prop on the board, and a second copy of a table like this does not stay in
// sync — it drifts, and the drift is invisible because each caller's tests
// check its own copy against itself. See one-source-of-truth.test.mjs for what
// that cost here the last time.
//
// EXACT KEYS ONLY, no fuzzy contains: a wrong market is worse than no market.
// A missing mapping means a prop is archived with a PrizePicks line and no book
// line beside it, which is honest. A wrong one silently compares a player's
// strikeouts against his walks.

/** Normalized stat key: lowercase, alphanumerics only. */
export function statKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const MLB_HIT_MARKETS = {
  hits: 'batter_hits', totalbases: 'batter_total_bases', rbi: 'batter_rbis', rbis: 'batter_rbis',
  runs: 'batter_runs_scored', runsscored: 'batter_runs_scored',
  homeruns: 'batter_home_runs', hr: 'batter_home_runs',
  singles: 'batter_singles', doubles: 'batter_doubles', triples: 'batter_triples',
  walks: 'batter_walks', strikeouts: 'batter_strikeouts', stolenbases: 'batter_stolen_bases',
  hitsrunsrbis: 'batter_hits_runs_rbis', fantasyscore: 'batter_fantasy_score',
};
export const MLB_PIT_MARKETS = {
  strikeouts: 'pitcher_strikeouts', hitsallowed: 'pitcher_hits_allowed',
  walks: 'pitcher_walks', walksallowed: 'pitcher_walks',
  earnedruns: 'pitcher_earned_runs', outsrecorded: 'pitcher_outs', pitchingouts: 'pitcher_outs',
};
export const HOOPS_MARKETS = {
  points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists',
  threes: 'player_threes', threepointersmade: 'player_threes',
  blocks: 'player_blocks', steals: 'player_steals', turnovers: 'player_turnovers',
  ptsrebsasts: 'player_points_rebounds_assists', pra: 'player_points_rebounds_assists',
  ptsrebs: 'player_points_rebounds', pr: 'player_points_rebounds',
  ptsasts: 'player_points_assists', pa: 'player_points_assists',
  rebsasts: 'player_rebounds_assists', ra: 'player_rebounds_assists',
  fantasyscore: 'player_fantasy_points', fantasypoints: 'player_fantasy_points',
};
export const NFL_MARKETS = {
  passyards: 'player_pass_yards', passingyards: 'player_pass_yards',
  passtds: 'player_pass_tds', passingtds: 'player_pass_tds',
  rushyards: 'player_rush_yards', rushingyards: 'player_rush_yards',
  rushtds: 'player_rush_tds', rushingtds: 'player_rush_tds',
  receptions: 'player_receptions',
  receivingyards: 'player_reception_yards', recyards: 'player_reception_yards',
  receivingtds: 'player_reception_tds', rectds: 'player_reception_tds',
  sacks: 'player_sacks',
};

// PrizePicks names the role in the stat itself on the props that need it —
// "Hitter Strikeouts" and "Pitcher Strikeouts" are different markets sharing a
// word. Checked BEFORE the role-based dispatch below, because the name is a
// fact and the role is a lookup that can be missing or wrong: a two-way player,
// a position string PrizePicks writes differently, or simply no position at all
// on the row. When the prop says which one it is, believe the prop.
//
// Measured against a live 5,908-prop MLB board: without these, 27% of it had no
// book market at all — every Hitter Fantasy Score, every Hitter Strikeouts,
// every Pitcher Strikeouts and every Earned Runs Allowed, because the keys were
// `fantasyscore`, `strikeouts` and `earnedruns` and PrizePicks does not post
// those names. With them, 9%.
export const MLB_EXPLICIT_MARKETS = {
  hitterstrikeouts: 'batter_strikeouts',
  hitterfantasyscore: 'batter_fantasy_score',
  hitterhomeruns: 'batter_home_runs',
  hitterrbis: 'batter_rbis',
  hitterrunsscored: 'batter_runs_scored',
  hitterwalks: 'batter_walks',
  hittersingles: 'batter_singles',
  pitcherstrikeouts: 'pitcher_strikeouts',
  pitcherwalks: 'pitcher_walks',
  pitcherhitsallowed: 'pitcher_hits_allowed',
  earnedrunsallowed: 'pitcher_earned_runs',
  outsrecorded: 'pitcher_outs',
  pitchingouts: 'pitcher_outs',
};

// DELIBERATELY UNMAPPED, and each for a reason. The Odds API publishes no
// equivalent market, so a mapping could only be a guess at a neighbouring one:
//   Pitches Thrown, Pitches Seen, Strikes Counted, Balls Counted,
//   Plate Appearances, Pitcher Fantasy Score
// These archive with a PrizePicks line and no book line beside them, which is
// the honest outcome — the CLV view reports them as unpriced rather than
// comparing them to something they are not.

// exact-key only (no fuzzy contains) — a wrong market is worse than no market
export function marketFor(league, stat, role) {
  const k = statKey(stat);
  if (league === 'mlb') {
    if (MLB_EXPLICIT_MARKETS[k]) return MLB_EXPLICIT_MARKETS[k];
    return (role === 'PIT' ? MLB_PIT_MARKETS : MLB_HIT_MARKETS)[k] || null;
  }
  if (league === 'nba' || league === 'wnba') return HOOPS_MARKETS[k] || null;
  if (league === 'nfl') return NFL_MARKETS[k] || null;
  return null; // no DK player-prop coverage wired for this league (e.g. soccer's defensive stats)
}

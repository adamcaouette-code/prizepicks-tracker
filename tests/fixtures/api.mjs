// Response shapes copied from what the real endpoints actually return — including
// the awkward parts (PrizePicks' two different stat names, probabilities as
// decimals, web-search <cite> markup in reasoning). Tests that invent tidier data
// than production sends aren't testing much.

export const LEAGUES = { leagues: [
  { id: '2',   name: 'MLB',    tag: 'mlb',    projections: 2941, kind: 'game',   research: 'full'  },
  { id: '3',   name: 'WNBA',   tag: 'wnba',   projections: 2153, kind: 'game',   research: 'full'  },
  { id: '163', name: 'NFLSZN', tag: 'nflszn', projections: 1352, kind: 'season', research: 'props' },
  { id: '231', name: 'MLBLIVE', tag: 'mlblive', projections: 288, kind: 'live',  research: 'props' },
  { id: '158', name: 'CS2',    tag: 'cs2',    projections: 31,   kind: 'game',   research: 'props' },
]};

// stat = PrizePicks' stat_type (what the engine filters on)
// display = stat_display_name (what the card in the app shows)
export const STATS = { statTypes: [
  { stat: 'Hits+Runs+RBIs',    display: 'Hits+Runs+RBIs', count: 500 },
  { stat: 'Total Bases',       display: 'TB',             count: 460 },
  { stat: 'Hitter Strikeouts', display: 'Hitter Ks',      count: 229 },
  { stat: 'Pitcher Strikeouts', display: 'Ks',            count: 69  },
]};

export const PARSE = { ok: true,
  warnings: ['One or more lines could not be read as a number — confirm before judging.'],
  slip: { slipType: 'power', legCount: 2, league: 'mlb', matchup: 'CIN vs CWS', alreadySettled: false, legs: [
    { player: 'Elly De La Cruz', team: 'CIN', position: 'IF', number: 44, stat: 'Hitter Ks', line: 0.5,  pick: 'over', oddsType: 'goblin' },
    { player: 'Seiya Suzuki',    team: 'CHC', position: 'OF', number: 27, stat: 'Home Runs', line: null, pick: 'over', oddsType: 'demon'  },
  ]}};

export const JUDGE = { ok: true,
  legs: [
    { player: 'Elly De La Cruz', stat: 'Hitter Ks', line: 0.5, pick: 'over', oddsType: 'goblin', verdict: 'play', prob: 0.68,
      key_risk: 'A quiet 0-K game.', reasoning: 'Highest-whiff regular — <cite index="2-14">31.3 percent K rate</cite>.',
      // raw numbers re-attached from research, as judge-slip-background now returns them
      recent5: [1, 0, 2, 1, 1], recentAvg: 1.0,
      histGames: [{ v: 1, opp: 'CWS', away: false }, { v: 0, opp: 'CWS', away: false }, { v: 2, opp: 'STL', away: true },
                  { v: 1, opp: 'STL', away: true }, { v: 1, opp: 'MIL', away: false }],
      oppSP: { name: 'Garrett Crochet', throws: 'L', era: 3.02, whip: 1.07, k: 160 } },
    { player: 'Seiya Suzuki', stat: 'Home Runs', line: 0.5, pick: 'over', oddsType: 'demon', verdict: 'fade', prob: 0.34,
      key_risk: 'Single-game HR is a low base rate.', reasoning: 'Demon pricing on a longshot.' },
  ],
  slip: { weakestLeg: 'Seiya Suzuki over 0.5 HR', correlationFlag: 'Independent games.', overall: 'fade',
          overallReasoning: 'One play cannot carry a demon HR longshot on a Power play.' },
  dataStatus: { matchedLegs: 1, totalLegs: 2, leagueSupported: true, oddsStatus: 'ok', bookLineStatus: 'skipped',
                loggedForCalibration: 1, skippedNoProjection: 1,
                tierCorrections: 1,
                tierFixes: [{ player: 'Elly De La Cruz', stat: 'Hitter Ks', line: 0.5, was: 'demon', now: 'goblin' }] } };

export const BOARD = { board: [
  { player: 'Sonia Citron', team: 'WAS', matchup: 'WAS vs PDX', stat: 'FG Made', statDisplay: 'FGM', line: 5,
    pick: 'under', verdict: 'play', prob: 0.64, oddsType: 'goblin', image: null },
]};

export const LEDGER = { date: '2026-08-13', count: 3, picks: [
  { player: 'A Hitter', stat: 'Hits', line: 0.5, pick: 'over',  verdict: 'play', prob: 0.71, team: 'CIN', hit: true,  image: null },
  { player: 'B Hitter', stat: 'Runs', line: 1.5, pick: 'under', verdict: 'lean', prob: 0.60, team: 'CHC', hit: false, image: null },
  { player: 'C Hitter', stat: 'RBIs', line: 0.5, pick: 'over',  verdict: 'fade', prob: 0.41, team: 'BOS', hit: null,  image: null },
]};

/**
 * The two-step background-job dance every heavy endpoint uses: POST returns 202,
 * then the page polls -status until it reports done. Returns route handlers plus
 * a `sent` object that captures the POST body so a test can assert what the page
 * actually submitted.
 */
export function jobRoutes(name, result, { runningPolls = 1 } = {}) {
  const sent = {};
  let polls = 0;
  return {
    sent,
    [`**/api/${name}-background`]: (route, request) => {
      // Reflect the LAST post, not the union of every post. Merging made an
      // absent field indistinguishable from one carried over from an earlier
      // run, so a flag that was correctly dropped still read as set — which is
      // exactly the bug a "is this sticky?" test is trying to catch. The object
      // identity is kept because callers hold a reference to it.
      for (const k of Object.keys(sent)) delete sent[k];
      Object.assign(sent, JSON.parse(request.postData() || '{}'));
      route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    },
    [`**/api/${name}-status*`]: (route) => {
      polls++;
      const body = polls <= runningPolls
        ? { status: 'running', step: 'working', typicalMs: 280000 }
        : { status: 'done', result };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    },
  };
}

/** A tiny real PNG, for the file-upload path. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

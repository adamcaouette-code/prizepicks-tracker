// Recent form for the ESPN leagues.
//
// This closes the largest hole in the engine outside MLB, and it had been open
// the whole time without showing up as an error. `recent5` is the signal the
// judge weights most heavily, and the ONLY thing that ever supplied it for a
// non-MLB pick was attachHistory(), which reads api.prizepicks.com — the host
// behind DataDome that answers 403 to everything.
//
// So every NFL, NBA, NHL and college candidate has reached the judge with no
// recent form at all: not an error, not a warning, just a missing field. It is
// very likely why probabilities have been clustering in the low 60s.
//
// The fix needs no new source. Grading already fetches a day's box scores and
// already knows how to read any mapped stat out of them. Form is those same two
// operations pointed at earlier dates — which also means form is exactly as
// correct as grading, off one mapping verified once.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const FINAL = { status: { type: { completed: true, state: 'post' } } };
const LIVE = { status: { type: { completed: false, state: 'in' } } };

const NBA_KEYS = ['minutes', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers'];
const boxFor = (rows) => ({
  boxscore: { players: [{ statistics: [{ keys: NBA_KEYS, athletes: rows }] }] },
});
const ath = (name, pts) => ({ athlete: { displayName: name }, stats: ['30', String(pts), '5', '4', '1', '1', '2'] });

export default async function ({ t }) {
  reset();
  const mod = await loadFn('espn-grade.js');

  // Five prior game days, each with a different scoring night, plus one game
  // that is still in progress and must be ignored.
  const byEvent = {
    '101': boxFor([ath('Some Guard', 10), ath('Other Wing', 4)]),
    '102': boxFor([ath('Some Guard', 20)]),
    '103': boxFor([ath('Some Guard', 30), ath('Other Wing', 8)]),
    '104': boxFor([ath('Some Guard', 14)]),
    '105': boxFor([ath('Some Guard', 26)]),
    '999': boxFor([ath('Some Guard', 99)]),      // in progress — must never count
  };
  let rangeQueried = false;
  const mock = mockFetch([
    [/scoreboard\?dates=\d{8}-\d{8}/, async () => {
      rangeQueried = true;
      return { events: [
        { id: '101', date: '2026-09-06T20:00Z', ...FINAL },
        { id: '102', date: '2026-09-13T20:00Z', ...FINAL },
        { id: '103', date: '2026-09-20T20:00Z', ...FINAL },
        { id: '104', date: '2026-09-27T20:00Z', ...FINAL },
        { id: '105', date: '2026-10-04T20:00Z', ...FINAL },
        { id: '999', date: '2026-10-08T20:00Z', ...LIVE },
      ] };
    }],
    [/scoreboard\?dates=(\d{8})$/, async (url) => {
      const d = url.match(/dates=(\d{8})/)[1];
      const map = { '20260906': '101', '20260913': '102', '20260920': '103', '20260927': '104', '20261004': '105', '20261008': '999' };
      const id = map[d];
      return { events: id ? [{ id, date: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}T20:00Z`, ...(id === '999' ? LIVE : FINAL) }] : [] };
    }],
    [/summary\?event=(\d+)/, async (url) => byEvent[url.match(/event=(\d+)/)[1]] || { boxscore: { players: [] } }],
  ]);

  const cands = [
    { player: 'Some Guard', stat: 'Points' },
    { player: 'Other Wing', stat: 'Points' },
    { player: 'Never Played', stat: 'Points' },
    { player: 'Some Guard', stat: 'Dunks' },        // unmapped stat
  ];
  let out;
  try {
    out = await mod.attachEspnForm(cands, 'nba', { before: '2026-10-09' });
  } finally { mock.restore(); }

  t.ok('form is attached', !!out);
  t.ok('a range query finds the game days instead of walking back day by day',
    rangeQueried);

  const guard = cands[0];
  t.eq('the last five results for THAT stat are attached', guard.last5.length, 5);
  t.eq('...in chronological order, oldest first', guard.last5, [10, 20, 30, 14, 26]);
  t.eq('...with the average', guard.avg, 20);
  t.eq('...and how many games it is based on', guard.histGames, 5);
  t.ok('a game still in progress is NEVER counted as form',
    !guard.last5.includes(99), guard.last5.join(','));

  const wing = cands[1];
  t.eq('a player who appeared in only some games gets only those', wing.last5, [4, 8]);
  t.eq('...with an honest count, not padded to five', wing.histGames, 2);
  // ...and an average over the games he PLAYED. Dividing by the window instead
  // of the count reads 6 as 2.4 and quietly makes every part-time player look
  // cold — the same "absent is not a zero" rule the count above states, applied
  // to the number the judge actually anchors on.
  t.eq('...and an average over those games, not over the window', wing.avg, 6);
  t.eq('...and days he did not play are absent, NOT recorded as zero',
    wing.last5.includes(0), false);

  // ---- the day cache is a round trip, not a write into the void ----------
  // Form costs one summary call per game day per candidate slate, and the same
  // day is read again by grading and by every later run. The cache is what
  // stops that being paid twice — and a cache whose write goes nowhere is
  // indistinguishable from a working one unless a SECOND pass is made and the
  // network is counted.
  let summaries = 0;
  const cands2 = [{ player: 'Some Guard', stat: 'Points' }];
  const mock2 = mockFetch([
    [/scoreboard\?dates=\d{8}-\d{8}/, async () => ({ events: [
      { id: '101', date: '2026-09-06T20:00Z', ...FINAL },
      { id: '102', date: '2026-09-13T20:00Z', ...FINAL },
      { id: '103', date: '2026-09-20T20:00Z', ...FINAL },
      { id: '104', date: '2026-09-27T20:00Z', ...FINAL },
      { id: '105', date: '2026-10-04T20:00Z', ...FINAL },
    ] })],
    [/scoreboard\?dates=(\d{8})$/, async () => ({ events: [] })],
    [/summary\?event=(\d+)/, async (url) => { summaries++; return byEvent[url.match(/event=(\d+)/)[1]]; }],
  ]);
  try {
    await mod.attachEspnForm(cands2, 'nba', { before: '2026-10-09' });
  } finally { mock2.restore(); }
  t.eq('a second pass reads every finished day out of the cache', summaries, 0);
  t.eq('...and reconstructs the same form from it', cands2[0].last5, [10, 20, 30, 14, 26]);

  t.eq('a player who never appears gets no form rather than an empty series',
    cands[2].last5, undefined);
  t.eq('an unmapped stat gets no form — the same refusal grading makes',
    cands[3].last5, undefined);

  // ---- form must never include the slate being judged ---------------------
  // A re-run after kickoff would otherwise feed the game's own result back in
  // as "recent form" and inflate the read on the pick being made.
  reset();
  let sawWindow = null;
  const leak = mockFetch([
    [/scoreboard\?dates=(\d{8})-(\d{8})/, async (url) => {
      sawWindow = url.match(/dates=(\d{8})-(\d{8})/);
      return { events: [] };
    }],
  ]);
  try { await mod.attachEspnForm([{ player: 'X', stat: 'Points' }], 'nba', { before: '2026-10-09' }); }
  finally { leak.restore(); }
  t.ok('the form window ends strictly BEFORE the slate date',
    sawWindow && sawWindow[2] < '20261009', sawWindow && sawWindow[2]);

  // ---- the guardrails --------------------------------------------------
  reset();
  const none = mockFetch([[/./, async () => ({ events: [] })]]);
  let empty, uncovered;
  try {
    empty = await mod.attachEspnForm([{ player: 'X', stat: 'Points' }], 'nba', { before: '2026-10-09' });
    uncovered = await mod.attachEspnForm([{ player: 'X', stat: 'Kills' }], 'lol', { before: '2026-10-09' });
  } finally { none.restore(); }
  t.eq('no games in the window yields null rather than empty form', empty, null);
  t.eq('a league with no ESPN slug yields null', uncovered, null);
  t.eq('no candidates yields null', await mod.attachEspnForm([], 'nba', { before: '2026-10-09' }), null);
  t.eq('no slate date yields null', await mod.attachEspnForm([{ player: 'X', stat: 'Points' }], 'nba', {}), null);
}

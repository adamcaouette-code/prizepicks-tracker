// The Fantasy Score weight check.
//
// This endpoint returned a BLANK PAGE in production — no JSON, no error. It was
// doing one awaited network call per pick in a plain loop, which at ~400ms a
// lookup runs past the ~10s a synchronous Netlify function gets, so the platform
// killed it mid-flight with nothing in the body. A blank response is the worst
// possible failure: there is nothing to debug from.
//
// So the rule this file pins is simple: it must ALWAYS answer, and it must say
// when the answer is partial.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const fantasyPick = (i, d) => ({
  date: d, loggedAt: d + 'T18:00:00Z', league: 'mlb', source: 'board',
  projectionId: `F${i}`, player: `Hitter ${i}`, stat: 'Hitter Fantasy Score',
  line: 8.5, prob: 0.6, verdict: 'play', oddsType: 'standard',
  result: null, hit: null, gradedAt: null,
});

export default async function ({ t }) {
  reset();
  const d = day(3);
  seed('pick-log', d, Array.from({ length: 30 }, (_, i) => fantasyPick(i, d)));

  const mod = await loadFn('fantasy-check.js');

  // A slow upstream is the exact condition that killed it in production.
  const slow = (body) => async () => { await new Promise((r) => setTimeout(r, 40)); return body; };
  const mock = mockFetch([
    [/\/sports\/1\/players/, slow({ people: Array.from({ length: 30 }, (_, i) => ({ id: 700 + i, fullName: `Hitter ${i}` })) })],
    [/people\/\d+\/stats/, slow({ stats: [{ splits: [{ date: d, stat: {
      hits: 2, doubles: 1, triples: 0, homeRuns: 0, runs: 1, rbi: 1, baseOnBalls: 1 } }] }] })],
  ]);

  let res, out;
  try {
    // A budget far shorter than the work needed, so the timeout path is what runs.
    res = await mod.handler({ queryStringParameters: { budget: '60', limit: '30' } });
    out = JSON.parse(res.body);
  } finally { mock.restore(); }

  t.eq('it answers at all rather than dying with an empty body', res.statusCode, 200);
  t.ok('the body is real JSON', !!out && typeof out === 'object');
  t.ok('it finds the fantasy props in the log', out.standardTierPicksUsed >= 30);
  t.eq('...and says plainly that it ran out of budget', out.timedOut, true);
  t.ok('...with a next step rather than just a flag', /limit=|faster pass/.test(out.timeoutNote || ''));
  t.ok('it reports how many it actually attempted', typeof out.attempted === 'number' && out.attempted >= 1);
  t.ok('...and how long it took', typeof out.elapsedMs === 'number');
  t.ok('it stopped early instead of running the whole sample', out.attempted < 30, `attempted ${out.attempted}`);

  // With room to work, it resolves the sample and reaches a verdict.
  reset();
  seed('pick-log', d, Array.from({ length: 12 }, (_, i) => fantasyPick(i, d)));
  const mod2 = await loadFn('fantasy-check.js');
  const fast = mockFetch([
    [/\/sports\/1\/players/, async () => ({ people: Array.from({ length: 12 }, (_, i) => ({ id: 700 + i, fullName: `Hitter ${i}` })) })],
    [/people\/\d+\/stats/, async () => ({ stats: [{ splits: [{ date: d, stat: {
      hits: 2, doubles: 1, triples: 0, homeRuns: 0, runs: 1, rbi: 1, baseOnBalls: 1 } }] }] })],
  ]);
  let full;
  try { full = JSON.parse((await mod2.handler({ queryStringParameters: {} })).body); } finally { fast.restore(); }

  t.eq('a sample that fits does not report a timeout', full.timedOut, false);
  t.ok('every pick was attempted', full.attempted >= 12, `attempted ${full.attempted}`);
  const v = full.verdicts?.['mlb-hitter'];
  t.ok('the MLB hitter formula produces a verdict', !!v);
  t.ok('...with a median computed score', typeof v.medianComputed === 'number');
  t.ok('...compared against the median line', typeof v.medianLine === 'number');
  t.ok('...as a ratio, which is what names the error', typeof v.lineRatio === 'number');
  t.eq('MLB stays gated regardless of what the check finds', full.mlbCurrentlyEnabled, false);
  t.ok('the weights it used are shown, so a wrong one can be corrected',
    !!full.weightsInUse?.mlbHitter?.singles);

  // The cached-Map regression that broke this endpoint in production: the second
  // MLB lookup read a serialized index back and threw. Twelve picks means the
  // cache is exercised many times over.
  t.ok('repeated MLB lookups survive the cache round trip', full.attempted >= 12 && !full.error);

  // ---- the two flaws the first real run exposed ---------------------------
  // 1. TIER MIXING. A goblin line is set below the median outcome by design and
  //    a demon above it, so mixing tiers makes the median line meaningless. The
  //    first live run had four of eight hitter lines at 3.5 or under and
  //    manufactured a 2.35x "weight error" that was really just tier mix.
  reset();
  const mixed = [];
  for (let i = 0; i < 6; i++) mixed.push({ ...fantasyPick(i, d), oddsType: 'standard', line: 8.5 });
  for (let i = 6; i < 14; i++) mixed.push({ ...fantasyPick(i, d), oddsType: 'goblin', line: 2.5 });
  seed('pick-log', d, mixed);
  const mod3 = await loadFn('fantasy-check.js');
  const tierMock = mockFetch([
    [/\/sports\/1\/players/, async () => ({ people: Array.from({ length: 14 }, (_, i) => ({ id: 700 + i, fullName: `Hitter ${i}` })) })],
    [/people\/\d+\/stats/, async () => ({ stats: [{ splits: [{ date: d, stat: {
      hits: 2, doubles: 1, triples: 0, homeRuns: 0, runs: 1, rbi: 1, baseOnBalls: 1 } }] }] })],
  ]);
  let tiered;
  try { tiered = JSON.parse((await mod3.handler({ queryStringParameters: {} })).body); } finally { tierMock.restore(); }

  t.eq('goblin picks are excluded from the ratio', tiered.standardTierPicksUsed, 6);
  t.ok('...but every tier is still counted so the exclusion is visible',
    tiered.allTiersInLog.goblin === 8 && tiered.allTiersInLog.standard === 6);
  t.eq('...so the median line is the STANDARD line, not dragged down by goblins',
    tiered.verdicts?.['mlb-hitter']?.medianLine, 8.5);

  // 2. SELECTION BIAS. The log holds props the engine CHOSE, mostly overs it
  //    liked, so outcomes beat lines even with perfect weights. Basketball is
  //    the control: its weights are standard, so its ratio IS the bias floor.
  reset();
  const bball = (i) => ({ ...fantasyPick(i, d), league: 'wnba', stat: 'Fantasy Score', oddsType: 'standard', line: 30, player: `Wing ${i}` });
  const both = [...Array.from({ length: 10 }, (_, i) => bball(i)),
                ...Array.from({ length: 10 }, (_, i) => ({ ...fantasyPick(100 + i, d), oddsType: 'standard', line: 8.5 }))];
  seed('pick-log', d, both);
  const mod4 = await loadFn('fantasy-check.js');
  const NBA_KEYS = ['minutes', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers'];
  const ctlMock = mockFetch([
    [/scoreboard/, async () => ({ events: [{ id: '9', date: d + 'T23:00Z', status: { type: { completed: true, state: 'post' } } }] })],
    [/summary/, async () => ({ boxscore: { players: [{ statistics: [{ keys: NBA_KEYS,
      athletes: Array.from({ length: 10 }, (_, i) => ({ athlete: { displayName: `Wing ${i}` }, stats: ['30', '30', '5', '4', '1', '1', '2'] })) }] }] } })],
    [/\/sports\/1\/players/, async () => ({ people: Array.from({ length: 10 }, (_, i) => ({ id: 800 + i, fullName: `Hitter ${100 + i}` })) })],
    [/people\/\d+\/stats/, async () => ({ stats: [{ splits: [{ date: d, stat: {
      hits: 2, doubles: 1, triples: 0, homeRuns: 0, runs: 1, rbi: 1, baseOnBalls: 1 } }] }] })],
  ]);
  let ctl;
  try { ctl = JSON.parse((await mod4.handler({ queryStringParameters: {} })).body); } finally { ctlMock.restore(); }

  t.ok('basketball resolves as the control', ctl.verdicts?.basketball?.n >= 8);
  t.ok('...and is labelled as a control rather than judged',
    /CONTROL/.test(ctl.verdicts.basketball.verdict), ctl.verdicts.basketball.verdict);
  t.ok('...with its ratio published as the baseline', typeof ctl.controlRatio === 'number');
  t.ok('an MLB verdict is measured RELATIVE to the control, not against 1.0',
    typeof ctl.verdicts?.['mlb-hitter']?.vsControl === 'number',
    JSON.stringify(ctl.verdicts?.['mlb-hitter']));
  t.ok('the method states both corrections so the number is not read naively',
    /goblin/.test(ctl.method) && /selection bias|only logs props it liked/.test(ctl.method));
}

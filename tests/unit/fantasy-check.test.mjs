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
  t.ok('it finds the fantasy props in the log', out.fantasyPicksInLog >= 30);
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
}

// The Full Sweep report: same coverage/edge/slip data the old label/value
// table and wide league table rendered, restructured to lead with the answer
// (how many cleared, out of how many) instead of burying it in a table row,
// show the edge distribution as a histogram instead of a text list, and
// collapse every league sharing one unscorable/no-slate/fetch-failed reason
// into a single row instead of repeating the same sentence per league.
//
// Display only — this drives the real /api/sweep-background job and renders
// whatever coverage report comes back; nothing here touches sweep selection,
// the edge gate, or thresholds.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

// Matches the task's own worked example (23 of 354 cleared) so the headline
// format is checked against a real, specific number rather than a round one.
const RESULT = {
  sweep: true,
  summary: 'Swept 354 props across 6 leagues, 4 slates. 23 cleared the gate but the pool built a 3-leg slip.',
  sweptN: 354,
  coverage: {
    leaguesRequested: 6, leaguesCovered: 4, slatesCovered: 4,
    propsEvaluated: 354, propsJudged: 340,
    slates: [
      { league: 'mlb', date: '2026-09-11', usedNext: false, props: 210, empty: false, status: 'covered', note: null },
      { league: 'wnba', date: '2026-09-11', usedNext: false, props: 74, empty: false, status: 'covered', note: null },
      // Two leagues sharing the identical "no grading map" reason — must
      // collapse into ONE row, with the standing sentence stated once.
      { league: 'nflszn', date: '2026-09-11', usedNext: false, props: 0, empty: true, status: 'no-match',
        note: '823 NFLSZN prop(s) today in the tiers you selected, but none of their stat types are mapped for grading yet. This league isn’t supported for scoring — no tier or prop-filter change will fix that.' },
      { league: 'mlblive', date: '2026-09-11', usedNext: false, props: 0, empty: true, status: 'no-match',
        note: '265 MLBLIVE prop(s) today in the tiers you selected, but none of their stat types are mapped for grading yet. This league isn’t supported for scoring — no tier or prop-filter change will fix that.' },
      // A league that answered fine with nothing posted.
      { league: 'cbb', date: null, usedNext: false, props: 0, empty: true, status: 'no-slate', note: 'no slate' },
      // A league PrizePicks never actually answered for.
      { league: 'nba', date: null, usedNext: false, props: 0, empty: true, status: 'fetch-failed', note: 'fetch failed: 429 rate limited' },
    ],
  },
  edge: {
    n: 113, unpriced: 5, min: -0.244, median: -0.031, max: 0.082,
    buckets: { belowMinus10: 40, minus10toMinus5: 30, minus5toZero: 20, zeroToPlus5: 15, plus5AndUp: 8 },
  },
  cleared: { edgeGE0: 18, gate: 23 },
  cost: { estimatedUsd: 4.2, actualUsd: 3.85, capUsd: 6, cappedEarly: false },
  parlay: { entry: 'power' },
  parlayLegs: [
    { player: 'Al Slugger', stat: 'Hits', statDisplay: 'Hits', pick: 'over', line: 1.5, league: 'mlb', edge: 0.082 },
    { player: 'Bo Guard', stat: 'Points', statDisplay: 'Points', pick: 'over', line: 9.5, league: 'wnba', edge: 0.061 },
    { player: 'Cy Pitcher', stat: 'Ks', statDisplay: 'Ks', pick: 'over', line: 5.5, league: 'mlb', edge: 0.044 },
  ],
  parlayNote: { requested: 3, built: 3, sweptN: 354 },
  board: [],
  errors: {},
  params: { legs: 3 },
};

async function runSweep(browser, url, result) {
  const app = await openApp(browser, {
    url, timezoneId: 'America/New_York', locale: 'en-US',
    routes: { '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('sweep', result) },
  });
  await app.page.click('#tabBtnSearch');
  await app.page.waitForSelector('#sweepBtn');
  await app.page.click('#sweepBtn');
  await app.page.waitForSelector('#searchResults .swhead', { timeout: 30000 });
  return app;
}

export default async function ({ t, url, browser }) {
  const { page, errors, unstubbed } = await runSweep(browser, url, RESULT);

  // ---- 1. lead with the answer --------------------------------------------
  t.eq('the headline is the count that cleared out of everything evaluated',
    await page.textContent('#searchResults .swhead'), '23 of 354 cleared');
  const ctx = await page.textContent('#searchResults .swctx');
  t.ok('context names the best edge', /best edge/.test(ctx) && /\+0\.082/.test(ctx), ctx);
  t.ok('...the median edge', /median/.test(ctx) && /-0\.031/.test(ctx), ctx);
  t.ok('...and whether a slip was built', /3-leg slip built/.test(ctx), ctx);
  const sliplegs = await page.$$eval('#searchResults .leg, #searchResults ul li', (els) => els.length);
  t.ok('the slip the sweep built is shown as an action, not buried in a table',
    (await page.textContent('#searchResults')).includes('Al Slugger'));

  // Provenance (props judged / sweptN / cost / leagues / slates) moved OFF
  // the headline area and into a run footer at the bottom.
  const footer = await page.textContent('#searchResults .swfoot');
  t.ok('the run footer carries sweptN', /swept/.test(footer) && /354/.test(footer), footer);
  t.ok('...and props judged', /props judged/.test(footer) && /340/.test(footer), footer);
  t.ok('...and cost', /cost/.test(footer) && /\$3\.85/.test(footer), footer);
  t.ok('...and leagues covered', /4\/6/.test(footer), footer);
  t.ok('...and slates', /4/.test(footer) && /slates/.test(footer), footer);

  // ---- 2. edge distribution as a histogram, matching the real buckets -----
  const bars = await page.$$eval('#searchResults .swbarcol', (cols) => cols.map((c) => ({
    count: Number(c.querySelector('.swbarcount').textContent.trim()),
    cls: c.querySelector('.swbar').classList.contains('neg') ? 'neg' : 'pos',
    height: parseFloat(c.querySelector('.swbar').style.height),
  })));
  t.eq('five bars, one per bucket', bars.length, 5);
  t.eq('the bucket counts match the underlying distribution, in order',
    bars.map((b) => b.count), [40, 30, 20, 15, 8]);
  t.eq('the three negative buckets use the red token', bars.slice(0, 3).map((b) => b.cls), ['neg', 'neg', 'neg']);
  t.eq('the two non-negative buckets use the green token', bars.slice(3).map((b) => b.cls), ['pos', 'pos']);
  t.ok('bar height scales with count (the largest bucket has the tallest bar)',
    bars[0].height > bars[4].height, JSON.stringify(bars));
  t.eq('a vertical rule marks the zero boundary, between the last negative and first non-negative bucket',
    await page.$$eval('#searchResults .swhist > *', (els) => els.map((e) => e.className)),
    ['swbarcol', 'swbarcol', 'swbarcol', 'swzeroline', 'swbarcol', 'swbarcol']);

  // ---- 3. coverage: compact per-league rows + grouped unscorable reasons --
  const covRows = await page.$$eval('#searchResults .swcovrow', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  t.eq('one compact row per covered league', covRows.length, 2);
  t.ok('mlb names its slate and count', covRows.some((r) => /mlb/.test(r) && /210 props/.test(r)), covRows.join(' | '));
  t.ok('wnba too', covRows.some((r) => /wnba/.test(r) && /74 props/.test(r)), covRows.join(' | '));

  const groups = await page.$$eval('#searchResults .swgroup', (els) => els.map((e) => ({
    row: e.querySelector('.swgrouprow').textContent.replace(/\s+/g, ' ').trim(),
    note: e.querySelector('.swgroupnote') ? e.querySelector('.swgroupnote').textContent.trim() : null,
  })));
  t.eq('three grouped rows: unscorable, no-slate, fetch-failed', groups.length, 3);

  const notGradeable = groups.find((g) => /no graders wired/.test(g.row));
  t.ok('nflszn and mlblive, sharing the identical unscorable reason, collapse into ONE row',
    !!notGradeable && /nflszn/.test(notGradeable.row) && /mlblive/.test(notGradeable.row), JSON.stringify(notGradeable));
  t.ok('...summing their props into one combined count',
    notGradeable && /1,?088 props|1088 props/.test(notGradeable.row), notGradeable && notGradeable.row);
  t.ok('the honest wording survives, unsoftened',
    notGradeable && /no tier or prop-filter change will fix that/.test(notGradeable.note), notGradeable && notGradeable.note);
  t.ok('...but stated ONCE for the group, not once per league',
    notGradeable && (notGradeable.note.match(/no tier or prop-filter change will fix that/g) || []).length === 1,
    notGradeable && notGradeable.note);
  t.eq('the group carries no per-league repeat of the note text on the row line itself',
    notGradeable && /prop-filter/.test(notGradeable.row), false);

  const noSlate = groups.find((g) => /no slate today/.test(g.row));
  t.ok('cbb groups under "no slate today"', !!noSlate && /cbb/.test(noSlate.row), JSON.stringify(noSlate));

  const fetchFailed = groups.find((g) => /fetch failed/.test(g.row));
  t.ok('nba groups under "fetch failed", flagged in the red token', !!fetchFailed && /nba/.test(fetchFailed.row), JSON.stringify(fetchFailed));
  const fetchFailedCls = await page.$$eval('#searchResults .swgroup', (els) =>
    els.map((e) => e.querySelector('.gtag').className));
  t.ok('...its tag carries the red-flagged class', fetchFailedCls.some((c) => /\bbad\b/.test(c)), JSON.stringify(fetchFailedCls));

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- "nothing cleared" — the other artboard ------------------------------
  const NOTHING = {
    ...RESULT,
    summary: 'Swept 200 props across 3 leagues, 2 slates. Nothing cleared.',
    sweptN: 200,
    coverage: { ...RESULT.coverage, propsEvaluated: 200, propsJudged: 190, slates: RESULT.coverage.slates.slice(0, 2) },
    cleared: { edgeGE0: 0, gate: 0 },
    edge: { n: 190, unpriced: 0, min: -0.31, median: -0.14, max: -0.02,
      buckets: { belowMinus10: 120, minus10toMinus5: 50, minus5toZero: 20, zeroToPlus5: 0, plus5AndUp: 0 } },
    parlay: null, parlayLegs: [], parlayNote: null,
  };
  const nothing = await runSweep(browser, url, NOTHING);
  t.eq('nothing cleared still leads with the answer, not silence',
    await nothing.page.textContent('#searchResults .swhead'), '0 of 200 cleared');
  const nothingCtx = await nothing.page.textContent('#searchResults .swctx');
  t.ok('no slip built is stated plainly', /no slip built/.test(nothingCtx), nothingCtx);
  t.eq('no slip list renders when nothing cleared', await nothing.page.$$eval('#searchResults ul', (u) => u.length), 0);
  const nothingFooter = await nothing.page.textContent('#searchResults .swfoot');
  t.ok('the run footer still carries sweptN even with nothing cleared', /200/.test(nothingFooter), nothingFooter);
  t.eq('no JS errors (nothing cleared)', nothing.errors, []);
  await nothing.page.close();
}

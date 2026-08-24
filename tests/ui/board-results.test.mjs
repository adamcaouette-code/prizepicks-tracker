// The board a Find Bets run renders: verdict styling, the per-pick "why" toggle,
// and the game start time.
//
// The board is the app's main output, and its failure modes are quiet ones — a
// board-mode "pass" arriving unstyled, citation markup from the judge's web
// search rendering literally, a prose panel forcing the page to scroll sideways
// on a phone, or a start time silently shown in the wrong timezone.

import { openApp, freezeClock } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

// One fixed slate, seen by viewers in two timezones. Times are instants with the
// game's local offset, exactly as PrizePicks stamps them.
const TONIGHT_ET = '2026-08-14T19:30:00.000-04:00';
const LATE_PT = '2026-08-14T22:15:00.000-07:00';   // 1:15am ET tomorrow

const RESULT = { board: [
  { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'goblin', image: null, start: TONIGHT_ET,
    key_risk: 'Facing a lefty.', reasoning: 'Cleared this line in 4 of the last 5 — <cite index="1-2">.312 average</cite>.',
    // raw numbers, shaped exactly as attachHistory/attachStarters attach them
    recent5: [1, 0, 2, 1, 1], recentAvg: 1.0,
    histGames: [
      { v: 1, opp: 'PIT', away: false }, { v: 0, opp: 'PIT', away: false }, { v: 2, opp: 'STL', away: true },
      { v: 1, opp: 'STL', away: true }, { v: 1, opp: 'MIL', away: false },
    ],
    oppSP: { name: 'Paul Skenes', throws: 'R', era: 2.14, whip: 0.95, k: 189 }, parkIndex: 104 },
  { player: 'Corbin Carroll', team: 'ARI', matchup: 'ARI vs SD', stat: 'Total Bases', line: 1.5, pick: 'over',
    verdict: 'pass', prob: 0.48, oddsType: 'standard', image: null, start: LATE_PT,
    key_risk: 'none', reasoning: 'Line sits above his median; no edge here.' },
  { player: 'No Extras Guy', team: 'BOS', matchup: 'BOS vs NYY', stat: 'Hits', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.60, oddsType: 'standard', image: null },              // no start, no reasoning
  { player: 'Junk Time Guy', team: 'LAD', matchup: 'LAD vs SF', stat: 'Hits', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.60, oddsType: 'standard', image: null, start: 'not-a-date',
    key_risk: 'r', reasoning: 'x' },
], teamRecords: { CIN: '61-59' }, winProbs: { CIN: 0.55 },
  timing: { totalMs: 41200, rows: 2941, candidates: 44,
    pieces: { props: 8100, judge: 26400, history: 5200, starters: 3100, records: 900, odds: 700, defense: 10 },
    phases: [{ phase: 'pulling props', ms: 8200 }, { phase: 'gathering data', ms: 5400 }] },
  params: { league: 'mlb', legs: 3, tiers: ['goblin', 'standard'] },
  oddsStatus: { status: 'ok', message: 'Win% loaded for 30 team(s).' } };

async function renderBoard(browser, url, timezoneId) {
  const app = await openApp(browser, {
    url, timezoneId, locale: 'en-US',
    // Freeze "today" so the rolls-into-tomorrow branch is deterministic.
    init: freezeClock('2026-08-14T20:00:00.000-04:00'),
    routes: { '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('bet-finder', RESULT) },
  });
  await app.page.click('#tabBtnSearch');
  await app.page.waitForSelector('#runBtn');
  await app.page.click('#runBtn');
  await app.page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  return app;
}

export default async function ({ t, url, browser }) {
  const { page, errors, unstubbed } = await renderBoard(browser, url, 'America/New_York');

  const names = () => page.$$eval('#searchResults .leg .name', els => els.map(e => e.textContent.trim()));
  const gtimes = () => page.$$eval('#searchResults .leg .team',
    els => els.map(e => { const s = e.querySelector('.gtime'); return s ? s.textContent.trim() : null; }));
  // Rows are addressed by PLAYER NAME, never by position. The default sort is
  // the board's ranking, so any change to how it ranks reshuffles every row —
  // and a position-indexed assertion then quietly starts testing a different
  // player instead of failing. That is how a real ranking bug survived here.
  const rowAt = async (name) => (await names()).indexOf(name);

  // ---- rows, default sort (edge), verdict styling -------------------------
  t.eq('every pick renders a row', await page.$$eval('#searchResults .leg', l => l.length), 4);
  // EDGE means probability MINUS the tier's break-even, not probability. Elly is
  // the highest-probability pick on the board at 68%, but she is a goblin: 2.0x
  // on a 3-pick Power needs 79.4% a leg, so she is -11.4pp and ranks below two
  // 60% standards that only need 59.5%. Sorting on raw probability under an
  // "EDGE %" label floated the worst-paying tier to the top of every board.
  t.eq('default order is edge over break-even, not raw probability',
    await names(), ['No Extras Guy', 'Junk Time Guy', 'Elly De La Cruz', 'Corbin Carroll']);
  // The EDGE % sort ranks on a number the board never showed: edgeHtml was
  // built and then dropped on the floor, never inserted into the row markup. So
  // the sort was correct and looked broken — a 65% ahead of an 80% with nothing
  // on screen explaining why.
  const edges = await page.$$eval('#searchResults .edgeval', els => els.map(e => e.textContent.trim()));
  t.eq('every row shows the number it is ranked by', edges.length, 4);
  t.ok('...as points against break-even, not a repeat of the percentage',
    edges.every((e) => /pp$|price \?/.test(e)), edges.join(' | '));
  t.eq('the goblin at 68% is shown as barely above water', edges[2], '-11.4pp');

  const pct = await page.$$eval('#searchResults .pct', els => els.map(e => e.className));
  t.eq('board-mode "pass" is styled as fade, not left bare', pct[await rowAt('Corbin Carroll')], 'pct fade');
  t.ok('probabilities render as percentages', /68%/.test(await page.textContent('#searchResults')));

  // ---- sort control -------------------------------------------------------
  const sortBtns = await page.$$eval('#searchResults .sortbtn',
    els => els.map(e => ({ label: e.textContent.trim(), sort: e.dataset.sort, active: e.classList.contains('active') })));
  t.eq('three sorts offered, edge active by default',
    sortBtns, [{ label: 'EDGE %', sort: 'edge', active: true }, { label: 'TEAM', sort: 'team', active: false }, { label: 'TIME', sort: 'time', active: false }]);

  await page.click('#searchResults .sortbtn[data-sort="team"]');
  t.eq('team sort is alphabetical by team (ARI, BOS, CIN, LAD)',
    await names(), ['Corbin Carroll', 'No Extras Guy', 'Elly De La Cruz', 'Junk Time Guy']);

  await page.click('#searchResults .sortbtn[data-sort="time"]');
  t.eq('time sort is soonest first, unknown times sink to the bottom',
    await names(), ['Elly De La Cruz', 'Corbin Carroll', 'No Extras Guy', 'Junk Time Guy']);

  await page.click('#searchResults .sortbtn[data-sort="edge"]');
  t.eq('edge sort restores the edge order', await names(),
    ['No Extras Guy', 'Junk Time Guy', 'Elly De La Cruz', 'Corbin Carroll']);

  // ---- game start time, viewer-local -------------------------------------
  const times = await gtimes();
  t.eq('tonight game shows local time (ET viewer)', times[await rowAt('Elly De La Cruz')], '7:30 PM');
  t.eq('late west-coast game rolls to tomorrow for an ET viewer', times[await rowAt('Corbin Carroll')], 'Sat 1:15 AM');
  t.eq('missing start_time renders no chip at all', times[await rowAt('No Extras Guy')], null);
  t.eq('unparseable start_time renders no chip at all', times[await rowAt('Junk Time Guy')], null);
  const dotIsCss = await page.$eval('#searchResults .gtime',
    el => getComputedStyle(el, '::before').content.includes('·'));
  t.ok('separator is CSS decoration, not DOM text', dotIsCss);

  // ---- the "stats" panel: raw numbers, never the judge --------------------
  const statsBtns = await page.$$('#searchResults .whybtn[data-panel="stats"]');
  t.eq('a stats button only where raw numbers arrived', statsBtns.length, 1);
  await statsBtns[0].click();
  await page.waitForFunction(() => !document.querySelector('#searchResults .why[data-panel="stats"]').hidden);
  const cellCls = await page.$$eval('#searchResults .why[data-panel="stats"] .g5cell', els => els.map(e => e.className));
  t.eq('five last-5 cells, colored by beating THIS line (0.5)',
    cellCls, ['g5cell over', 'g5cell under', 'g5cell over', 'g5cell over', 'g5cell over']);
  const sPanel = await page.$eval('#searchResults .why[data-panel="stats"]', e => e.innerText.replace(/\s+/g, ' '));
  t.ok('summary counts the games over the line', /4\/5 over 0\.5/.test(sPanel), sPanel.slice(0, 80));
  t.ok('average shown', /avg 1/.test(sPanel));
  t.ok('opponents ride along per game', /@STL/.test(sPanel) && /vs PIT/.test(sPanel));
  t.ok('opposing starter season line from ESPN', /Skenes.*ERA 2\.14.*WHIP 0\.95.*K 189/.test(sPanel), sPanel);
  t.ok('team record + win% + park context', /61-59/.test(sPanel) && /55%/.test(sPanel) && /104/.test(sPanel));
  t.ok('sources are named, so it reads as data not judgement', /PRIZEPICKS/.test(sPanel) && /ESPN/.test(sPanel));
  await statsBtns[0].click();
  await page.waitForFunction(() => document.querySelector('#searchResults .why[data-panel="stats"]').hidden);

  // ---- the "why" toggle ---------------------------------------------------
  const whyBtns = await page.$$('#searchResults .whybtn[data-panel="why"]');
  // Which rows carry a why button, by name — the citation-stripping check below
  // needs Elly's panel specifically, and she is no longer the first of them.
  const whyOwners = await page.$$eval('#searchResults .leg', legs => legs
    .filter(l => l.querySelector('.whybtn[data-panel="why"]'))
    .map(l => l.querySelector('.name').textContent.trim()));
  t.eq('a why button only where the judge gave reasoning', whyBtns.length, 3);
  t.eq('panels start collapsed', await page.$$eval('#searchResults .why[data-panel="why"]', w => w.map(x => x.hidden)), [true, true, true]);

  const ellyAt = whyOwners.indexOf('Elly De La Cruz');
  const ellyWhy = whyBtns[ellyAt];
  await ellyWhy.click();
  await page.waitForFunction(() => [...document.querySelectorAll('#searchResults .why[data-panel="why"]')].some(w => !w.hidden));
  t.eq('button flips open', (await ellyWhy.textContent()).trim(), 'why ↑');
  t.eq('aria-expanded tracks it', await ellyWhy.getAttribute('aria-expanded'), 'true');
  const panel = await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) => w[i].innerText, ellyAt);
  t.ok('citation markup is stripped', !/<cite|cite index/.test(panel), panel.slice(0, 60));
  t.ok('the reasoning text survives', /4 of the last 5/.test(panel));
  t.eq('other why panels stay closed',
    await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) => w.filter((_, j) => j !== i).map(x => x.hidden), ellyAt),
    [true, true]);

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  t.ok('no sideways scroll with a panel open (430px viewport)', width <= 430, `scrollWidth ${width}`);

  await ellyWhy.click();
  await page.waitForFunction(() => [...document.querySelectorAll('#searchResults .why[data-panel="why"]')].every(w => w.hidden));
  t.ok('toggles closed again', true);

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- a real phone is narrower than the design frame ---------------------
  // The imported design hardcoded a 460px frame; iPhones are 390-430 CSS px.
  // The frame must be fluid below 460 or every phone pans sideways forever.
  const phone = await openApp(browser, {
    url, viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York', locale: 'en-US',
    init: freezeClock('2026-08-14T20:00:00.000-04:00'),
    routes: { '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('bet-finder', RESULT) },
  });
  const w390 = await phone.page.evaluate(() => document.documentElement.scrollWidth);
  t.ok('no sideways scroll at iPhone width (390px)', w390 <= 390, `scrollWidth ${w390}`);
  await phone.page.close();

  // ---- same slate, west-coast viewer --------------------------------------
  const west = await renderBoard(browser, url, 'America/Los_Angeles');
  const wrow = await west.page.$$eval('#searchResults .leg', legs => Object.fromEntries(legs.map(l => {
    const s = l.querySelector('.team .gtime');
    return [l.querySelector('.name').textContent.trim(), s ? s.textContent.trim() : null];
  })));
  t.eq('same game, PT viewer: 7:30 ET reads 4:30 PM', wrow['Elly De La Cruz'], '4:30 PM');
  t.eq('the late PT game is still today out west — no weekday prefix', wrow['Corbin Carroll'], '10:15 PM');
  t.eq('no JS errors (PT viewer)', west.errors, []);
  await west.page.close();
}

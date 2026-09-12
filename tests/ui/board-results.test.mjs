// The board a Find Bets run renders: the edge meter, the recent-5 sparkline,
// inline key_risk, the per-pick "why" panel (audit strip, first pass vs deep
// dive, provenance, ask thread), and the game start time.
//
// The board is the app's main output, and its failure modes are quiet ones — a
// probability shown without its tier's own break-even, citation markup from
// the judge's web search rendering literally, a prose panel forcing the page
// to scroll sideways on a phone, a negative-edge leg still one tap from a
// slip, or a start time silently shown in the wrong timezone.

import { openApp, freezeClock } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

// One fixed slate, seen by viewers in two timezones. Times are instants with the
// game's local offset, exactly as PrizePicks stamps them.
const TONIGHT_ET = '2026-08-14T19:30:00.000-04:00';
const LATE_PT = '2026-08-14T22:15:00.000-07:00';   // 1:15am ET tomorrow

const RESULT = { board: [
  { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'goblin', image: null, start: TONIGHT_ET, deepDive: true,
    shallowProb: 0.62,
    key_risk: 'Facing a lefty.', reasoning: 'Cleared this line in 4 of the last 5 — <cite index="1-2">.312 average</cite>.',
    // raw numbers, shaped exactly as attachHistory/attachStarters attach them
    recent5: [1, 0, 2, 1, 1], recentAvg: 1.0,
    // ground truth here is 4/5 (only the 0 misses), so this claim of 4 AGREES
    cleared: 4, lineMatched: true, tierKnown: true, sidePriceUnverified: false,
    promptVersion: 'aphrodite', judgeModel: 'claude-opus-4', maxSearches: 3,
    judgedAt: '2026-08-14T19:00:00.000Z',
    histGames: [
      { v: 1, opp: 'PIT', away: false }, { v: 0, opp: 'PIT', away: false }, { v: 2, opp: 'STL', away: true },
      { v: 1, opp: 'STL', away: true }, { v: 1, opp: 'MIL', away: false },
    ],
    oppSP: { name: 'Paul Skenes', throws: 'R', era: 2.14, whip: 0.95, k: 189 }, parkIndex: 104 },
  { player: 'Corbin Carroll', team: 'ARI', matchup: 'ARI vs SD', stat: 'Total Bases', line: 1.5, pick: 'over',
    verdict: 'pass', prob: 0.48, oddsType: 'standard', image: null, start: LATE_PT,
    key_risk: 'none', reasoning: 'Line sits above his median; no edge here.',
    // the judge's own claim (5) disagrees with the data below (recent5 clears twice) —
    // this is the audit-strip mismatch case
    cleared: 5, recent5: [1, 2, 0, 1, 2], lineMatched: true, tierKnown: true, sidePriceUnverified: false },
  { player: 'No Extras Guy', team: 'BOS', matchup: 'BOS vs NYY', stat: 'Hits', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.60, oddsType: 'standard', image: null },              // no start, no reasoning, no audit fields
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

  // ---- rows, default sort (edge) -------------------------------------------
  t.eq('every pick renders a row', await page.$$eval('#searchResults .leg', l => l.length), 4);
  // EDGE means probability MINUS the tier's break-even, not probability. Elly is
  // the highest-probability pick on the board at 68%, but she is a goblin: 2.0x
  // on a 3-pick Power needs 79.4% a leg, so she is -11.4pp and ranks below two
  // 60% standards that only need 59.5%. Sorting on raw probability under an
  // "EDGE %" label floated the worst-paying tier to the top of every board.
  t.eq('default order is edge over break-even, not raw probability',
    await names(), ['No Extras Guy', 'Junk Time Guy', 'Elly De La Cruz', 'Corbin Carroll']);
  const ellyAt0 = await rowAt('Elly De La Cruz');
  const carrollAt0 = await rowAt('Corbin Carroll');
  const noExtrasAt0 = await rowAt('No Extras Guy');

  const edges = await page.$$eval('#searchResults .edgebig', els => els.map(e => e.textContent.trim()));
  t.eq('every row shows the big edge number it is ranked by', edges.length, 4);
  t.ok('...as points against break-even, not a repeat of the percentage',
    edges.every((e) => /pp$|price \?/.test(e)), edges.join(' | '));
  t.eq('the goblin at 68% is shown as barely above water', edges[ellyAt0], '-11.4pp');

  // ---- edge meter: tick at THIS row's own break-even, colored by comparison
  // to it — never by the flat verdict cutoff (see edgeVerdictFor) -----------
  const meters = await page.$$eval('#searchResults .leg', legs => legs.map(l => {
    const tick = l.querySelector('.etick');
    const fill = l.querySelector('.efill');
    const pct = l.querySelector('.pct');
    const needs = l.querySelector('.needs');
    return {
      tickLeft: tick ? tick.style.left : null,
      fillCls: fill ? fill.className : null,
      pctCls: pct ? pct.className : null,
      pctText: pct ? pct.textContent.trim() : null,
      needsText: needs ? needs.textContent.trim() : null,
    };
  }));
  t.eq('the goblin meter ticks at the GOBLIN break-even (79.4%)', meters[ellyAt0].tickLeft, '79.4%');
  t.eq('a standard meter ticks at the STANDARD break-even (59.5%)', meters[carrollAt0].tickLeft, '59.5%');
  t.eq('...same break-even for every standard row, not per-row guessed', meters[noExtrasAt0].tickLeft, '59.5%');
  t.eq('the goblin at 68% reads short of its own tick, in red', meters[ellyAt0].fillCls, 'efill short');
  t.eq('...and the number itself is styled the same way', meters[ellyAt0].pctCls, 'pct short');
  t.eq('a 60% standard clears its own (lower) bar, in green', meters[noExtrasAt0].fillCls, 'efill over');
  t.eq('the goblin needs line names its own bar', meters[ellyAt0].needsText, 'needs 79.4%');
  t.eq('the standard needs a different, lower bar', meters[noExtrasAt0].needsText, 'needs 59.5%');
  t.ok('probabilities render as percentages', /68%/.test(await page.textContent('#searchResults')));

  // ---- tier badge ----------------------------------------------------------
  const tierBadges = await page.$$eval('#searchResults .leg .tierbadge', els => els.map(e => e.textContent.trim()));
  t.eq('every row carries a tier badge', tierBadges[ellyAt0], 'GOBLIN');
  t.eq('...naming standard too', tierBadges[carrollAt0], 'STANDARD');

  // ---- deep dive badge + shallow -> deep shift -----------------------------
  const deepBadges = await page.$$eval('#searchResults .leg', (els) => els.map((e) => !!e.querySelector('.deepbadge')));
  t.eq('the deep-dived pick carries the badge', deepBadges[ellyAt0], true);
  t.ok('nobody else does', deepBadges.filter(Boolean).length === 1, JSON.stringify(deepBadges));
  const shift = await page.$eval('#searchResults .leg .deepshift', e => e.textContent.trim());
  t.eq('the shallow -> deep probability shift is shown on the row', shift, '62% → 68%');
  const noShift = await page.$$eval('#searchResults .leg', (els) => els.map((e) => !!e.querySelector('.deepshift')));
  t.eq('...only on the deep-dived pick', noShift.filter(Boolean).length, 1);

  // ---- recent-5 sparkline, always visible, no tap required -----------------
  const sparkSums = await page.$$eval('#searchResults .leg', els => els.map(e => {
    const s = e.querySelector('.sparksum');
    return s ? s.textContent.trim() : null;
  }));
  t.eq('Elly’s sparkline summarizes 4 of 5 clearing her own line', sparkSums[ellyAt0], '4/5 cleared · avg 1');
  const ellyBars = await page.$$eval('#searchResults .leg', (els, i) =>
    [...els[i].querySelectorAll('.sparkbar')].map(b => b.classList.contains('over')), ellyAt0);
  t.eq('bars above the line are highlighted, in the same order as recent5',
    ellyBars, [true, false, true, true, true]);
  t.eq('a row with no recent5 renders no sparkline', sparkSums[noExtrasAt0], null);

  // ---- key_risk inline on the row, no longer only reachable by tapping -----
  const inlineRisks = await page.$$eval('#searchResults .leg', els => els.map(e => {
    const r = e.querySelector('.keyrisk');
    return r ? r.textContent.trim() : null;
  }));
  t.ok('key_risk reads on the row itself', /Facing a lefty/.test(inlineRisks[ellyAt0]), inlineRisks[ellyAt0]);
  t.eq('a row with no key_risk shows no inline line at all', inlineRisks[noExtrasAt0], null);
  t.eq('only where the judge actually gave one', inlineRisks.filter((r) => r != null).length, 3);   // Corbin, Elly, Junk Time Guy

  // ---- negative-edge rows: dimmed, and the add button is gone entirely ----
  const negRows = await page.$$eval('#searchResults .leg', els => els.map(e => e.classList.contains('negedge')));
  t.eq('the -11.4pp goblin is flagged negative-edge', negRows[ellyAt0], true);
  t.eq('a positive-edge standard is not', negRows[noExtrasAt0], false);
  const addBtns = await page.$$eval('#searchResults .leg', els => els.map(e => !!e.querySelector('.addbtn')));
  t.eq('the negative-edge row has no + button at all — not disabled, absent', addBtns[ellyAt0], false);
  t.eq('a positive-edge row keeps its + button', addBtns[noExtrasAt0], true);

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
  // Elly AND Corbin both carry recent5 now (Corbin's is there so the audit
  // strip below has real data to disagree with), so two stats buttons exist —
  // Elly's is addressed by owner name, same pattern as the "why" panels below.
  const statsOwners = await page.$$eval('#searchResults .leg', legs => legs
    .filter(l => l.querySelector('.whybtn[data-panel="stats"]'))
    .map(l => l.querySelector('.name').textContent.trim()));
  const statsBtns = await page.$$('#searchResults .whybtn[data-panel="stats"]');
  t.eq('a stats button only where raw numbers arrived', statsBtns.length, 2);
  const ellyStatsAt = statsOwners.indexOf('Elly De La Cruz');
  await statsBtns[ellyStatsAt].click();
  await page.waitForFunction((i) => ![...document.querySelectorAll('#searchResults .why[data-panel="stats"]')][i].hidden, ellyStatsAt);
  const cellCls = await page.$$eval('#searchResults .why[data-panel="stats"]', (w, i) =>
    [...w[i].querySelectorAll('.g5cell')].map(e => e.className), ellyStatsAt);
  t.eq('five last-5 cells, colored by beating THIS line (0.5)',
    cellCls, ['g5cell over', 'g5cell under', 'g5cell over', 'g5cell over', 'g5cell over']);
  const sPanel = await page.$$eval('#searchResults .why[data-panel="stats"]',
    (w, i) => w[i].innerText.replace(/\s+/g, ' '), ellyStatsAt);
  t.ok('summary counts the games over the line', /4\/5 over 0\.5/.test(sPanel), sPanel.slice(0, 80));
  t.ok('average shown', /avg 1/.test(sPanel));
  t.ok('opponents ride along per game', /@STL/.test(sPanel) && /vs PIT/.test(sPanel));
  t.ok('opposing starter season line from ESPN', /Skenes.*ERA 2\.14.*WHIP 0\.95.*K 189/.test(sPanel), sPanel);
  t.ok('team record + win% + park context', /61-59/.test(sPanel) && /55%/.test(sPanel) && /104/.test(sPanel));
  t.ok('sources are named, so it reads as data not judgement', /PRIZEPICKS/.test(sPanel) && /ESPN/.test(sPanel));
  await statsBtns[ellyStatsAt].click();
  await page.waitForFunction((i) => [...document.querySelectorAll('#searchResults .why[data-panel="stats"]')][i].hidden, ellyStatsAt);

  // ---- the "why" panel: always available, one per pick ---------------------
  const whyBtns = await page.$$('#searchResults .whybtn[data-panel="why"]');
  t.eq('every pick gets a why button — the audit strip and ask thread live there '
    + 'regardless of whether the judge gave reasoning', whyBtns.length, 4);
  t.eq('panels start collapsed',
    await page.$$eval('#searchResults .why[data-panel="why"]', w => w.map(x => x.hidden)), [true, true, true, true]);

  const ellyWhy = whyBtns[ellyAt0];
  await ellyWhy.click();
  await page.waitForFunction(() => [...document.querySelectorAll('#searchResults .why[data-panel="why"]')].some(w => !w.hidden));
  t.eq('button flips open', (await ellyWhy.textContent()).trim(), 'why ↑');
  t.eq('aria-expanded tracks it', await ellyWhy.getAttribute('aria-expanded'), 'true');
  const panel = await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) => w[i].innerText, ellyAt0);
  t.ok('citation markup is stripped', !/<cite|cite index/.test(panel), panel.slice(0, 60));
  t.ok('the full reasoning text is still there', /4 of the last 5/.test(panel));
  t.ok('key_risk repeats inside the panel too', /Facing a lefty/.test(panel));
  t.eq('other why panels stay closed',
    await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) => w.filter((_, j) => j !== i).map(x => x.hidden), ellyAt0),
    [true, true, true]);

  // ---- audit strip: four checks, opening the why panel -------------------
  const auditRows = await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) =>
    [...w[i].querySelectorAll('.auditrow')].map(r => ({
      mark: r.querySelector('.auditmark').className.replace('auditmark ', ''),
      text: r.textContent.replace(/\s+/g, ' ').trim(),
    })), ellyAt0);
  t.eq('four audit checks', auditRows.length, 4);
  t.ok('cleared-count check agrees for Elly (judge said 4, data says 4)',
    auditRows[0].mark === 'ok' && /cleared count/i.test(auditRows[0].text), JSON.stringify(auditRows[0]));
  t.ok('line matched', auditRows[1].mark === 'ok' && /line matched/i.test(auditRows[1].text));
  t.ok('price verified', auditRows[2].mark === 'ok' && /price verified/i.test(auditRows[2].text));
  t.ok('tier resolved, naming the tier', auditRows[3].mark === 'ok' && /GOBLIN/.test(auditRows[3].text), auditRows[3].text);

  // The audit strip shows a MISMATCH when the judge's own cleared claim
  // disagrees with the truth computed from recent5 — Corbin's judge said 5,
  // but his recent5 ([1,2,0,1,2] against a 1.5 line) only clears twice.
  const carrollWhy = whyBtns[carrollAt0];
  await carrollWhy.click();
  await page.waitForFunction((i) => ![...document.querySelectorAll('#searchResults .why[data-panel="why"]')][i].hidden, carrollAt0);
  const carrollAudit = await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) =>
    [...w[i].querySelectorAll('.auditrow')].map(r => ({
      mark: r.querySelector('.auditmark').className.replace('auditmark ', ''),
      text: r.textContent.replace(/\s+/g, ' ').trim(),
    })), carrollAt0);
  t.eq('the cleared-count check reads BAD on a real disagreement', carrollAudit[0].mark, 'bad');
  t.ok('...and says what the judge claimed vs what the data says',
    /judge said 5\/5/.test(carrollAudit[0].text) && /data says 2\/5/.test(carrollAudit[0].text), carrollAudit[0].text);

  // A pick with none of the audit fields reads "not reported", never a false
  // pass or a false mismatch — the strip must not invent an answer it doesn't have.
  const noExtrasWhy = whyBtns[noExtrasAt0];
  await noExtrasWhy.click();
  await page.waitForFunction((i) => ![...document.querySelectorAll('#searchResults .why[data-panel="why"]')][i].hidden, noExtrasAt0);
  const noExtrasAudit = await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) =>
    [...w[i].querySelectorAll('.auditrow')].map(r => r.querySelector('.auditmark').className.replace('auditmark ', '')), noExtrasAt0);
  t.eq('with nothing to check, cleared count reads neutral, not a false mismatch', noExtrasAudit[0], 'na');
  t.eq('...same for line matched', noExtrasAudit[1], 'na');
  t.eq('...same for price verified', noExtrasAudit[2], 'na');

  // ---- first pass vs deep dive, with the change between them --------------
  const ellyCompare = await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
    els[i].querySelector('.passcompare').innerText.replace(/\s+/g, ' '), ellyAt0);
  t.ok('first pass shown', /FIRST PASS 62%/.test(ellyCompare), ellyCompare);
  t.ok('deep dive shown', /DEEP DIVE 68%/.test(ellyCompare), ellyCompare);
  t.ok('...and the change between them', /\+6pp/.test(ellyCompare), ellyCompare);
  const carrollCompare = await page.$$eval('#searchResults .why[data-panel="why"]',
    (els, i) => !els[i].querySelector('.passcompare') || !els[i].querySelector('.passcompare').innerText.trim(), carrollAt0);
  t.ok('no first-pass/deep-dive section on a pick that was never deep-dived', carrollCompare);

  // ---- provenance strip -----------------------------------------------------
  const prov = await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
    els[i].querySelector('.provrow').textContent.trim(), ellyAt0);
  t.ok('prompt version', /aphrodite/.test(prov), prov);
  t.ok('judge model', /claude-opus-4/.test(prov), prov);
  t.ok('search count', /3 searches/.test(prov), prov);
  t.ok('judged-at', /judged/.test(prov), prov);

  // ---- the ask thread lives inside the why panel now -----------------------
  const askInWhy = await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
    !!els[i].querySelector('.askinput'), ellyAt0);
  t.ok('the ask input is reachable from inside the why panel', askInWhy);

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  t.ok('no sideways scroll with a panel open (430px viewport)', width <= 430, `scrollWidth ${width}`);

  await ellyWhy.click();
  await page.waitForFunction((i) => [...document.querySelectorAll('#searchResults .why[data-panel="why"]')][i].hidden, ellyAt0);
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

  // ---- an unpriced under does not borrow the over side's tier icon --------
  // odds_type describes the OVER side only. A goblin line's UNDER can be a
  // completely different tier on the real PrizePicks card — showing the
  // goblin icon next to a pick that's actually the under claims a price this
  // app never confirmed. Reported live: a goblin-icon "Total Bases under 0.5"
  // at 82% turned out to be a DEMON on the real card once the user checked.
  const UNVERIFIED_RESULT = { board: [
    { player: 'Cole Young', team: 'SEA', matchup: 'SEA vs BOS', stat: 'Total Bases', line: 0.5,
      side: 'under', sideVerdict: 'play', sideProb: 0.82, prob: 0.18, oddsType: 'goblin',
      sidePriceUnverified: true, image: null },
    { player: 'Priced Goblin Guy', team: 'TEX', matchup: 'TEX vs OAK', stat: 'Hits', line: 0.5,
      side: 'over', sideVerdict: 'play', sideProb: 0.80, prob: 0.80, oddsType: 'goblin',
      sidePriceUnverified: false, image: null },
  ], timing: RESULT.timing, params: RESULT.params };
  const unverified = await openApp(browser, {
    url, timezoneId: 'America/New_York', locale: 'en-US',
    init: freezeClock('2026-08-14T20:00:00.000-04:00'),
    routes: { '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('bet-finder', UNVERIFIED_RESULT) },
  });
  await unverified.page.click('#tabBtnSearch');
  await unverified.page.click('#runBtn');
  await unverified.page.waitForSelector('#searchResults .leg', { timeout: 30000 });

  const legByName = async (name) =>
    unverified.page.locator('#searchResults .leg', { hasText: name }).first();
  const coleName = await (await legByName('Cole Young')).locator('.name').innerHTML();
  t.ok('an unconfirmed side shows a neutral "?" mark, not a tier icon',
    /class="tiericon unk"/.test(coleName), coleName);
  t.ok('...never the goblin image the over side actually prices at',
    !/goblinImg|alt="goblin"/.test(coleName), coleName);
  t.ok('...and says why, for anyone who checks',
    /title="[^"]*UNDER[^"]*separately[^"]*"/.test(coleName), coleName);

  const pricedName = await (await legByName('Priced Goblin Guy')).locator('.name').innerHTML();
  t.ok('a genuinely goblin-priced pick still gets the real goblin icon',
    /alt="goblin"/.test(pricedName), pricedName);
  t.ok('...not the unconfirmed mark', !/tiericon unk/.test(pricedName), pricedName);

  t.eq('no unstubbed API calls (unverified-side board)', unverified.unstubbed, []);
  t.eq('no JS errors (unverified-side board)', unverified.errors, []);
  await unverified.page.close();
}

// The board a Find Bets run renders: the edge meter, the pp edge that leads
// the row, the recent-5 sparkline, inline key_risk, the per-pick "why" panel
// (audit strip, first pass vs deep dive, provenance, ask thread), and the
// game start time.
//
// The board is the app's main output, and its failure modes are quiet ones — a
// probability shown without its tier's own break-even, citation markup from
// the judge's web search rendering literally, a prose panel forcing the page
// to scroll sideways on a phone, a leg below its break-even still one tap
// from a slip, or a start time silently shown in the wrong timezone.

import { openApp, freezeClock } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

// One fixed slate, seen by viewers in two timezones. Times are instants with the
// game's local offset, exactly as PrizePicks stamps them.
const TONIGHT_ET = '2026-08-14T19:30:00.000-04:00';
const LATE_PT = '2026-08-14T22:15:00.000-07:00';   // 1:15am ET tomorrow

// Edges against the real break-evens (goblin 79.4 / standard 59.5 / demon 43.7):
//   Nova   standard 68%  -> +8.5pp   the rich, positive row
//   Corbin standard 66%  -> +6.5pp   positive, and its cleared claim is WRONG
//   Demon  demon    50%  -> +6.3pp   the third tier's own bar
//   Junk   standard 61%  -> +1.5pp   positive, unparseable start time
//   NoEx   standard 60%  -> +0.5pp   positive, carries nothing else at all
//   Elly   goblin   68%  -> -11.4pp  BELOW break-even: dimmed, stripped
const RESULT = { board: [
  { player: 'Nova Standard', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'standard', image: null, start: TONIGHT_ET,
    deepDive: true, shallowProb: 0.62,
    // A book line that disagrees with PrizePicks' own — shown; one that agreed
    // would be two renderings of the same number.
    bookLine: 1.5,
    key_risk: 'Facing a lefty.', reasoning: 'Cleared this line in 4 of the last 5 — <cite index="1-2">.312 average</cite>.',
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
    verdict: 'play', prob: 0.66, oddsType: 'standard', image: null, start: LATE_PT,
    key_risk: 'none', reasoning: 'Line sits above his median; thin.',
    // the judge's own claim (5) disagrees with the data below (recent5 clears
    // this 1.5 line exactly twice) — this is the audit-strip mismatch case
    cleared: 5, recent5: [1, 2, 0, 1, 2], lineMatched: true, tierKnown: true, sidePriceUnverified: false },
  { player: 'Demon Guy', team: 'SEA', matchup: 'SEA vs HOU', stat: 'Home Runs', line: 0.5, pick: 'over',
    verdict: 'lean', prob: 0.50, oddsType: 'demon', image: null, start: TONIGHT_ET },
  { player: 'Junk Time Guy', team: 'LAD', matchup: 'LAD vs SF', stat: 'Hits', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.61, oddsType: 'standard', image: null, start: 'not-a-date',
    key_risk: 'r', reasoning: 'x' },
  { player: 'No Extras Guy', team: 'BOS', matchup: 'BOS vs NYY', stat: 'Hits', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.60, oddsType: 'standard', image: null },   // no start, no reasoning, no audit fields
  // Below its own break-even. Carries a full set of extras in the DATA on
  // purpose — the row must suppress them because of the edge, not because
  // they are missing.
  { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'goblin', image: null, start: TONIGHT_ET,
    key_risk: 'Facing a lefty.', reasoning: 'Cleared this line in 4 of the last 5.',
    recent5: [1, 0, 2, 1, 1], recentAvg: 1.0, cleared: 4, lineMatched: true, tierKnown: true,
    sidePriceUnverified: false },
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
  t.eq('every pick renders a row', await page.$$eval('#searchResults .leg', l => l.length), 6);
  // EDGE means probability MINUS the tier's break-even, not probability. Elly
  // is tied for the highest probability on the board at 68%, but she is a
  // goblin: 2.0x on a 3-pick Power needs 79.4% a leg, so she is -11.4pp and
  // ranks last — below a 50% demon that only needs 43.7%.
  t.eq('default order is edge over break-even, not raw probability',
    await names(),
    ['Nova Standard', 'Corbin Carroll', 'Demon Guy', 'Junk Time Guy', 'No Extras Guy', 'Elly De La Cruz']);

  const novaAt = await rowAt('Nova Standard');
  const carrollAt = await rowAt('Corbin Carroll');
  const demonAt = await rowAt('Demon Guy');
  const noExtrasAt = await rowAt('No Extras Guy');
  const ellyAt = await rowAt('Elly De La Cruz');

  // ---- the pp edge leads the row, top right, in the condensed face --------
  const edges = await page.$$eval('#searchResults .edgebig', els => els.map(e => e.textContent.trim()));
  t.eq('every row shows the big edge number it is ranked by', edges.length, 6);
  t.ok('...as points against break-even, not a repeat of the percentage',
    edges.every((e) => /pp$|price \?/.test(e)), edges.join(' | '));
  t.eq('the goblin at 68% is shown as well under water', edges[ellyAt], '-11.4pp');
  t.eq('the standard at 68% clears the same probability comfortably', edges[novaAt], '+8.5pp');
  const edgeFirst = await page.$$eval('#searchResults .leg .stat-right', els =>
    els.map(e => e.firstElementChild.className));
  t.ok('the edge is the FIRST thing in the right column, not buried under the stat line',
    edgeFirst.every(c => /edgebig/.test(c)), JSON.stringify(edgeFirst));
  const edgeFont = await page.$eval('#searchResults .edgebig',
    e => getComputedStyle(e).fontFamily.toLowerCase());
  t.ok('...and set in Oswald, the condensed display face', /oswald/.test(edgeFont), edgeFont);

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
  t.eq('the goblin meter ticks at the GOBLIN break-even (79.4%)', meters[ellyAt].tickLeft, '79.4%');
  t.eq('a standard meter ticks at the STANDARD break-even (59.5%)', meters[novaAt].tickLeft, '59.5%');
  t.eq('a demon meter ticks at the DEMON break-even (43.7%)', meters[demonAt].tickLeft, '43.7%');
  t.eq('the goblin at 68% reads short of its own tick, in red', meters[ellyAt].fillCls, 'efill short');
  t.eq('...and the number itself is styled the same way', meters[ellyAt].pctCls, 'pct short');
  t.eq('the same 68% on a standard clears its own (lower) bar, in green', meters[novaAt].fillCls, 'efill over');
  t.eq('a 50% demon clears the lowest bar of the three', meters[demonAt].fillCls, 'efill over');
  t.eq('the probability sits on the left under the meter', meters[novaAt].pctText, '68%');
  t.eq('...and what it needs on the right', meters[ellyAt].needsText, 'needs 79.4%');
  t.eq('each tier names its own bar', meters[demonAt].needsText, 'needs 43.7%');

  // ---- tier badge ----------------------------------------------------------
  const tierBadges = await page.$$eval('#searchResults .leg .tierbadge', els => els.map(e => e.textContent.trim()));
  t.eq('every row carries a tier badge', tierBadges[ellyAt], 'GOBLIN');
  t.eq('...naming standard too', tierBadges[novaAt], 'STANDARD');
  t.eq('...and demon', tierBadges[demonAt], 'DEMON');

  // ---- a book line only where it disagrees with PrizePicks ----------------
  const books = await page.$$eval('#searchResults .leg', els => els.map(e => {
    const b = e.querySelector('.bookline');
    return b ? b.textContent.trim() : null;
  }));
  t.eq('the DK line shows on the stat line where it differs', books[novaAt], 'DK 1.5');
  t.eq('...and nowhere else', books.filter(Boolean).length, 1);
  const bookColor = await page.$eval('#searchResults .bookline', e => getComputedStyle(e).color);
  t.eq('...in the blue token, a second opinion rather than a warning', bookColor, 'rgb(122, 148, 201)');

  // ---- deep dive badge + the move it made ---------------------------------
  const deepBadges = await page.$$eval('#searchResults .leg', (els) => els.map((e) => !!e.querySelector('.deepbadge')));
  t.eq('the deep-dived pick carries the badge', deepBadges[novaAt], true);
  t.ok('nobody else does', deepBadges.filter(Boolean).length === 1, JSON.stringify(deepBadges));
  const shift = await page.$eval('#searchResults .leg .deepshift', e => e.textContent.trim());
  t.eq('the deep dive reads as a move from the first pass, not a bare number', shift, '68% ↗ from 62%');

  // ---- recent-5 sparkline, always visible on a row you can act on ---------
  const sparkSums = await page.$$eval('#searchResults .leg', els => els.map(e => {
    const s = e.querySelector('.sparksum');
    return s ? s.textContent.trim() : null;
  }));
  t.eq('the sparkline summarizes how many of five cleared this line', sparkSums[novaAt], '4/5 cleared · avg 1');
  const novaBars = await page.$$eval('#searchResults .leg', (els, i) =>
    [...els[i].querySelectorAll('.sparkbar')].map(b => b.classList.contains('over')), novaAt);
  t.eq('bars above the line are highlighted, in the same order as recent5',
    novaBars, [true, false, true, true, true]);
  t.eq('a row with no recent5 renders no sparkline', sparkSums[noExtrasAt], null);

  // ---- key_risk inline on the row, no longer only reachable by tapping -----
  const inlineRisks = await page.$$eval('#searchResults .leg', els => els.map(e => {
    const r = e.querySelector('.keyrisk');
    return r ? r.textContent.trim() : null;
  }));
  t.ok('key_risk reads on the row itself, prefixed "risk"',
    /^risk\s+Facing a lefty/.test(inlineRisks[novaAt]), inlineRisks[novaAt]);
  t.eq('a row with no key_risk shows no inline line at all', inlineRisks[noExtrasAt], null);

  // ---- a leg below its break-even is not one tap from anything ------------
  const negRows = await page.$$eval('#searchResults .leg', els => els.map(e => e.classList.contains('negedge')));
  t.eq('the -11.4pp goblin is flagged negative-edge', negRows[ellyAt], true);
  t.eq('a positive-edge standard is not', negRows[novaAt], false);
  const ellyDim = await page.$$eval('#searchResults .leg', (els, i) => getComputedStyle(els[i]).opacity, ellyAt);
  t.eq('...dimmed to 42%', ellyDim, '0.42');
  const buttons = await page.$$eval('#searchResults .leg', els =>
    els.map(e => e.querySelectorAll('.whybtn, .addbtn').length));
  t.eq('the negative-edge row has NO buttons at all — not disabled, absent', buttons[ellyAt], 0);
  t.ok('a positive-edge row keeps its buttons', buttons[novaAt] > 0, String(buttons[novaAt]));
  const addBtns = await page.$$eval('#searchResults .leg', els => els.map(e => !!e.querySelector('.addbtn')));
  t.eq('...specifically, no + button', addBtns[ellyAt], false);
  t.eq('a positive-edge row keeps its + button', addBtns[novaAt], true);
  t.eq('the negative-edge row drops its sparkline even though it HAS recent5', sparkSums[ellyAt], null);
  t.ok('...and replaces key_risk with one plain sentence naming the bar it missed',
    /^Below break-even: 68% against the 79\.4% this tier needs, so it is not offered\.$/.test(inlineRisks[ellyAt]),
    inlineRisks[ellyAt]);
  t.eq('...it carries no hidden panels either, since nothing can open them',
    await page.$$eval('#searchResults .leg', (els, i) => els[i].querySelectorAll('.why').length, ellyAt), 0);

  // ---- "why" sits beside the + on rows you can act on ---------------------
  const whyBtns = await page.$$('#searchResults .whybtn[data-panel="why"]');
  t.eq('every positive-edge row gets a why button, and only those', whyBtns.length, 5);
  const btnOrder = await page.$$eval('#searchResults .leg', (els, i) =>
    [...els[i].querySelector('.whyrow').children].map(b => b.dataset.panel || (b.classList.contains('addbtn') ? 'add' : '?')), novaAt);
  t.eq('why is the last control before the + it sits beside',
    btnOrder.slice(-2), ['why', 'add']);

  // ---- sort control -------------------------------------------------------
  const sortBtns = await page.$$eval('#searchResults .sortbtn',
    els => els.map(e => ({ label: e.textContent.trim(), sort: e.dataset.sort, active: e.classList.contains('active') })));
  t.eq('three sorts offered, edge active by default',
    sortBtns, [{ label: 'EDGE %', sort: 'edge', active: true }, { label: 'TEAM', sort: 'team', active: false }, { label: 'TIME', sort: 'time', active: false }]);

  await page.click('#searchResults .sortbtn[data-sort="team"]');
  t.eq('team sort is alphabetical by team (ARI, BOS, CIN, CIN, LAD, SEA)',
    await names(),
    ['Corbin Carroll', 'No Extras Guy', 'Nova Standard', 'Elly De La Cruz', 'Junk Time Guy', 'Demon Guy']);

  await page.click('#searchResults .sortbtn[data-sort="edge"]');
  t.eq('edge sort restores the edge order', await names(),
    ['Nova Standard', 'Corbin Carroll', 'Demon Guy', 'Junk Time Guy', 'No Extras Guy', 'Elly De La Cruz']);

  // ---- game start time, viewer-local -------------------------------------
  const times = await gtimes();
  t.eq('tonight game shows local time (ET viewer)', times[await rowAt('Nova Standard')], '7:30 PM');
  t.eq('late west-coast game rolls to tomorrow for an ET viewer', times[await rowAt('Corbin Carroll')], 'Sat 1:15 AM');
  t.eq('missing start_time renders no chip at all', times[await rowAt('No Extras Guy')], null);
  t.eq('unparseable start_time renders no chip at all', times[await rowAt('Junk Time Guy')], null);
  const dotIsCss = await page.$eval('#searchResults .gtime',
    el => getComputedStyle(el, '::before').content.includes('·'));
  t.ok('separator is CSS decoration, not DOM text', dotIsCss);

  // ---- the "stats" panel: raw numbers, never the judge --------------------
  const statsOwners = await page.$$eval('#searchResults .leg', legs => legs
    .filter(l => l.querySelector('.whybtn[data-panel="stats"]'))
    .map(l => l.querySelector('.name').textContent.trim()));
  const statsBtns = await page.$$('#searchResults .whybtn[data-panel="stats"]');
  t.eq('a stats button only where raw numbers arrived AND the row is actionable',
    statsOwners, ['Nova Standard', 'Corbin Carroll']);
  const novaStatsAt = statsOwners.indexOf('Nova Standard');
  await statsBtns[novaStatsAt].click();
  await page.waitForFunction((i) => ![...document.querySelectorAll('#searchResults .why[data-panel="stats"]')][i].hidden, novaStatsAt);
  const cellCls = await page.$$eval('#searchResults .why[data-panel="stats"]', (w, i) =>
    [...w[i].querySelectorAll('.g5cell')].map(e => e.className), novaStatsAt);
  t.eq('five last-5 cells, colored by beating THIS line (0.5)',
    cellCls, ['g5cell over', 'g5cell under', 'g5cell over', 'g5cell over', 'g5cell over']);
  const sPanel = await page.$$eval('#searchResults .why[data-panel="stats"]',
    (w, i) => w[i].innerText.replace(/\s+/g, ' '), novaStatsAt);
  t.ok('summary counts the games over the line', /4\/5 over 0\.5/.test(sPanel), sPanel.slice(0, 80));
  t.ok('average shown', /avg 1/.test(sPanel));
  t.ok('opponents ride along per game', /@STL/.test(sPanel) && /vs PIT/.test(sPanel));
  t.ok('opposing starter season line from ESPN', /Skenes.*ERA 2\.14.*WHIP 0\.95.*K 189/.test(sPanel), sPanel);
  t.ok('team record + win% + park context', /61-59/.test(sPanel) && /55%/.test(sPanel) && /104/.test(sPanel));
  t.ok('sources are named, so it reads as data not judgement', /PRIZEPICKS/.test(sPanel) && /ESPN/.test(sPanel));
  await statsBtns[novaStatsAt].click();
  await page.waitForFunction((i) => [...document.querySelectorAll('#searchResults .why[data-panel="stats"]')][i].hidden, novaStatsAt);

  // ---- the "why" panel -----------------------------------------------------
  // Re-queried here: the sort clicks above re-render the whole board, which
  // detaches every handle taken before them.
  const whyOwners = await page.$$eval('#searchResults .leg', legs => legs
    .filter(l => l.querySelector('.whybtn[data-panel="why"]'))
    .map(l => l.querySelector('.name').textContent.trim()));
  const whyIdx = (name) => whyOwners.indexOf(name);
  const liveWhyBtns = await page.$$('#searchResults .whybtn[data-panel="why"]');
  t.eq('panels start collapsed',
    await page.$$eval('#searchResults .why[data-panel="why"]', w => w.map(x => x.hidden)), [true, true, true, true, true]);

  const novaWhy = liveWhyBtns[whyIdx('Nova Standard')];
  await novaWhy.click();
  await page.waitForFunction(() => [...document.querySelectorAll('#searchResults .why[data-panel="why"]')].some(w => !w.hidden));
  t.eq('button flips open', (await novaWhy.textContent()).trim(), 'why ↑');
  t.eq('aria-expanded tracks it', await novaWhy.getAttribute('aria-expanded'), 'true');
  const panel = await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) => w[i].innerText, whyIdx('Nova Standard'));
  t.ok('citation markup is stripped', !/<cite|cite index/.test(panel), panel.slice(0, 60));
  t.ok('the full reasoning text is still there', /4 of the last 5/.test(panel));
  t.ok('key_risk repeats inside the panel too', /Facing a lefty/.test(panel));
  t.eq('other why panels stay closed',
    await page.$$eval('#searchResults .why[data-panel="why"]', (w, i) => w.filter((_, j) => j !== i).map(x => x.hidden), whyIdx('Nova Standard')),
    [true, true, true, true]);

  // ---- audit strip: four checks, opening the why panel -------------------
  const auditOf = async (name) => page.$$eval('#searchResults .why[data-panel="why"]', (w, i) =>
    [...w[i].querySelectorAll('.auditrow')].map(r => ({
      mark: r.querySelector('.auditmark').className.replace('auditmark ', ''),
      text: r.textContent.replace(/\s+/g, ' ').trim(),
    })), whyIdx(name));
  const novaAudit = await auditOf('Nova Standard');
  t.eq('four audit checks', novaAudit.length, 4);
  t.ok('cleared-count check agrees (judge said 4, data says 4)',
    novaAudit[0].mark === 'ok' && /cleared count/i.test(novaAudit[0].text), JSON.stringify(novaAudit[0]));
  t.ok('line matched', novaAudit[1].mark === 'ok' && /line matched/i.test(novaAudit[1].text));
  t.ok('price verified', novaAudit[2].mark === 'ok' && /price verified/i.test(novaAudit[2].text));
  t.ok('tier resolved, naming the tier', novaAudit[3].mark === 'ok' && /STANDARD/.test(novaAudit[3].text), novaAudit[3].text);

  // The audit strip flags a MISMATCH when the judge's own cleared claim
  // disagrees with the truth computed from recent5 — Corbin's judge said 5,
  // but his recent5 ([1,2,0,1,2] against a 1.5 line) only clears twice.
  const carrollWhy = liveWhyBtns[whyIdx('Corbin Carroll')];
  await carrollWhy.click();
  await page.waitForFunction((i) => ![...document.querySelectorAll('#searchResults .why[data-panel="why"]')][i].hidden, whyIdx('Corbin Carroll'));
  const carrollAudit = await auditOf('Corbin Carroll');
  t.eq('the cleared-count check reads BAD on a real disagreement', carrollAudit[0].mark, 'bad');
  t.ok('...and says what the judge claimed vs what the data says',
    /judge said 5\/5/.test(carrollAudit[0].text) && /data says 2\/5/.test(carrollAudit[0].text), carrollAudit[0].text);

  // A pick with none of the audit fields reads "not reported", never a false
  // pass or a false mismatch — the strip must not invent an answer it doesn't have.
  const noExtrasWhy = liveWhyBtns[whyIdx('No Extras Guy')];
  await noExtrasWhy.click();
  await page.waitForFunction((i) => ![...document.querySelectorAll('#searchResults .why[data-panel="why"]')][i].hidden, whyIdx('No Extras Guy'));
  const noExtrasAudit = await auditOf('No Extras Guy');
  t.eq('with nothing to check, cleared count reads neutral, not a false mismatch', noExtrasAudit[0].mark, 'na');
  t.eq('...same for line matched', noExtrasAudit[1].mark, 'na');
  t.eq('...same for price verified', noExtrasAudit[2].mark, 'na');

  // ---- first pass and deep dive as separate blocks, with the move between --
  const novaCompare = await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
    els[i].querySelector('.passcompare').innerText.replace(/\s+/g, ' '), whyIdx('Nova Standard'));
  t.ok('first pass shown', /FIRST PASS 62%/.test(novaCompare), novaCompare);
  t.ok('deep dive shown', /DEEP DIVE 68%/.test(novaCompare), novaCompare);
  t.ok('...and the change between them', /\+6pp/.test(novaCompare), novaCompare);
  t.eq('the two passes render as two separate blocks',
    await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
      els[i].querySelectorAll('.passcompare .passrow').length, whyIdx('Nova Standard')), 2);
  const carrollCompare = await page.$$eval('#searchResults .why[data-panel="why"]',
    (els, i) => !els[i].querySelector('.passcompare'), whyIdx('Corbin Carroll'));
  t.ok('no first-pass/deep-dive section on a pick that was never deep-dived', carrollCompare);

  // ---- provenance strip -----------------------------------------------------
  const prov = await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
    els[i].querySelector('.provrow').textContent.trim(), whyIdx('Nova Standard'));
  t.ok('prompt version', /aphrodite/.test(prov), prov);
  t.ok('judge model', /claude-opus-4/.test(prov), prov);
  t.ok('search count', /3 searches/.test(prov), prov);
  t.ok('judged-at', /judged/.test(prov), prov);

  // ---- the ask thread lives inside the why panel now -----------------------
  const askInWhy = await page.$$eval('#searchResults .why[data-panel="why"]', (els, i) =>
    !!els[i].querySelector('.askinput'), whyIdx('Nova Standard'));
  t.ok('the ask input is reachable from inside the why panel', askInWhy);

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  t.ok('no sideways scroll with a panel open (430px viewport)', width <= 430, `scrollWidth ${width}`);

  await novaWhy.click();
  await page.waitForFunction((i) => [...document.querySelectorAll('#searchResults .why[data-panel="why"]')][i].hidden, whyIdx('Nova Standard'));
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
  t.eq('same game, PT viewer: 7:30 ET reads 4:30 PM', wrow['Nova Standard'], '4:30 PM');
  t.eq('the late PT game is still today out west — no weekday prefix', wrow['Corbin Carroll'], '10:15 PM');
  t.eq('no JS errors (PT viewer)', west.errors, []);
  await west.page.close();

  // ---- an unpriced under does not borrow the over side's tier icon --------
  // odds_type describes the OVER side only. A goblin line's UNDER can be a
  // completely different tier on the real PrizePicks card — showing the
  // goblin icon next to a pick that's actually the under claims a price this
  // app never confirmed. Reported live: a goblin-icon "Total Bases under 0.5"
  // at 82% turned out to be a DEMON on the real card once the user checked.
  //
  // An unpriced side is also NOT a negative-edge side: its edge is null, not
  // below zero, so it keeps its buttons. Not knowing the payout is not the
  // same as knowing it is bad.
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
  const coleRow = await legByName('Cole Young');
  const coleName = await coleRow.locator('.name').innerHTML();
  t.ok('an unconfirmed side shows a neutral "?" mark, not a tier icon',
    /class="tiericon unk"/.test(coleName), coleName);
  t.ok('...never the goblin image the over side actually prices at',
    !/goblinImg|alt="goblin"/.test(coleName), coleName);
  t.ok('...and says why, for anyone who checks',
    /title="[^"]*UNDER[^"]*separately[^"]*"/.test(coleName), coleName);
  t.eq('an unpriced side keeps its + button — null edge is not a negative edge',
    await coleRow.locator('.addbtn').count(), 1);

  const pricedName = await (await legByName('Priced Goblin Guy')).locator('.name').innerHTML();
  t.ok('a genuinely goblin-priced pick still gets the real goblin icon',
    /alt="goblin"/.test(pricedName), pricedName);
  t.ok('...not the unconfirmed mark', !/tiericon unk/.test(pricedName), pricedName);

  t.eq('no unstubbed API calls (unverified-side board)', unverified.unstubbed, []);
  t.eq('no JS errors (unverified-side board)', unverified.errors, []);
  await unverified.page.close();
}

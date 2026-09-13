// The audited "why" panel used to exist only on the Find Bets board
// (#searchResults). Today's Best Picks and the full ledger list both had an
// "ask" button and a "+ slip" button but no way to interrogate the pick
// before tapping it into a slip — exactly backwards, since those are the
// picks ranked highest and most likely to be tapped straight in.
//
// All three surfaces now share one component (pickWhyHtml, index.html) that
// builds the sparkline, key_risk, why button/panel, audit strip and ask
// thread identically. This test proves that sharing rather than asserting it
// three separate times: the SAME pick, rendered on all three surfaces at
// once, must produce the SAME audit strip everywhere — including flagging a
// cleared-count mismatch on all three, not just the board.

import { openApp, freezeClock } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

const TONIGHT_ET = '2026-08-14T19:30:00.000-04:00';

// Ground truth for a 1.5 line against [1,2,0,1,2] is 2 clears (the two 2s).
// The judge's own claim of 5 disagrees — the same mismatch shape already
// proven on the board (Corbin Carroll, board-results.test.mjs), reused here
// unpriced so the log row and the board row are the identical object PickLog
// would actually persist (see bet-finder-background.js's `logged` shape).
const MISMATCH_PICK = {
  player: 'Mismatch Guy', team: 'ARI', matchup: 'ARI vs SD', stat: 'Total Bases',
  statDisplay: 'TB', line: 1.5, pick: 'over', side: 'over',
  verdict: 'play', prob: 0.66, oddsType: 'standard', image: null, start: TONIGHT_ET,
  key_risk: 'Thin sample on the road.', reasoning: 'Cleared this line in the last two outings.',
  recent5: [1, 2, 0, 1, 2], recentAvg: 1.2,
  cleared: 5, lineMatched: true, tierKnown: true, sidePriceUnverified: false,
  promptVersion: 'aphrodite', judgeModel: 'claude-opus-4', maxSearches: 3,
  judgedAt: '2026-08-14T19:00:00.000Z', hit: null,
};

const RESULT = { board: [MISMATCH_PICK],
  teamRecords: {}, winProbs: {}, params: { league: 'mlb', legs: 3, tiers: ['goblin', 'standard'] } };
const LEDGER = { date: '2026-08-14', count: 1, picks: [MISMATCH_PICK] };

// The audit strip as the panel actually renders it, scoped to whichever
// container the surface uses ('.leg' on the board and the ledger list,
// '.recline' on Today's Best Picks) so the same player name can be located
// on all three without cross-matching another surface's row.
async function auditStripFor(page, rowSel) {
  const row = page.locator(rowSel, { hasText: 'Mismatch Guy' }).first();
  await row.locator('.whybtn[data-panel="why"]').click();
  const panel = row.locator('.why[data-panel="why"]');
  await panel.waitFor({ state: 'visible' });
  return panel.locator('.auditrow').evaluateAll((els) => els.map((e) => ({
    mark: e.querySelector('.auditmark').className.replace('auditmark ', ''),
    text: e.textContent.replace(/\s+/g, ' ').trim(),
  })));
}

export default async function ({ t, url, browser }) {
  const { page, errors, unstubbed } = await openApp(browser, {
    url, timezoneId: 'America/New_York', locale: 'en-US',
    init: freezeClock('2026-08-14T20:00:00.000-04:00'),
    routes: {
      '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS,
      '**/api/top-picks*': LEDGER,
      '**/api/calibration*': { graded: 0, brier: null, playsLeans: { n: 0, hits: 0 } },
      ...jobRoutes('bet-finder', RESULT),
    },
  });

  // ---- the board (#searchResults / Find Bets) ------------------------------
  await page.click('#tabBtnSearch');
  await page.waitForSelector('#runBtn');
  await page.click('#runBtn');
  await page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  t.ok('the board exposes a why button',
    await page.$('#searchResults .whybtn[data-panel="why"]') !== null);
  const boardAudit = await auditStripFor(page, '#searchResults .leg');

  // ---- Today's Picks: the ledger list and the leaderboard ------------------
  await page.click('#tabBtnToday');
  await page.waitForSelector('#ledgerBody .leg');
  await page.waitForSelector('#ledgerRec .recline');

  t.ok('the ledger list exposes a why button',
    await page.$('#ledgerBody .whybtn[data-panel="why"]') !== null);
  t.ok('the leaderboard (Today’s Best Picks) exposes a why button too',
    await page.$('#ledgerRec .whybtn[data-panel="why"]') !== null);

  const ledgerAudit = await auditStripFor(page, '#ledgerBody .leg');
  const recAudit = await auditStripFor(page, '#ledgerRec .recline');

  t.eq('the ledger list carries the same audit strip as the board', ledgerAudit, boardAudit);
  t.eq('...and so does the leaderboard', recAudit, boardAudit);

  // ---- the cleared-count mismatch itself, on all three ----------------------
  t.eq('the board flags the cleared-count mismatch', boardAudit[0].mark, 'bad');
  t.ok('...judge claimed 5, data says 2',
    /judge said 5\/5/.test(boardAudit[0].text) && /data says 2\/5/.test(boardAudit[0].text), boardAudit[0].text);
  t.eq('the ledger list flags it too', ledgerAudit[0].mark, 'bad');
  t.eq('the leaderboard flags it too', recAudit[0].mark, 'bad');

  // ---- the leaderboard also carries the recent5 sparkline and key_risk ------
  // These were the "single most useful thing missing from a compact row" —
  // present, not just present on the ledger's own detail rows.
  t.ok('the leaderboard row carries the recent5 sparkline',
    await page.$('#ledgerRec .recline .spark') !== null);
  t.ok('...and the key_risk line', /Thin sample on the road/.test(await page.textContent('#ledgerRec')));
  t.ok('the ledger list row also carries the sparkline',
    await page.$('#ledgerBody .leg .spark') !== null);
  t.ok('...and the key_risk line',
    /Thin sample on the road/.test(await page.textContent('#ledgerBody')));

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();
}

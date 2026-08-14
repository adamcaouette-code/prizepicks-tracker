// Today's Picks — the public ledger of what the engine called and how it landed.
//
// The honesty rule: pending, won and lost must never look alike. A pick with
// hit:null is a forecast; true/false is a settled record. And a dead feed must
// say so rather than showing yesterday's board as if it were live.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, LEDGER } from '../fixtures/api.mjs';

export default async function ({ t, url, browser }) {
  const CAL = { graded: 23, brier: 0.214, playsLeans: { n: 23, hits: 14 },
    bySource: { board: { n: 15, hits: 9, brierSum: 3.2 }, slip: { n: 8, hits: 5, brierSum: 1.5 } } };
  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/top-picks*': LEDGER,
    '**/api/calibration*': CAL,
  }});

  await page.click('#tabBtnToday');
  await page.waitForSelector('#ledgerBody .leg');

  // the scoreboard: the engine's own record, with the small-sample guard
  await page.waitForFunction(() => !document.getElementById('scoreBar').hidden);
  const score = (await page.textContent('#scoreBar')).replace(/\s+/g, ' ').trim();
  t.ok('record renders as W–L with hit rate', /14–9/.test(score) && /61%/.test(score), score.slice(0, 80));
  t.ok('Brier score shown', /0\.214/.test(score));
  t.ok('small sample is flagged as early, not presented as proven', /early/i.test(score), score);

  t.eq('every logged pick renders', await page.$$eval('#ledgerBody .leg', l => l.length), LEDGER.picks.length);

  const rows = await page.$$eval('#ledgerBody .leg', els => els.map(e => ({
    text: e.innerText.replace(/\s+/g, ' '),
    settled: e.querySelector('.settled') ? e.querySelector('.settled').textContent.trim() : null,
  })));
  t.eq('a settled winner is marked HIT', rows[0].settled, 'HIT');
  t.eq('a settled loser is marked MISS', rows[1].settled, 'MISS');
  t.eq('a pending pick carries NO settled badge', rows[2].settled, null);
  t.ok('probabilities render as percentages', /71%/.test(rows[0].text), rows[0].text.slice(0, 60));

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- feed down ---------------------------------------------------------
  const down = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/calibration*': CAL,
    '**/api/top-picks*': (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }),
  }});
  await down.page.click('#tabBtnToday');
  await down.page.waitForSelector('#ledgerBody .errbox, #ledgerBody .empty', { timeout: 15000 });
  const msg = (await down.page.textContent('#ledgerBody')).trim();
  t.ok('a dead feed shows an error, not a stale board', msg.length > 0, msg.slice(0, 60));
  t.eq('and produces no JS errors', down.errors, []);
  await down.page.close();
}

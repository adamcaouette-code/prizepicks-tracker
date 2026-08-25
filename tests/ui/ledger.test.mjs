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
  // The tray prices through the real sizing endpoint, which is the whole point
  // of routing ledger legs into it rather than quoting a number here — that
  // endpoint owns the per-tier PrizePicks tables.
  const sized = [];
  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/top-picks*': LEDGER,
    '**/api/calibration*': CAL,
    '**/api/bet-finder-size*': (route, request) => {
      sized.push(JSON.parse(request.postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        entries: { power: { label: 'POWER', evPerDollar: -0.12, stake: 0,
          multipliers: [{ hits: 3, mult: 4.75 }], payouts: [{ hits: 3, pays: 0 }] } },
        hitDistribution: [0.05, 0.2, 0.4, 0.35], allHitProb: 0.35,
        breakEvenAllHit: 0.21, breakEvenPerLeg: 0.595, recommended: 'POWER', mixed: false,
      }) });
    },
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


  // ---- building a slip from the ledger ------------------------------------
  // The tray used to resolve legs only against LAST_RUN.picks — the search
  // tab's last board — so a "+ slip" button anywhere else rendered, took the
  // click, and silently added nothing.
  const settledRows = await page.$$eval('#ledgerBody .leg', els => els.map(e => ({
    settled: !!e.querySelector('.settled'), add: !!e.querySelector('.addbtn'),
  })));
  t.ok('settled picks offer no + slip — yesterday\'s winner is not a bet',
    settledRows.filter(r => r.settled).every(r => !r.add));
  t.ok('...while pending ones do',
    settledRows.filter(r => !r.settled).every(r => r.add));

  const add = (player, line) => `#ledgerBody .addbtn[data-add^="${player}|"][data-add*="|${line}|"]`;
  await page.click(add('Second Game', 1.5));
  await page.waitForFunction(() => !document.getElementById('slipTray').hidden);
  t.eq('a ledger pick reaches the tray', await page.$$eval('#slipTray .trayleg', l => l.length), 1);
  t.ok('...and the row marks itself as added',
    await page.$eval(add('Second Game', 1.5), b => b.classList.contains('on')));

  // The same nesting rule the board enforces: two lines of one prop are not
  // independent, so PrizePicks will not take both.
  await page.click(add('Edge Std', 1.5));
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .trayleg').length === 2);
  await page.click(add('Edge Std', 2.5));
  await page.waitForFunction(() => /already on this slip/.test(document.getElementById('trayMsg').textContent));
  t.eq('a second line of the same prop is refused', await page.$$eval('#slipTray .trayleg', l => l.length), 2);

  // ---- the recommended slip ----------------------------------------------
  const rec = await page.$$eval('#ledgerRec .recline .rl-name', els => els.map(e => e.textContent.trim()));
  t.eq('a slip is built from the day\'s board', rec.length, 3);

  // EDGE, not percentage. Shiny Goblin is the highest number on the ledger at
  // 78% and the worst bet on it — a goblin needs 79.4% a leg — so it must not
  // be on a slip that three ~65% standards clear comfortably.
  t.ok('the highest percentage on the board is left off, because it is a goblin',
    !rec.some(n => /Shiny Goblin/.test(n)), rec.join(', '));
  t.ok('...in favour of lower percentages that actually clear their tier',
    rec.some(n => /Edge Std/.test(n)) && rec.some(n => /Second Game/.test(n)), rec.join(', '));

  // Spread across games before doubling up: a slip stacked on one game is one
  // weather delay from zero. Edge Std has the three best standards on the board
  // and still only contributes one leg here.
  t.eq('each leg comes from a different game', rec.length, new Set(rec).size);
  t.eq('...so one player cannot fill the slip',
    rec.filter(n => /Edge Std/.test(n)).length, 1);

  // An under on a demon line is placeable but unpriced, so it cannot be sized.
  t.ok('an unpriced side is never put on a slip',
    !rec.some(n => /Unpriced Under/.test(n)), rec.join(', '));
  t.ok('...though it is still shown on the ledger, marked as unpriced',
    (await page.textContent('#ledgerBody')).includes('price ?'));

  // Loading it hands the legs to the real sizing path rather than quoting a
  // number the ledger made up.
  await page.click('#ledgerRecLoad');
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .trayleg').length === 3);
  t.eq('loading replaces the tray with the recommendation',
    await page.$$eval('#slipTray .trayleg .tl-name', els => els.map(e => e.textContent.trim())).then(n => n.length), 3);
  t.ok('...and takes you to the builder where the payout is computed',
    await page.$eval('#tabSearch', el => !el.hidden));

  // The ledger quotes no payout of its own. It hands the legs to the endpoint
  // that owns the real per-tier tables — the same path the search board uses,
  // and the one that was corrected when the board was found quoting +70% EV on
  // goblin slips returning -32%.
  // `sized` is captured in Node, not in the page, so this waits on the right
  // side of the boundary — waitForFunction would be evaluating a variable the
  // browser has never heard of.
  for (let i = 0; i < 60 && !sized.length; i++) await new Promise((r) => setTimeout(r, 100));
  t.ok('the slip is priced by the sizing endpoint, not by the ledger', sized.length > 0);
  const last = sized[sized.length - 1];
  t.eq('...on exactly the legs it recommended', last.legs.length, 3);
  t.ok('...each carrying the tier its payout depends on',
    last.legs.every((l) => typeof l.oddsType === 'string'), JSON.stringify(last.legs.map((l) => l.oddsType)));

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

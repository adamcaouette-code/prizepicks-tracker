// Building a slip off the board, pricing it, saving it, and reading it back in
// My Slips.
//
// The thing worth guarding hardest: the payout numbers must come from
// /api/bet-finder-size (which owns the real PrizePicks tables) and the SAVED
// slip must freeze the table it quoted — otherwise a settled slip could be paid
// against different numbers than the ones you agreed to.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

const mk = (player, team, line, prob, oddsType, id) => ({
  player, team, matchup: team + ' vs OPP', stat: 'Hits', statDisplay: 'Hits', line, pick: 'over',
  verdict: 'play', prob, oddsType, image: null, projectionId: id,
  start: '2026-08-14T19:30:00.000-04:00', key_risk: 'k', reasoning: 'r',
});
const RESULT = { board: [
  mk('Alpha One', 'CIN', 0.5, 0.68, 'goblin', 'PP-A'),
  mk('Beta Two', 'PIT', 1.5, 0.62, 'standard', 'PP-B'),
  mk('Gamma Three', 'CHC', 0.5, 0.60, 'standard', 'PP-C'),
], params: { league: 'mlb' } };

// bet-finder-size returns payouts in DOLLARS, scaled by the stake it was given —
// so the mock scales too. A static table would let a stake-handling bug pass.
const POWER_MULT = { 2: 3.0, 1: 0, 0: 0 };
const FLEX_MULT = { 2: 2.5, 1: 1.0, 0: 0 };
const sizingFor = (stake) => ({
  entries: {
    power: { label: 'POWER', evPerDollar: 0.12, stake,
      payouts: [2, 1, 0].map((h) => ({ hits: h, pays: Math.round(stake * POWER_MULT[h] * 100) / 100 })) },
    flex: { label: 'FLEX', evPerDollar: -0.04, stake,
      payouts: [2, 1, 0].map((h) => ({ hits: h, pays: Math.round(stake * FLEX_MULT[h] * 100) / 100 })) },
  },
  hitDistribution: [0.1216, 0.4432, 0.4352],
  recommended: 'POWER', mixed: false,
});

export default async function ({ t, url, browser }) {
  let savePost = null;
  let slipList = { slips: [] };

  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/bet-finder-size': (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(sizingFor(Number(body.bankroll) || 0)) });
    },
    '**/api/slips': (route, request) => {
      if (request.method() === 'POST') {
        savePost = JSON.parse(request.postData() || '{}');
        const slip = { id: 'saved-1', name: savePost.name || 'Slip 2026-08-14', createdAt: '2026-08-14T22:00:00Z',
          slateDate: '2026-08-14', entry: savePost.entry, stake: savePost.stake, status: 'pending',
          legs: savePost.legs.map((l) => ({ ...l, hit: null, result: null })) };
        slipList = { slips: [slip] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slip }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(slipList) });
    },
    ...jobRoutes('bet-finder', RESULT),
  }});

  await page.click('#tabBtnSearch');
  await page.click('#runBtn');
  await page.waitForSelector('#searchResults .leg');

  // ---- the tray only exists once you pick something -----------------------
  t.ok('slip tray is hidden before any leg is added', !(await page.isVisible('#slipTray')));
  const addBtns = await page.$$('#searchResults .addbtn');
  t.eq('every board card offers "+ slip"', addBtns.length, 3);

  await addBtns[0].click();
  await page.waitForFunction(() => !document.getElementById('slipTray').hidden);
  t.eq('one leg shows in the tray', await page.$$eval('#slipTray .trayleg', l => l.length), 1);
  t.ok('the card marks itself as added',
    await page.$eval('#searchResults .addbtn', b => b.classList.contains('on') && /in slip/.test(b.textContent)));
  t.ok('with one leg it says there is nothing to price yet',
    /at least 2 legs/.test(await page.textContent('#trayMath')));

  // ---- two legs: real payout math ----------------------------------------
  await (await page.$$('#searchResults .addbtn'))[1].click();
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .payrow').length > 1);
  t.eq('default stake is $10', await page.$eval('#trayStake', el => el.value), '10');

  const rows = await page.$$eval('#slipTray .payrow:not(.head)', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  t.note(rows.join('  |  '));
  t.ok('all-hit row pays the POWER table on a $10 entry', rows.some(r => /2 of 2 hit/.test(r) && /\$30\.00/.test(r)), rows[0]);
  t.ok('...and states the multiplier', /3\.00x/.test(rows.join(' ')));
  t.ok('each outcome carries its likelihood from the hit distribution', /44% likely|12% likely/.test(rows.join(' ')));
  t.ok('positive EV is stated as such', /\+12\.0% expected value/.test(await page.textContent('#trayMath')));

  // ---- switching entry re-prices without refetching ------------------------
  await page.click('#slipTray .etoggle[data-entry="flex"]');
  await page.waitForFunction(() => /25\.00/.test(document.getElementById('trayMath').textContent));
  const flex = await page.textContent('#trayMath');
  t.ok('FLEX shows its own table', /\$25\.00/.test(flex) && /\$10\.00/.test(flex));
  t.ok('negative EV is called out as a reason not to play',
    /-4\.0% expected value/.test(flex) && /telling you not to play/.test(flex), flex.slice(0, 140));
  await page.click('#slipTray .etoggle[data-entry="power"]');
  await page.waitForFunction(() => /30\.00/.test(document.getElementById('trayMath').textContent));

  // ---- changing the stake re-prices --------------------------------------
  await page.fill('#trayStake', '25');
  await page.waitForFunction(() => /\$75\.00/.test(document.getElementById('trayMath').textContent));
  t.ok('a $25 stake re-prices to $75 all-hit, still 3.00x',
    /3\.00x/.test(await page.textContent('#trayMath')));
  await page.fill('#trayStake', '10');
  await page.waitForFunction(() => /30\.00/.test(document.getElementById('trayMath').textContent));

  // ---- removing a leg -----------------------------------------------------
  await (await page.$$('#searchResults .addbtn'))[2].click();
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .trayleg').length === 3);
  await page.click('#slipTray .trayleg:last-child .tl-x');
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .trayleg').length === 2);
  t.ok('a removed leg clears the card marker',
    !(await page.$$eval('#searchResults .addbtn', bs => bs[2].classList.contains('on'))));

  // ---- save ---------------------------------------------------------------
  await page.fill('#trayName', 'Friday night card');
  await page.click('#traySave');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('trayMsg').textContent));

  t.eq('the name is sent', savePost.name, 'Friday night card');
  t.eq('the stake is sent', savePost.stake, 10);
  t.eq('the entry type is sent', savePost.entry, 'power');
  t.eq('the league rides along', savePost.league, 'mlb');
  t.eq('both legs are sent', savePost.legs.length, 2);
  t.eq('each leg carries its projection id, without which it can never be graded',
    savePost.legs.map(l => l.projectionId), ['PP-A', 'PP-B']);
  t.eq('the leg keeps the side you took', savePost.legs[0].pick, 'over');
  t.eq('the quoted payout table is frozen with the slip', savePost.sizing.payouts[0].pays, 30);
  t.eq('...as dollars for the stake actually entered, not a bare multiplier', savePost.sizing.label, 'POWER');
  t.eq('...along with the EV it was quoted at', savePost.sizing.evPerDollar, 0.12);

  t.eq('the tray empties after saving', await page.$$eval('#slipTray .trayleg', l => l.length), 0);
  t.ok('and the cards reset', !(await page.$eval('#searchResults .addbtn', b => b.classList.contains('on'))));

  // ---- My Slips -----------------------------------------------------------
  await page.click('#tabBtnSlips');
  await page.waitForSelector('#slipsBody .slipcard');
  t.eq('the saved slip appears', await page.$$eval('#slipsBody .slipcard', c => c.length), 1);
  const head = await page.textContent('#slipsBody .sliphead');
  t.ok('the card shows the name you gave it', /Friday night card/.test(head));
  t.ok('...the entry, legs and stake', /POWER/.test(head) && /2 legs/.test(head) && /\$10\.00/.test(head));
  t.ok('...and that it is not settled yet', /pending/.test(head));
  t.ok('an unsettled ledger says so rather than showing a record',
    /none settled yet/.test(await page.textContent('#slipsSummary')));

  t.ok('slips start collapsed', !(await page.isVisible('#slipsBody .slipbody')));
  await page.click('#slipsBody .sliphead');
  await page.waitForFunction(() => !document.querySelector('#slipsBody .slipbody').hidden);
  t.eq('expanding shows every leg', await page.$$eval('#slipsBody .slipleg', l => l.length), 2);
  t.ok('ungraded legs show a neutral mark, not a hit or a miss',
    await page.$$eval('#slipsBody .sl-mark', ms => ms.every(m => m.classList.contains('pend'))));

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();
}

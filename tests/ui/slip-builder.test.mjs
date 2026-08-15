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
// Mirrors the real endpoint exactly, including the trap: `payouts` is scaled by
// the KELLY-recommended stake, which is 0 whenever EV is non-positive. FLEX here
// has negative EV, so its payouts are all zero — the page must price off
// `multipliers` instead, or it shows $0.00 across the board.
const entryFor = (label, ev, mult, stake) => {
  const kelly = ev > 0 ? stake : 0;
  return { label, evPerDollar: ev, stake: kelly,
    multipliers: [2, 1, 0].map((h) => ({ hits: h, mult: mult[h] })),
    payouts: [2, 1, 0].map((h) => ({ hits: h, pays: Math.round(kelly * mult[h] * 100) / 100 })) };
};
const sizingFor = (stake) => ({
  entries: {
    power: entryFor('POWER', 0.12, POWER_MULT, stake),
    flex: entryFor('FLEX', -0.04, FLEX_MULT, stake),
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
    // A saved slip whose slate has already finished triggers a settle-on-open
    // pass, so this must be stubbed even in the build-a-slip flow.
    '**/api/grade-slips*': { legsGraded: 0, slipsSettled: 0 },
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
  // The reported bug: FLEX has NEGATIVE EV here, so the endpoint's Kelly stake
  // is 0 and its payouts array is all zeros. The table must still show what a
  // $10 entry actually returns — a negative-EV slip is exactly when you want to
  // see the payout you'd be chasing.
  t.ok('a negative-EV entry still shows real dollars, not $0.00',
    !/\$0\.00 \(2\.50x\)/.test(flex) && /\$25\.00 \(2\.50x\)/.test(flex), flex.slice(0, 160));
  t.ok('negative EV is called out as a reason not to play',
    /-4\.0% expected value/.test(flex) && /telling you not to play/.test(flex), flex.slice(0, 160));
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
  t.eq('...and the multiplier table alongside it', savePost.sizing.multipliers[0].mult, 3.0);
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

  // ---- waking up the morning after ---------------------------------------
  // The overnight cron settles slips at a fixed hour; open the app before it
  // runs and last night's card would still read "pending". Opening My Slips
  // must settle anything whose slate has already finished.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let graded = false;
  const pending = { slips: [{ id: 'p1', name: 'Last night', createdAt: yesterday + 'T22:00:00Z',
    slateDate: yesterday, entry: 'power', stake: 10, status: 'pending',
    legs: [{ player: 'A', stat: 'Hits', line: 0.5, pick: 'over', oddsType: 'goblin', hit: null, result: null },
           { player: 'B', stat: 'Hits', line: 1.5, pick: 'over', oddsType: 'standard', hit: null, result: null }] }] };
  const settled = { slips: [{ ...pending.slips[0], status: 'won', hits: 2, misses: 0, payout: 30,
    legs: [{ ...pending.slips[0].legs[0], hit: true, result: 2 }, { ...pending.slips[0].legs[1], hit: true, result: 3 }] }] };

  const morning = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS,
    '**/api/grade-slips*': (route) => { graded = true; route.fulfill({ status: 200, contentType: 'application/json', body: '{"legsGraded":2,"slipsSettled":1}' }); },
    '**/api/slips': (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(graded ? settled : pending) }),
  }});
  await morning.page.click('#tabBtnSlips');
  await morning.page.waitForSelector('#slipsBody .slipcard');
  t.ok('opening My Slips settles a finished slate rather than showing stale pending', graded);
  const headTxt = await morning.page.textContent('#slipsBody .sliphead');
  t.ok('the card reads WON the morning after', /won/i.test(headTxt), headTxt.replace(/\s+/g, ' ').trim());
  await morning.page.click('#slipsBody .sliphead');
  await morning.page.waitForFunction(() => !document.querySelector('#slipsBody .slipbody').hidden);
  const marks = await morning.page.$$eval('#slipsBody .sl-mark', ms => ms.map(m => m.className.replace('sl-mark ', '')));
  t.eq('both legs show as hits with their real results', marks, ['hit', 'hit']);
  t.ok('the payout is shown', /\$30\.00/.test(await morning.page.textContent('#slipsBody .slipbody')));
  t.ok('retention is stated so vanishing slips are expected',
    /kept for 3 days/.test(await morning.page.textContent('#slipsSummary')));
  t.eq('no JS errors the morning after', morning.errors, []);
  await morning.page.close();

  // ---- a slip that can't be fully settled --------------------------------
  const stuck = { slips: [{ id: 'u1', name: 'Half known', createdAt: yesterday + 'T22:00:00Z',
    slateDate: yesterday, entry: 'power', stake: 10, status: 'ungradeable', hits: 1, misses: 0, ungradeableLegs: 1,
    legs: [{ player: 'Known', stat: 'Hits', line: 0.5, pick: 'over', oddsType: 'goblin', hit: true, result: 2 },
           { player: 'Unknown', stat: 'Hits', line: 0.5, pick: 'over', oddsType: 'standard', hit: null, result: null, ungradeable: 'no projection id' }] }] };
  const odd = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS,
    '**/api/grade-slips*': { legsGraded: 0, slipsSettled: 0 },
    '**/api/slips': stuck,
  }});
  await odd.page.click('#tabBtnSlips');
  await odd.page.waitForSelector('#slipsBody .slipcard');
  await odd.page.click('#slipsBody .sliphead');
  await odd.page.waitForFunction(() => !document.querySelector('#slipsBody .slipbody').hidden);
  const body = await odd.page.textContent('#slipsBody .slipbody');
  t.ok('an unlookup-able leg is explained in plain words, not left broken',
    /couldn’t be looked up/.test(body), body.replace(/\s+/g, ' ').slice(0, 120));
  t.ok('the leg that DID grade is still shown as a hit',
    await odd.page.$eval('#slipsBody .sl-mark', m => m.classList.contains('hit')));
  t.ok('no payout is invented for an unsettled card', !/Paid/.test(body));
  t.eq('and it renders without JS errors', odd.errors, []);
  await odd.page.close();
}

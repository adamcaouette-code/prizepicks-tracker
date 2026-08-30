// Today's Picks — the public ledger of what the engine called and how it landed.
//
// The honesty rule: pending, won and lost must never look alike. A pick with
// hit:null is a forecast; true/false is a settled record. And a dead feed must
// say so rather than showing yesterday's board as if it were live.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, LEDGER, jobRoutes } from '../fixtures/api.mjs';

export default async function ({ t, url, browser }) {
  const CAL = { graded: 23, brier: 0.214, playsLeans: { n: 23, hits: 14 },
    bySource: { board: { n: 15, hits: 9, brierSum: 3.2 }, slip: { n: 8, hits: 5, brierSum: 1.5 } } };
  // The tray prices through the real sizing endpoint, which is the whole point
  // of routing ledger legs into it rather than quoting a number here — that
  // endpoint owns the per-tier PrizePicks tables.
  const sized = [];
  const asked = [];
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
    '**/api/ask': (route, request) => {
      asked.push(JSON.parse(request.postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        answer: 'Confirmed active tonight.', revisedProb: null, usedSearch: true }) });
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

  // ---- today's best picks: a browsable leaderboard, not an auto-built slip --
  // Used to auto-assemble one 2-6 leg slip (capped per player, spread across
  // games). That hid everything else worth seeing. Now it just ranks every
  // eligible pick by edge and lets the user tap + on whichever ones they want —
  // no per-player cap, no game-spreading, because there is no longer a single
  // slip being assembled for them.
  const rec = await page.$$eval('#ledgerRec .recline .rl-name', els => els.map(e => e.textContent.trim()));
  // 7 of the 10 logged picks are eligible: A/B Hitter are already settled,
  // Unpriced Under fails sidePriced, and Edge Std's two lines of the SAME prop
  // (Hits 1.5 and 2.5) collapse to one — nested lines were never independent.
  // Different STATS on the same player (Runs, RBIs) are different props and
  // all three survive; C Hitter (a pending "fade") is still pending, so it's
  // eligible too, just ranked last.
  t.eq('every eligible pick is listed, not capped at a slip-sized handful', rec.length, 7);
  t.eq('...including the same player under three different stats — no per-player cap anymore',
    rec.filter(n => /Edge Std/.test(n)).length, 3);

  // EDGE, not percentage. C Hitter is a standard-tier "fade" at 41% — needs
  // 59.5% to break even, the worst edge on the ledger — and Shiny Goblin is
  // the highest RAW number on the ledger at 78% but a goblin needs 79.4%, so
  // it's second-worst. Neither is hidden: this is a leaderboard, not a slip
  // filter, and the user can still see and choose either.
  t.eq('ranked by edge, worst last — the fade at 41% sinks to the very bottom',
    rec[rec.length - 1], 'C Hitter');
  t.eq('...the misleadingly-high-percentage goblin is second-worst, not first',
    rec[rec.length - 2], 'Shiny Goblin');
  t.eq('the best edge leads', rec[0], 'Edge Std');

  // A duplicate LINE of the same prop still collapses to one row (the nesting
  // rule), even though the per-player cap that used to apply alongside it is gone.
  const recLines = await page.$$eval('#ledgerRec .recline .rl-stat', els => els.map(e => e.textContent.trim()));
  const nameStat = rec.map((n, i) => `${n}|${recLines[i]}`);
  t.ok('Edge Std Hits 1.5 (the better-edge line) is the one shown',
    nameStat.some(s => /Edge Std\|Hits.*1\.5/.test(s)));
  t.eq('...and the second (2.5) line of the SAME prop does not get its own row',
    nameStat.some(s => /Edge Std\|Hits.*2\.5/.test(s)), false);

  // An under on a demon line is placeable but unpriced, so it cannot be ranked
  // by an edge that is not known.
  t.ok('an unpriced side never appears in the leaderboard',
    !rec.some(n => /Unpriced Under/.test(n)), rec.join(', '));
  t.ok('...though it is still shown on the ledger itself, marked as unpriced',
    (await page.textContent('#ledgerBody')).includes('price ?'));

  // ---- adding ONE pick from the leaderboard, not the whole thing at once ----
  // The tray already has 2 legs from the ledgerBody +buttons clicked above
  // (Second Game, Edge Std) — pick something NOT already in it so this is
  // actually exercising the leaderboard's own add buttons, not re-toggling one.
  const recAdd = (player) => page.locator('#ledgerRec .recline', { hasText: player }).locator('.addbtn');
  await recAdd('Third Game').click();
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .trayleg').length === 3);
  t.ok('the row marks itself as added', await recAdd('Third Game').evaluate((b) => b.classList.contains('on')));

  await recAdd('Shiny Goblin').click();
  await page.waitForFunction(() => document.querySelectorAll('#slipTray .trayleg').length === 4);
  t.ok('even the worst-edge pick can still be added — it is a choice, not a rule',
    await recAdd('Shiny Goblin').evaluate((b) => b.classList.contains('on')));

  // ---- tier chips: browse the leaderboard by payout tier --------------------
  // "just in case I want to risk it a bit with a higher payout" — the chips let
  // the user narrow to one tier (e.g. demon-only) without leaving the tab, while
  // the ranking underneath stays the same edge-based sort.
  const chipTexts = await page.$$eval('#ledgerRec .rtier', els => els.map((e) => e.textContent.trim()));
  t.eq('all three tiers are offered', chipTexts, ['Goblin', 'Standard', 'Demon']);
  t.ok('all three start active — the default view is unfiltered',
    await page.$$eval('#ledgerRec .rtier', els => els.every((e) => e.classList.contains('active'))));

  // This fixture's only demon leg (Unpriced Under) is an unpriced side, so it
  // was never eligible in the first place — narrowing to demon-only should
  // leave the leaderboard with nothing to show, not silently fall back to
  // showing every tier again.
  await page.click('#ledgerRec .rtier.g');
  await page.click('#ledgerRec .rtier.s');
  await page.waitForFunction(() => !document.querySelector('#ledgerRec .rtier.g').classList.contains('active')
    && !document.querySelector('#ledgerRec .rtier.s').classList.contains('active'));
  t.eq('demon-only, with no priced demon pick on this ledger, shows none',
    await page.$$eval('#ledgerRec .recline', els => els.length), 0);
  t.ok('...and says so, rather than showing an empty box with no explanation',
    /No picks in the selected tier/.test(await page.textContent('#ledgerRec')));

  // Deselecting the only remaining active tier is a no-op — the leaderboard
  // must never end up with zero tiers selected.
  await page.click('#ledgerRec .rtier.d');
  t.ok('the last active tier chip cannot be turned off',
    await page.$eval('#ledgerRec .rtier.d', (e) => e.classList.contains('active')));
  t.eq('...so the board is still empty, not broken open to every tier again',
    await page.$$eval('#ledgerRec .recline', els => els.length), 0);

  // Standard + demon: everything comes back except the one goblin pick.
  await page.click('#ledgerRec .rtier.s');
  await page.waitForFunction(() => document.querySelectorAll('#ledgerRec .recline').length > 0);
  const standardDemonNames = await page.$$eval('#ledgerRec .rl-name', els => els.map((e) => e.textContent.trim()));
  t.eq('standard + demon shows every eligible pick except the goblin one', standardDemonNames.length, 6);
  t.ok('...Shiny Goblin (goblin tier) is filtered out', !standardDemonNames.includes('Shiny Goblin'));

  // Back to all three tiers, leaving the leaderboard as later assertions expect it.
  await page.click('#ledgerRec .rtier.g');
  await page.waitForFunction(() => document.querySelectorAll('#ledgerRec .recline').length === 7);

  // The ledger quotes no payout of its own. It hands whatever is in the tray to
  // the endpoint that owns the real per-tier tables — the same path the search
  // board uses, and the one that was corrected when the board was found
  // quoting +70% EV on goblin slips returning -32%.
  // `sized` is captured in Node, not in the page, so this waits on the right
  // side of the boundary — waitForFunction would be evaluating a variable the
  // browser has never heard of.
  for (let i = 0; i < 60 && !sized.length; i++) await new Promise((r) => setTimeout(r, 100));
  t.ok('the slip is priced by the sizing endpoint, not by the ledger', sized.length > 0);
  const last = sized[sized.length - 1];
  t.ok('...each carrying the tier its payout depends on',
    last.legs.every((l) => typeof l.oddsType === 'string'), JSON.stringify(last.legs.map((l) => l.oddsType)));

  // ---- ask a question about a ledger pick, same feature as the board -------
  const mahleRow = page.locator('#ledgerBody .leg', { hasText: 'A Hitter' });
  await mahleRow.locator('.whybtn[data-panel="ask"]').click();
  const mahlePanel = mahleRow.locator('.why[data-panel="ask"]');
  await mahlePanel.waitFor({ state: 'visible' });
  await mahlePanel.locator('.askinput').fill('is he confirmed tonight');
  await mahlePanel.locator('.askinput').press('Enter');
  await page.waitForFunction(
    () => /Confirmed active tonight/.test(document.querySelector('#ledgerBody .why[data-panel="ask"]').innerText));
  t.eq('a ledger pick can be asked about too', asked.length, 1);
  t.eq('...with its own player context', asked[0].pick.player, 'A Hitter');
  t.ok('...and the answer renders in that card’s panel',
    /Confirmed active tonight/.test(await mahlePanel.innerText()));

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- re-judging the ledger ---------------------------------------------
  // The evening re-run exists because the morning run judged before lineups were
  // posted. It is worth nothing if it quietly turns into a full board scan — the
  // request it sends is the whole feature, so that is what gets asserted.
  const REJUDGED = { ...LEDGER, picks: LEDGER.picks.map(
    (p) => (p.player === 'Edge Std' && p.line === 1.5 ? { ...p, prob: 0.55 } : p)) };
  let ledgerFetches = 0;
  const job = jobRoutes('bet-finder', { board: REJUDGED.picks, timing: { pieces: {} } });
  const rj = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/calibration*': CAL,
    '**/api/top-picks*': (route) => {
      // Second load returns the re-judged numbers, so "did the ledger refresh?"
      // is answerable from the page rather than from the stub's call count alone.
      const body = ++ledgerFetches === 1 ? LEDGER : REJUDGED;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    },
    ...job,
  }});
  await rj.page.click('#tabBtnToday');
  await rj.page.waitForSelector('#ledgerBody .leg');

  await rj.page.click('#ledgerRejudge');
  await rj.page.waitForFunction(() => document.querySelectorAll('#ledgerBody .leg').length > 0
    && !document.querySelector('#ledgerStatus .spin'));

  t.eq('the re-judge asks for the ledger, not the board', job.sent.fromLedger, true);
  t.eq('...for the league selected on Find Bets', job.sent.league, 'mlb');
  // The tier chips and side toggle belong to the board scan. Re-applying them
  // here would drop rows off the ledger the user is looking at.
  t.eq('...across every tier regardless of the board chips',
    (job.sent.tiers || []).slice().sort(), ['demon', 'goblin', 'standard']);
  t.eq('...and both sides', job.sent.sides, 'both');
  // Which judge wrote a probability is part of the experiment, so it does carry.
  t.ok('the judge and model pickers carry over',
    typeof job.sent.prompt === 'string' && typeof job.sent.model === 'string',
    JSON.stringify({ prompt: job.sent.prompt, model: job.sent.model }));

  t.ok('the ledger reloads once the re-judge finishes', ledgerFetches >= 2, String(ledgerFetches));
  t.ok('...showing the new judgment, not the morning one',
    /55%/.test(await rj.page.textContent('#ledgerBody')));
  t.eq('no JS errors while re-judging', rj.errors, []);
  await rj.page.close();

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

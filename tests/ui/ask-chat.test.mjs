// Per-pick "ask" chat on the board. A user asks a follow-up question about one
// specific prop; the answer comes back from /api/ask (Haiku), and if the model's
// own view genuinely moves it can hand back a revised probability — shown next
// to the board's own number, never silently replacing it.
//
// What has to hold: the panel opens per-card without cross-talk between rows,
// the running thread is actually sent back on a follow-up (not just the latest
// question), a revision renders without touching the board's own pct/edge, and
// a failed request reads as a failure in the chat, not a broken page.
//
// The panel's innerHTML is fully replaced on every send (loading -> answered),
// which detaches any element handle grabbed before that — so panel-internal
// controls are addressed as Locators throughout, which re-resolve against the
// live DOM on every action instead of holding a stale reference.

import { openApp, freezeClock } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

const TONIGHT_ET = '2026-08-14T19:30:00.000-04:00';

const RESULT = { board: [
  { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'goblin', image: null, start: TONIGHT_ET,
    key_risk: 'Facing a lefty.', reasoning: 'Cleared this line in 4 of the last 5.',
    recent5: [1, 0, 2, 1, 1], recentAvg: 1.0,
    oppSP: { name: 'Paul Skenes', throws: 'R', era: 2.14, whip: 0.95, k: 189 }, parkIndex: 104 },
  { player: 'Corbin Carroll', team: 'ARI', matchup: 'ARI vs SD', stat: 'Total Bases', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.58, oddsType: 'standard', image: null, start: TONIGHT_ET },
], teamRecords: {}, winProbs: {}, params: { league: 'mlb', legs: 3, tiers: ['goblin', 'standard'] } };

async function renderBoard(browser, url, askRoute) {
  const app = await openApp(browser, {
    url, timezoneId: 'America/New_York', locale: 'en-US',
    init: freezeClock('2026-08-14T20:00:00.000-04:00'),
    routes: {
      '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('bet-finder', RESULT),
      '**/api/ask': askRoute,
    },
  });
  await app.page.click('#tabBtnSearch');
  await app.page.waitForSelector('#runBtn');
  await app.page.click('#runBtn');
  await app.page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  return app;
}

async function nameOrder(page) {
  return page.$$eval('#searchResults .leg .name', (els) => els.map((e) => e.textContent.trim()));
}

export default async function ({ t, url, browser }) {
  // ---- basic round trip, one card ------------------------------------------
  const asked = [];
  const { page, errors, unstubbed } = await renderBoard(browser, url, (route, request) => {
    asked.push(JSON.parse(request.postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      answer: 'Confirmed in tonight’s lineup, batting second.', revisedProb: null, usedSearch: true }) });
  });

  t.eq('every pick gets an ask button', await page.locator('#searchResults .whybtn[data-panel="ask"]').count(), 2);
  t.eq('panels start collapsed',
    await page.$$eval('#searchResults .why[data-panel="ask"]', (w) => w.map((x) => x.hidden)), [true, true]);

  const ellyAt = (await nameOrder(page)).indexOf('Elly De La Cruz');
  const ellyBtn = page.locator('#searchResults .whybtn[data-panel="ask"]').nth(ellyAt);
  const ellyPanel = page.locator('#searchResults .why[data-panel="ask"]').nth(ellyAt);
  const ellyInput = ellyPanel.locator('.askinput');

  await ellyBtn.click();
  await ellyPanel.waitFor({ state: 'visible' });
  t.eq('button flips open', (await ellyBtn.textContent()).trim(), 'ask ↑');
  t.ok('an empty thread prompts rather than showing nothing',
    /Ask about lineup news/.test(await ellyPanel.innerText()));

  await ellyInput.fill('is he in the lineup tonight');
  await ellyInput.press('Enter');
  await page.waitForFunction(
    (i) => /Confirmed in tonight/.test(document.querySelectorAll('#searchResults .why[data-panel="ask"]')[i].innerText),
    ellyAt);

  const text1 = await ellyPanel.innerText();
  t.ok('the user’s own question is shown', /is he in the lineup tonight/.test(text1));
  t.ok('the answer is shown', /Confirmed in tonight.*batting second/.test(text1));
  t.eq('no revision badge when the model did not send one', /Revised read/.test(text1), false);

  t.eq('exactly one call went to /api/ask', asked.length, 1);
  t.eq('the right player’s context was sent', asked[0].pick.player, 'Elly De La Cruz');
  t.eq('...with the tier', asked[0].pick.oddsType, 'goblin');
  t.eq('...and the recent5 the card carries', asked[0].pick.recent5, [1, 0, 2, 1, 1]);
  t.eq('the first turn carries just the one question', asked[0].messages.length, 1);
  t.eq('...role user', asked[0].messages[0].role, 'user');

  // ---- the OTHER card's panel is untouched ---------------------------------
  const carrollAt = (await nameOrder(page)).indexOf('Corbin Carroll');
  const carrollPanel = page.locator('#searchResults .why[data-panel="ask"]').nth(carrollAt);
  t.ok('a card nobody asked about stays empty', /Ask about lineup news/.test(await carrollPanel.innerText()));
  t.eq('...and stays closed', await carrollPanel.isHidden(), true);

  // ---- follow-up: the running thread actually carries prior turns ---------
  await ellyInput.fill('what about the recent form');
  await ellyInput.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#searchResults .askmsg.me').length >= n, 2);
  t.eq('the second call went out too', asked.length, 2);
  t.eq('a follow-up sends the WHOLE thread, not just the new question', asked[1].messages.length, 3);
  t.eq('...user, assistant, user in order',
    asked[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  t.eq('...the prior answer is included verbatim',
    asked[1].messages[1].content, 'Confirmed in tonight’s lineup, batting second.');

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- a genuine revision renders without touching the board's own number --
  const { page: page2 } = await renderBoard(browser, url, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      answer: 'He was just scratched with tightness — that changes things.', revisedProb: 0.15, usedSearch: true }),
  }));
  const at2 = (await nameOrder(page2)).indexOf('Elly De La Cruz');
  const pctBefore = (await page2.$$eval('#searchResults .pct', (els) => els.map((e) => e.textContent.trim())))[at2];
  const panel2 = page2.locator('#searchResults .why[data-panel="ask"]').nth(at2);
  await page2.locator('#searchResults .whybtn[data-panel="ask"]').nth(at2).click();
  await panel2.locator('.askinput').fill('any injury news');
  await panel2.locator('.askinput').press('Enter');
  await page2.waitForFunction(
    (i) => /Revised read/.test(document.querySelectorAll('#searchResults .why[data-panel="ask"]')[i].innerText),
    at2);
  const text2 = await panel2.innerText();
  t.ok('the revised probability is shown', /Revised read from this chat.*15%/.test(text2.replace(/\n/g, ' ')));
  const pctAfter = (await page2.$$eval('#searchResults .pct', (els) => els.map((e) => e.textContent.trim())))[at2];
  t.eq('the board’s own number is untouched by a chat-side revision', pctAfter, pctBefore);
  await page2.close();

  // ---- a failed request reads as a chat failure, not a broken page ---------
  const { page: page3, errors: errors3 } = await renderBoard(browser, url, (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }),
  }));
  const panel3 = page3.locator('#searchResults .why[data-panel="ask"]').first();
  await page3.locator('#searchResults .whybtn[data-panel="ask"]').first().click();
  await panel3.locator('.askinput').fill('any news');
  await panel3.locator('.askinput').press('Enter');
  await page3.waitForFunction(
    () => /Could not reach/.test(document.querySelector('#searchResults .why[data-panel="ask"]').innerText));
  t.ok('a server error surfaces inline, in the chat', /Could not reach the assistant/.test(await panel3.innerText()));
  t.eq('...and no JS error was thrown handling it', errors3, []);
  await page3.close();
}

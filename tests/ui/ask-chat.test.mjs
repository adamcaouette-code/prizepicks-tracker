// Per-pick "ask" chat, now living inside the board's "why" panel. A user asks
// a follow-up question about one specific prop; the answer comes back from
// /api/ask (Haiku), and if the model's own view genuinely moves it can hand
// back a revised probability — shown next to the board's own number, never
// silently replacing it.
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

// Both rows are POSITIVE-edge standards (needs 59.5%) on purpose: a leg below
// its own break-even carries no buttons at all, so it has no why panel and no
// ask thread to drive. That behaviour is board-results.test.mjs's to pin; this
// suite is about the chat itself.
const RESULT = { board: [
  { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'standard', image: null, start: TONIGHT_ET,
    key_risk: 'Facing a lefty.', reasoning: 'Cleared this line in 4 of the last 5.',
    recent5: [1, 0, 2, 1, 1], recentAvg: 1.0,
    oppSP: { name: 'Paul Skenes', throws: 'R', era: 2.14, whip: 0.95, k: 189 }, parkIndex: 104 },
  { player: 'Corbin Carroll', team: 'ARI', matchup: 'ARI vs SD', stat: 'Total Bases', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.64, oddsType: 'standard', image: null, start: TONIGHT_ET },
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

// Opens the "why" panel for the leg at index `at` (the ask thread now lives at
// the bottom of it, below the audit strip / pass compare / provenance) and
// returns a Locator scoped to that one panel.
async function openWhy(page, at) {
  const btn = page.locator('#searchResults .whybtn[data-panel="why"]').nth(at);
  const panel = page.locator('#searchResults .why[data-panel="why"]').nth(at);
  await btn.click();
  await panel.waitFor({ state: 'visible' });
  return { btn, panel };
}

export default async function ({ t, url, browser }) {
  // ---- basic round trip, one card ------------------------------------------
  const asked = [];
  const { page, errors, unstubbed } = await renderBoard(browser, url, (route, request) => {
    asked.push(JSON.parse(request.postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      answer: 'Confirmed in tonight’s lineup, batting second.', revisedProb: null, usedSearch: true }) });
  });

  // Every pick gets a why button now — the audit strip and provenance are
  // always available, and the ask thread lives inside it, so this is the one
  // place a pick's own follow-up chat is always reachable (UI-CONTRACT §6:
  // "ask is available everywhere a pick appears").
  t.eq('every pick gets a why button', await page.locator('#searchResults .whybtn[data-panel="why"]').count(), 2);
  t.eq('panels start collapsed',
    await page.$$eval('#searchResults .why[data-panel="why"]', (w) => w.map((x) => x.hidden)), [true, true]);

  const ellyAt = (await nameOrder(page)).indexOf('Elly De La Cruz');
  const { btn: ellyBtn, panel: ellyPanel } = await openWhy(page, ellyAt);
  const ellyInput = ellyPanel.locator('.askinput');

  t.eq('button flips open', (await ellyBtn.textContent()).trim(), 'why ↑');
  t.ok('an empty thread prompts rather than showing nothing',
    /Ask about lineup news/.test(await ellyPanel.innerText()));

  await ellyInput.fill('is he in the lineup tonight');
  await ellyInput.press('Enter');
  await page.waitForFunction(
    (i) => /Confirmed in tonight/.test(document.querySelectorAll('#searchResults .why[data-panel="why"]')[i].innerText),
    ellyAt);

  const text1 = await ellyPanel.innerText();
  t.ok('the user’s own question is shown', /is he in the lineup tonight/.test(text1));
  t.ok('the answer is shown', /Confirmed in tonight.*batting second/.test(text1));
  t.eq('no revision badge when the model did not send one', /Revised read/.test(text1), false);

  t.eq('exactly one call went to /api/ask', asked.length, 1);
  t.eq('the right player’s context was sent', asked[0].pick.player, 'Elly De La Cruz');
  t.eq('...with the tier', asked[0].pick.oddsType, 'standard');
  t.eq('...and the recent5 the card carries', asked[0].pick.recent5, [1, 0, 2, 1, 1]);
  t.eq('the first turn carries just the one question', asked[0].messages.length, 1);
  t.eq('...role user', asked[0].messages[0].role, 'user');

  // ---- the OTHER card's panel is untouched ---------------------------------
  const carrollAt = (await nameOrder(page)).indexOf('Corbin Carroll');
  const carrollPanel = page.locator('#searchResults .why[data-panel="why"]').nth(carrollAt);
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
  const { panel: panel2 } = await openWhy(page2, at2);
  await panel2.locator('.askinput').fill('any injury news');
  await panel2.locator('.askinput').press('Enter');
  await page2.waitForFunction(
    (i) => /Revised read/.test(document.querySelectorAll('#searchResults .why[data-panel="why"]')[i].innerText),
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
  const { panel: panel3 } = await openWhy(page3, 0);
  await panel3.locator('.askinput').fill('any news');
  await panel3.locator('.askinput').press('Enter');
  await page3.waitForFunction(
    () => /Could not reach/.test(document.querySelector('#searchResults .why[data-panel="why"]').innerText));
  t.ok('a server error surfaces inline, in the chat', /Could not reach the assistant/.test(await panel3.innerText()));
  t.eq('...and no JS error was thrown handling it', errors3, []);
  await page3.close();
}

// The empty board offers to scan the next game day.
//
// CFB plays Saturday plus the odd Thursday or Friday; NFL plays Sunday, Monday
// and Thursday. On every other morning their whole posted board is dated
// forward, "today" is empty, and the app's answer was a sentence telling you to
// come back in three days — while the board it would scan was already posted.
//
// Two failure modes are guarded here, and the second is the dangerous one:
//   1. the offer never appears, so the feature is unreachable from the screen
//      that needs it
//   2. a board of FRIDAY's games renders looking exactly like a board of
//      tonight's, with nothing saying otherwise

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS } from '../fixtures/api.mjs';

const EMPTY = {
  board: [], params: { league: 'cfb', legs: 3 },
  emptyMessage: "No CFB games today — the next posted slate is 2026-09-11. This league doesn't play daily like MLB.",
  parlay: { error: "No CFB games today — the next posted slate is 2026-09-11. This league doesn't play daily like MLB." },
  slate: { date: null, usedNext: false, nextAvailable: '2026-09-11' },
};

const FRIDAY = {
  board: [
    { player: 'Friday Guy', team: 'OU', matchup: 'OU vs TEX', stat: 'Rec TDs', line: 0.5, pick: 'over',
      verdict: 'play', prob: 0.66, oddsType: 'standard', start: '2026-09-11T20:00:00.000-04:00',
      key_risk: 'k', reasoning: 'r' },
  ],
  params: { league: 'cfb', legs: 3 },
  slate: { date: '2026-09-11', usedNext: true, nextAvailable: null },
  // A pick thrown away because the judge priced it off a game that has not been
  // played. Dropping it is right; dropping it silently would leave a board one
  // pick shorter with no reason given.
  staleReads: [{ player: 'Donovan Olugbode', stat: 'Receiving Yards', prob: 0.99,
    why: 'the judge read this as a game already played — it has not started yet' }],
};

// Two runs, two different answers — which jobRoutes' single fixed result can't
// express, and the whole point here is what the SECOND run returns.
function sequencedRoutes() {
  const posts = [];
  let run = 0, polls = 0;
  return {
    posts,
    '**/api/bet-finder-background': (route, request) => {
      posts.push(JSON.parse(request.postData() || '{}'));
      run++; polls = 0;
      route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    },
    '**/api/bet-finder-status*': (route) => {
      polls++;
      const body = polls <= 1
        ? { status: 'running', step: 'working', typicalMs: 1000 }
        : { status: 'done', result: run === 1 ? EMPTY : FRIDAY };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    },
  };
}

export default async function ({ t, url, browser }) {
  const seq = sequencedRoutes();
  const app = await openApp(browser, {
    url,
    routes: { '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...seq },
  });
  const { page, errors } = app;

  await page.click('#tabBtnSearch');
  await page.waitForSelector('#runBtn');
  await page.click('#runBtn');
  await page.waitForSelector('#searchResults .empty', { timeout: 30000 });

  // ---- the offer -----------------------------------------------------------
  const emptyText = await page.$eval('#searchResults .empty', (e) => e.textContent);
  t.ok('the empty board still says why it is empty', /no cfb games today/i.test(emptyText), emptyText);
  t.ok('...and no longer tells you to rerun the scan in three days',
    !/rerun the scan/i.test(emptyText), emptyText);
  await page.waitForSelector('#scanNextBtn', { timeout: 5000 });
  t.eq('it offers the actual next date as a button',
    (await page.$eval('#scanNextBtn', (e) => e.textContent.trim())), 'Scan 2026-09-11 instead →');

  // ---- one click, and the request says what it should ----------------------
  await page.click('#scanNextBtn');
  await page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  t.eq('the run it fires asks for the next slate', seq.posts[1]?.slate, 'next');
  t.eq('...and the first run did not, so the default is untouched', seq.posts[0]?.slate, undefined);
  t.eq('the board renders the next slate’s picks',
    await page.$$eval('#searchResults .leg .name', (els) => els.map((e) => e.textContent.trim())),
    ['Friday Guy']);

  // ---- the dangerous half: it must not look like tonight -------------------
  const banner = await page.$eval('#searchResults', (e) => e.textContent);
  t.ok('the board says out loud which day it is showing', /Showing 2026-09-11/.test(banner), banner.slice(0, 200));
  t.ok('...and why, so it is not mistaken for tonight',
    /no CFB games today/i.test(banner) && /next posted slate/i.test(banner), banner.slice(0, 300));
  t.ok('...and warns that a future board can still move',
    /can still move before then/i.test(banner), banner.slice(0, 300));

  // ---- it is one-shot, not sticky -----------------------------------------
  // A forward scan is a deliberate act. If the flag stuck, the next ordinary
  // Find Bets would silently keep scanning a future date.
  await page.click('#runBtn');
  await page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  t.eq('a following ordinary run does NOT carry the flag over', seq.posts[2]?.slate, undefined);

  // ---- the standing preference, for someone who wants it every time --------
  await page.click('#tabBtnSearch');
  await page.check('#nextSlateToggle');
  await page.click('#runBtn');
  await page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  t.eq('the checkbox makes it the standing behaviour', seq.posts[3]?.slate, 'next');

  // ---- discarded picks are reported, not silently missing ------------------
  const page1 = await page.$eval('#searchResults', (e) => e.textContent);
  t.ok('the board says a pick was discarded', /1 pick discarded/.test(page1), page1.slice(0, 300));
  t.ok('...names it, so it can be checked',
    /Donovan Olugbode/.test(page1) && /99%/.test(page1), page1.slice(0, 400));
  t.ok('...and says why, in terms of the thing that was actually wrong',
    /game had already been played/.test(page1) && /hasn.t started/.test(page1), page1.slice(0, 500));
  t.ok('the discarded pick is not among the rows',
    !(await page.$$eval('#searchResults .leg .name', (els) => els.map((e) => e.textContent.trim())))
      .includes('Donovan Olugbode'), '');

  t.eq('no JS errors', errors, []);
}

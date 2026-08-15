// MLB enrichment on the board.
//
// The rule the user set: everything from the MLB Stats API loads in the
// background or on demand, EXCEPT injuries — a prop on a player who isn't
// active isn't a bet, so that has to be visible before you tap. Headshots and
// team logos just appear (they're deterministic from ids the run already has);
// the deep numbers cost a request and so are fetched only when opened.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

const HEAD = (id) => `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best,f_auto/v1/people/${id}/headshot/67/current`;
const LOGO = (id) => `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg`;

const RESULT = { board: [
  { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'play', prob: 0.68, oddsType: 'goblin', projectionId: 'PP-A',
    headshot: HEAD(5001), teamLogo: LOGO(113), teamLogoFallback: 'https://a.espncdn.com/i/teamlogos/mlb/500/cin.png',
    mlbId: 5001, key_risk: 'k', reasoning: 'r' },
  { player: 'Hurt Guy', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 1.5, pick: 'over',
    verdict: 'lean', prob: 0.61, oddsType: 'standard', projectionId: 'PP-B',
    headshot: HEAD(5002), teamLogo: LOGO(113), mlbId: 5002,
    injured: '10-Day Injured List', key_risk: 'k', reasoning: 'r' },
  { player: 'No Mlb Match', team: 'PIT', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5, pick: 'over',
    verdict: 'lean', prob: 0.60, oddsType: 'standard', projectionId: 'PP-C', key_risk: 'k', reasoning: 'r' },
], mlbInjuries: { CIN: [{ name: 'Hurt Guy', position: 'OF', status: '10-Day Injured List' }] },
   params: { league: 'mlb' } };

const PLAYER = { id: 5001, name: 'Elly De La Cruz', group: 'hitting', position: 'SS', bats: 'S', throws: 'R',
  headshot: HEAD(5001), teamLogo: LOGO(113),
  season: { avg: '.281', obp: '.340', slg: '.510', ops: '.850', hr: 22, rbi: 71, sb: 51, ab: 480, games: 128 },
  last10: [
    { date: '2026-08-13', opp: 'PIT', home: true, ab: 4, h: 2, hr: 0, rbi: 1, so: 1, tb: 3 },
    { date: '2026-08-12', opp: 'STL', home: false, ab: 5, h: 0, hr: 0, rbi: 0, so: 3, tb: 0 },
  ],
  splits: { vsLHP: { avg: '.310', ops: '.920', hr: 8, ab: 140 }, vsRHP: { avg: '.268', ops: '.815', hr: 14, ab: 340 } } };

export default async function ({ t, url, browser }) {
  let playerCalls = 0;
  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/mlb-stats*': (route, request) => {
      playerCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAYER) });
    },
    ...jobRoutes('bet-finder', RESULT),
  }});

  await page.click('#tabBtnSearch');
  await page.click('#runBtn');
  await page.waitForSelector('#searchResults .leg');

  // ---- injuries are NOT lazy ---------------------------------------------
  t.eq('the deep MLB endpoint is untouched until something is opened', playerCalls, 0);

  const injCard = await page.$('#searchResults .leg.hurt');
  t.ok('an inactive player\'s card is marked', !!injCard);
  const flag = await page.textContent('#searchResults .leg.hurt .injflag');
  t.ok('the card states the status and that he is not expected to play',
    /10-Day Injured List/.test(flag) && /not expected to play/.test(flag), flag.trim());
  t.eq('only the injured card is marked', await page.$$eval('#searchResults .injflag', f => f.length), 1);

  // The always-open slate-wide list is gone: it ran to ~90 names a team off the
  // full org roster, which you had to scroll past to reach the picks.
  t.eq('no wall-of-text injury report above the board',
    await page.$$eval('#searchResults .injbox', b => b.length), 0);

  // Per card, on demand, and only about THIS player and HIS team.
  const injBtns = await page.$$('#searchResults .whybtn[data-panel="inj"]');
  t.eq('every card offers its own injuries toggle', injBtns.length, 3);
  t.eq('injury panels start closed',
    await page.$$eval('#searchResults .why[data-panel="inj"]', ps => ps.map(x => x.hidden)), [true, true, true]);

  await injBtns[1].click();   // the injured player's card
  await page.waitForFunction(() => {
    const ps = document.querySelectorAll('#searchResults .why[data-panel="inj"]');
    return ps[1] && !ps[1].hidden;
  });
  const hurtPanel = await page.$$eval('#searchResults .why[data-panel="inj"]',
    ps => ps[1].innerText.replace(/\s+/g, ' '));
  t.ok('the panel leads with THIS player\'s own status',
    /Hurt Guy.*10-Day Injured List.*not expected to play/.test(hurtPanel), hurtPanel.slice(0, 110));
  t.ok('...and says nobody else on his team is out, when nobody is',
    /No one else on CIN/.test(hurtPanel), hurtPanel.slice(0, 200));
  t.ok('no other team appears anywhere in it', !/PIT|LAD|SFG/.test(hurtPanel), hurtPanel.slice(0, 200));

  await injBtns[0].click();   // a healthy player on the same team
  await page.waitForFunction(() => !document.querySelectorAll('#searchResults .why[data-panel="inj"]')[0].hidden);
  const healthy = await page.$$eval('#searchResults .why[data-panel="inj"]', ps => ps[0].innerText.replace(/\s+/g, ' '));
  t.ok('a healthy player is stated as having no designation',
    /No injury designation/.test(healthy), healthy.slice(0, 90));
  t.ok('...and his injured teammate IS listed', /Hurt Guy/.test(healthy) && /1 OUT/.test(healthy), healthy.slice(0, 160));

  // ---- headshots and logos just appear -----------------------------------
  const avatars = await page.$$eval('#searchResults .avatar img', els => els.map(e => e.getAttribute('src')));
  t.eq('players resolved to an MLB id get a real headshot, no request needed', avatars.length, 2);
  t.ok('...pointed at the MLB photo CDN', avatars.every(s => /mlbstatic\.com.*headshot/.test(s)), avatars[0]);

  // NOTE: this environment can't reach the MLB CDN, so the first logo's onerror
  // has already swapped it to the ESPN PNG by the time we look — which is the
  // fallback chain working, and worth asserting as such. The second card has no
  // fallback configured, so its src stays as authored and shows the intent.
  const logos = await page.$$eval('#searchResults .tlogo', els => els.map(e => ({ src: e.getAttribute('src'), onerr: e.getAttribute('onerror') })));
  t.eq('cards with a resolved team carry a cap logo', logos.length, 2);
  t.ok('the authored mark is the CAP variant, not the primary wordmark',
    /team-cap-on-dark/.test(logos[1].src), logos[1].src);
  t.ok('a card with a fallback falls back to the ESPN PNG when the SVG fails',
    /espncdn/.test(logos[0].src), logos[0].src);
  t.ok('a card with no fallback hides the whole mark slot rather than leaving a broken image',
    /tmark.*display=.none./.test(logos[1].onerr || ''), logos[1].onerr);

  // The mark lives in the dead space between the name block and the numbers —
  // not inline with the matchup text, where it was too small to identify.
  const geom = await page.$$eval('#searchResults .leg', legs => legs.map(leg => {
    const mark = leg.querySelector('.tmark');
    const info = leg.querySelector('.info');
    const right = leg.querySelector('.stat-right');
    if (!mark) return null;
    const m = mark.getBoundingClientRect(), i = info.getBoundingClientRect(), r = right.getBoundingClientRect();
    return { w: Math.round(m.width), afterInfo: m.left >= i.right - 1, beforeStats: m.right <= r.left + 1,
      insideMatchup: !!leg.querySelector('.team .tlogo'), legW: Math.round(leg.getBoundingClientRect().width) };
  }).filter(Boolean));
  t.eq('two cards carry a mark', geom.length, 2);
  t.ok('the mark is big enough to identify a team', geom[0].w >= 28, `${geom[0].w}px`);
  t.ok('...sits after the name block', geom[0].afterInfo);
  t.ok('...and before the numbers', geom[0].beforeStats);
  t.ok('...and is no longer crammed inline with the matchup text', !geom[0].insideMatchup);

  // A card with no resolved team must not leave a hole where the mark would be.
  const noMark = await page.$$eval('#searchResults .leg', legs =>
    legs.filter(l => !l.querySelector('.tmark')).map(l => l.querySelector('.info') ? 'laid out' : 'broken'));
  t.eq('a card with no MLB match still lays out normally, with no gap', noMark, ['laid out']);

  // ---- the deep numbers are lazy -----------------------------------------
  const mlbBtns = await page.$$('#searchResults .whybtn[data-panel="mlb"]');
  t.eq('an "mlb" toggle only where a personId resolved', mlbBtns.length, 2);
  t.eq('still no request before opening one', playerCalls, 0);

  await mlbBtns[0].click();
  await page.waitForFunction(() => {
    const p = document.querySelector('#searchResults .why[data-panel="mlb"]');
    return p && !p.hidden && /SEASON/.test(p.textContent);
  }, null, { timeout: 15000 });
  t.eq('opening it fetches exactly once', playerCalls, 1);

  const panel = await page.$eval('#searchResults .why[data-panel="mlb"]', e => e.innerText.replace(/\s+/g, ' '));
  t.ok('season line rendered', /AVG \.281/.test(panel) && /OPS \.850/.test(panel), panel.slice(0, 90));
  t.ok('handedness shown, which is the whole point of a platoon split', /B:S/.test(panel) && /T:R/.test(panel));
  t.ok('platoon splits rendered', /vs LHP/.test(panel) && /vs RHP/.test(panel));
  t.ok('...with the actual numbers', /\.310/.test(panel) && /\.268/.test(panel));
  t.ok('the game log is shown with opponents', /LAST 2/.test(panel) && /vs PIT/.test(panel) && /@STL/.test(panel));
  t.ok('sourced to MLB so it reads as data', /· MLB/.test(panel));

  await mlbBtns[0].click();
  await page.waitForFunction(() => document.querySelector('#searchResults .why[data-panel="mlb"]').hidden);
  await mlbBtns[0].click();
  await page.waitForFunction(() => !document.querySelector('#searchResults .why[data-panel="mlb"]').hidden);
  t.eq('reopening reuses the cached response instead of refetching', playerCalls, 1);

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- the MLB API being down must not break the board -------------------
  const down = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS,
    '**/api/mlb-stats*': (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }),
    ...jobRoutes('bet-finder', RESULT),
  }});
  await down.page.click('#tabBtnSearch');
  await down.page.click('#runBtn');
  await down.page.waitForSelector('#searchResults .leg');
  t.eq('the board still renders in full', await down.page.$$eval('#searchResults .leg', l => l.length), 3);
  await (await down.page.$$('#searchResults .whybtn[data-panel="mlb"]'))[0].click();
  await down.page.waitForFunction(() => {
    const p = document.querySelector('#searchResults .why[data-panel="mlb"]');
    return p && !p.hidden && /unavailable/i.test(p.textContent);
  }, null, { timeout: 15000 });
  t.ok('a dead MLB endpoint reads as "unavailable", not as a broken card', true);
  t.eq('and produces no JS errors', down.errors, []);
  await down.page.close();
}

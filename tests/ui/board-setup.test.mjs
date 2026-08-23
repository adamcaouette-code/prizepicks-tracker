// League chips + prop chips on the Search tab.
//
// Replaces the pre-redesign suites that drove `#chans` and a `<select id=propFilter>`.
// The current UI renders both as horizontal chip rails (#leagueScroll, #propScroll),
// which changes the failure modes worth guarding:
//
//   - the rails are drag-to-scroll, and pointer capture during a drag once ate the
//     taps that select a league (the chips ARE the navigation, so that must work);
//   - PrizePicks carries two names per stat and the chip must LABEL with one and
//     SUBMIT the other, or the engine filters on a string the board doesn't have;
//   - when /api/pp-leagues is down the hardcoded fallback chips have to stay usable,
//     because a dead endpoint should cost you the long league list, not the app.

import { openApp, freezeClock } from '../helpers/browser.mjs';
import { LEAGUES, STATS, BOARD, jobRoutes } from '../fixtures/api.mjs';

export default async function ({ t, url, browser }) {
  // ---- live endpoints ----------------------------------------------------
  const statsFor = [];
  const job = jobRoutes('bet-finder', BOARD);
  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': (route, request) => {
      statsFor.push(new URL(request.url()).searchParams.get('league'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATS) });
    },
    ...job,
  }});

  await page.click('#tabBtnSearch');
  await page.waitForSelector('#leagueScroll .leaguechip');

  const chips = () => page.$$eval('#leagueScroll .leaguechip',
    els => els.map(e => ({ label: e.textContent.trim(), tag: e.dataset.tag, active: e.classList.contains('active') })));

  const live = await chips();
  t.note('leagues: ' + live.map(c => c.label).join(' | '));
  t.eq('live league list replaces the built-in fallback', live.length, LEAGUES.leagues.length);
  t.eq('first league is selected by default', live[0].tag, 'mlb');
  t.ok('slate size is shown on the chip', /2941/.test(live[0].label), live[0].label);
  t.ok('World Cup is gone', !live.some(c => /world cup/i.test(c.label)));

  // ---- prop chips: label with the display name, submit the stat_type ------
  await page.waitForSelector('#propScroll .propchip');
  const props = await page.$$eval('#propScroll .propchip',
    els => els.map(e => ({ label: e.textContent.trim(), value: e.dataset.v, active: e.classList.contains('active') })));
  t.eq('"All props" leads and is selected', [props[0].label, props[0].value, props[0].active], ['All props', '', true]);
  const ks = props.find(p => p.label.startsWith('Hitter Ks'));
  t.ok('chip is labelled with the name on the PrizePicks card', !!ks, ks && ks.label);
  t.eq('...but submits stat_type, which is what the engine filters on', ks && ks.value, 'Hitter Strikeouts');

  // ---- selecting a league drives the rest of the tab ---------------------
  await page.click('#leagueScroll .leaguechip[data-tag="cs2"]');
  await page.waitForFunction(() => document.querySelector('#leagueScroll .leaguechip[data-tag="cs2"]').classList.contains('active'));
  t.ok('a tap on a chip selects it (pointer capture does not eat the click)', true);
  t.ok('prop chips refetch for the newly selected league', statsFor.includes('cs2'), 'pp-stats called for: ' + statsFor.join(', '));

  // ---- derived boards must announce themselves ---------------------------
  await page.click('#leagueScroll .leaguechip[data-tag="nflszn"]');
  await page.waitForFunction(() => !document.getElementById('leagueInfo').hidden);
  const info = (await page.textContent('#leagueInfo')).trim();
  t.note(info.slice(0, 100));
  t.ok('season-long board is flagged as not-tonight', /SEASON/.test(info), info.slice(0, 40));
  t.ok('props-only board warns that research is missing', /PROPS ONLY/.test(info));

  await page.click('#leagueScroll .leaguechip[data-tag="mlb"]');
  await page.waitForFunction(() => document.getElementById('leagueInfo').hidden);
  t.ok('warning clears on a fully-researched league', true);

  // ---- the judge picker ---------------------------------------------------
  // Two judge versions exist so they can be compared. A picker that silently
  // always sends the same one would make every comparison a comparison of
  // Aphrodite with itself, and nothing about the page would look wrong.
  t.eq('both judges are offered, Aphrodite active by default',
    await page.$$eval('#judges .sidebtn',
      els => els.map(e => ({ v: e.dataset.v, active: e.classList.contains('active') }))),
    [{ v: 'aphrodite', active: true }, { v: 'psyche', active: false }]);

  // ---- the selection reaches the POST -----------------------------------
  await page.click('#propScroll .propchip[data-v="Hitter Strikeouts"]');
  await page.click('#runBtn');
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled, null, { timeout: 30000 });
  t.eq('run posts the selected league', job.sent.league, 'mlb');
  t.eq('run posts the selected prop as stat_type', job.sent.statFilter, 'Hitter Strikeouts');
  t.eq('run posts the active tiers', job.sent.tiers, ['goblin', 'standard']);
  t.eq('run posts the selected judge', job.sent.prompt, 'aphrodite');
  t.eq('a normal run does NOT ask for balancing', job.sent.balance, undefined);
  t.eq('run posts the selected model', job.sent.model, 'claude-haiku-4-5-20251001');
  t.eq('Vilifiant is the default, and named in the user\'s language not a model id',
    await page.$eval('#models .sidebtn.active', el => el.textContent.trim()), 'VILIFIANT');
  t.ok('run mints a jobId', typeof job.sent.jobId === 'string' && job.sent.jobId.length > 8, job.sent.jobId);

  // Switching to the original must actually switch it — the whole archive is
  // pointless if the old judge cannot be reached from the page.
  await page.click('#judges .sidebtn[data-v="psyche"]');
  await page.click('#runBtn');
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled, null, { timeout: 30000 });
  t.eq('picking Psyche posts Psyche', job.sent.prompt, 'psyche');
  // Cheaper models are the only way to buy more graded picks on a fixed budget,
  // so the picker has to actually reach the run — a control that silently always
  // sends Opus would look identical and cost 5x.
  await page.click('#models .sidebtn[data-v="claude-opus-4-8"]');
  await page.click('#runBtn');
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled, null, { timeout: 30000 });
  t.eq('the expensive model is still one click away', job.sent.model, 'claude-opus-4-8');

  // ---- the balanced calibration run --------------------------------------
  // Demon is deliberately NOT active by default in the tier chips, so a normal
  // run produces no demons and the tier gap — the whole point of the behaviour
  // table — cannot be computed. The balanced run has to override that itself,
  // or it silently measures nothing.
  t.eq('demon is off by default, which is why a balanced run must override it',
    await page.$eval('#tiers .tier[data-v="demon"]', el => el.classList.contains('active')), false);

  await page.click('#calBtn');
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled, null, { timeout: 30000 });
  t.eq('a balanced run asks for it explicitly', job.sent.balance, true);
  t.eq('...and forces all three tiers regardless of the chips',
    job.sent.tiers.slice().sort(), ['demon', 'goblin', 'standard']);

  // One run only. A sticky flag would quietly turn every later search into a
  // measurement sample, which is a worse board to bet from.
  await page.click('#runBtn');
  await page.waitForFunction(() => !document.getElementById('runBtn').disabled, null, { timeout: 30000 });
  t.eq('the next ordinary run is not balanced', job.sent.balance, undefined);
  t.eq('...and goes back to the chips the user actually picked',
    job.sent.tiers, ['goblin', 'standard']);
  t.eq('...and is exclusive, not additive',
    await page.$$eval('#judges .sidebtn.active', els => els.map(e => e.dataset.v)), ['psyche']);

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- endpoint down: fallback chips must still work ---------------------
  const down = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }),
    '**/api/pp-stats*': (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }),
    ...jobRoutes('bet-finder', BOARD),
  }});
  await down.page.click('#tabBtnSearch');
  await down.page.waitForSelector('#leagueScroll .leaguechip');
  const fallback = await down.page.$$eval('#leagueScroll .leaguechip', els => els.map(e => e.dataset.tag));
  t.note('fallback leagues: ' + fallback.join(', '));
  t.ok('fallback chips render when pp-leagues is down', fallback.length > 0, fallback.join(','));
  await down.page.click('#leagueScroll .leaguechip[data-tag="wnba"]');
  await down.page.waitForFunction(() => document.querySelector('#leagueScroll .leaguechip[data-tag="wnba"]').classList.contains('active'));
  t.ok('fallback chips are still selectable', true);
  const allProps = await down.page.$$eval('#propScroll .propchip', els => els.map(e => e.textContent.trim()));
  t.eq('"All props" survives a dead pp-stats, so a run is still possible', allProps, ['All props']);
  t.eq('a dead endpoint produces no JS errors', down.errors, []);
  await down.page.close();
}

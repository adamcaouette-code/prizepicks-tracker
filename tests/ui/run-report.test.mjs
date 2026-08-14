// The run report: every heavy run prints its own timing breakdown.
//
// This exists so "it felt slow" never has to be the whole bug report. Three
// surfaces have to agree: the browser console line, window.__atombets.last (for
// copy-paste), and the on-screen panel (phones have no console). And all three
// have to degrade silently when the deployed function is older than the page and
// sends no timing at all — a missing diagnostic must never break a run.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';

const PICK = { player: 'Elly De La Cruz', team: 'CIN', matchup: 'CIN vs PIT', stat: 'Hits', line: 0.5,
  pick: 'over', verdict: 'play', prob: 0.68, oddsType: 'goblin', image: null };

const TIMED = { board: [PICK],
  timing: { totalMs: 41200, rows: 2941, candidates: 44,
    pieces: { props: 8100, judge: 26400, history: 5200, starters: 3100, records: 900, odds: 700 } },
  params: { league: 'mlb', legs: 3 },
  oddsStatus: { status: 'ok', message: 'Win% loaded for 30 team(s).' } };

const UNTIMED = { board: [PICK] };   // an older deployed function

async function run(browser, url, result) {
  const app = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('bet-finder', result) } });
  const logs = [];
  app.page.on('console', (m) => { if (m.type() === 'log') logs.push(m.text()); });
  await app.page.click('#tabBtnSearch');
  await app.page.click('#runBtn');
  await app.page.waitForSelector('#searchResults .leg', { timeout: 30000 });
  return { ...app, logs };
}

export default async function ({ t, url, browser }) {
  const { page, errors, logs } = await run(browser, url, TIMED);

  // ---- console ------------------------------------------------------------
  const line = logs.find((l) => l.includes('[AtomBets]'));
  t.ok('a run report is printed to the console', !!line, (line || '').split('\n')[0]);
  t.ok('headline carries wall time in seconds', /41\.2s wall/.test(line || ''), (line || '').split('\n')[0]);
  t.ok('headline carries board size', /2941 props/.test(line || '') && /44 candidates/.test(line || ''));
  // Order matters: the point of the report is that the top line names the
  // bottleneck. Read the indented piece rows only — the headline also says
  // "props" (as in "2941 props"), which is a different thing.
  const pieceOrder = (line || '').split('\n')
    .filter((l) => /^ {4}\w/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  t.eq('pieces are listed slowest first', pieceOrder,
    ['judge', 'props', 'history', 'starters', 'records', 'odds']);
  t.ok('the slowest piece carries its duration', /judge\s+26\.4s/.test(line || ''));
  t.ok('warns that concurrent pieces do not sum to wall time', /wall time ≠ sum/.test(line || ''));

  // ---- copyable object ----------------------------------------------------
  const last = await page.evaluate(() => window.__atombets && window.__atombets.last);
  t.eq('window.__atombets.last records the kind of run', last && last.kind, 'find bets');
  t.eq('...the full timing object', last && last.timing.pieces.judge, 26400);
  t.eq('...the params the run used', last && last.params.league, 'mlb');
  t.eq('...and the odds status, which explains a missing win%', last && last.oddsStatus.status, 'ok');
  const count = await page.evaluate(() => window.__atombets.runs.length);
  t.eq('runs accumulate for comparison across a session', count, 1);

  // ---- on-screen panel (a phone has no console) ---------------------------
  t.ok('the timing link appears once a run has reported', await page.isVisible('#runReportRow'));
  t.ok('the panel starts collapsed', !(await page.isVisible('#runReportBox')));
  await page.click('#runReportBtn');
  await page.waitForFunction(() => !document.getElementById('runReportBox').hidden);
  const box = await page.textContent('#runReportBox');
  t.ok('panel shows the same headline', /41\.2s wall/.test(box));
  t.ok('panel shows the per-piece breakdown', /judge\s+26\.4s/.test(box));
  t.ok('panel embeds the full JSON for pasting', /"totalMs": 41200/.test(box));
  const selectable = await page.$eval('#runReportBox', el => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
  t.eq('panel is tap-to-select-all so it can be copied off a phone', selectable, 'all');
  await page.click('#runReportBtn');
  await page.waitForFunction(() => document.getElementById('runReportBox').hidden);
  t.ok('panel toggles closed again', true);

  t.eq('no JS errors', errors, []);
  await page.close();

  // ---- an older function that sends no timing -----------------------------
  const old = await run(browser, url, UNTIMED);
  t.ok('no report is invented when the function sends no timing',
    !old.logs.some((l) => l.includes('[AtomBets]')));
  t.ok('the timing link stays hidden', !(await old.page.isVisible('#runReportRow')));
  t.eq('the board still renders normally', await old.page.$$eval('#searchResults .leg', l => l.length), 1);
  t.eq('and there are no JS errors', old.errors, []);
  await old.page.close();
}

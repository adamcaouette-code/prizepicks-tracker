// The Find Bets run must OVERLAP work, twice over:
//
//  1. Across phases — team records, MLB starters and opponent defense need only
//     the league tag, and the Odds API call needs the board only at its final
//     name-mapping step, so all of them start at t=0 alongside fetchProps. Only
//     recent form waits: it looks each candidate up by projection id.
//  2. Within the props pull — the board is ~12 pages and fetching them one at a
//     time was the single slowest stretch of a run. Page 1 goes alone (it carries
//     meta.total_pages), the rest go in parallel waves. Same for ESPN's
//     per-game starter summaries.
//
// Every outbound call is intercepted with a synthetic latency and stamped with
// when it was issued and how many of its kind were in flight — if either overlap
// regresses to sequential, the stamps say so and this fails.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const LAT = { catalog: 60, propsPage: 100, standings: 90, summary: 60, odds: 90, claude: 60 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Three pages: 1 and 2 full (250 rows), 3 short — so pagination must reach page 3.
function propsPage(page) {
  const full = page < 3;
  const n = full ? 250 : 40;
  const data = Array.from({ length: n }, (_, i) => ({
    id: `p${page}-${i}`, type: 'projection',
    attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: 0.5 + (i % 3),
      odds_type: i % 2 ? 'standard' : 'goblin', description: i % 2 ? 'PIT' : 'CIN',
      start_time: new Date().toISOString(), today: true },
    relationships: { new_player: { data: { id: i % 2 ? 'n2' : 'n1' } } },
  }));
  return { data, included: [
    { id: 'n1', type: 'new_player', attributes: { display_name: 'Elly De La Cruz', team: 'CIN', position: 'SS', market: 'Cincinnati' } },
    { id: 'n2', type: 'new_player', attributes: { display_name: 'Oneil Cruz', team: 'PIT', position: 'CF', market: 'Pittsburgh' } },
  ], meta: { total_pages: 3 } };
}

export default async function ({ t }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ODDS_API_KEY = 'test-odds';

  const T0 = Date.now();
  const starts = {};
  const ends = {};
  const live = { page: 0, summary: 0 };
  const peak = { page: 0, summary: 0 };
  const mark = async (label, ms, kind) => {
    if (starts[label] == null) starts[label] = Date.now() - T0;
    if (kind) { live[kind]++; peak[kind] = Math.max(peak[kind], live[kind]); }
    await sleep(ms);
    if (kind) live[kind]--;
    ends[label] = Date.now() - T0;
  };

  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => { await mark('catalog', LAT.catalog);
      return { data: [{ id: '2', type: 'league', attributes: { name: 'MLB', projections_count: 750 } }] }; }],
    ['partner-api.prizepicks.com/projections', async (url) => {
      const page = Number(new URL(url).searchParams.get('page')) || 1;
      await mark(`props_p${page}`, LAT.propsPage, 'page');
      return propsPage(page); }],
    ['/standings', async () => { await mark('records', LAT.standings); return { children: [] }; }],
    ['/scoreboard', async () => { await mark('scoreboard', 40);
      return { events: Array.from({ length: 8 }, (_, i) => ({ id: `ev${i}`, competitions: [{ competitors: [] }] })) }; }],
    ['/summary', async (url) => { const ev = new URL(url).searchParams.get('event');
      await mark(`summary_${ev}`, LAT.summary, 'summary'); return {}; }],
    ['the-odds-api.com', async () => { await mark('odds', LAT.odds); return []; }],
    ['/history', async () => { await mark('history', 20); return { games: [] }; }],
    ['api.anthropic.com', async () => { await mark('claude', LAT.claude);
      return { content: [{ type: 'text', text: JSON.stringify({ picks: [
        { player: 'Elly De La Cruz', stat: 'Hits', line: 0.5, verdict: 'play', prob: 0.7, key_risk: 'k', reasoning: 'r' },
        { player: 'Oneil Cruz', stat: 'Hits', line: 1.5, verdict: 'lean', prob: 0.6, key_risk: 'k', reasoning: 'r' },
      ] }) }], usage: {} }; }],
  ]);

  let done = null;
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'pipe1', league: 'mlb', legs: 2, bankroll: 100 }) });
    const { read } = await import('../helpers/blobs.mjs');
    done = read('bet-jobs', 'pipe1');
  } finally {
    mock.restore();
  }

  const propsEnd = Math.max(...Object.keys(ends).filter((k) => k.startsWith('props_p')).map((k) => ends[k]));
  t.note(Object.entries(starts).sort((a, b) => a[1] - b[1])
    .map(([k, v]) => `${k}@${v}→${ends[k] ?? '?'}`).join('  '));

  // ---- research overlaps the props pull -----------------------------------
  t.ok('team records start before the props pull finishes', starts.records < propsEnd, `records@${starts.records}, props done@${propsEnd}`);
  t.ok('MLB scoreboard starts before the props pull finishes', starts.scoreboard < propsEnd, `scoreboard@${starts.scoreboard}`);
  t.ok('odds request is issued before the props pull finishes', starts.odds < propsEnd, `odds@${starts.odds}`);
  t.ok('recent form waits for candidates (needs projection ids)',
    starts.history == null || starts.history >= propsEnd,
    starts.history == null ? 'no history calls' : `history@${starts.history}`);
  t.ok('the judge runs last, after every research piece settles',
    starts.claude >= Math.max(propsEnd, ends.records, ends.odds), `claude@${starts.claude}`);

  // ---- pagination is parallel after page 1 --------------------------------
  t.eq('all three board pages were fetched', ['props_p1', 'props_p2', 'props_p3'].every((k) => k in starts), true);
  t.ok('page 1 goes alone (it carries total_pages)', starts.props_p2 >= ends.props_p1, `p2@${starts.props_p2}, p1 done@${ends.props_p1}`);
  t.ok('later pages fetch concurrently, not one at a time', peak.page >= 2, `peak in-flight pages: ${peak.page}`);

  // ---- starter summaries are parallel -------------------------------------
  t.eq('every game got a summary call', Object.keys(starts).filter((k) => k.startsWith('summary_')).length, 8);
  t.ok('summaries fetch concurrently, not one at a time', peak.summary >= 2, `peak in-flight summaries: ${peak.summary}`);

  // ---- the run reports its own timing back to the browser -----------------
  // Without this the console report has nothing to print, and a slow run is
  // once again unfalsifiable.
  const tm = done?.result?.timing;
  t.ok('the finished job carries a timing block', !!tm);
  t.ok('every piece that ran is timed',
    ['props', 'records', 'odds', 'starters', 'history', 'judge'].every((k) => typeof tm?.pieces?.[k] === 'number'),
    JSON.stringify(tm?.pieces));
  t.ok('board size is reported', tm?.rows > 0 && tm?.candidates > 0, `${tm?.rows} rows, ${tm?.candidates} candidates`);
  t.ok('wall time is at least the slowest piece', tm.totalMs >= Math.max(...Object.values(tm.pieces)),
    `total ${tm.totalMs}ms`);
  t.ok('and LESS than the sum, proving the pieces really overlapped',
    tm.totalMs < Object.values(tm.pieces).reduce((a, b) => a + b, 0),
    `total ${tm.totalMs}ms vs sum ${Object.values(tm.pieces).reduce((a, b) => a + b, 0)}ms`);
}

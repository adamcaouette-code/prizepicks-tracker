// The Find Bets run must OVERLAP league research with the PrizePicks props pull.
//
// Team records, MLB starters and opponent defense need only the league tag, and
// the Odds API call needs the board only at its final name-mapping step — so all
// of them start at t=0 alongside fetchProps. Only recent form waits: it looks
// each candidate up by projection id. This suite intercepts every outbound call,
// gives each a chunky synthetic latency, and stamps when it was ISSUED — if the
// pipelining regresses to sequential, research start times jump to after the
// props fetch ends and this fails.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const LAT = { catalog: 60, props: 240, standings: 90, scoreboard: 90, odds: 90, claude: 60 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROPS_PAGE = {
  data: [
    { id: 'p1', type: 'projection', attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: 0.5, odds_type: 'goblin', description: 'CIN', start_time: new Date().toISOString(), today: true }, relationships: { new_player: { data: { id: 'n1' } } } },
    { id: 'p2', type: 'projection', attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: 1.5, odds_type: 'standard', description: 'PIT', start_time: new Date().toISOString(), today: true }, relationships: { new_player: { data: { id: 'n2' } } } },
  ],
  included: [
    { id: 'n1', type: 'new_player', attributes: { display_name: 'Elly De La Cruz', team: 'CIN', position: 'SS', market: 'Cincinnati' } },
    { id: 'n2', type: 'new_player', attributes: { display_name: 'Oneil Cruz', team: 'PIT', position: 'CF', market: 'Pittsburgh' } },
  ],
  meta: { total_pages: 1 },
};

export default async function ({ t }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ODDS_API_KEY = 'test-odds';

  const T0 = Date.now();
  const starts = {};
  const ends = {};
  const mark = async (label, ms) => {
    if (starts[label] == null) starts[label] = Date.now() - T0;
    await sleep(ms);
    ends[label] = Date.now() - T0;
  };

  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => { await mark('catalog', LAT.catalog);
      return { data: [{ id: '2', type: 'league', attributes: { name: 'MLB', projections_count: 500 } }] }; }],
    ['partner-api.prizepicks.com/projections', async () => { await mark('props', LAT.props); return PROPS_PAGE; }],
    ['/standings', async () => { await mark('records', LAT.standings); return { children: [] }; }],
    ['/scoreboard', async () => { await mark('starters', LAT.scoreboard); return { events: [] }; }],
    ['/summary', async () => ({})],
    ['the-odds-api.com', async () => { await mark('odds', LAT.odds); return []; }],
    [/projections\/p\d+\/history/, async () => { await mark('history', 20); return { games: [] }; }],
    ['api.anthropic.com', async () => { await mark('claude', LAT.claude);
      return { content: [{ type: 'text', text: JSON.stringify({ picks: [
        { player: 'Elly De La Cruz', stat: 'Hits', line: 0.5, verdict: 'play', prob: 0.7, key_risk: 'k', reasoning: 'r' },
        { player: 'Oneil Cruz', stat: 'Hits', line: 1.5, verdict: 'lean', prob: 0.6, key_risk: 'k', reasoning: 'r' },
      ] }) }], usage: {} }; }],
  ]);

  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'pipe1', league: 'mlb', legs: 2, bankroll: 100 }) });
  } finally {
    mock.restore();
  }

  t.note(Object.entries(starts).sort((a, b) => a[1] - b[1])
    .map(([k, v]) => `${k}@${v}ms→${ends[k] ?? '?'}ms`).join('  '));

  t.ok('team records start before props returns', starts.records < ends.props, `records@${starts.records}, props ends@${ends.props}`);
  t.ok('MLB starters start before props returns', starts.starters < ends.props, `starters@${starts.starters}`);
  t.ok('odds request is issued before props returns', starts.odds < ends.props, `odds@${starts.odds}`);
  t.ok('recent form waits for candidates (needs projection ids)',
    starts.history == null || starts.history >= ends.props,
    starts.history == null ? 'no history calls' : `history@${starts.history}`);
  t.ok('the judge runs last, after every research piece settles',
    starts.claude >= Math.max(ends.props, ends.records, ends.odds, ends.starters), `claude@${starts.claude}`);
}

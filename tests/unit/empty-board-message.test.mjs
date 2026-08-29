// A Find Bets run that returns zero candidates used to say the same thing no
// matter why: "No candidates — props not posted yet." That's wrong for the
// most common real case — a league that doesn't play daily (NFL, NHL, CFB,
// CBB) routinely has its WHOLE next slate posted days ahead, with nothing
// dated today. "Not posted yet" reads as a broken scan when the honest answer
// is "check back on game day, here's when that is."
//
// Three distinct causes, three distinct messages, all surfaced through the
// same emptyMessage field the UI already had wired for the OTHER empty-board
// cause (item M's demon-filtered-to-zero case) but never extended to this one.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const leagues = () => ({ data: [{ id: '9', type: 'league', attributes: { name: 'NFL', projections_count: 2000 } }] });

const proj = (rows) => ({
  data: rows.map((r, i) => ({
    id: `p${i}`, type: 'projection',
    attributes: { stat_type: r.stat, stat_display_name: r.stat, line_score: r.line,
      odds_type: r.tier || 'goblin', description: 'OPP', start_time: r.start,
      ...(r.today !== undefined ? { today: r.today } : {}) },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player || `Player ${i}`, team: 'TOR', position: r.position || 'WR', market: 'TOR' } })),
  meta: { total_pages: 1 },
});

export default async function ({ t }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { handler } = await loadFn('bet-finder-background.js');
  const { read } = await import('../helpers/blobs.mjs');

  // ---- cause 1: a real board, just none of it dated today ------------------
  // No `today` field at all (PrizePicks leaves it null on a future slate, per a
  // live probe against the real API), start_time two weeks out — exactly the
  // shape an NFL board has between the end of preseason and Week 1.
  reset();
  const futureMock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => leagues()],
    // Later date listed FIRST on purpose — the soonest slate must be picked by
    // sorting, not by whichever row the board happens to list first.
    ['partner-api.prizepicks.com/projections', async () => proj([
      { player: 'Future Gal', stat: 'Receptions', line: 4.5, start: '2026-09-10T20:00:00.000-04:00' },
      { player: 'Future Guy', stat: 'Receiving Yards', line: 45.5, start: '2026-09-09T20:00:00.000-04:00' },
    ])],
  ]);
  try {
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'empty1', league: 'nfl', legs: 3, today: true }) });
  } finally { futureMock.restore(); }
  const r1 = read('bet-jobs', 'empty1');
  t.eq('board is empty', (r1?.result?.board || []).length, 0);
  t.ok('names the actual next slate date, not a generic "not posted" line',
    /next posted slate starts 2026-09-09/.test(r1?.result?.emptyMessage || ''), r1?.result?.emptyMessage);
  t.ok('says this league does not play daily — the real reason, not a guess',
    /doesn't play daily/.test(r1?.result?.emptyMessage || ''));
  t.eq('parlay.error carries the same message, so nothing reading the old field breaks',
    r1?.result?.parlay?.error, r1?.result?.emptyMessage);

  // ---- cause 2: genuinely nothing posted at all -----------------------------
  reset();
  const deadMock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => leagues()],
    ['partner-api.prizepicks.com/projections', async () => proj([])],
  ]);
  try {
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'empty2', league: 'nfl', legs: 3, today: true }) });
  } finally { deadMock.restore(); }
  const r2 = read('bet-jobs', 'empty2');
  t.eq('a truly empty board keeps the original generic message',
    r2?.result?.emptyMessage, 'No candidates — props not posted yet.');

  // ---- cause 3: today's board is real, but nothing matches the tier filter --
  reset();
  const filteredMock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => leagues()],
    ['partner-api.prizepicks.com/projections', async () => proj([
      { player: 'Today Guy', stat: 'Receiving Yards', line: 45.5, tier: 'goblin', today: true, start: new Date().toISOString() },
    ])],
  ]);
  try {
    // Ask only for demon — the only row on the board is goblin.
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'empty3', league: 'nfl', legs: 3, today: true, tiers: ['demon'] }) });
  } finally { filteredMock.restore(); }
  const r3 = read('bet-jobs', 'empty3');
  t.ok('says props exist today but none matched the filter, not that nothing was posted',
    /1 NFL prop\(s\) today, but none matched/.test(r3?.result?.emptyMessage || ''), r3?.result?.emptyMessage);
}

// FULL SWEEP — exhaustive coverage instead of one sample.
//
// A normal Find Bets run judges one league, one slate, the tiers you picked,
// one side per prop. "No slip" then means "no slip in that one sample". The
// sweep runs the SAME candidate + judge + edge pipeline over every league with
// a slate in the window, all three tiers, both sides, so "no slip" becomes a
// statement about the whole opportunity space — reported with evidence whether
// or not anything cleared.
//
// Three things this suite pins:
//   1. the no-result path still returns a FULL coverage report;
//   2. sweptN (props evaluated to produce a slip) propagates onto the slip,
//      its legs, its pick-log rows, and the report;
//   3. a sweep applies the IDENTICAL edge gate a normal run applies — it
//      widens what gets evaluated, never what passes.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const BREAK_EVEN = { goblin: 2 ** (-1 / 3), standard: 4.75 ** (-1 / 3), demon: 12 ** (-1 / 3) };

// One projection per row. `today: true` so selectSlate keeps it on today's board.
const proj = (rows) => ({
  data: rows.map((r, i) => ({
    id: r.id || `pp-${i}`, type: 'projection',
    attributes: {
      stat_type: r.stat, stat_display_name: r.stat, line_score: r.line,
      odds_type: r.tier || 'standard', description: r.opp || 'OPP',
      allowed_wager_types: 'over',
      start_time: `${TODAY}T20:00:00.000-04:00`, today: true,
    },
    relationships: { new_player: { data: { id: `np-${r.id || i}` } } },
  })),
  included: rows.map((r, i) => ({
    id: `np-${r.id || i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team || 'AAA', position: r.pos || 'C', market: r.team || 'AAA' },
  })),
  meta: { total_pages: 1 },
});

// The judge echoes back every prop it was sent, at whatever probability the
// scenario assigned that player (default 0.5 — a weak over that clears nothing).
const answerWith = (probByPlayer) => async (init) => {
  const payload = String(JSON.parse(init.body).messages[0].content);
  const sent = JSON.parse(payload.slice(payload.indexOf('{')));
  const picks = Object.values(sent).flat().map((e) => ({
    player: e.player, stat: e.stat, line: e.line,
    prob: probByPlayer[e.player] ?? 0.5, key_risk: 'k', reasoning: 'r',
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {} };
};

// MLB (id 2) and WNBA (id 3) are both pinned in PP_LEAGUE_IDS, but the sweep
// still enumerates the live catalog to decide WHICH leagues have a board.
const CATALOG = {
  data: [
    { id: '2', type: 'league', attributes: { name: 'MLB', projections_count: 200, active: true } },
    { id: '3', type: 'league', attributes: { name: 'WNBA', projections_count: 80, active: true } },
  ],
};

async function sweep({ mlb = [], wnba = [], probs = {}, body = {} }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => CATALOG],
    ['partner-api.prizepicks.com/projections', async (url) => {
      const id = new URL(url).searchParams.get('league_id');
      return proj(id === '3' ? wnba : mlb);
    }],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => answerWith(probs)(init)],
  ]);
  try {
    const { handler } = await loadFn('sweep-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'sw', legs: 3, ...body }) });
  } finally { mock.restore(); }
  return { job: read('bet-jobs', 'sw') || {}, log: read('pick-log', TODAY) || [] };
}

// A normal single-league run of the same MLB props, for the gate comparison.
async function normalRun({ mlb, probs }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => CATALOG],
    ['partner-api.prizepicks.com/projections', async () => proj(mlb)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => answerWith(probs)(init)],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({
      jobId: 'nr', league: 'mlb', legs: 3, today: true,
      tiers: ['goblin', 'standard', 'demon'], sides: 'both', balance: true,
    }) });
  } finally { mock.restore(); }
  return { result: read('bet-jobs', 'nr')?.result || {}, log: read('pick-log', TODAY) || [] };
}

export default async function ({ t }) {
  // ---- 1. the no-result path still returns a full coverage report --------
  {
    // Every prop is a goblin at 0.55 — needs 0.794, so nothing clears anywhere.
    const mlb = [
      { id: 'm1', player: 'Weak A', stat: 'Hits', line: 0.5, tier: 'goblin', team: 'CIN', opp: 'PIT' },
      { id: 'm2', player: 'Weak B', stat: 'Hits', line: 0.5, tier: 'goblin', team: 'PIT', opp: 'CIN' },
    ];
    const wnba = [
      { id: 'w1', player: 'Weak C', stat: 'Points', line: 9.5, tier: 'goblin', team: 'NY', opp: 'LV', pos: 'G' },
      { id: 'w2', player: 'Weak D', stat: 'Points', line: 9.5, tier: 'goblin', team: 'LV', opp: 'NY', pos: 'G' },
    ];
    const probs = { 'Weak A': 0.55, 'Weak B': 0.55, 'Weak C': 0.55, 'Weak D': 0.55 };
    const { job, log } = await sweep({ mlb, wnba, probs });

    t.eq('the sweep finishes', job.status, 'done');
    const r = job.result || {};
    t.eq('...flagged as a sweep', r.sweep, true);

    t.ok('the summary states the scale and the outcome',
      /Swept \d+ props across \d+ leagues/.test(r.summary || '') && /Nothing cleared\.$/.test(r.summary || ''),
      r.summary);

    t.ok('coverage names every league it swept',
      (r.coverage?.leaguesCovered ?? 0) === 2 && (r.coverage?.slates || []).length >= 2,
      JSON.stringify(r.coverage));
    t.ok('...and counts the props it evaluated', r.coverage.propsEvaluated > 0, String(r.coverage.propsEvaluated));

    t.ok('the full edge distribution is reported even with nothing cleared',
      r.edge && r.edge.n > 0 && r.edge.min != null && r.edge.median != null && r.edge.max != null,
      JSON.stringify(r.edge));
    t.ok('...as counts by bucket', r.edge.buckets && typeof r.edge.buckets.belowMinus10 === 'number',
      JSON.stringify(r.edge.buckets));
    t.ok('every swept goblin edge is negative, so the best one is too',
      r.edge.max < 0, String(r.edge.max));

    t.eq('nothing cleared edge >= 0', r.cleared.edgeGE0, 0);
    t.eq('...and no slip was built', r.parlay, null);
    t.eq('...so nothing was logged', log.filter((p) => p.source === 'sweep').length, 0);

    t.ok('the cost report carries an estimate, a measured figure and the cap',
      typeof r.cost.estimatedUsd === 'number' && typeof r.cost.actualUsd === 'number' && r.cost.capUsd > 0,
      JSON.stringify(r.cost));
  }

  // ---- 2. sweptN propagates end to end ---------------------------------
  {
    // Standards at 0.66 (needs 0.595) across two leagues and four matchups —
    // enough clear that selectLegs builds a 3-leg slip.
    const mk = (id, player, team, opp, pos) => ({ id, player, stat: pos ? 'Points' : 'Hits', line: pos ? 9.5 : 1.5, tier: 'standard', team, opp, pos });
    const mlb = [
      mk('m1', 'Al', 'CIN', 'PIT'), mk('m2', 'Bo', 'CIN', 'PIT'),
      mk('m3', 'Cy', 'LAD', 'SFG'), mk('m4', 'Di', 'LAD', 'SFG'),
    ];
    const wnba = [
      mk('w1', 'Ed', 'NY', 'LV', 'G'), mk('w2', 'Fi', 'NY', 'LV', 'G'),
      mk('w3', 'Gy', 'SEA', 'PHX', 'G'), mk('w4', 'Ha', 'SEA', 'PHX', 'G'),
    ];
    const probs = Object.fromEntries(['Al', 'Bo', 'Cy', 'Di', 'Ed', 'Fi', 'Gy', 'Ha'].map((n) => [n, 0.66]));
    const { job, log } = await sweep({ mlb, wnba, probs });
    const r = job.result || {};

    t.ok('a slip was built from the swept pool', !!r.parlay && (r.parlayLegs || []).length >= 3,
      JSON.stringify(r.parlayNote));

    const N = r.sweptN;
    t.ok('sweptN is the count of props evaluated', N > 0 && N === r.coverage.propsEvaluated, `${N} vs ${r.coverage.propsEvaluated}`);
    t.eq('the slip note carries sweptN', r.parlayNote.sweptN, N);
    t.ok('every leg carries sweptN', (r.parlayLegs || []).every((l) => l.sweptN === N),
      JSON.stringify((r.parlayLegs || []).map((l) => l.sweptN)));

    const swept = log.filter((p) => p.source === 'sweep');
    t.ok('the sweep logged its cleared picks', swept.length >= 3, String(swept.length));
    t.ok('...every one as source:sweep with the same sweptN', swept.every((p) => p.sweptN === N),
      JSON.stringify(swept.map((p) => [p.player, p.sweptN])));
    t.ok('...never pooled with a board run (no source-less row this sweep wrote)',
      log.filter((p) => !p.source).length === 0, JSON.stringify(log.map((p) => p.source)));

    const legIds = new Set((r.parlayLegs || []).map((l) => l.projectionId));
    const loggedLegIds = new Set(swept.map((p) => p.projectionId));
    t.ok('each slip leg has a matching pick-log row carrying sweptN',
      [...legIds].every((id) => loggedLegIds.has(id)),
      `legs ${[...legIds]} vs logged ${[...loggedLegIds]}`);
  }

  // ---- 3. a sweep applies the identical edge gate as a normal run ------
  {
    // A goblin at 0.65 needs 0.794 — its edge is -0.14, a known loser. Two
    // standards at 0.66 clear their 0.595. The guardrail must treat the goblin
    // identically whether it is reached by a sweep or by a normal scan.
    const mlb = [
      { id: 'g1', player: 'Doomed Goblin', stat: 'Hits', line: 0.5, tier: 'goblin', team: 'CIN', opp: 'PIT' },
      { id: 's1', player: 'Good Standard One', stat: 'Hits', line: 1.5, tier: 'standard', team: 'CIN', opp: 'PIT' },
      { id: 's2', player: 'Good Standard Two', stat: 'Hits', line: 1.5, tier: 'standard', team: 'LAD', opp: 'SFG' },
    ];
    const probs = { 'Doomed Goblin': 0.65, 'Good Standard One': 0.66, 'Good Standard Two': 0.66 };

    const { job, log } = await sweep({ mlb, wnba: [], probs });
    const r = job.result || {};
    const swept = log.filter((p) => p.source === 'sweep');
    const { result: normal, log: normalLog } = await normalRun({ mlb, probs });

    // The sweep's board is what cleared the gate.
    const sweepCleared = new Set((r.board || []).map((p) => p.player));
    t.ok('the sweep clears exactly the two standards', sweepCleared.size === 2
      && sweepCleared.has('Good Standard One') && sweepCleared.has('Good Standard Two'),
      `sweep cleared ${[...sweepCleared]}`);
    t.ok('...and refuses the negative-edge goblin', !sweepCleared.has('Doomed Goblin'), `sweep cleared ${[...sweepCleared]}`);
    t.eq('cleared-the-gate count excludes the goblin', r.cleared.gate, 2);

    // A normal run — same props, same tiers, same sides — reaches the identical
    // guardrail: the goblin stays on the board (browsing is as wide as ever)
    // but its edgeVerdict is 'pass' and it never enters the auto-built slip.
    const normalBoard = Object.fromEntries((normal.board || []).map((p) => [p.player, p]));
    const g = normalBoard['Doomed Goblin'];
    t.ok('a normal run still lists the goblin on the board', !!g && g.sideVerdict === 'play', JSON.stringify(g && { sv: g.sideVerdict, ev: g.edgeVerdict }));
    t.eq('...but the identical edge gate demotes it to pass', g && g.edgeVerdict, 'pass');
    const normalLegs = (normal.parlayLegs || []).map((l) => l.player);
    t.ok('...and it never reaches the normal auto-slip either', !normalLegs.includes('Doomed Goblin'), normalLegs.join(','));

    // Same prop, same edge arithmetic in both paths.
    t.ok('the goblin edge is the same negative number a sweep computed and a normal run computed',
      Math.abs(g.edge - r.edge.min) < 1e-9 && g.edge < 0,
      `normal ${g.edge}  sweep min ${r.edge.min}`);

    t.ok('the sweep never logs the refused goblin as a recommendation',
      !swept.some((p) => p.player === 'Doomed Goblin'),
      JSON.stringify(swept.map((p) => p.player)));
    t.ok('...while a normal run keeps it in the log with edgeVerdict pass, unchanged',
      (normalLog.find((p) => p.player === 'Doomed Goblin' && !p.source) || {}).edgeVerdict === 'pass',
      JSON.stringify(normalLog.filter((p) => p.player === 'Doomed Goblin')));
  }
}

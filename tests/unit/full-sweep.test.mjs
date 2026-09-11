// FULL SWEEP — exhaustive coverage instead of one sample.
//
// A normal Find Bets run judges one league, one slate, the tiers you picked,
// one side per prop. "No slip" then means "no slip in that one sample". The
// sweep runs the SAME candidate + judge + edge pipeline over every league with
// a slate in the window, all three tiers, both sides, so "no slip" becomes a
// statement about the whole opportunity space — reported with evidence whether
// or not anything cleared.
//
// Four things this suite pins:
//   1. the no-result path still returns a FULL coverage report;
//   2. sweptN (props evaluated to produce a slip) propagates onto the slip,
//      its legs, its pick-log rows, and the report;
//   3. a sweep applies the IDENTICAL edge gate a normal run applies — it
//      widens what gets evaluated, never what passes;
//   4. `sweep: true` is a property of the SWEEP sub-run, not of the pipeline —
//      a normal Find Bets run (no `sweep` key, or an explicit `sweep: false`)
//      must still write its pick-log rows. If that flag ever leaked onto an
//      ordinary run, board picks would stop reaching the log with nothing
//      visibly wrong on screen — the measurement record going silently thin
//      is the worst failure mode this project has.

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
      allowed_wager_types: r.wagerTypes || 'over',
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

// Run bet-finder-background directly with whatever body is handed in.
async function betFinderRun({ mlb, probs, body }) {
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
      jobId: 'bf', league: 'mlb', legs: 3, today: true,
      tiers: ['goblin', 'standard', 'demon'], sides: 'both', ...body,
    }) });
  } finally { mock.restore(); }
  return { result: read('bet-jobs', 'bf')?.result || {}, log: read('pick-log', TODAY) || [] };
}

// A bet-finder-background run for a league of its own (not MLB/WNBA), so the
// zero-candidates messaging can be tested against a league that genuinely has
// no grading mapping (statResolves always false) — cs2/nbaszn/ufc/tt on the
// first live sweep. Its own one-league catalog, since resolveLeagueId falls
// back to fetchLeagueCatalog for anything not in PP_LEAGUE_IDS.
async function emptyBoardRun({ league, rows, tiers, statFilter }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const oneLeagueCatalog = { data: [{ id: '55', type: 'league', attributes: { name: league.toUpperCase(), projections_count: rows.length, active: true } }] };
  const mock = mockFetch([
    ['partner-api.prizepicks.com/leagues', async () => oneLeagueCatalog],
    ['partner-api.prizepicks.com/projections', async () => proj(rows)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (_u, init) => answerWith({})(init)],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({
      jobId: 'eb', league, legs: 3, today: true,
      tiers: tiers || ['goblin', 'standard', 'demon'], sides: 'both', statFilter,
    }) });
  } finally { mock.restore(); }
  return (read('bet-jobs', 'eb') || {}).result || {};
}

// Env knobs sweep-background/bet-finder-background read at module load, so a
// fresh loadFn() (which re-parses the source per call) is what actually picks
// up an override — see fn.mjs. Always restored, even on failure, since these
// vars are process-wide and would otherwise leak into unrelated suites/tests.
async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

// Fast, deterministic knobs for the retry/stagger tests below: real ones page
// through several seconds of backoff on purpose, which is correct for talking
// to the actual PrizePicks API and wrong for a test suite with a ~2 minute
// budget across 67 suites.
const FAST_RETRY_ENV = {
  SWEEP_STAGGER_MS: '1',
  SWEEP_LEAGUE_BACKOFF_BASE_MS: '1',
  SWEEP_LEAGUE_BACKOFF_CAP_MS: '2',
  PP_FETCH_MAX_RETRIES: '0',        // isolates the league-level retry under test
  PP_FETCH_BACKOFF_BASE_MS: '1',
  PP_FETCH_BACKOFF_CAP_MS: '1',
};

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

  // ---- 4. sweep:true must never leak onto a normal Find Bets run ---------
  // bet-finder-background is a normal, single-league run everywhere EXCEPT
  // inside a sweep's own sub-runs, which pass sweep:true so the ORCHESTRATOR
  // can own logging (source:'sweep' + sweptN aren't known until every league
  // is judged). Nothing else may ever set that flag. If it did, board picks
  // would stop reaching the pick log with nothing visibly wrong on screen —
  // the run still "succeeds", it just stops leaving a measurement record.
  {
    const mlb = [{ id: 'p1', player: 'Ordinary Player', stat: 'Hits', line: 1.5, tier: 'standard', team: 'CIN', opp: 'PIT' }];
    const probs = { 'Ordinary Player': 0.6 };

    // No sweep key at all — the ordinary shape every real caller uses.
    const bare = await betFinderRun({ mlb, probs, body: {} });
    t.ok('a normal run with no sweep key writes pick-log rows', bare.log.length > 0, JSON.stringify(bare.log));
    t.ok('...carrying no source (an ordinary board row)', bare.log.every((p) => !p.source), JSON.stringify(bare.log.map((p) => p.source)));

    // Explicit sweep:false — the value a sweep sub-run's own params never take,
    // but worth pinning: falsy must behave exactly like absent.
    const explicitFalse = await betFinderRun({ mlb, probs, body: { sweep: false } });
    t.ok('...and so does sweep:false, explicitly', explicitFalse.log.length > 0, JSON.stringify(explicitFalse.log));

    // Only sweep:true — the one shape sweep-background.js actually sends —
    // suppresses the write. Same props, same probs, only the flag differs.
    const asSweep = await betFinderRun({ mlb, probs, body: { sweep: true } });
    t.eq('only an explicit sweep:true suppresses the pick-log write', asSweep.log.length, 0);

    // And the run itself still succeeded and produced a board either way —
    // sweep:true changes logging, nothing about the judged result.
    t.ok('sweep:true still returns a normal board (only logging changed)',
      (asSweep.result.board || []).length > 0, JSON.stringify(asSweep.result.board));
  }

  // ---- 5. the summary's count is the table's count, not a different one -----
  // First live run: the summary read "13 cleared edge >= 0" while the table's
  // own "cleared edge >= 0" row said 8 and its "cleared the gate (play/lean)"
  // row said 13 — the summary was printing the GATE count under the EDGE
  // label. Constructed here with a leg whose gate clears but whose edge is
  // unknown (a goblin/demon under — attachSides marks its payout unverified,
  // so `edge` is null and it can never enter the priced edge>=0 count) to
  // force the two numbers apart, rather than trust a scenario where they
  // happen to agree by coincidence.
  {
    const mk = (id, player, team, opp) => ({ id, player, stat: 'Hits', line: 1.5, tier: 'standard', team, opp });
    const mlb = [
      mk('m1', 'Al', 'CIN', 'PIT'), mk('m2', 'Bo', 'LAD', 'SFG'), mk('m3', 'Cy', 'NYY', 'BOS'),
      // Goblin, under available, low P(over) -> the bet taken is the UNDER,
      // whose payout attachSides refuses to price (sidePriceUnverified). Its
      // sideVerdict still clears the gate; its edge stays null.
      { id: 'g1', player: 'Di', stat: 'Hits', line: 1.5, tier: 'goblin', team: 'SEA', opp: 'HOU', wagerTypes: 'under_or_over' },
    ];
    const probs = { Al: 0.70, Bo: 0.70, Cy: 0.70, Di: 0.25 };
    const { job } = await sweep({ mlb, wnba: [], probs });
    const r = job.result || {};

    t.ok('a slip was built', !!r.parlay && (r.parlayLegs || []).length >= 3, JSON.stringify(r.parlayNote));
    t.eq('the unpriced-but-gated goblin under clears the gate', r.cleared.gate, 4);
    t.eq('...but is excluded from "cleared edge >= 0" (its edge is null, not >= 0)', r.cleared.edgeGE0, 3);
    t.ok('the two counts actually differ in this scenario (otherwise this test proves nothing)',
      r.cleared.gate !== r.cleared.edgeGE0, JSON.stringify(r.cleared));

    const n = /(\d+) cleared the gate/.exec(r.summary || '');
    t.ok('the summary states a "cleared the gate" count', !!n, r.summary);
    t.eq('...and it is the TABLE\'s gate count', Number(n && n[1]), r.cleared.gate);
    t.ok('...never the edge>=0 count under the gate label',
      !new RegExp(`${r.cleared.edgeGE0} cleared the gate`).test(r.summary || '') || r.cleared.edgeGE0 === r.cleared.gate,
      r.summary);
  }

  // ---- 6. a league retries a bounded number of times on 429, then recovers --
  {
    let attempts = 0;
    const mlb = [{ id: 'm1', player: 'Al', stat: 'Hits', line: 1.5, tier: 'standard', team: 'CIN', opp: 'PIT' }];
    const r = await withEnv({ ...FAST_RETRY_ENV, SWEEP_LEAGUE_MAX_ATTEMPTS: '3' }, async () => {
      reset();
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const mock = mockFetch([
        ['partner-api.prizepicks.com/projections', async () => {
          attempts++;
          // Throttled twice, then PrizePicks answers — recovers inside the
          // 3 attempts the sweep is allowed.
          if (attempts <= 2) return { status: 429, headers: {} };
          return proj(mlb);
        }],
        [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
        ['api.anthropic.com', async (_u, init) => answerWith({ Al: 0.7 })(init)],
      ]);
      try {
        const { handler } = await loadFn('sweep-background.js');
        await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'swretry', legs: 3, leagues: ['mlb'] }) });
      } finally { mock.restore(); }
      return (read('bet-jobs', 'swretry') || {}).result || {};
    });

    t.ok('it took more than one attempt to get through', attempts >= 2, String(attempts));
    const mlbSlate = (r.coverage?.slates || []).find((s) => s.league === 'mlb');
    t.eq('a league throttled at first still ends up covered once it gets through', mlbSlate && mlbSlate.status, 'covered');
    t.eq('...with its real props, not an empty/error placeholder', mlbSlate && mlbSlate.props, 1);
  }

  // ---- 7. ...but the retry is bounded, not infinite ------------------------
  {
    let attempts = 0;
    const r = await withEnv({ ...FAST_RETRY_ENV, SWEEP_LEAGUE_MAX_ATTEMPTS: '3' }, async () => {
      reset();
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const mock = mockFetch([
        ['partner-api.prizepicks.com/projections', async () => { attempts++; return { status: 429, headers: {} }; }],
        [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
        ['api.anthropic.com', async (_u, init) => answerWith({})(init)],
      ]);
      try {
        const { handler } = await loadFn('sweep-background.js');
        await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'swgiveup', legs: 3, leagues: ['mlb'] }) });
      } finally { mock.restore(); }
      return (read('bet-jobs', 'swgiveup') || {}).result || {};
    });

    t.eq('a league still throttled after every attempt is retried exactly the configured number of times, not forever',
      attempts, 3);
    const mlbSlate = (r.coverage?.slates || []).find((s) => s.league === 'mlb');
    t.eq('...and is reported as a real gap in coverage, not folded into "empty"', mlbSlate && mlbSlate.status, 'fetch-failed');
    t.ok('...worded as a fetch failure with the real reason, not "error:"',
      (mlbSlate?.note || '').startsWith('fetch failed:') && /429|rate limit/i.test(mlbSlate.note),
      JSON.stringify(mlbSlate));
  }

  // ---- 8. "no slate" and "fetch failed" are different facts, reported differently ----
  {
    const r = await withEnv({ ...FAST_RETRY_ENV, SWEEP_LEAGUE_MAX_ATTEMPTS: '2' }, async () => {
      reset();
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const mock = mockFetch([
        ['partner-api.prizepicks.com/projections', async (url) => {
          const id = new URL(url).searchParams.get('league_id');
          if (id === '3') return { status: 429, headers: {} }; // WNBA: never actually answers
          return proj([]);                                      // MLB: answers fine, nothing posted
        }],
        [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
        ['api.anthropic.com', async (_u, init) => answerWith({})(init)],
      ]);
      try {
        const { handler } = await loadFn('sweep-background.js');
        await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'swsep', legs: 3, leagues: ['mlb', 'wnba'] }) });
      } finally { mock.restore(); }
      return (read('bet-jobs', 'swsep') || {}).result || {};
    });

    const byLeague = Object.fromEntries((r.coverage?.slates || []).map((s) => [s.league, s]));
    t.eq('a league PrizePicks genuinely answered with nothing on it is "no-slate"', byLeague.mlb?.status, 'no-slate');
    t.eq('a league PrizePicks never actually answered for is "fetch-failed", a different fact',
      byLeague.wnba?.status, 'fetch-failed');
    t.ok('...worded distinctly, not the same "0 props" both used to render as',
      byLeague.wnba?.note !== byLeague.mlb?.note && byLeague.wnba?.note.startsWith('fetch failed:'),
      JSON.stringify([byLeague.mlb, byLeague.wnba]));
  }

  // ---- 9. a league with no grading mapping gets an honest empty message -----
  // cs2/nbaszn/ufc/tt on the first live sweep: real props, all three tiers
  // requested, zero candidates — but not because of the tiers or a prop
  // filter. statResolves has no mapping for this league at all, so nothing
  // any UI control does can ever produce a candidate here. The old message
  // ("Try widening tiers or props") told the user to do something that cannot
  // solve it — see docs/judge-measurement.md.
  {
    const rows = [
      { id: 'c1', player: 'Player One', stat: 'Kills', line: 15.5, tier: 'standard', team: 'A', opp: 'B' },
      { id: 'c2', player: 'Player Two', stat: 'Headshots', line: 4.5, tier: 'goblin', team: 'A', opp: 'B' },
    ];
    const out = await emptyBoardRun({ league: 'cs2', rows });

    t.eq('reported as not-gradeable, a distinct cause from a tier or filter mismatch', out.emptyReason, 'not-gradeable');
    t.ok('...and the message says so plainly, not "try widening tiers or props"',
      !/try widening tiers or props/i.test(out.emptyMessage || ''), out.emptyMessage);
    t.ok('...naming the real, unfixable-from-the-UI reason',
      /not.*mapped for grading|no grading mapping|isn'?t supported for scoring/i.test(out.emptyMessage || ''),
      out.emptyMessage);
  }

  // ---- 10. the other two empty-board causes still point at something fixable ----
  {
    // Real props, but none are in the tiers the caller asked for — widening
    // tiers really would help here, unlike case 9.
    const rows = [{ id: 'm1', player: 'Al', stat: 'Hits', line: 1.5, tier: 'demon', team: 'CIN', opp: 'PIT' }];
    const tierMiss = await emptyBoardRun({ league: 'mlb', rows: [], tiers: ['goblin'] });
    // No rows at all today -> the existing "no games today" path, unaffected.
    t.eq('no props posted at all is still its own reason', tierMiss.emptyReason, 'not-posted');

    const wrongTier = await emptyBoardRun({ league: 'mlb', rows, tiers: ['goblin'] });
    t.eq('a real tier mismatch is tagged distinctly from "not gradeable"', wrongTier.emptyReason, 'tier-mismatch');
    t.ok('...and stays a "try widening tiers" message, because that would actually work',
      /widening tiers/i.test(wrongTier.emptyMessage || ''), wrongTier.emptyMessage);
  }
}

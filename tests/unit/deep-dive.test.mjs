// The two-stage "deep dive" run.
//
// A normal run judges the whole board in ONE call, sharing a fixed search
// budget (JUDGE_MAX_SEARCHES) across every game on the slate — on a full board
// most props get no dedicated research at all. Deep dive is the expensive
// second pass: after the normal screen, the best-edge props are re-judged ONE
// AT A TIME, each its own API call with its own search, and the result
// replaces the screen's number for that prop. The three things that have to
// be true for this to be worth its extra cost:
//
//   1. only the shortlist gets the individual treatment — not the whole board,
//      or this is just an expensive way to run the same scan;
//   2. the shortlist is picked by EDGE (not raw probability), same as
//      everywhere else this app ranks;
//   3. where a prop WAS deep-dived, its number is the deep one everywhere
//      downstream — the board, the parlay legs, the pick log — not silently
//      still the shallow one.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const props = (rows) => ({
  data: rows.map((r, i) => ({
    id: `pp-${i}`, type: 'projection',
    attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: r.line,
      odds_type: 'standard', description: r.opp,
      start_time: new Date().toISOString(), today: true },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team, position: 'OF', market: r.team } })),
  meta: { total_pages: 1 },
});

// All standard tier, so ranking by edge is exactly ranking by probability —
// keeps the shortlist predictable without needing per-tier break-even math in
// the fixture. Four games so the per-game cap (4) never trims one out.
const ROWS = [
  { player: 'Deep One',   team: 'CIN', line: 0.5, opp: 'PIT' },
  { player: 'Deep Two',   team: 'PIT', line: 1.5, opp: 'CIN' },
  { player: 'Deep Three', team: 'LAD', line: 0.5, opp: 'SFG' },
  { player: 'Deep Four',  team: 'SFG', line: 1.5, opp: 'LAD' },
];

// Stage 1 (batch): fixed per-player probabilities, ranked Deep One > Two >
// Three > Four. Stage 2 (individual): deliberately far-off numbers so a merge
// is unmistakable if it happened, and absent for anyone never deep-dived.
const SHALLOW_PROB = { 'Deep One': 0.90, 'Deep Two': 0.85, 'Deep Three': 0.70, 'Deep Four': 0.65 };
const DEEP_PROB = { 'Deep One': 0.55, 'Deep Two': 0.99 };

const answer = async (init) => {
  const body = JSON.parse(init.body);
  const payload = String(body.messages[0].content);
  const sent = JSON.parse(payload.slice(payload.indexOf('{')));
  const entries = Object.values(sent).flat();
  if (entries.length === 1) {
    // A deep-dive call carries exactly one prop in its own request — the
    // whole point of not sharing a batch.
    const e = entries[0];
    const prob = DEEP_PROB[e.player];
    return { content: [{ type: 'text', text: JSON.stringify({ picks: [
      { player: e.player, stat: e.stat, line: e.line, prob, cleared: 4,
        key_risk: 'deep risk', reasoning: 'deep reasoning' },
    ] }) }], usage: {} };
  }
  const picks = entries.map((e) => ({
    player: e.player, stat: e.stat, line: e.line, prob: SHALLOW_PROB[e.player],
    cleared: 3, key_risk: 'shallow risk', reasoning: 'shallow reasoning',
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ picks }) }], usage: {} };
};

async function run(body, env = {}) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  const calls = [];
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (url, init) => { calls.push(init); return answer(init); }],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST',
      body: JSON.stringify({ jobId: 'dd', league: 'mlb', legs: 3, tiers: ['standard'], ...body }) });
  } finally {
    mock.restore();
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { result: read('bet-jobs', 'dd')?.result || {}, calls };
}

export default async function ({ t }) {
  // DEEP_DIVE_MAX=2 so the shortlist is small and the two-best/two-worst split
  // is unambiguous without a large fixture.
  const deep = await run({ deepDive: true }, { DEEP_DIVE_MAX: '2', DEEP_DIVE_CONCURRENCY: '2' });

  // ---- exactly one batch call, plus one individual call per shortlist slot -
  t.eq('one batch call for the whole board, plus one call per deep-dived prop',
    deep.calls.length, 3, `${deep.calls.length} calls made`);

  const byPlayer = (arr) => Object.fromEntries(arr.map((p) => [p.player, p]));
  const board = byPlayer(deep.result.board || []);

  // ---- shortlisted by EDGE, capped at DEEP_DIVE_MAX -----------------------
  t.eq('the two best-edge picks were deep-dived', board['Deep One'].deepDive, true);
  t.eq('...both of them', board['Deep Two'].deepDive, true);
  t.eq('the rest were not — the shortlist is capped, not the whole board',
    board['Deep Three'].deepDive, false);
  t.eq('...neither of them', board['Deep Four'].deepDive, false);

  // ---- the deep number replaces the shallow one downstream -----------------
  t.eq('a deep-dived pick shows the DEEP probability, not the shallow one',
    board['Deep One'].prob, 0.55);
  t.eq('...even when the deep number went the other way',
    board['Deep Two'].prob, 0.99);
  t.eq('a non-deep-dived pick keeps its shallow number unchanged',
    board['Deep Three'].prob, 0.70);
  t.eq('...for both of them', board['Deep Four'].prob, 0.65);

  // ---- the shallow read stays on the record, not overwritten silently ------
  t.eq('the pre-deep-dive number is kept alongside the deep one',
    board['Deep One'].shallowProb, 0.90);
  t.eq('...so a second opinion that moved the number is visible, not just applied',
    board['Deep Two'].shallowProb, 0.85);

  // ---- the deep flag reaches the pick log, so calibration can slice by it --
  const day = new Date().toISOString().slice(0, 10);
  const log = read('pick-log', day) || [];
  const logByPlayer = byPlayer(log);
  t.eq('the pick log tags a deep-dived pick', logByPlayer['Deep One'].deepDive, true);
  t.eq('...and a shallow one as not deep-dived', logByPlayer['Deep Three'].deepDive, false);

  // ---- parlay legs carry the flag too, so the card can show it -------------
  const parlayByPlayer = byPlayer(deep.result.parlayLegs || []);
  if (parlayByPlayer['Deep One']) {
    t.eq('a deep-dived leg in the parlay is flagged', parlayByPlayer['Deep One'].deepDive, true);
  }

  // ---- the result reports what the deep dive actually did ------------------
  t.eq('the result says how many were requested for deep dive', deep.result.deepDive?.requested, 2);
  t.eq('...and how many completed', deep.result.deepDive?.completed, 2);

  // ---- an ordinary run (no deepDive flag) is completely unaffected ---------
  const plain = await run({});
  t.eq('without the flag, only the one batch call is made', plain.calls.length, 1);
  t.ok('no pick is flagged as deep-dived', (plain.result.board || []).every((p) => !p.deepDive));
  t.eq('the result carries no deep-dive summary', plain.result.deepDive, null);

  // ---- a failed individual call does not sink the whole run ----------------
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const prevMax = process.env.DEEP_DIVE_MAX;
  process.env.DEEP_DIVE_MAX = '2';
  let n = 0;
  const flaky = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async (url, init) => {
      const body = JSON.parse(init.body);
      const payload = String(body.messages[0].content);
      const sent = JSON.parse(payload.slice(payload.indexOf('{')));
      const entries = Object.values(sent).flat();
      if (entries.length === 1) {
        n++;
        // The FIRST individual call this run fails outright.
        if (n === 1) return { status: 500, body: { error: { message: 'boom' } } };
      }
      return answer(init);
    }],
  ]);
  let flakyResult;
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST',
      body: JSON.stringify({ jobId: 'ddflaky', league: 'mlb', legs: 3, tiers: ['standard'], deepDive: true }) });
    flakyResult = read('bet-jobs', 'ddflaky')?.result || {};
  } finally {
    flaky.restore();
    if (prevMax === undefined) delete process.env.DEEP_DIVE_MAX; else process.env.DEEP_DIVE_MAX = prevMax;
  }
  t.ok('the run still finishes and returns a board when one deep-dive call fails',
    (flakyResult.board || []).length > 0, JSON.stringify(flakyResult.board));
  t.eq('the failed one is reported, not silently dropped', flakyResult.deepDive?.errors?.length, 1);
  t.eq('the run says how many actually completed vs. were requested',
    flakyResult.deepDive?.completed, 1);
}

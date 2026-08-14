// The deterministic anchors attached to slip legs before the judge sees them.
//
// Eyeballed per-game probabilities drift badly on low-line counting props — a
// single-game home run is ~15%, not the 34% a narrative-first read once gave.
// So judge-slip computes two anchors per leg from PrizePicks' own history and
// the prompt orders the model to start from them:
//   recentOverRate — share of the recent games that beat THIS exact line
//   poissonAnchor  — P(over) implied by the per-game average, low lines only
//
// This runs the REAL judge-slip handler with fetches stubbed, and inspects the
// payload that would go to the model.

import { loadFn, fnPath, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

// Stand-in for bet-finder-background.js: only the shapes judge-slip consumes.
// attachHistory mutates legs in place, exactly like the real one.
const STUB = `
export const PP_LEAGUE_IDS = { mlb: 2 };
export const ODDS_SPORT_KEYS = { mlb: 'baseball_mlb' };
export const PP_TO_ESPN_ABBR = {};
export const normKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]/g, '');
export const normStat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const mlbRole = () => null;
export async function fetchProps() {
  return [
    { id: 'PP-1', player: 'Elly De La Cruz', stat: 'Hitter Ks', line: 0.5, team: 'CIN', opp: 'CWS', matchupLabel: 'CIN vs CWS', image: null, position: 'IF' },
    { id: 'PP-2', player: 'Eugenio Suárez', stat: 'Strikeouts', line: 5.5, team: 'CIN', opp: 'CWS', matchupLabel: 'CIN vs CWS', image: null, position: 'DH' },
  ];
}
export async function attachHistory(legs) {
  for (const l of legs) {
    if (l.player === 'Elly De La Cruz') { l.last5 = [1, 0, 2, 1, 1]; l.avg = 1.0; }
    if (l.player === 'Eugenio Suárez')  { l.last5 = [4, 7, 5, 6, 8]; l.avg = 6.0; }
  }
}
export async function fetchTeamRecords() { return {}; }
export function resolveRecords() { return {}; }
export async function fetchWinProbs() { return { status: 'ok', teamWinProbs: {}, games: [] }; }
export async function fetchMlbStarters() { return null; }
export function attachStarters() {}
export async function fetchTeamFullNames() { return {}; }
export async function fetchOppDefense() { return {}; }
export async function recordCost() {}
`;

export default async function ({ t }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';

  let captured = null;
  const mock = mockFetch([
    ['api.anthropic.com', async (_url, init) => {
      captured = JSON.parse(init.body);
      return { content: [{ type: 'text', text: JSON.stringify({
        legs: [{ player: 'x', stat: 'y', line: 0.5, pick: 'over', verdict: 'lean', prob: 0.6, key_risk: 'k', reasoning: 'r' }],
        slip: { weakestLeg: '', correlationFlag: '', overall: 'lean', overallReasoning: '' } }) }], usage: {} };
    }],
  ]);

  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const stubFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stub-')), 'stub-bfb.mjs');
    fs.writeFileSync(stubFile, STUB);
    const { handler } = await loadFn('judge-slip-background.js', {
      replace: [[`from '${fnPath('bet-finder-background.js')}'`, `from '${stubFile}'`]],
    });
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'anch1', slip: {
      slipType: 'power', legCount: 2, league: 'mlb', legs: [
        { player: 'Elly De La Cruz', team: 'CIN', stat: 'Hitter Ks',  line: 0.5, pick: 'over',  oddsType: 'goblin' },
        { player: 'Eugenio Suárez',  team: 'CIN', stat: 'Strikeouts', line: 5.5, pick: 'under', oddsType: 'goblin' },
      ] } }) });
  } finally {
    mock.restore();
  }

  t.ok('the judge was called', !!captured);
  const user = captured.messages[0].content;
  const legs = JSON.parse(user.slice(user.indexOf('[')));
  const elly = legs.find((l) => l.player === 'Elly De La Cruz').research;
  const suarez = legs.find((l) => l.player === 'Eugenio Suárez').research;

  t.eq('empirical anchor: last5 [1,0,2,1,1] over 0.5 -> 4/5', elly.recentOverRate, 0.8);
  t.eq('empirical anchor: last5 [4,7,5,6,8] over 5.5 -> 3/5', suarez.recentOverRate, 0.6);
  // λ=1.0, line 0.5 -> P(X>=1) = 1 - e^-1 = 0.632
  t.eq('Poisson anchor on the low-line count: λ=1.0 over 0.5 -> 0.63', elly.poissonAnchor, 0.63);
  t.eq('no Poisson anchor above the rare-event range (line 5.5)', 'poissonAnchor' in suarez, false);

  const sys = captured.system;
  t.ok('prompt carries the anchor rule', /Anchor on the computed numbers/.test(sys));
  t.ok('prompt carries the under-inversion instruction', /for an under, use 1 minus/.test(sys));
  t.ok('bucket rule survived the renumbering', /6\. Bucket every leg/.test(sys));
  t.ok('no-parlay rule survived the renumbering', /7\. Do NOT compute/.test(sys));
}

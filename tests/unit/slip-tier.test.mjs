// Tier resolution: goblin / standard / demon on an uploaded slip.
//
// The tier comes from OCR reading a small cartoon face off a screenshot, and the
// green goblin and the red demon get confused — they're similar shapes at
// thumbnail size. That is not a cosmetic mistake: the two sit at OPPOSITE ends of
// the payout table (a 3-leg pure goblin Power pays 2.0x, pure demon 12.0x), so a
// flipped tier silently corrupts the EV and Kelly sizing on the verdict screen.
//
// The fix is to stop trusting the pixels: a leg that binds to a live PrizePicks
// projection AT THE SAME LINE takes that projection's odds_type, which is the
// feed's own value. This suite pins that behaviour, including the cases where the
// override must NOT fire.

import { loadFn, fnPath, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Live board: the truth. Note Suzuki is a DEMON at 0.5 and Elly a GOBLIN at 0.5 —
// the exact pair a screenshot flips.
const ROWS = `[
  { id: 'PP-1', player: 'Elly De La Cruz', stat: 'Hitter Ks',  statDisplay: 'Hitter Ks', line: 0.5, oddsType: 'goblin',   team: 'CIN', opp: 'CWS', matchupLabel: 'CIN vs CWS', image: null, position: 'IF' },
  { id: 'PP-2', player: 'Seiya Suzuki',    stat: 'Home Runs',  statDisplay: 'Home Runs', line: 0.5, oddsType: 'demon',    team: 'CHC', opp: 'MIL', matchupLabel: 'CHC vs MIL', image: null, position: 'OF' },
  { id: 'PP-3', player: 'Nico Hoerner',    stat: 'Hits',       statDisplay: 'Hits',      line: 0.5, oddsType: 'standard', team: 'CHC', opp: 'MIL', matchupLabel: 'CHC vs MIL', image: null, position: 'IF' },
  { id: 'PP-4', player: 'Line Drift Guy',  stat: 'Hits',       statDisplay: 'Hits',      line: 1.5, oddsType: 'demon',    team: 'CHC', opp: 'MIL', matchupLabel: 'CHC vs MIL', image: null, position: 'IF' }
]`;

const STUB = `
export const PP_LEAGUE_IDS = { mlb: 2 };
export const ODDS_SPORT_KEYS = { mlb: 'baseball_mlb' };
export const PP_TO_ESPN_ABBR = {};
export const normKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]/g, '');
export const normStat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const mlbRole = () => null;
export async function fetchProps() { return ${ROWS}; }
export async function attachHistory() {}
export async function fetchTeamRecords() { return {}; }
export function resolveRecords() { return {}; }
export async function fetchWinProbs() { return { status: 'ok', teamWinProbs: {}, games: [] }; }
export async function fetchMlbStarters() { return null; }
export function attachStarters() {}
export async function fetchTeamFullNames() { return {}; }
export async function fetchOppDefense() { return {}; }
export async function recordCost() {}
`;

// What the OCR produced: Elly and Suzuki's tiers swapped (the reported bug),
// Hoerner correct, Drift Guy's line misread so it can't be trusted.
const OCR_LEGS = [
  { player: 'Elly De La Cruz', team: 'CIN', stat: 'Hitter Ks', line: 0.5, pick: 'over', oddsType: 'demon' },
  { player: 'Seiya Suzuki',    team: 'CHC', stat: 'Home Runs', line: 0.5, pick: 'over', oddsType: 'goblin' },
  { player: 'Nico Hoerner',    team: 'CHC', stat: 'Hits',      line: 0.5, pick: 'over', oddsType: 'standard' },
  { player: 'Line Drift Guy',  team: 'CHC', stat: 'Hits',      line: 0.5, pick: 'over', oddsType: 'goblin' },
  { player: 'Not On Board',    team: 'CHC', stat: 'Hits',      line: 2.5, pick: 'over', oddsType: 'demon' },
];

export default async function ({ t }) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';

  let sentToJudge = null;
  const mock = mockFetch([
    ['api.anthropic.com', async (_u, init) => {
      sentToJudge = JSON.parse(init.body);
      // The judge echoes tiers back from the prompt — and deliberately gets them
      // WRONG here, to prove the response uses our resolved value, not the echo.
      return { content: [{ type: 'text', text: JSON.stringify({
        legs: OCR_LEGS.map((l) => ({ player: l.player, stat: l.stat, line: l.line, pick: 'over',
          oddsType: 'standard', verdict: 'lean', prob: 0.6, key_risk: 'k', reasoning: 'r' })),
        slip: { weakestLeg: '', correlationFlag: '', overall: 'lean', overallReasoning: '' } }) }], usage: {} };
    }],
  ]);

  let done = null;
  try {
    const stubFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stub-')), 'stub-bfb.mjs');
    fs.writeFileSync(stubFile, STUB);
    const { handler } = await loadFn('judge-slip-background.js', {
      replace: [[`from '${fnPath('bet-finder-background.js')}'`, `from '${stubFile}'`]],
    });
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'tier1',
      slip: { slipType: 'power', legCount: OCR_LEGS.length, league: 'mlb', legs: OCR_LEGS } }) });
    done = read('slip-jobs', 'tier1');
  } finally {
    mock.restore();
  }

  const out = done?.result;
  t.ok('the slip was graded', !!out?.ok);
  const tierOf = (name) => out.legs.find((l) => l.player === name)?.oddsType;
  const srcOf = (name) => out.legs.find((l) => l.player === name)?.tierSource;

  // ---- the reported bug ---------------------------------------------------
  t.eq('OCR called Elly a demon; the live board says goblin — board wins', tierOf('Elly De La Cruz'), 'goblin');
  t.eq('OCR called Suzuki a goblin; the live board says demon — board wins', tierOf('Seiya Suzuki'), 'demon');
  t.eq('a correctly-read tier is left alone', tierOf('Nico Hoerner'), 'standard');
  t.eq('confirmed legs are marked as live-sourced', srcOf('Elly De La Cruz'), 'live');

  // ---- where the override must NOT fire -----------------------------------
  // Same player+stat exists on the board but at a DIFFERENT line, so it is a
  // different projection; importing its tier would trade a maybe-right read for
  // a definitely-wrong one.
  t.eq('a line mismatch does not import the board tier', tierOf('Line Drift Guy'), 'goblin');
  t.eq('...and that leg is still marked image-sourced', srcOf('Line Drift Guy'), 'image');
  t.eq('a leg with no live match keeps the screenshot read', tierOf('Not On Board'), 'demon');
  t.eq('...also marked image-sourced', srcOf('Not On Board'), 'image');

  // ---- the model cannot launder a tier back in ----------------------------
  // Every judged leg came back as "standard" from the model above.
  t.ok('the judge echo does not overwrite a verified tier',
    tierOf('Elly De La Cruz') === 'goblin' && tierOf('Seiya Suzuki') === 'demon');

  // ---- and it is reported, never silent -----------------------------------
  t.eq('both corrections are counted', out.dataStatus.tierCorrections, 2);
  const fixes = out.dataStatus.tierFixes.map((f) => `${f.player} ${f.was}->${f.now}`).sort();
  t.eq('each correction names what changed', fixes,
    ['Elly De La Cruz demon->goblin', 'Seiya Suzuki goblin->demon']);

  // ---- the judge saw the corrected tiers, not the OCR ones ----------------
  const user = sentToJudge.messages[0].content;
  const judged = JSON.parse(user.slice(user.indexOf('[')));
  t.eq('the judge is told Elly is a goblin', judged.find((l) => l.player === 'Elly De La Cruz').oddsType, 'goblin');
  t.eq('the judge is told Suzuki is a demon', judged.find((l) => l.player === 'Seiya Suzuki').oddsType, 'demon');

  // ---- and the corrected tiers reach the calibration log ------------------
  // Slip legs are a large share of the graded sample, and every skill number is
  // computed WITHIN a tier — so a slip leg logged under the OCR's tier is not
  // merely a wrong label, it is a row scored in the wrong bucket. The log write
  // is best-effort and swallows its own failure, which is exactly the shape of
  // write that can go nowhere without anything going red.
  const logged = read('pick-log', new Date().toISOString().slice(0, 10)) || [];
  t.eq('every judged leg is logged for calibration', out.dataStatus.loggedForCalibration, logged.length);
  t.eq('...under the source that made the prediction, not the board engine',
    [...new Set(logged.map((p) => p.source))], ['slip']);
  const loggedTier = (name) => logged.find((p) => p.player === name)?.oddsType;
  t.eq('...and at the tier the board confirmed, not the one the screenshot read',
    [loggedTier('Elly De La Cruz'), loggedTier('Seiya Suzuki')], ['goblin', 'demon']);
}

// Recent-form sample size, split out from the binary has-form/no-form read.
//
// `recentAvg != null` says a prop reached the judge with SOME history — it
// reads a player with one game the same as one with five. `clearedOf`
// (bet-finder-background.js) is the size of that same recent5 sample, logged
// going forward; rows already in the log before it existed carry recentAvg
// but no clearedOf, and must read as 'unknown' rather than being folded into
// a real bucket or silently dropped.
//
// This is measurement only: nothing here touches selection, sizing, the
// ranker or any prompt, and the existing has-form/no-form totals must come
// out identical to before — the split only breaks has-form open, it does not
// change what counts as has-form.

import { loadFn } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

const DAY = '2026-08-14';
// judgeModel defaults to the standing engine (Vilifiant) so every row here
// lands in calibration's default scope rather than "legacy engines".
const mk = (o) => ({
  date: DAY, loggedAt: `${DAY}T18:00:00Z`, source: 'board',
  stat: 'Player Touchdowns', line: 0.5, verdict: 'lean', oddsType: 'demon',
  gradedAt: `${DAY}T23:00:00Z`, judgeModel: 'claude-haiku-4-5-20251001',
  recentAvg: 0.4, ...o,
});

export default async function ({ t }) {
  reset();

  // Four has-form buckets, one league each, deliberately monotonic in both
  // sample size AND hit rate — the shape the pre-registration's has-form
  // demon AUC would produce if real discrimination concentrates in the
  // deepest samples. 20 per bucket clears computeSkill's own n>=20 floor for
  // a tier to report at all; 10 (unknown) is left under it on purpose.
  const rows = [
    // CFB, 1-2 games behind the number: thinnest sample, worst rate (30%).
    ...Array.from({ length: 20 }, (_, i) => mk({
      league: 'cfb', projectionId: `cfb${i}`, player: `CFB${i}`,
      clearedOf: i % 2 ? 1 : 2, prob: 0.30, hit: i < 6, result: i < 6 ? 1 : 0,
    })),
    // NFL, 3-4 games: clears the demon break-even (43.7%) at 45%.
    ...Array.from({ length: 20 }, (_, i) => mk({
      league: 'nfl', projectionId: `nfl${i}`, player: `NFL${i}`,
      clearedOf: i % 2 ? 3 : 4, prob: 0.30, hit: i < 9, result: i < 9 ? 1 : 0,
    })),
    // MLB, the full 5 games: best rate (60%).
    ...Array.from({ length: 20 }, (_, i) => mk({
      league: 'mlb', projectionId: `mlb5-${i}`, player: `M5-${i}`,
      clearedOf: 5, prob: 0.30, hit: i < 12, result: i < 12 ? 1 : 0,
    })),
    // MLB, has form but logged before clearedOf existed — half omit the field
    // entirely, half carry it as an explicit null, and both must read the
    // same way: 'unknown', not folded into a real bucket or dropped.
    ...Array.from({ length: 5 }, (_, i) => {
      const p = mk({ league: 'mlb', projectionId: `unk-a${i}`, player: `UA${i}`,
        prob: 0.30, hit: i < 3, result: i < 3 ? 1 : 0 });
      delete p.clearedOf;
      return p;
    }),
    ...Array.from({ length: 5 }, (_, i) => mk({
      league: 'mlb', projectionId: `unk-b${i}`, player: `UB${i}`, clearedOf: null,
      prob: 0.30, hit: i < 2, result: i < 2 ? 1 : 0,
    })),
    // MLB, no form at all — must not move under this split; it is the same
    // no-form bucket the page already reported.
    ...Array.from({ length: 10 }, (_, i) => mk({
      league: 'mlb', projectionId: `nf${i}`, player: `NF${i}`, oddsType: 'standard',
      recentAvg: null, prob: 0.50, hit: i < 5, result: i < 5 ? 1 : 0,
    })),
  ];
  seed('pick-log', DAY, rows);

  const cal = await loadFn('calibration.js');
  const res = JSON.parse((await cal.handler({ queryStringParameters: { format: 'json' } })).body);
  const fc = res.byFormCoverage;

  // ---- the split does not change what has-form already meant --------------
  t.eq('every graded pick is accounted for', res.graded, 80);
  t.eq('has-form is unchanged by adding the split: still every row with recentAvg set',
    fc['has-form'].n, 70);
  t.eq('...and no-form is unchanged too', fc['no-form'].n, 10);
  t.eq('the four games-buckets sum back to the has-form total',
    ['1-2', '3-4', '5', 'unknown'].reduce((s, g) => s + (fc.byGames[g]?.n || 0), 0), 70);

  // ---- each bucket is scored exactly like has-form/no-form already are ----
  t.eq('1-2 games: n and the raw rate', [fc.byGames['1-2'].n, fc.byGames['1-2'].brier != null], [20, true]);
  t.ok('...Brier computed the same way formBucket already does it',
    Math.abs(fc.byGames['1-2'].brier - ((0.3 - 1) ** 2 * 6 + (0.3 - 0) ** 2 * 14) / 20) < 1e-9,
    String(fc.byGames['1-2'].brier));
  t.eq('3-4 games: n', fc.byGames['3-4'].n, 20);
  t.eq('5 games: n', fc.byGames['5'].n, 20);
  t.eq('unknown: the pre-clearedOf rows, both the omitted-field and explicit-null forms',
    fc.byGames.unknown.n, 10);

  // ---- the demon AUC/hit-rate pre-registration is scored on, broken open --
  // computeSkill needs n>=20 to report a tier at all — 'unknown' sits below
  // that floor on purpose here, and must report nothing rather than a number
  // built on ten rows.
  t.eq('the 1-2-game demon rate is what it actually hit', fc.byGames['1-2'].skill.demon.tierRate, 0.3);
  t.eq('the 3-4-game demon rate clears its own break-even, 1-2 does not',
    [fc.byGames['1-2'].skill.demon.baselineClears, fc.byGames['3-4'].skill.demon.baselineClears],
    [false, true]);
  t.eq('the 5-game bucket clears it more comfortably still', fc.byGames['5'].skill.demon.tierRate, 0.6);
  t.eq('a thin bucket (n=10) reports no tier skill at all, rather than a number the sample cannot support',
    fc.byGames.unknown.skill.demon, undefined);

  // ---- the population question: where the thin rows actually are ----------
  t.eq('overall share across the whole board', fc.gamesShare.overall,
    { '1-2': 20, '3-4': 20, 5: 20, unknown: 10, 'no-form': 10 });
  t.eq('CFB is ALL thin (1-2 games) in this fixture', fc.gamesShare.byLeague.cfb, { '1-2': 20 });
  t.eq('NFL is ALL 3-4 games', fc.gamesShare.byLeague.nfl, { '3-4': 20 });
  t.eq('MLB carries the 5-game, unknown and no-form rows',
    fc.gamesShare.byLeague.mlb, { 5: 20, unknown: 10, 'no-form': 10 });

  // ---- it renders, and says the answer the counts above give --------------
  const html = (await cal.handler({ queryStringParameters: {} })).body;
  t.ok('the split renders its own section', /Has form, split by sample size/.test(html));
  t.ok('...naming all three real buckets plus unknown',
    /1-2 games/.test(html) && /3-4 games/.test(html) && /5 games/.test(html) && /unknown \(pre-clearedOf\)/.test(html));
  t.ok('the population table renders', /Where the thin has-form rows are/.test(html));
  t.ok('...naming CFB and NFL, which is where this fixture put the thin rows',
    /<td>CFB<\/td>/.test(html) && /<td>NFL<\/td>/.test(html));
}

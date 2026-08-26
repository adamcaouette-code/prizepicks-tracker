// Item L: tier-reliability shrinkage. INSTRUMENTATION ONLY — see
// SHRINKAGE_ENABLED in bet-finder-background.js. Nothing here tests that
// selection or sizing change, because they must not: this only tests the
// shrinkProb formula itself and that the env flag correctly gates whether
// it gets computed and logged.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

export default async function ({ t }) {
  // ---- shrinkProb: the formula, in isolation --------------------------------
  const { shrinkProb } = await loadFn('bet-finder-background.js');

  // shrunk = tier_rate + (judge_prob - tier_rate) * ICC_tier
  // demon: rate 0.193, ICC 0.427. judge said 0.35.
  // 0.193 + (0.35 - 0.193) * 0.427 = 0.193 + 0.157 * 0.427 = 0.260039
  const demonShrunk = shrinkProb(0.35, 'demon', { demon: 0.193 }, { demon: 0.427 });
  t.ok('the formula matches: tier rate + residual * ICC',
    Math.abs(demonShrunk - 0.260039) < 1e-6, String(demonShrunk));

  // goblin: rate 0.698, ICC 0.063 — almost fully discarded, exactly the
  // ~20-way-tie consequence the report has to name.
  const goblinShrunk = shrinkProb(0.90, 'goblin', { goblin: 0.698 }, { goblin: 0.063 });
  t.ok('a near-zero ICC collapses the judge\'s number to within a point of the tier rate',
    Math.abs(goblinShrunk - 0.698) < 0.02, String(goblinShrunk));

  // ICC of exactly 1 would trust the judge completely — sanity-checking the
  // formula's other end, even though nothing measured is anywhere near it.
  t.eq('an ICC of 1 returns the judge\'s own number, unshrunk',
    shrinkProb(0.72, 'demon', { demon: 0.193 }, { demon: 1 }), 0.72);
  // ICC of 0 returns the tier rate exactly, regardless of what the judge said.
  t.eq('an ICC of 0 returns the pure tier rate',
    shrinkProb(0.99, 'demon', { demon: 0.193 }, { demon: 0 }), 0.193);

  // ---- negative ICC floors at 0, never subtracts variance --------------------
  const negIcc = shrinkProb(0.80, 'standard', { standard: 0.452 }, { standard: -0.2 });
  t.eq('a negative ICC point estimate floors at 0, not below', negIcc, 0.452);

  // ---- a tier with no measured ICC falls through to 0, not 1 -----------------
  // "Too few props to estimate" must default to "assume no signal", not to
  // "assume the judge is fully trustworthy" — the unsafe direction.
  const noIcc = shrinkProb(0.80, 'exotic-tier', { 'exotic-tier': 0.5 }, {});
  t.eq('a tier missing from the ICC table shrinks all the way to the tier rate',
    noIcc, 0.5);

  // ---- a tier missing its RATE has nothing to shrink toward — refuse, don't guess
  // t.eq compares via JSON.stringify, which collapses NaN and null to the same
  // "null" text — a wrong NaN would pass a t.eq(..., null) silently. Checked
  // with strict equality instead, so a regression to NaN is actually caught.
  const noRate = shrinkProb(0.80, 'unknown', {}, { unknown: 0.5 });
  t.ok('a tier with no measured rate returns null rather than inventing an anchor (or NaN)',
    noRate === null, String(noRate));

  // ---- a non-finite probability refuses too ----------------------------------
  const noProb = shrinkProb(null, 'demon', { demon: 0.193 }, { demon: 0.427 });
  t.ok('a non-numeric probability refuses rather than propagating NaN',
    noProb === null, String(noProb));

  // ---- the shipped tables: item K's measured values, not the prompt's rounder
  // ODDS_PRIOR. Pinned so a future edit changes them on purpose, not by accident.
  const { TIER_MEASURED_RATE, TIER_RELIABILITY_ICC, SHRINKAGE_ENABLED, ODDS_PRIOR } =
    await loadFn('bet-finder-background.js');
  t.eq('the measured tier rates are item K\'s precise decimals',
    TIER_MEASURED_RATE, { goblin: 0.698, standard: 0.452, demon: 0.193 });
  t.ok('...distinct from the prompt\'s own rounder anchor, not aliased to it',
    TIER_MEASURED_RATE !== ODDS_PRIOR
      && ['goblin', 'standard', 'demon'].every((k) => TIER_MEASURED_RATE[k] !== ODDS_PRIOR[k]));
  t.eq('the reliability coefficients are item K\'s residual ICC per tier',
    TIER_RELIABILITY_ICC, { goblin: 0.063, standard: 0.095, demon: 0.427 });
  t.eq('the flag defaults off with no env var set', SHRINKAGE_ENABLED, false);

  // ---- end to end: the flag gates whether it is computed and logged at all ---
  const props = (rows) => ({
    data: rows.map((r, i) => ({
      id: `pp-${i}`, type: 'projection',
      attributes: { stat_type: 'Hits', stat_display_name: 'Hits', line_score: r.line,
        odds_type: r.tier, description: 'OPP', start_time: new Date().toISOString(), today: true },
      relationships: { new_player: { data: { id: `n${i}` } } },
    })),
    included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
      attributes: { display_name: r.player, team: 'CIN', position: 'OF', market: 'CIN' } })),
    meta: { total_pages: 1 },
  });
  const ROWS = [
    { player: 'Goblin Guy', line: 0.5, tier: 'goblin' },
    { player: 'Demon Guy', line: 1.5, tier: 'demon' },
  ];
  const PICKS = [
    { player: 'Goblin Guy', stat: 'Hits', line: 0.5, prob: 0.90, cleared: 4, key_risk: 'k', reasoning: 'r' },
    { player: 'Demon Guy', stat: 'Hits', line: 1.5, prob: 0.35, cleared: 1, key_risk: 'k', reasoning: 'r' },
  ];
  async function runFlag(flagValue) {
    reset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const saved = process.env.JUDGE_SHRINKAGE;
    if (flagValue == null) delete process.env.JUDGE_SHRINKAGE; else process.env.JUDGE_SHRINKAGE = flagValue;
    const mock = mockFetch([
      ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
      [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
      ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: {} })],
    ]);
    try {
      const { handler } = await loadFn('bet-finder-background.js');
      await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: `sh-${flagValue}`, league: 'mlb', legs: 2, tiers: ['goblin', 'demon'] }) });
    } finally {
      mock.restore();
      if (saved == null) delete process.env.JUDGE_SHRINKAGE; else process.env.JUDGE_SHRINKAGE = saved;
    }
    return read('pick-log', new Date().toISOString().slice(0, 10)) || [];
  }

  const off1 = await runFlag(null);
  t.ok('flag unset: no logged pick carries a shrunk probability', off1.every((p) => p.shrunkProb === null));
  t.ok('...but the raw probability is untouched, still what selection reads',
    off1.some((p) => p.player === 'Goblin Guy' && p.prob === 0.90));

  const off0 = await runFlag('0');
  t.ok('flag explicitly "0": still off', off0.every((p) => p.shrunkProb === null));

  const on = await runFlag('1');
  const goblinRow = on.find((p) => p.player === 'Goblin Guy');
  const demonRow = on.find((p) => p.player === 'Demon Guy');
  t.ok('flag on: goblin\'s shrunk value collapses near the tier rate — the ~20-way-tie consequence',
    Math.abs(goblinRow.shrunkProb - 0.698) < 0.02, String(goblinRow.shrunkProb));
  t.ok('...demon keeps more of the judge\'s own signal, per its higher ICC',
    Math.abs(demonRow.shrunkProb - 0.260039) < 1e-6, String(demonRow.shrunkProb));
  t.eq('raw prob is unchanged by the flag either way', goblinRow.prob, 0.90);
  t.eq('...on both rows', demonRow.prob, 0.35);
}

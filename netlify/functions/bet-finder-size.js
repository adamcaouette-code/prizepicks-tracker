// netlify/functions/bet-finder-size.js
//
// INSTANT sizing. The heavy job (props + Claude) already picked the legs; this
// just sizes them against a bankroll. No PrizePicks, no Claude, runs in ms.
// The page calls this whenever you type a bankroll in the results.
//
// POST body: { legs: [{prob,...}], bankroll, floor, maxStake }
// Returns:   { entries:{power,flex}, recommended, hitDistribution, legs }

// Real PrizePicks payouts, captured per tier (goblin/standard/demon).
// POWER_PURE[tier][legs] = all-hit multiplier for a slip entirely of that tier.
const POWER_PURE = {
  goblin:   { 3: 2.0,  4: 2.3,  5: 2.6,  6: 3.25 },
  standard: { 3: 4.75, 4: 7.0,  5: 10.0, 6: 16.0 },
  demon:    { 3: 12.0, 4: 23.0, 5: 45.0, 6: 97.0 },
};
// FLEX_PURE[tier][legs] = { hitsCorrect: multiplier, ... }
const FLEX_PURE = {
  goblin: {
    3: { 3: 1.7,  2: 0.5 },
    4: { 4: 1.9,  3: 0.5 },
    5: { 5: 2.0,  4: 0.5,  3: 0.25 },
    6: { 6: 2.5,  5: 0.5,  4: 0.25 },
  },
  standard: {
    3: { 3: 2.5,  2: 1.0 },
    4: { 4: 4.0,  3: 1.0 },
    5: { 5: 6.0,  4: 1.5,  3: 0.4 },
    6: { 6: 8.0,  5: 2.0,  4: 0.4 },
  },
  demon: {
    3: { 3: 10.0, 2: 1.0 },
    4: { 4: 16.0, 3: 1.75 },
    5: { 5: 32.0, 4: 2.25, 3: 0.4 },
    6: { 6: 51.0, 5: 5.5,  4: 1.25 },
  },
};
// Per-leg Power factor (cube root of the 3-leg pure power) — used to price MIXED
// slips by multiplying each leg's factor. Verified within rounding vs real mixed slips.
const LEG_FACTOR = { goblin: Math.pow(2.0, 1 / 3), standard: Math.pow(4.75, 1 / 3), demon: Math.pow(12.0, 1 / 3) };

const clamp = (p) => Math.min(0.99, Math.max(0.01, Number(p)));

// Tier of a slip: 'pure' (all one tier) returns that tier; else 'mixed'.
function slipTiers(legs) {
  const tiers = legs.map((l) => (l.oddsType || 'standard').toLowerCase());
  const uniq = [...new Set(tiers)];
  return { tiers, pure: uniq.length === 1 ? uniq[0] : null };
}

// Build the POWER + FLEX multiplier tables for THIS specific slip.
function tablesForSlip(legs) {
  const n = legs.length;
  const { tiers, pure } = slipTiers(legs);
  if (pure && POWER_PURE[pure]?.[n]) {
    return { power: { [n]: POWER_PURE[pure][n] }, flex: FLEX_PURE[pure][n], mixed: false };
  }
  // MIXED: all-hit power = product of each leg's factor. Flex scales off the
  // standard-tier shape (closest neutral) by the same top-line ratio.
  const allHit = tiers.reduce((m, t) => m * (LEG_FACTOR[t] || LEG_FACTOR.standard), 1);
  const power = { [n]: Math.round(allHit * 100) / 100 };
  const baseFlex = FLEX_PURE.standard[n] || {};
  const baseTop = baseFlex[n] || allHit;
  const scale = allHit / baseTop;
  const flex = {};
  for (const k in baseFlex) flex[k] = Math.round(baseFlex[k] * scale * 100) / 100;
  return { power, flex, mixed: true };
}

function hitDistribution(probs) {
  let dist = [1.0];
  for (const p of probs) {
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}
function evPerDollar(probs, table) {
  const dist = hitDistribution(probs);
  let ev = 0;
  for (let k = 0; k < dist.length; k++) ev += dist[k] * (table[k] || 0);
  return ev;
}
function expectedLogGrowth(probs, table, f) {
  const dist = hitDistribution(probs);
  let g = 0;
  for (let k = 0; k < dist.length; k++) {
    const ret = 1 - f + f * (table[k] || 0);
    if (ret <= 0) return -Infinity;
    g += dist[k] * Math.log(ret);
  }
  return g;
}
function kellyFraction(probs, table, mult = 0.25) {
  let bestF = 0, bestG = 0;
  for (let f = 0; f <= 1.0001; f += 0.005) {
    const g = expectedLogGrowth(probs, table, f);
    if (g > bestG) { bestG = g; bestF = f; }
  }
  return bestF * mult;
}
function priceEntry(probs, table, bankroll, floor, maxStake, label) {
  const edge = evPerDollar(probs, table) - 1;
  if (edge <= 0) return { label, evPerDollar: Math.round(edge * 1000) / 1000, stake: 0, note: 'NO BET — non-positive EV' };
  const f = kellyFraction(probs, table);
  const spendable = Math.max(bankroll - floor, 0);
  let stake = f * bankroll;
  if (maxStake) stake = Math.min(stake, maxStake);
  stake = Math.min(stake, spendable);
  stake = Math.round(stake * 100) / 100;
  return { label, evPerDollar: Math.round(edge * 1000) / 1000, fraction: f, stake };
}
function sizeParlay(legs, { bankroll, floor, maxStake }) {
  const probs = legs.map((p) => clamp(p.prob));
  const n = probs.length;
  if (n < 2) return { error: `Only ${n} playable leg(s) — need 2+.` };
  if (n > 6) return { error: `${n} legs exceeds PrizePicks max of 6.` };

  const { power: POWER, flex: FLEX, mixed } = tablesForSlip(legs);
  const out = { legs, hitDistribution: hitDistribution(probs), entries: {}, mixed };
  let best = null, bestG = -Infinity;
  for (const entry of ['power', 'flex']) {
    if (entry === 'flex' && (n < 3 || !FLEX)) continue;
    const table = entry === 'power' ? POWER : FLEX;
    const rec = priceEntry(probs, table, bankroll, floor, maxStake, entry.toUpperCase());
    rec.payouts = Object.entries(table)
      .map(([hits, m]) => ({ hits: Number(hits), pays: Math.round(rec.stake * m * 100) / 100 }))
      .sort((a, b) => b.hits - a.hits);
    if (mixed) rec.note = (rec.note ? rec.note + ' ' : '') + '(mixed-tier estimate)';
    out.entries[entry] = rec;
    if (rec.stake > 0) {
      const g = expectedLogGrowth(probs, table, rec.stake / bankroll);
      if (g > bestG) { bestG = g; best = entry.toUpperCase(); }
    }
  }
  out.recommended = best;
  return out;
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const body = JSON.parse(event.body || '{}');
    const legs = Array.isArray(body.legs) ? body.legs : [];
    const bankroll = Number(body.bankroll) || 0;
    const floor = Number(body.floor) || 0;
    const maxStake = body.maxStake ? Number(body.maxStake) : null;
    if (!legs.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No legs supplied' }) };
    const parlay = sizeParlay(legs, { bankroll, floor, maxStake });
    return { statusCode: 200, headers, body: JSON.stringify(parlay) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

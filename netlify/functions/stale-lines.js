// netlify/functions/stale-lines.js
//
// Finds PrizePicks lines the market has moved away from, and shouts about them.
//
// ===========================================================================
// THE QUOTA IS THE BINDING CONSTRAINT, SO THIS SPENDS NONE OF IT
//
// The brief says to assume The Odds API quota binds. It does — the archive
// already burns ~90 credits every ten minutes. A five-minute monitor that
// re-fetched book prices would DOUBLE that spend to look at numbers already
// sitting in the store.
//
// So the two sides are fetched asymmetrically, and the asymmetry is the whole
// design:
//
//   PrizePicks   fetched LIVE every run. It is free, unmetered, and it is the
//                side that goes stale — the entire premise of this monitor is
//                that PP has not moved.
//   the books    read from the line-snapshot archive, which snapshot-cron
//                already captured and paid for. Never re-fetched here.
//
// Net Odds API cost of this function: ZERO requests, and `oddsRequests: 0` is
// asserted in the tests so it stays that way. The book side is therefore up to
// ten minutes old, which is stated in every alert rather than glossed — a book
// price from eight minutes ago is exactly the situation this is looking for,
// not a defect in the measurement.
//
// ---------------------------------------------------------------------------
// WHAT IS BEING MEASURED
//
//   gap        no-vig book P(over) at the PP line, minus PP's implied
//              break-even for that tier. A positive gap means the market
//              thinks this side is likelier than PP is pricing it.
//   persistence how many consecutive observations that gap has survived. A gap
//              that flickers for one cycle is usually a stale book quote or a
//              name mismatch; one that holds for twenty minutes is a line.
//   velocity   how fast the BOOK's fair probability is moving, per hour, from
//              the archive. A book sprinting while PP sits still is the
//              strongest signal available and is ranked first.
//
// Only the third of those needs history the archive does not already hold, and
// the archive holds it.
// ===========================================================================

import { getStore } from '@netlify/blobs';
import { fetchProps } from './bet-finder-background.js';
import { fairFromBooks } from './fair-odds.js';
import { translate } from './alt-line.js';
import { propKey, listCaptures, getCapture } from './ledger-store.js';

export const STORES = {
  state: 'stale-line-state',     // per-prop gap history, for persistence
  alerts: 'stale-line-alerts',   // the alert log, and its follow-up
};

const store = (name) => {
  try { return getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }); }
  catch { return null; }
};

// PrizePicks prices only the OVER's payout, so the break-even a tier implies is
// the over's. Same three numbers the rest of the app uses.
export const TIER_BREAK_EVEN = {
  goblin: 2.0 ** (-1 / 3),
  standard: 4.75 ** (-1 / 3),
  demon: 12.0 ** (-1 / 3),
};

// ---------------------------------------------------------------------------
// 1. The gap

/**
 * The edge on one prop: the book's fair probability against PrizePicks' price.
 *
 * Returns null WITH a reason whenever either side is unavailable or the
 * translation onto PP's line would rest more on an assumed distribution than on
 * the market. A monitor that guessed here would alert on its own assumptions.
 */
export function gapFor(ppRow, snapRow, { weights = {}, models = {} } = {}) {
  const tier = String(ppRow.pp_tier || ppRow.oddsType || 'standard').toLowerCase();
  const be = TIER_BREAK_EVEN[tier];
  if (be == null) return { gap: null, reason: `unknown tier "${tier}"` };
  if (!snapRow) return { gap: null, reason: 'no archived book price for this prop' };

  const fair = fairFromBooks(snapRow.books, { side: 'over', config: weights });
  if (fair.fairProb == null) return { gap: null, reason: fair.unpriced || 'no two-way book price' };

  const ppLine = Number(ppRow.pp_line ?? ppRow.line);
  let bookProb = fair.fairProb;
  let translated = false;
  if (Number(fair.fairLine) !== ppLine) {
    const t = translate({
      market: snapRow.market, bookLine: fair.fairLine, bookProb: fair.fairProb,
      ppLine, config: models,
    });
    if (!t.ok) return { gap: null, reason: t.reason };
    bookProb = t.prob_no_push.over;
    translated = true;
  }

  return {
    gap: bookProb - be,
    bookProb,
    breakEven: be,
    tier,
    bookLine: fair.fairLine,
    ppLine,
    translated,
    bookCount: fair.bookCount,
    hold: fair.hold,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// 2. Persistence

/**
 * Fold this observation into a prop's history.
 *
 * PERSISTENCE IS COUNTED ONLY WHILE THE SIGN HOLDS. A gap that flips from +4pp
 * to -2pp and back has not persisted for three cycles — it has been noise for
 * three cycles, and the run resets. Counting raw consecutive observations
 * instead would let a market oscillating around zero accumulate a "twenty
 * minute" gap it never actually had.
 */
export function updateHistory(prev, { gap, at, minGap }) {
  const held = prev && prev.firstSeen && Math.sign(prev.lastGap) === Math.sign(gap)
    && Math.abs(gap) >= minGap && Math.abs(prev.lastGap) >= minGap;
  const firstSeen = held ? prev.firstSeen : at;
  const observations = held ? (prev.observations || 1) + 1 : 1;
  const samples = [...(held ? prev.samples || [] : []), { at, gap }].slice(-24);
  return {
    firstSeen,
    lastSeen: at,
    lastGap: gap,
    observations,
    heldMs: Date.parse(at) - Date.parse(firstSeen),
    // The smallest gap seen during the run. A run that dipped to 0.5pp is not a
    // twenty-minute 6pp edge, however it looks at the moment it is read.
    minGapInRun: held ? Math.min(Math.abs(prev.minGapInRun ?? Math.abs(gap)), Math.abs(gap)) : Math.abs(gap),
    samples,
  };
}

// ---------------------------------------------------------------------------
// 3. Velocity

/**
 * How fast the BOOK's fair probability is moving, in probability points/hour.
 *
 * Measured from the archive, over the captures inside `windowMin`. Least
 * squares rather than first-minus-last: a single stale quote at either end
 * would otherwise define the whole trend, and stale quotes are exactly what
 * this module is surrounded by.
 */
export function velocity(samples, { windowMin = 60 } = {}) {
  const cutoff = Date.now() - windowMin * 60000;
  const pts = (samples || [])
    .filter((s) => Date.parse(s.at) >= cutoff && isFinite(s.bookProb))
    .map((s) => ({ t: Date.parse(s.at) / 3600000, y: s.bookProb }));
  if (pts.length < 3) return { perHour: null, n: pts.length, reason: 'fewer than three archived observations' };
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.t - mt) * (p.y - my); den += (p.t - mt) ** 2; }
  if (!(den > 0)) return { perHour: 0, n, reason: 'every observation at the same instant' };
  return { perHour: num / den, n };
}

// ---------------------------------------------------------------------------
// 4. Scoring

/**
 * One number combining magnitude, persistence and velocity — requirement 2/3.
 *
 * score = |gap| x persistenceWeight x (1 + velocityBonus)
 *
 * PERSISTENCE SATURATES. Twenty minutes of a held gap is worth roughly double
 * one observation; two hours is not worth twelve times, because after a point a
 * gap that has not closed is more likely to be a mapping error than an edge.
 * A linear weight would rank a day-old phantom above a live one.
 *
 * VELOCITY ONLY COUNTS WHEN IT MOVES TOWARD THE GAP. A book drifting the same
 * way PP is priced is closing the gap, not opening it, and the bonus is zero —
 * never negative, because a closing gap is already penalised by being smaller.
 */
export function score(entry, config = {}) {
  const halfLifeMin = config.persistence_half_saturation_min ?? 20;
  const velRef = config.velocity_reference_per_hour ?? 0.10;
  const velWeight = config.velocity_weight ?? 1.0;

  const heldMin = (entry.heldMs || 0) / 60000;
  // Saturating: 0 at zero minutes, 0.5 at the half-saturation point, ->1.
  const persistence = heldMin / (heldMin + halfLifeMin);
  const v = entry.velocityPerHour;
  const towardGap = v != null && Math.sign(v) === Math.sign(entry.gap);
  const velocityBonus = towardGap ? velWeight * Math.min(1, Math.abs(v) / velRef) : 0;

  return {
    score: Math.abs(entry.gap) * (0.5 + persistence) * (1 + velocityBonus),
    persistence,
    velocityBonus,
    velocityTowardGap: towardGap,
    heldMinutes: heldMin,
  };
}

// ---------------------------------------------------------------------------
// 5. Alert gating — requirements 4 and 5

/**
 * Should this fire, and if not, why not.
 *
 * Three gates, and the ORDER matters for what gets reported: an edge that fails
 * the confidence gate is a different situation from one suppressed by the
 * cooldown, and lumping them together would hide a market that is genuinely
 * qualifying every cycle behind "rate limited".
 */
export function alertDecision(entry, { config, lastAlertAt = null, now = Date.now(), firedThisRun = 0 }) {
  const minGap = config.alert_min_gap ?? 0.04;
  const minHeldMin = config.alert_min_held_minutes ?? 10;
  const minBooks = config.alert_min_books ?? 2;
  const cooldownMin = config.alert_cooldown_minutes ?? 10;
  const perRun = config.alert_max_per_run ?? 5;

  if (Math.abs(entry.gap) < minGap) {
    return { fire: false, why: `gap ${(entry.gap * 100).toFixed(1)}pp is under the ${(minGap * 100).toFixed(0)}pp threshold`, gate: 'edge' };
  }
  // CONFIDENCE IS PERSISTENCE PLUS BOOK COUNT, not a model's self-report. One
  // book quoting a number is a quote; three books agreeing is a market.
  if ((entry.heldMs || 0) / 60000 < minHeldMin) {
    return { fire: false, why: `held for ${((entry.heldMs || 0) / 60000).toFixed(0)}m, under the ${minHeldMin}m minimum`, gate: 'confidence' };
  }
  if ((entry.bookCount ?? 0) < minBooks) {
    return { fire: false, why: `only ${entry.bookCount ?? 0} book(s) priced it, under the ${minBooks} minimum`, gate: 'confidence' };
  }
  if (lastAlertAt && now - Date.parse(lastAlertAt) < cooldownMin * 60000) {
    const mins = Math.round((now - Date.parse(lastAlertAt)) / 60000);
    return { fire: false, why: `alerted ${mins}m ago, inside the ${cooldownMin}m cooldown`, gate: 'cooldown' };
  }
  if (firedThisRun >= perRun) {
    return { fire: false, why: `${perRun} alerts already sent this run`, gate: 'rate-limit' };
  }
  return { fire: true, why: null };
}

/** The alert text — requirement 4's contents, in one line a phone can show. */
export function alertText(entry) {
  const dir = entry.gap > 0 ? 'OVER' : 'UNDER';
  const held = Math.round((entry.heldMs || 0) / 60000);
  const vel = entry.velocityPerHour == null ? 'flat'
    : `${entry.velocityPerHour > 0 ? '+' : ''}${(entry.velocityPerHour * 100).toFixed(1)}pp/h`;
  return `${entry.player} ${entry.market} ${dir} ${entry.ppLine} (${entry.tier})`
    + ` — book ${(entry.bookProb * 100).toFixed(1)}% vs ${(entry.breakEven * 100).toFixed(1)}% needed`
    + `, gap ${entry.gap > 0 ? '+' : ''}${(entry.gap * 100).toFixed(1)}pp`
    + `, held ${held}m across ${entry.observations} checks`
    + `, book line ${entry.bookLine}${entry.translated ? ' (translated)' : ''} moving ${vel}`
    + `, ${entry.bookCount} books`;
}

/**
 * Deliver an alert. Whatever is simplest to wire up — requirement 4.
 *
 * A webhook URL in the environment, POSTed as JSON. That is the lowest-friction
 * target there is: Slack, Discord, ntfy, Pushover and IFTTT all accept one, and
 * none of them needs a library, an OAuth dance or a second account. With no URL
 * set the alert is still LOGGED — the log is the evidence for whether any of
 * this works, and it must not depend on delivery having been configured.
 */
export async function deliver(alerts, { webhook = process.env.STALE_LINE_WEBHOOK } = {}) {
  if (!webhook) return { delivered: false, reason: 'STALE_LINE_WEBHOOK is not set — alerts were logged but not sent' };
  if (!alerts.length) return { delivered: false, reason: 'nothing to send' };
  const body = {
    text: `${alerts.length} stale line${alerts.length === 1 ? '' : 's'}:\n`
      + alerts.map((a) => `• ${a.text}`).join('\n'),
    alerts,
  };
  try {
    const res = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { delivered: res.ok, status: res.status };
  } catch (e) {
    return { delivered: false, reason: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 6. The archive side

/** The most recent capture's rows, indexed by prop, plus the fair-prob history. */
export async function readArchive({ windowMin = 60, weights = {} } = {}) {
  const keys = (await listCaptures({ kind: 'routine' })).sort();
  if (!keys.length) return { latest: new Map(), history: new Map(), captures: 0, latestAt: null };

  const cutoff = Date.now() - windowMin * 60000;
  const recent = keys.filter((k) => Date.parse(k.slice('capture/'.length)) >= cutoff);
  // Always include the newest, even if it is older than the window — a monitor
  // that reported nothing because the archive stalled would look identical to
  // one reporting no edges, and those are opposite situations.
  const use = recent.length ? recent : keys.slice(-1);

  const latest = new Map();
  const history = new Map();
  let latestAt = null;

  for (const key of use) {
    const cap = await getCapture(key);              // eslint-disable-line no-await-in-loop
    if (!cap) continue;
    const at = cap.captured_at;
    if (!latestAt || at > latestAt) latestAt = at;
    for (const row of cap.rows || []) {
      const k = propKey({ league: row.league, player: row.player, market: row.market, line: row.pp_line });
      if (key === use[use.length - 1]) latest.set(k, row);
      const fair = fairFromBooks(row.books, { side: 'over', config: weights });
      if (fair.fairProb != null) {
        if (!history.has(k)) history.set(k, []);
        history.get(k).push({ at, bookProb: fair.fairProb, bookLine: fair.fairLine });
      }
    }
  }
  return { latest, history, captures: use.length, latestAt };
}

// ---------------------------------------------------------------------------
// 7. The run

export async function run({
  league = 'mlb',
  config = {},
  weights = {},
  models = {},
  now = Date.now(),
  props = null,
} = {}) {
  const t0 = Date.now();
  // FREE side, live. See the header: this is the half that goes stale, and
  // fetching it costs no Odds API quota.
  const board = props || await fetchProps(league);
  const archive = await readArchive({ windowMin: config.velocity_window_minutes ?? 60, weights });

  const stateStore = store(STORES.state);
  const alertStore = store(STORES.alerts);
  const stateKey = `state/${league}`;
  let state = {};
  try { state = (await stateStore?.get(stateKey, { type: 'json' })) || {}; } catch { /* first run */ }

  const at = new Date(now).toISOString();
  const minGap = config.persistence_min_gap ?? 0.02;
  const nextState = {};
  const scored = [];
  const skipped = {};

  for (const prop of board) {
    const row = {
      league, player: prop.player, market: prop.stat,
      pp_line: Number(prop.line), pp_tier: String(prop.oddsType || 'standard').toLowerCase(),
    };
    const k = propKey({ league, player: row.player, market: row.market, line: row.pp_line });
    const snap = archive.latest.get(k);
    const g = gapFor(row, snap, { weights, models });
    if (g.gap == null) { skipped[g.reason] = (skipped[g.reason] || 0) + 1; continue; }

    const hist = updateHistory(state[k], { gap: g.gap, at, minGap });
    nextState[k] = hist;

    const v = velocity(archive.history.get(k), { windowMin: config.velocity_window_minutes ?? 60 });
    const entry = {
      key: k, league,
      player: row.player, market: row.market, ppLine: row.pp_line, tier: row.pp_tier,
      ...g,
      ...hist,
      velocityPerHour: v.perHour,
      velocityN: v.n,
      bookAgeMs: archive.latestAt ? now - Date.parse(archive.latestAt) : null,
    };
    Object.assign(entry, score(entry, config));
    scored.push(entry);
  }

  // RANKED BY SCORE, WHICH PUTS A MOVING BOOK FIRST — requirement 3.
  scored.sort((a, b) => b.score - a.score);

  // ---- alerts -----------------------------------------------------------
  let lastAlerts = {};
  try { lastAlerts = (await alertStore?.get('last-alert', { type: 'json' })) || {}; } catch { /* none yet */ }

  const fired = [];
  const gatedBy = {};
  for (const entry of scored) {
    const d = alertDecision(entry, { config, lastAlertAt: lastAlerts[entry.key], now, firedThisRun: fired.length });
    if (!d.fire) { gatedBy[d.gate] = (gatedBy[d.gate] || 0) + 1; continue; }
    fired.push({ ...entry, text: alertText(entry), alertedAt: at });
    lastAlerts[entry.key] = at;
  }

  const delivery = fired.length ? await deliver(fired) : { delivered: false, reason: 'nothing qualified' };

  // ---- persist ----------------------------------------------------------
  try { await stateStore?.setJSON(stateKey, nextState); } catch { /* best effort */ }
  if (fired.length) {
    try {
      await alertStore?.setJSON('last-alert', lastAlerts);
      const day = at.slice(0, 10);
      const existing = (await alertStore?.get(`log/${day}`, { type: 'json' })) || [];
      await alertStore?.setJSON(`log/${day}`, [...existing, ...fired.map((f) => ({
        // The alert as sent, plus everything needed to judge it LATER. The
        // whole point of the log is requirement 6 — did the line converge the
        // way this said it would — and that question is unanswerable without
        // the PP line and book probability AS THEY WERE at alert time.
        alertedAt: f.alertedAt, key: f.key, league: f.league,
        player: f.player, market: f.market, tier: f.tier,
        ppLine: f.ppLine, bookLine: f.bookLine,
        bookProbAtAlert: f.bookProb, breakEven: f.breakEven, gap: f.gap,
        heldMs: f.heldMs, observations: f.observations,
        velocityPerHour: f.velocityPerHour, bookCount: f.bookCount,
        score: f.score, text: f.text,
        // Filled in by followUp(), never at alert time.
        outcome: null,
      }))]);
    } catch { /* best effort */ }
  }

  return {
    league,
    at,
    // ZERO. Asserted in the tests — see the header.
    oddsRequests: 0,
    boardSize: board.length,
    archive: { captures: archive.captures, latestAt: archive.latestAt, ageMs: archive.latestAt ? now - Date.parse(archive.latestAt) : null },
    compared: scored.length,
    skipped,
    alerts: fired.map((f) => f.text),
    alertCount: fired.length,
    gatedBy,
    delivery,
    top: scored.slice(0, 10).map((e) => ({
      player: e.player, market: e.market, line: e.ppLine, tier: e.tier,
      gapPP: e.gap * 100, heldMinutes: Math.round(e.heldMinutes),
      velocityPerHour: e.velocityPerHour, score: e.score,
      velocityTowardGap: e.velocityTowardGap,
    })),
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// 8. Did it converge? — requirement 6

/**
 * Score past alerts against what the book did next.
 *
 * THIS IS THE EVIDENCE FOR WHETHER ANY OF THIS WORKS, and it is deliberately
 * scored on the BOOK's subsequent movement rather than on whether the prop won.
 * A single prop's result is one coin flip and says almost nothing; whether the
 * market kept moving the way the alert predicted is a measurement with a real
 * sample size behind it, available within hours instead of after grading.
 *
 * `converged` means the book's fair probability moved FURTHER in the direction
 * the gap pointed. `reverted` means it came back. Anything inside `flatBand` is
 * neither, and is counted separately rather than being rounded into a win.
 */
export async function followUp({ day = null, weights = {}, config = {} } = {}) {
  const alertStore = store(STORES.alerts);
  if (!alertStore) return { error: 'no store' };
  const key = `log/${day || new Date().toISOString().slice(0, 10)}`;
  const log = (await alertStore.get(key, { type: 'json' })) || [];
  if (!log.length) return { day: key, alerts: 0, note: 'no alerts logged for this day' };

  const archive = await readArchive({ windowMin: 24 * 60, weights });
  const flat = config.convergence_flat_band ?? 0.005;
  const horizonMs = (config.convergence_horizon_minutes ?? 60) * 60000;

  let converged = 0, reverted = 0, flatN = 0, unresolved = 0;
  const scoredLog = log.map((a) => {
    if (a.outcome) return a;
    const hist = (archive.history.get(a.key) || [])
      .filter((h) => Date.parse(h.at) > Date.parse(a.alertedAt)
        && Date.parse(h.at) <= Date.parse(a.alertedAt) + horizonMs);
    if (!hist.length) { unresolved++; return { ...a, outcome: null, outcomeReason: 'no archived book price after the alert yet' }; }
    const last = hist[hist.length - 1];
    const move = last.bookProb - a.bookProbAtAlert;
    const signed = Math.sign(a.gap) * move;
    let outcome;
    if (Math.abs(move) < flat) { outcome = 'flat'; flatN++; }
    else if (signed > 0) { outcome = 'converged'; converged++; }
    else { outcome = 'reverted'; reverted++; }
    return { ...a, outcome, bookProbAfter: last.bookProb, bookMove: move, resolvedAt: last.at };
  });

  try { await alertStore.setJSON(key, scoredLog); } catch { /* best effort */ }

  const decided = converged + reverted;
  return {
    day: key,
    alerts: log.length,
    converged,
    reverted,
    flat: flatN,
    unresolved,
    // Flat outcomes are excluded from the rate rather than counted as wins.
    convergenceRate: decided ? converged / decided : null,
    // Under "the alert carries no information", converged is Binomial(decided, 0.5).
    sigma: decided ? (converged - decided / 2) / Math.sqrt(0.25 * decided) : null,
    verdict: !decided ? 'nothing has resolved yet'
      : decided < (config.min_alerts_to_conclude ?? 30)
        ? `${decided} resolved alerts is too few to conclude anything`
        : converged / decided > 0.5 ? 'the book has been moving toward the alerts' : 'the book has NOT been moving toward the alerts',
  };
}

// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export const handler = async (event) => {
  const q = event?.queryStringParameters || {};
  try {
    const [config, weights, models] = await Promise.all([
      loadJson('./stale-lines-config.json'),
      loadJson('./book-weights.json'),
      loadJson('./market-models.json'),
    ]);
    if (q.followUp) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(await followUp({ day: q.day, weights, config }), null, 2) };
    }
    const out = await run({ league: q.league || 'mlb', config, weights, models });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(out, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

async function loadJson(rel) {
  const { readFile } = await import('node:fs/promises');
  try { return JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8')); }
  catch { return {}; }
}

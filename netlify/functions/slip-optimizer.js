// netlify/functions/slip-optimizer.js
//
// Searches the board for the highest-EV legal slips.
//
// ===========================================================================
// WHY NOT BRUTE FORCE
//
// A PrizePicks board is 2,000-3,000 props. Even after keeping only the ones
// with a judged probability, a few hundred survive, and the number of 6-leg
// subsets of 300 props is C(300,6) = 1.2e12. At a millisecond each — and each
// one needs a 100k-path copula simulation, so it is nowhere near a millisecond
// — that is thirty thousand years. Exhaustive search is not slow here, it is
// impossible, and any module that claims to "search the full board" is doing
// something else and had better say what.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES INSTEAD, AND WHAT IT COSTS
//
//   1. PREFILTER   drop legs that cannot appear in any winning slip.
//   2. BEAM SEARCH build slips one leg at a time, keeping the best `beam_width`
//                  partials at each size.
//   3. EXACT PRICE run the full correlation-aware pricer on every complete
//                  candidate the beam produced, and rank on that.
//
// The tradeoff is in step 2 and it is a real one: a beam can throw away a
// partial that would have grown into the best slip. Concretely, a pair of
// mediocre legs whose third partner is superb gets cut before that partner is
// ever considered. Widening the beam buys that back at linear cost, and the
// optimum is found on every case in the test suite at the default width — but
// the result is labelled `heuristic`, always, because it is one.
//
// The alternative designs, and why not:
//
//   greedy (beam width 1)   fast, and wrong often enough to matter. It commits
//                           to the single best leg before knowing what it will
//                           be paired with, and slip EV is not separable across
//                           legs — the payout table is a step function of the
//                           whole set.
//   exhaustive with pruning a branch-and-bound on P(all hit) would be exact,
//                           and its bound is weak exactly where the board is
//                           dense with similar legs, which is always. It
//                           degenerates to brute force on real input.
//   ILP / convex relaxation the objective is a step function of a count. There
//                           is no relaxation of it that stays honest.
//
// SEARCH IS GUIDED BY INDEPENDENT EV, DECIDED BY CORRELATED EV. The independent
// EV is closed-form and exact (payout-engine's Poisson-binomial), so it costs
// nothing per partial; a short simulation would be strictly worse guidance at
// enormously higher cost. The copula runs once per surviving candidate. The gap
// between the two numbers is reported per slip — it is the correlation
// contribution, and it is what task 08 exists to measure.
// ===========================================================================

import { legalSlips, payoutTable, evForSlip, kellyStake, breakEven } from './payout-engine.js';
import { priceSlip } from './slip-pricing.js';

const get = (o, path, dflt) => path.split('.').reduce((x, k) => (x && x[k] !== undefined ? x[k] : undefined), o) ?? dflt;

// ---------------------------------------------------------------------------
// 1. Legs

/** The win probability a leg is offering, whichever shape it arrived in. */
export function legWinProb(leg) {
  if (leg.pWin != null) return Number(leg.pWin);
  if (leg.over != null || leg.under != null) {
    const isUnder = String(leg.side || 'over').toLowerCase() === 'under';
    return Number(isUnder ? leg.under : leg.over);
  }
  return Number(leg.prob);
}

/** Every legal (slipType, legCount) this payout config offers. */
export function legalShapes(config, { minLegs = 2, maxLegs = 6 } = {}) {
  const sizes = new Set();
  for (const type of ['power', 'flex']) {
    for (const k of Object.keys(config?.slip_types?.[type] || {})) sizes.add(Number(k));
  }
  return [...sizes]
    .filter((n) => n >= minLegs && n <= maxLegs)
    .sort((a, b) => a - b)
    .flatMap((n) => legalSlips(config, n));
}

// ---------------------------------------------------------------------------
// 2. Hard constraints — requirement 3

/**
 * Does this set of legs satisfy every hard constraint?
 *
 * PREFIX-CLOSED, WHICH IS WHAT MAKES THE BEAM CORRECT. Every constraint here is
 * a cap on a count, so adding a leg can only ever move a set from legal to
 * illegal and never back. That means a partial slip that already violates one
 * can be pruned immediately — no extension of it will ever be legal — and the
 * beam never wastes width on branches that cannot produce a bet.
 *
 * A constraint that were NOT prefix-closed (a MINIMUM number of legs from one
 * sport, say) could not be checked during the search at all, and would have to
 * be applied at the end. There are none here on purpose.
 */
export function violatesConstraints(legs, constraints = {}) {
  const {
    max_legs_per_game: maxGame = Infinity,
    max_legs_per_team: maxTeam = Infinity,
    max_legs_per_player: maxPlayer = Infinity,
  } = constraints;

  const count = (key) => {
    const seen = new Map();
    for (const l of legs) {
      const v = l[key];
      if (v == null) continue;
      const k = String(v).toLowerCase();
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return seen.size ? Math.max(...seen.values()) : 0;
  };

  if (count('eventId') > maxGame) return `more than ${maxGame} legs from one game`;
  if (count('team') > maxTeam) return `more than ${maxTeam} legs from one team`;
  if (count('player') > maxPlayer) return `more than ${maxPlayer} legs on one player`;
  return null;
}

/** Per-leg admissibility: the constraints that do not depend on the other legs. */
export function legAdmissible(leg, constraints = {}) {
  const p = legWinProb(leg);
  if (!isFinite(p)) return 'no probability';
  if (p < (constraints.min_leg_probability ?? 0)) {
    return `win probability ${(p * 100).toFixed(1)}% is under the ${((constraints.min_leg_probability ?? 0) * 100).toFixed(0)}% floor`;
  }
  if (constraints.allow_low_confidence_legs === false && leg.lowConfidence) {
    return 'flagged low confidence by the model that produced it';
  }
  const sports = constraints.allowed_sports;
  if (Array.isArray(sports) && sports.length && !sports.includes(leg.league)) {
    return `sport "${leg.league}" is not in the allowed list`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. The prefilter

/**
 * Drop legs that cannot appear in any winning slip.
 *
 * ===========================================================================
 * THE_PREFILTER_IS_ADMISSIBLE_ONLY_UNDER_INDEPENDENCE, and that matters.
 *
 * For each leg, the most favourable slip it could possibly be in is itself plus
 * the best partners on the board. If even THAT slip is negative-EV under
 * independence, no independent slip containing the leg is positive, and it can
 * be dropped with no loss — a real admissibility argument, not a heuristic.
 *
 * Under a copula it is weaker, and in the direction that matters: positive
 * correlation raises P(all hit) above the product, so a leg the independent
 * bound rejects can be rescued by correlation. `prefilter_slack` is the margin
 * bought to cover that, and it is a knob rather than a claim.
 *
 * A NAIVE PER-LEG THRESHOLD WOULD BE WRONG. It is tempting to require each leg
 * to clear the slip's per-leg break-even — 59.5% for a 3-leg Power. It is also
 * false: legs at 0.90, 0.90 and 0.40 have a product of 0.324 against a
 * break-even of 0.2105, so a 40% leg sits happily inside a comfortably positive
 * slip. Any filter that drops it is discarding winners.
 * ===========================================================================
 */
export function prefilter(legs, { config, constraints = {}, slack = 0.05, shapes = null }) {
  const kept = [], dropped = [];
  const eligible = [];
  for (const leg of legs) {
    const why = legAdmissible(leg, constraints);
    if (why) dropped.push({ leg, reason: why, stage: 'constraint' });
    else eligible.push(leg);
  }
  if (!eligible.length) return { kept, dropped, bestPartners: [] };

  const shapeList = shapes || legalShapes(config, {
    minLegs: constraints.min_legs ?? 2,
    maxLegs: constraints.max_legs ?? 6,
  });
  // The best partners available, by win probability. Used only to build the
  // bound — the real search never assumes these are compatible with the leg.
  const byProb = [...eligible].sort((a, b) => legWinProb(b) - legWinProb(a));

  for (const leg of eligible) {
    const p = legWinProb(leg);
    let best = -Infinity, bestShape = null;
    for (const { slipType, legCount } of shapeList) {
      // Partners: the top (legCount - 1) OTHER legs on the board.
      const partners = [];
      for (const o of byProb) {
        if (o === leg) continue;
        partners.push(o);
        if (partners.length === legCount - 1) break;
      }
      if (partners.length < legCount - 1) continue;
      const probs = [p, ...partners.map(legWinProb)];
      const ev = evForSlip({ config, slipType, probs, legs: [leg, ...partners] }).evPerUnit;
      if (ev > best) { best = ev; bestShape = `${legCount}-${slipType}`; }
    }
    if (best >= -slack) kept.push(leg);
    else {
      dropped.push({
        leg,
        stage: 'hopeless',
        reason: `even beside the best legs on the board its best shape (${bestShape}) prices at `
          + `${(best * 100).toFixed(1)}%, below the -${(slack * 100).toFixed(0)}% slack`,
        bound: best,
      });
    }
  }
  return { kept, dropped, shapes: shapeList };
}

// ---------------------------------------------------------------------------
// 4. The beam

/**
 * Build slips one leg at a time, keeping the best `width` partials per size.
 *
 * Extensions only ever add a leg with a HIGHER INDEX than the last one added,
 * so each subset is generated exactly once. Without that the beam spends its
 * width on permutations of the same set and effectively searches a fraction of
 * what its width suggests.
 *
 * A partial is scored by the best INDEPENDENT EV over the legal shapes at its
 * current size. Where no shape is legal at that size — a single leg, or a size
 * the config does not offer — it is scored by the sum of log probabilities,
 * which is the quantity Power EV is monotone in and therefore the right proxy
 * for "is this on the way to something good".
 */
export function beamSearch({ legs, config, constraints = {}, width = 40, shapes = null }) {
  const minLegs = constraints.min_legs ?? 2;
  const maxLegs = Math.min(constraints.max_legs ?? 6, legs.length);
  const shapeList = shapes || legalShapes(config, { minLegs, maxLegs });
  const sizesWithShape = new Set(shapeList.map((s) => s.legCount));

  const score = (set) => {
    let best = -Infinity;
    for (const { slipType, legCount } of shapeList) {
      if (legCount !== set.length) continue;
      const ev = evForSlip({ config, slipType, probs: set.map(legWinProb), legs: set }).evPerUnit;
      if (ev > best) best = ev;
    }
    if (best > -Infinity) return best;
    // No legal shape at this size — score by the quantity Power EV is monotone
    // in, so the beam still prefers partials that can become good slips.
    return set.reduce((s, l) => s + Math.log(Math.max(1e-9, legWinProb(l))), 0) / Math.max(1, set.length);
  };

  const complete = [];
  let frontier = legs.map((leg, i) => ({ set: [leg], last: i }));
  let expansions = 0;

  for (let size = 1; size < maxLegs; size++) {
    const next = [];
    for (const node of frontier) {
      for (let i = node.last + 1; i < legs.length; i++) {
        const set = [...node.set, legs[i]];
        expansions++;
        // Prefix-closed, so a violation here prunes the whole branch.
        if (violatesConstraints(set, constraints)) continue;
        next.push({ set, last: i, score: score(set) });
      }
    }
    if (!next.length) break;
    next.sort((a, b) => b.score - a.score);
    frontier = next.slice(0, width);
    if (sizesWithShape.has(size + 1)) {
      for (const node of frontier) if (node.set.length >= minLegs) complete.push(node.set);
    }
  }

  return { candidates: complete, expansions, width, shapes: shapeList };
}

// ---------------------------------------------------------------------------
// 5. Pricing and reporting

/** Per-leg "why it cleared the bar" — requirement 4. */
function explainLegs(set, { config, slipType, legCount, matrix }) {
  const perLegBar = breakEven({ config, slipType, legCount, legs: set });
  return set.map((leg, i) => {
    const p = legWinProb(leg);
    const mates = matrix
      ? matrix[i].filter((_, j) => j !== i)
      : [];
    const meanRho = mates.length ? mates.reduce((s, v) => s + v, 0) / mates.length : 0;
    return {
      player: leg.player ?? null,
      market: leg.market ?? null,
      line: leg.line ?? null,
      side: leg.side ?? 'over',
      tier: leg.tier ?? null,
      league: leg.league ?? null,
      team: leg.team ?? null,
      eventId: leg.eventId ?? null,
      pWin: p,
      // The bar is the per-leg break-even for THIS slip shape — the flat rate
      // every leg would need if they were all identical. A leg below it is not
      // disqualified (see the prefilter note); it is being carried.
      perLegBreakEven: perLegBar,
      edge: perLegBar == null ? null : p - perLegBar,
      carries: perLegBar != null && p >= perLegBar,
      confidence: leg.lowConfidence ? 'low' : 'ok',
      marginalSource: leg.pmf ? 'projected distribution'
        : (leg.over != null || leg.under != null) ? 'book-derived probabilities'
          : 'judged probability',
      meanCorrelationToMates: meanRho,
      why: perLegBar == null
        ? `${(p * 100).toFixed(1)}% win probability`
        : p >= perLegBar
          ? `${(p * 100).toFixed(1)}% against a ${(perLegBar * 100).toFixed(1)}% per-leg bar — clears it by `
            + `${((p - perLegBar) * 100).toFixed(1)} points`
          : `${(p * 100).toFixed(1)}% against a ${(perLegBar * 100).toFixed(1)}% bar — carried by the rest of the slip, `
            + `which is ${((p - perLegBar) * 100).toFixed(1)} points stronger than it needs to be`,
    };
  });
}

/** Price one candidate set across every legal shape at its size. */
function priceCandidate(set, opts) {
  const { config, table, correlationConfig, paths, seed, shapes } = opts;
  const out = [];
  for (const { slipType, legCount } of shapes) {
    if (legCount !== set.length) continue;
    let priced;
    try {
      priced = priceSlip({ legs: set, table, config, slipType, paths, seed, correlationConfig });
    } catch { continue; }

    out.push({ slipType, legCount, set, priced, config });
  }
  return out;
}

/**
 * The whole optimisation.
 *
 * Returns the top N slips, the runner-up diff, and — when nothing clears the
 * bar — a `noBet` verdict that is a first-class answer rather than an empty
 * list. See requirement 6: "no bet today" and mean it.
 */
export function optimize({
  props,
  table = { pairs: {} },
  config,
  optimizerConfig = {},
  correlationConfig = {},
  bankroll = null,
}) {
  const constraints = { ...get(optimizerConfig, 'constraints', {}) };
  const staking = { ...get(optimizerConfig, 'staking', {}) };
  const search = { ...get(optimizerConfig, 'search', {}) };
  const minEv = get(optimizerConfig, 'reporting.min_ev_per_unit', 0);
  const bank = bankroll ?? staking.bankroll ?? 1000;

  const shapes = legalShapes(config, {
    minLegs: constraints.min_legs ?? 2,
    maxLegs: constraints.max_legs ?? 6,
  });

  // ---- 0. is a slip even possible? ---------------------------------------
  //
  // Checked BEFORE the prefilter, because the prefilter cannot answer it
  // sensibly. With one prop on the board there are no partners to build the
  // hopelessness bound against, so every leg falls through as "hopeless" and
  // the refusal blames the prop instead of the board. The size of the board is
  // a fact about the board.
  const minLegsNeeded = constraints.min_legs ?? 2;
  const eligible = props.filter((leg) => !legAdmissible(leg, constraints));
  if (eligible.length < minLegsNeeded) {
    return noBet({
      reason: `${eligible.length} prop${eligible.length === 1 ? '' : 's'} on the board `
        + `${eligible.length === 1 ? 'is' : 'are'} playable, and the smallest legal slip needs ${minLegsNeeded}`,
      board: {
        propsIn: props.length,
        afterConstraints: eligible.length,
        afterPrefilter: eligible.length,
        droppedForConstraints: props.length - eligible.length,
        droppedAsHopeless: 0,
        dropReasons: summariseDrops(props
          .filter((leg) => legAdmissible(leg, constraints))
          .map((leg) => ({ leg, stage: 'constraint', reason: legAdmissible(leg, constraints) }))),
      },
      shapes,
      constraints,
    });
  }

  // ---- 1. prefilter -------------------------------------------------------
  const pf = prefilter(props, {
    config, constraints, shapes,
    slack: search.prefilter_slack ?? 0.05,
  });

  const board = {
    propsIn: props.length,
    afterConstraints: props.length - pf.dropped.filter((d) => d.stage === 'constraint').length,
    afterPrefilter: pf.kept.length,
    droppedForConstraints: pf.dropped.filter((d) => d.stage === 'constraint').length,
    droppedAsHopeless: pf.dropped.filter((d) => d.stage === 'hopeless').length,
    dropReasons: summariseDrops(pf.dropped),
  };

  if (pf.kept.length < minLegsNeeded) {
    return noBet({
      reason: pf.kept.length === 0
        ? 'every playable prop was dropped as unable to appear in any winning slip'
        : `only ${pf.kept.length} prop survived the prefilter, and the smallest legal slip needs ${minLegsNeeded}`,
      board, shapes, constraints,
    });
  }

  // ---- 2. beam ------------------------------------------------------------
  const beam = beamSearch({
    legs: pf.kept, config, constraints,
    width: search.beam_width ?? 40,
    shapes,
  });

  // ---- 3. pricing, in two stages ------------------------------------------
  //
  // A 100k-path simulation costs about 80ms, and the beam produces a few
  // hundred candidates across every legal shape. Pricing all of them at full
  // resolution took 29 SECONDS on a 40-prop board — measured, not guessed —
  // which is not a tool anyone runs twice.
  //
  // So: SCREEN every candidate cheaply, then re-price only the finalists
  // exactly. At 5k paths the standard error on P(all hit) is about 0.007,
  // which cannot separate two slips that are genuinely close — and does not
  // need to, because a generous multiple of top_n goes through to the final
  // round and gets its real number there. The risk is a candidate mis-ranked at
  // the screen falling outside that multiple; the multiple is the margin.
  const screenPaths = search.screen_paths ?? 5000;
  const finalPaths = search.final_paths ?? 100000;
  const seed = search.seed ?? 20260910;
  const wanted = search.top_n ?? 5;

  const screened = [];
  for (const set of beam.candidates) {
    for (const cand of priceCandidate(set, {
      config, table, correlationConfig, shapes, paths: screenPaths, seed,
    })) screened.push(cand);
  }
  screened.sort((a, b) => (b.priced.correlated.evPerUnit - a.priced.correlated.evPerUnit)
    || (a.legCount - b.legCount));

  // WHICH candidates go to the expensive round is chosen HERE, not after, and
  // that ordering matters. Taking the top twenty by screened EV and then
  // filtering for diversity leaves two survivors on a real board, because the
  // top twenty are permutations of one idea. Selecting the diverse set FIRST
  // and pricing that exactly is what makes the finalists both accurate and
  // different from each other.
  const minDistinct = get(optimizerConfig, 'reporting.min_distinct_legs', 2);
  const keyOf = (c) => new Set(c.set.map((l) => `${l.player}|${l.market}|${l.line}|${l.side}`));
  const distinctFrom = (cand, list) => !list.some((c) => {
    const a = keyOf(cand), b = keyOf(c);
    let shared = 0;
    for (const x of a) if (b.has(x)) shared++;
    return Math.max(a.size, b.size) - shared < minDistinct;
  });

  const diverse = [];
  for (const cand of screened) {
    if (diverse.length >= wanted) break;
    if (distinctFrom(cand, diverse)) diverse.push(cand);
  }
  // The true second best joins them whether or not it is distinct — it is the
  // runner-up diff's whole subject, and it has to carry an exact price.
  const finalists = [...diverse];
  if (screened[1] && !finalists.includes(screened[1])) finalists.push(screened[1]);
  // A little headroom, so a candidate the cheap screen mis-ranked can still
  // climb back on its real number.
  for (const c of screened.slice(0, Math.max(12, wanted * 2))) {
    if (!finalists.includes(c)) finalists.push(c);
  }

  const priced = [];
  for (const c of finalists) {
    for (const cand of priceCandidate(c.set, {
      config, table, correlationConfig, shapes: [{ slipType: c.slipType, legCount: c.legCount }],
      paths: finalPaths, seed,
    })) priced.push(cand);
  }

  // Rank on the CORRELATED EV. That is the number that is actually true; the
  // independent one only guided the search.
  priced.sort((a, b) => (b.priced.correlated.evPerUnit - a.priced.correlated.evPerUnit)
    || (a.legCount - b.legCount));

  // ---- 4. the floor — requirement 6 ---------------------------------------
  const positive = priced.filter((p) => p.priced.correlated.evPerUnit > minEv);
  if (!positive.length) {
    const bestSeen = priced[0];
    return noBet({
      reason: bestSeen
        ? `the best slip on the board prices at ${(bestSeen.priced.correlated.evPerUnit * 100).toFixed(1)}% `
          + `per unit staked, which is not positive`
        : 'no legal slip could be built from the surviving props',
      bestRejected: bestSeen ? summarise(bestSeen, { bank, staking }) : null,
      board, shapes, constraints, beam,
      considered: priced.length,
    });
  }

  // ---- the reported list, diversified -------------------------------------
  //
  // Re-applied on the EXACT prices, because the cheap screen chose the
  // finalists on a noisier number and the final ranking can differ.
  const chosen = [];
  for (const cand of positive) {
    if (chosen.length >= wanted) break;
    if (distinctFrom(cand, chosen)) chosen.push(cand);
  }
  const topN = chosen.map((c) => summarise(c, { bank, staking }));
  // The true second best, whether or not it survived the diversity rule.
  const trueRunnerUp = positive[1] ? summarise(positive[1], { bank, staking }) : null;

  // ---- 5. stake allocation, against the slate cap -------------------------
  const cap = staking.max_slate_stake;
  const rawTotal = topN.reduce((s, x) => s + x.staking.stake, 0);
  let scale = 1;
  if (cap != null && rawTotal > cap && rawTotal > 0) {
    scale = cap / rawTotal;
    for (const x of topN) {
      x.staking.stakeBeforeSlateCap = x.staking.stake;
      // FLOORED, not rounded. Rounding each stake to the nearest cent can push
      // the total a cent OVER the cap, and a cap that is exceeded by a cent is
      // not a cap — it is a suggestion, and the next person to read the code
      // would be right to stop trusting it.
      x.staking.stake = Math.floor(x.staking.stake * scale * 100) / 100;
      x.staking.scaledBySlateCap = true;
      // RECOMPUTED, because it is quoted against a stake that just changed.
      // ev.atRecommendedStake was calculated inside summarise() from the
      // pre-cap Kelly stake, so on a capped slate it reported the EV of a bet
      // three times larger than the one being recommended.
      x.ev.atRecommendedStake = x.ev.perUnit * x.staking.stake;
    }
  }

  return {
    noBet: false,
    slips: topN,
    // Against the TRUE second best — see the diversity note above.
    runnerUpDiff: trueRunnerUp ? diffSlips(topN[0], trueRunnerUp) : null,
    runnerUp: trueRunnerUp,
    nextDistinctDiff: topN.length > 1 ? diffSlips(topN[0], topN[1]) : null,
    staking: {
      bankroll: bank,
      kellyMultiplier: staking.kelly_multiplier ?? 0.25,
      slateCap: cap ?? null,
      recommendedTotal: Math.round(topN.reduce((s, x) => s + x.staking.stake, 0) * 100) / 100,
      uncappedTotal: Math.round(rawTotal * 100) / 100,
      scaledBySlateCap: scale < 1,
      scale,
    },
    board,
    search: {
      method: 'prefilter + beam search + exact correlated pricing',
      // NEVER PRESENTED AS OPTIMAL. It is a beam.
      optimality: 'heuristic — a beam can discard a partial that would have grown into the best slip',
      beamWidth: beam.width,
      expansions: beam.expansions,
      candidatesPriced: priced.length,
      candidatesPositive: positive.length,
      shapes: shapes.map((s) => `${s.legCount}-${s.slipType}`),
    },
    constraints,
  };
}

function noBet({ reason, board, shapes, constraints, beam = null, bestRejected = null, considered = 0 }) {
  return {
    noBet: true,
    verdict: 'NO BET TODAY',
    reason,
    // Stated in full, because the useful part of a no-bet is WHY.
    bestRejected,
    slips: [],
    runnerUpDiff: null,
    board,
    search: {
      method: 'prefilter + beam search + exact correlated pricing',
      beamWidth: beam?.width ?? null,
      expansions: beam?.expansions ?? 0,
      candidatesPriced: considered,
      candidatesPositive: 0,
      shapes: (shapes || []).map((s) => `${s.legCount}-${s.slipType}`),
    },
    constraints,
  };
}

function summariseDrops(dropped) {
  const out = {};
  for (const d of dropped) {
    const key = d.stage === 'hopeless' ? 'no winning slip could contain it' : d.reason.replace(/[\d.]+/g, 'N');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** One priced candidate, in the shape the report needs — requirement 4. */
function summarise(cand, { bank, staking }) {
  const { priced, slipType, legCount, set } = cand;
  // The engine's own tier breakdown — probability beside the multiplier it
  // pays. Kelly needs the multipliers, and only the payout engine knows them.
  const outcomes = priced.correlated.byOutcome || [];

  const k = kellyStake({ byOutcome: outcomes }, {
    bankroll: bank,
    multiplier: staking.kelly_multiplier ?? 0.25,
    maxStake: staking.max_stake_per_slip ?? null,
  });

  return {
    id: `${legCount}-${slipType}:${set.map((l) => l.player).join('+')}`,
    slipType,
    legCount,
    ev: {
      perUnit: priced.correlated.evPerUnit,
      // Requirement 4 asks for both. They are the same number twice, and both
      // get asked for because "EV" alone is read as currency half the time.
      percentOfStake: priced.correlated.evPerUnit * 100,
      atRecommendedStake: priced.correlated.evPerUnit * k.stake,
      naivePerUnit: priced.naive.evPerUnit,
    },
    // THE CORRELATION CONTRIBUTION — how much of this slip's EV exists only
    // because the legs move together.
    correlation: {
      contributionPerUnit: priced.delta.evPerUnit,
      contributionShare: priced.correlated.evPerUnit !== 0
        ? priced.delta.evPerUnit / priced.correlated.evPerUnit : null,
      significant: priced.delta.significant,
      meanPairwise: priced.correlation.meanOffDiagonal,
      maxPairwise: priced.correlation.maxAbsOffDiagonal,
      confidence: priced.correlation.confidence,
      matrixAdjusted: priced.correlation.matrixAdjusted,
      // The matrix itself, so a slip's price can be reproduced from the report
      // rather than only inspected through the summary statistics above.
      matrix: priced.correlation.matrix,
      provenance: priced.correlation.provenance,
    },
    tiers: outcomes
      .filter((o) => o.probability > 1e-9)
      .map((o) => ({
        correct: o.correct,
        pushes: o.pushes ?? 0,
        probability: o.probability,
        multiplier: o.multiplier,
        contribution: o.contribution,
      }))
      .sort((a, b) => b.correct - a.correct),
    probAllHit: priced.correlated.probAllHit,
    legs: explainLegs(set, { config: cand.config, slipType, legCount, matrix: priced.correlation.matrix }),
    payoutTable: payoutTable(cand.config, slipType, legCount),
    staking: {
      kellyFraction: k.fraction,
      fullKelly: k.full,
      stake: k.stake,
      expectedLogGrowth: k.expectedLogGrowth,
    },
    simulation: priced.simulation,
    _legs: set,
    _priced: priced,
  };
}

/**
 * What changed between the best slip and the runner-up — requirement 5.
 *
 * The point is not the EV gap, it is WHICH LEGS MOVED. A runner-up that swaps
 * one leg says the model is nearly indifferent between two props; one that
 * changes slip type on identical legs says the decision was about the payout
 * curve, not the picks; one that shares nothing says the board has two
 * unrelated ideas and the ranking between them is thin.
 */
export function diffSlips(a, b) {
  const key = (l) => `${l.player}|${l.market}|${l.line}|${l.side}`;
  const aKeys = new Set(a.legs.map(key));
  const bKeys = new Set(b.legs.map(key));
  const shared = a.legs.filter((l) => bKeys.has(key(l)));
  const onlyBest = a.legs.filter((l) => !bKeys.has(key(l)));
  const onlyRunnerUp = b.legs.filter((l) => !aKeys.has(key(l)));

  const shapeChanged = a.slipType !== b.slipType || a.legCount !== b.legCount;
  let story;
  if (!onlyBest.length && !onlyRunnerUp.length && shapeChanged) {
    story = `Identical legs, different shape: ${a.legCount}-${a.slipType} against ${b.legCount}-${b.slipType}. `
      + 'The choice here was the payout curve, not the picks.';
  } else if (onlyBest.length === 1 && onlyRunnerUp.length === 1) {
    const inLeg = onlyBest[0], outLeg = onlyRunnerUp[0];
    story = `One leg apart: ${inLeg.player} ${inLeg.market} ${inLeg.line} (${(inLeg.pWin * 100).toFixed(1)}%) `
      + `instead of ${outLeg.player} ${outLeg.market} ${outLeg.line} (${(outLeg.pWin * 100).toFixed(1)}%). `
      + `Worth ${((a.ev.perUnit - b.ev.perUnit) * 100).toFixed(2)} points of EV per unit — `
      + (Math.abs(a.ev.perUnit - b.ev.perUnit) < 0.02
        ? 'close enough that the model is nearly indifferent between them.'
        : 'a clear preference.');
  } else if (!shared.length) {
    story = 'No legs in common at all. These are two unrelated ideas, and the ranking between them is only '
      + `${((a.ev.perUnit - b.ev.perUnit) * 100).toFixed(2)} points wide.`;
  } else {
    story = `${shared.length} leg(s) shared, ${onlyBest.length} swapped out for ${onlyRunnerUp.length}. `
      + `EV gap ${((a.ev.perUnit - b.ev.perUnit) * 100).toFixed(2)} points per unit.`;
  }

  return {
    evGapPerUnit: a.ev.perUnit - b.ev.perUnit,
    shapeChanged,
    sharedLegs: shared.map((l) => `${l.player} ${l.market} ${l.line}`),
    onlyInBest: onlyBest.map((l) => `${l.player} ${l.market} ${l.line} (${(l.pWin * 100).toFixed(1)}%)`),
    onlyInRunnerUp: onlyRunnerUp.map((l) => `${l.player} ${l.market} ${l.line} (${(l.pWin * 100).toFixed(1)}%)`),
    correlationGap: a.correlation.contributionPerUnit - b.correlation.contributionPerUnit,
    story,
  };
}

// ---------------------------------------------------------------------------
// 6. Rendering

const pc = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const sg = (v, d = 1) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const wrap = (text, width) => {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
};

/** The optimizer's output as text. */
export function renderOptimizerReport(r, { width = 78 } = {}) {
  const L = [];
  L.push('═'.repeat(width));
  L.push('SLIP OPTIMIZER');
  L.push('═'.repeat(width));

  // ---- the refusal, which is a first-class answer ------------------------
  if (r.noBet) {
    L.push('');
    L.push('┌' + '─'.repeat(width - 2) + '┐');
    L.push('│ 🚫  NO BET TODAY' + ' '.repeat(Math.max(0, width - 19)) + '│');
    L.push('│' + ' '.repeat(width - 2) + '│');
    for (const line of wrap(r.reason, width - 4)) L.push('│ ' + line.padEnd(width - 4) + ' │');
    L.push('└' + '─'.repeat(width - 2) + '┘');
    L.push('');
    L.push(`  ${r.board.propsIn} props in · ${r.board.droppedForConstraints} failed a constraint · `
      + `${r.board.droppedAsHopeless} could not appear in any winning slip`);
    for (const [reason, n] of Object.entries(r.board.dropReasons || {})) {
      for (const [i, w] of wrap(`${String(n).padStart(5)}  ${reason}`, width - 6).entries()) {
        L.push(`    ${i ? '       ' : ''}${w}`);
      }
    }
    if (r.bestRejected) {
      L.push('');
      L.push(`  The best thing on the board was a ${r.bestRejected.legCount}-leg ${r.bestRejected.slipType} `
        + `at ${sg(r.bestRejected.ev.perUnit)} per unit staked. It was rejected, not shown as a recommendation.`);
    }
    L.push('');
    L.push('═'.repeat(width));
    return L.join('\n');
  }

  L.push('');
  L.push(`  ${r.slips.length} slip(s) · bankroll ${r.staking.bankroll} · `
    + `${r.staking.kellyMultiplier}x Kelly · slate cap ${r.staking.slateCap ?? 'none'}`);
  if (r.staking.scaledBySlateCap) {
    L.push(`  ⚠ stakes scaled to ${(r.staking.scale * 100).toFixed(0)}% — uncapped total was `
      + `${r.staking.uncappedTotal}, the slate cap is ${r.staking.slateCap}`);
  }

  r.slips.forEach((s, idx) => {
    L.push('');
    L.push('─'.repeat(width));
    L.push(`${idx === 0 ? 'BEST' : `#${idx + 1}`}  ${s.legCount}-leg ${s.slipType.toUpperCase()}`
      + `   EV ${sg(s.ev.perUnit)} per unit   stake ${s.staking.stake}   `
      + `EV ${s.ev.atRecommendedStake >= 0 ? '+' : ''}${s.ev.atRecommendedStake.toFixed(2)}`);
    L.push('─'.repeat(width));
    for (const leg of s.legs) {
      L.push(`  ${(leg.player || '?').slice(0, 18).padEnd(19)}${(`${leg.market} ${leg.side} ${leg.line}`).slice(0, 26).padEnd(27)}`
        + `${pc(leg.pWin).padStart(7)}  ${leg.carries ? '✓' : '·'} ${leg.tier || ''}`);
      for (const w of wrap(leg.why, width - 8)) L.push(`      ${w}`);
    }
    L.push('');
    // Wrapped: a 6-leg slip has seven tiers and they ran to 125 columns on one
    // line. Only the tiers that PAY are listed — the zero-multiplier rows are
    // the ways to lose, and printing five of them buries the two that matter.
    const paying = s.tiers.filter((x) => x.multiplier > 0);
    const shown = (paying.length ? paying : s.tiers)
      .map((x) => `${x.correct}/${s.legCount} ${pc(x.probability, 1)} @${x.multiplier}x`).join('   ');
    for (const [i, w] of wrap(shown, width - 18).entries()) {
      L.push(`  ${i === 0 ? 'payout tiers:  ' : '               '}${w}`);
    }
    if (paying.length && paying.length < s.tiers.length) {
      L.push(`                 (${s.tiers.length - paying.length} losing outcome(s) not shown, `
        + `${pc(1 - paying.reduce((a, b) => a + b.probability, 0), 1)} combined)`);
    }
    L.push(`  correlation:   ${sg(s.correlation.contributionPerUnit)} of the EV `
      + `(mean pairwise ${s.correlation.meanPairwise.toFixed(3)}, confidence ${s.correlation.confidence.level})`
      + `${s.correlation.significant ? '' : ' — inside simulation noise'}`);
    L.push(`  naive EV:      ${sg(s.ev.naivePerUnit)} — what independence would have said`);
    L.push(`  kelly:         ${(s.staking.fullKelly * 100).toFixed(2)}% full, `
      + `${(s.staking.kellyFraction * 100).toFixed(2)}% at ${r.staking.kellyMultiplier}x`);
  });

  // ---- the runner-up, and what changed — requirement 5 --------------------
  if (r.runnerUpDiff) {
    L.push('');
    L.push('─'.repeat(width));
    L.push('WHAT SEPARATES THE BEST SLIP FROM THE SECOND BEST');
    L.push('─'.repeat(width));
    for (const w of wrap(r.runnerUpDiff.story, width - 4)) L.push(`  ${w}`);
    if (r.runnerUpDiff.sharedLegs.length) {
      L.push(`  shared:   ${r.runnerUpDiff.sharedLegs.join(' · ')}`);
    }
    if (r.runnerUpDiff.onlyInBest.length) {
      L.push(`  only #1:  ${r.runnerUpDiff.onlyInBest.join(' · ')}`);
    }
    if (r.runnerUpDiff.onlyInRunnerUp.length) {
      L.push(`  only #2:  ${r.runnerUpDiff.onlyInRunnerUp.join(' · ')}`);
    }
  }

  L.push('');
  L.push('─'.repeat(width));
  L.push(`  ${r.board.propsIn} props in → ${r.board.afterPrefilter} searched → `
    + `${r.search.candidatesPriced} slips priced → ${r.search.candidatesPositive} positive`);
  for (const w of wrap(r.search.optimality, width - 4)) L.push(`  ${w}`);
  L.push('');
  L.push('═'.repeat(width));
  return L.join('\n');
}

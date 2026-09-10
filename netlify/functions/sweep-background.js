// netlify/functions/sweep-background.js
//
// BACKGROUND FUNCTION (name ends in -background.js -> 15-min budget, returns 202).
// The browser polls sweep-status.js for the result.
//
// FULL SWEEP — exhaustive coverage instead of one sample.
//
// A normal Find Bets run looks at one league, one slate, the tiers you picked,
// one side per prop. "No slip" then means "no slip in that one sample". A sweep
// runs the SAME candidate + judge + edge pipeline over every league with a slate
// in the window (today, or the next game day when today is empty), all three
// tiers, both sides — so "no slip" becomes a statement about the whole
// opportunity space.
//
// WHAT IT DOES NOT DO. It does not touch a single threshold. edgeVerdictFor,
// the per-tier break-even, selectLegs, verdictFor, ODDS_PRIOR, tier weighting,
// sizing and every prompt are imported and used exactly as a normal run uses
// them. A sweep widens what gets EVALUATED, never what PASSES — a leg it
// surfaces cleared the identical gate a Find Bets leg clears.
//
// SELECTION INTENSITY. A leg that clears out of 1200 swept candidates is a
// weaker claim than one that clears out of 40. Every slip a sweep builds
// carries `sweptN` (props evaluated to produce it) on the slip, on its
// pick-log rows, and on the screen, so the log can tell the two apart later.
//
// COST. A sweep costs many times a single run. It reports an up-front estimate
// and the measured spend, and stops early when a configurable cap
// (SWEEP_COST_CAP_USD, or body.costCapUsd) would be exceeded.

import { getStore } from '@netlify/blobs';
// The real pipeline, imported and driven unchanged — see the header note.
import {
  handler as betFinder,
  selectLegs,
  sizeParlay,
  fetchLeagueCatalog,
} from './bet-finder-background.js';
// Ground-truth "how many of the last five cleared the line", the one function
// the judge payload, the board pick log and ask.js all share. Reused here so a
// sweep row's `cleared` is computed the same way every other logged row's is.
import { clearedCount } from './top-picks.js';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// All configurable — a sweep's whole risk is cost, so its knobs are env vars,
// not constants. body.* overrides win over the env default where it makes sense.
const SWEEP_COST_CAP_USD = num(process.env.SWEEP_COST_CAP_USD, 8);
const SWEEP_EST_PER_LEAGUE_USD = num(process.env.SWEEP_EST_PER_LEAGUE_USD, 0.15);
const SWEEP_CONCURRENCY = Math.max(1, Math.round(num(process.env.SWEEP_CONCURRENCY, 3)));
const SWEEP_PER_LEAGUE_MAX_PICKS = Math.max(3, Math.min(60, Math.round(num(process.env.SWEEP_PER_LEAGUE_MAX_PICKS, 60))));
const SWEEP_MAX_LEAGUES = Math.max(1, Math.round(num(process.env.SWEEP_MAX_LEAGUES, 16)));
// Leave headroom under Netlify's 15-min background budget so a slow sweep
// writes the partial coverage report it has rather than being killed with none.
const SWEEP_DEADLINE_MS = num(process.env.SWEEP_DEADLINE_MS, 12 * 60 * 1000);

// Edge is `sideProb - breakEven`; in practice it runs roughly -0.6 .. +0.3.
function bucketEdges(edges) {
  const b = { belowMinus10: 0, minus10toMinus5: 0, minus5toZero: 0, zeroToPlus5: 0, plus5AndUp: 0 };
  for (const e of edges) {
    if (e < -0.10) b.belowMinus10++;
    else if (e < -0.05) b.minus10toMinus5++;
    else if (e < 0) b.minus5toZero++;
    else if (e < 0.05) b.zeroToPlus5++;
    else b.plus5AndUp++;
  }
  return b;
}

const round = (n, dp = 4) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const fmtEdge = (e) => (e == null ? 'n/a' : `${e >= 0 ? '+' : ''}${e.toFixed(2)}`);

export const handler = async (event) => {
  const store = getStore({
    name: 'bet-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
  let jobId;
  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

    const legs = Math.max(2, Math.min(6, Number(body.legs) || 3));
    const costCapUsd = num(body.costCapUsd, SWEEP_COST_CAP_USD);
    const perLeagueMaxPicks = Math.max(3, Math.min(60, Number(body.perLeagueMaxPicks) || SWEEP_PER_LEAGUE_MAX_PICKS));
    const base = {
      bankroll: Number(body.bankroll) || 0,
      floor: Number(body.floor) || 0,
      maxStake: body.maxStake ? Number(body.maxStake) : null,
      prompt: body.prompt ? String(body.prompt) : null,
      model: body.model ? String(body.model) : null,
    };

    const startedAt = new Date();
    const started = Date.now();
    const deadline = started + SWEEP_DEADLINE_MS;
    const stamp = startedAt.toISOString();

    const tick = (step, extra = {}) => store.setJSON(jobId, {
      status: 'running', step, startedAt: stamp, elapsedMs: Date.now() - started, ...extra,
    });
    await tick('enumerating leagues');

    // ---- 1. which leagues have a board worth sweeping --------------------
    // An explicit list wins. Otherwise take PrizePicks' own catalog of what it
    // is posting right now: active, a real top-level league (not a 1H/1Q split
    // of another), with props on the board. A league with no gradeable stat
    // mapping still gets swept — findCandidates drops its rows for free and the
    // sub-run returns an empty board in well under a second, so it costs a
    // props fetch and nothing else, and the coverage report still names it.
    let leagues = Array.isArray(body.leagues) && body.leagues.length
      ? [...new Set(body.leagues.map((l) => String(l).toLowerCase().trim()).filter(Boolean))]
      : null;
    let catalogNote = null;
    const leagueCapSkips = [];
    if (!leagues) {
      try {
        const catalog = await fetchLeagueCatalog();
        const ranked = catalog
          .filter((l) => l.active !== false)
          .filter((l) => l.parentId == null)
          .filter((l) => l.projections == null || l.projections > 0)
          .sort((a, b) => (b.projections || 0) - (a.projections || 0));
        leagues = [...new Set(ranked.map((l) => l.tag))];
        if (leagues.length > SWEEP_MAX_LEAGUES) {
          for (const t of leagues.slice(SWEEP_MAX_LEAGUES)) leagueCapSkips.push({ league: t, reason: 'league cap' });
          leagues = leagues.slice(0, SWEEP_MAX_LEAGUES);
        }
      } catch (e) {
        leagues = ['mlb'];
        catalogNote = `league catalog unavailable (${e.message}) — swept MLB only`;
      }
    }

    // ---- 2. run each league through the real pipeline -------------------
    // A sub-run is a normal Find Bets run with all tiers, both sides, the
    // widest board the pipeline allows, and slate:'next' (today, or the next
    // game day when today is empty). `sweep: true` tells it not to write its
    // own pick-log rows — this orchestrator owns sweep logging, because
    // source:'sweep' and sweptN are not known until every league is judged.
    const costStore = getStore({ name: 'cost-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const day = new Date().toISOString().slice(0, 10);
    const spentSince = async (sinceMs) => {
      try {
        const arr = (await costStore.get(day, { type: 'json' })) || [];
        return arr.filter((e) => Date.parse(e.at) >= sinceMs).reduce((s, e) => s + (Number(e.usd) || 0), 0);
      } catch { return 0; }
    };

    const subResults = [];      // { league, result } | { league, error }
    const skipped = [...leagueCapSkips];
    let costCappedEarly = false;
    let cursor = 0;

    const runLeague = async (league) => {
      const subId = `${jobId}__${league}`;
      try {
        await betFinder({ httpMethod: 'POST', body: JSON.stringify({
          ...base,
          jobId: subId,
          league,
          today: true,
          slate: 'next',
          tiers: ['goblin', 'standard', 'demon'],
          sides: 'both',
          balance: true,                 // even tier sampling — see findCandidates
          maxPicks: perLeagueMaxPicks,
          sweep: true,                   // this orchestrator owns the pick log
        }) });
        const job = await store.get(subId, { type: 'json' });
        if (job && job.status === 'done') subResults.push({ league, result: job.result || {} });
        else subResults.push({ league, error: (job && job.message) || 'sub-run produced no result' });
      } catch (e) {
        subResults.push({ league, error: String(e.message || e) });
      }
      await tick(`swept ${subResults.length}/${leagues.length} leagues`, { leaguesDone: subResults.length });
    };

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= leagues.length) return;
        const league = leagues[i];
        if (Date.now() > deadline) { skipped.push({ league, reason: 'time deadline' }); continue; }
        // Cost gate. spentSince reads the shared cost log, which the sub-runs
        // write best-effort and un-awaited, so it lags — the per-league
        // estimate buffer and the hard deadline are what actually bound the
        // spend. Still worth checking: a sweep that has already blown the cap
        // stops here rather than judging another twelve leagues.
        const spent = await spentSince(started);
        if (spent + SWEEP_EST_PER_LEAGUE_USD > costCapUsd) {
          costCappedEarly = true;
          skipped.push({ league, reason: 'cost cap' });
          continue;
        }
        await runLeague(league);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, leagues.length) }, worker));

    await tick('aggregating coverage');

    // ---- 3. aggregate ---------------------------------------------------
    const covered = subResults.filter((r) => r.result);
    const allPicks = [];
    const slates = [];
    const slateDateByLeague = {};
    let propsEvaluated = 0;
    let propsJudged = 0;
    for (const { league, result } of covered) {
      const picks = Array.isArray(result.allPicks) ? result.allPicks : [];
      for (const p of picks) allPicks.push({ ...p, league });
      propsJudged += picks.length;
      propsEvaluated += Number(result?.timing?.candidates) || picks.length;
      const sd = result?.slate?.date || null;
      slateDateByLeague[league] = sd || day;
      slates.push({
        league,
        date: sd,
        usedNext: !!result?.slate?.usedNext,
        props: picks.length,
        empty: !picks.length,
        note: picks.length ? null : (result?.emptyMessage || null),
      });
    }
    for (const { league, error } of subResults.filter((r) => r.error)) {
      slates.push({ league, date: null, usedNext: false, props: 0, empty: true, note: `error: ${error}` });
    }

    // The count that goes on every slip and every logged row this sweep produces.
    const sweptN = propsEvaluated;

    // ---- edge distribution over everything evaluated -------------------
    const priced = allPicks.filter((p) => p.edge != null && Number.isFinite(p.edge));
    const edges = priced.map((p) => p.edge).sort((a, b) => a - b);
    const median = edges.length ? edges[Math.floor((edges.length - 1) / 2)] : null;
    const edgeReport = {
      n: edges.length,
      unpriced: allPicks.length - priced.length,   // goblin/demon unders — payout unknown, edge null
      min: edges.length ? round(edges[0]) : null,
      median: round(median),
      max: edges.length ? round(edges[edges.length - 1]) : null,
      buckets: bucketEdges(edges),
    };
    const gate = (p) => p.edgeVerdict || p.sideVerdict || p.verdict;
    const clearedEdgeGE0 = edges.filter((e) => e >= 0).length;
    const clearedGate = allPicks.filter((p) => gate(p) === 'play' || gate(p) === 'lean').length;

    // ---- 4. slip — identical selection + gate as a normal run ---------
    const chosen = selectLegs(allPicks, legs);
    let parlay = null;
    let parlayLegs = [];
    let parlayNote = null;
    if (chosen.length >= 3) {
      parlay = sizeParlay(
        chosen.map((p) => ({ ...p, prob: p.sideProb != null ? p.sideProb : p.prob })),
        { bankroll: base.bankroll, floor: base.floor, maxStake: base.maxStake },
      );
      parlayLegs = chosen.map((p) => ({
        player: p.player, stat: p.stat, statDisplay: p.statDisplay, line: p.line,
        prob: p.sideProb != null ? p.sideProb : p.prob,
        probOver: p.prob, pick: p.side || 'over',
        verdict: p.edgeVerdict || p.sideVerdict || p.verdict,
        oddsType: p.oddsType, edge: p.edge, breakEven: p.breakEven,
        team: p.team, matchup: p.matchupLabel || p.matchup, league: p.league,
        projectionId: p.projectionId || null, start: p.start || null,
        headshot: p.headshot || null, teamLogo: p.teamLogo || null,
        key_risk: p.key_risk || null, mlbId: p.mlbId || null,
        // Selection intensity — how many props were evaluated to surface this leg.
        sweptN,
      }));
      parlayNote = {
        requested: legs,
        built: chosen.length,
        shortfall: chosen.shortfall || 0,
        poolSize: chosen.poolSize || 0,
        sides: 'both',
        sweptN,
      };
    }

    // ---- 5. log the sweep's recommendations as their own population ---
    // source:'sweep', the way source:'ledger' already is — calibration groups
    // by source, so these never pool with a normal board run's rows. Only the
    // legs that cleared the gate are logged (as with a ledger re-judge), each
    // carrying sweptN so a months-later read can weigh the selection intensity.
    const toLog = allPicks.filter((p) => gate(p) === 'play' || gate(p) === 'lean');
    if (toLog.length) {
      try {
        const logStore = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
        const byDay = {};
        for (const p of toLog) {
          const d = slateDateByLeague[p.league] || day;
          (byDay[d] ||= []).push({
            date: d, loggedAt: stamp, league: p.league,
            source: 'sweep',
            sweptN,
            projectionId: p.projectionId || null,
            player: p.player, stat: p.stat, line: p.line,
            prob: p.prob, verdict: p.verdict, oddsType: p.oddsType,
            edgeVerdict: p.edgeVerdict ?? null,
            side: p.side || null, sideProb: p.sideProb ?? null,
            edge: p.edge ?? null, sidePriceUnverified: !!p.sidePriceUnverified,
            promptVersion: p.promptVersion || null,
            judgeModel: p.judgeModel || base.model || null,
            cleared: clearedCount(p.recent5, p.line),
            judgeClearedClaim: p.cleared ?? null,
            deepDive: !!p.deepDive,
            shallowProb: p.shallowProb ?? null, shallowEdge: p.shallowEdge ?? null,
            standout: p.standout ?? null,
            shrunkProb: null,
            wagerTypes: p.wagerTypes ?? null,
            recentAvg: p.recentAvg ?? null,
            mlbId: p.mlbId ?? null, image: p.image || null, team: p.team || null,
            matchup: p.matchupLabel || p.matchup || null,
            result: null, hit: null, gradedAt: null,
          });
        }
        // Merge in place, exactly as the board engine does: keyed by source +
        // judge config + projection id, a graded row always beats a fresh one.
        const keyOf = (p) => [
          p.source || 'board', p.promptVersion || '', p.judgeModel || '',
          p.projectionId || `${p.player}|${p.stat}|${p.line}`,
        ].join('|');
        for (const [d, rows] of Object.entries(byDay)) {
          let existing = [];
          try { existing = (await logStore.get(d, { type: 'json' })) || []; } catch {}
          const m = new Map();
          for (const p of existing) m.set(keyOf(p), p);
          for (const p of rows) {
            const prev = m.get(keyOf(p));
            if (prev && (prev.hit === true || prev.hit === false)) continue;
            m.set(keyOf(p), p);
          }
          await logStore.setJSON(d, [...m.values()]);
        }
      } catch { /* logging is best-effort — never fail a sweep on it */ }
    }

    // ---- 6. report — always, whether or not anything cleared ---------
    const leaguesCovered = covered.length;
    const slatesCovered = slates.filter((s) => !s.empty).length;
    const spentUsd = await spentSince(started);
    const cost = {
      estimatedUsd: round(SWEEP_EST_PER_LEAGUE_USD * leagues.length, 2),
      actualUsd: round(spentUsd, 4),
      capUsd: round(costCapUsd, 2),
      perLeagueEstimateUsd: SWEEP_EST_PER_LEAGUE_USD,
      cappedEarly: costCappedEarly,
      note: 'actualUsd is read from the shared cost log over the sweep window; best-effort, may lag or include a concurrent run.',
    };

    let summary;
    if (parlay && chosen.length >= 3) {
      summary = `Swept ${sweptN} props across ${leaguesCovered} leagues, ${slatesCovered} slates. `
        + `${clearedGate} cleared edge ≥ 0 — built a ${chosen.length}-leg slip.`;
    } else {
      summary = `Swept ${sweptN} props across ${leaguesCovered} leagues, ${slatesCovered} slates. `
        + `Best edge ${fmtEdge(edgeReport.max)}. `
        + (clearedGate >= 1
          ? `${clearedGate} cleared but fewer than 3 — no slip.`
          : 'Nothing cleared.');
    }

    const board = allPicks
      .filter((p) => gate(p) === 'play' || gate(p) === 'lean')
      .sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity));

    const errors = Object.fromEntries(subResults.filter((r) => r.error).map((r) => [r.league, r.error]));

    await store.setJSON(jobId, {
      status: 'done',
      totalMs: Date.now() - started,
      result: {
        sweep: true,
        summary,
        sweptN,
        coverage: {
          leaguesRequested: leagues.length,
          leaguesCovered,
          leagues,
          slates,
          slatesCovered,
          propsEvaluated,
          propsJudged,
          skipped,
          catalogNote,
          deadlineHit: Date.now() > deadline,
        },
        edge: edgeReport,
        cleared: { edgeGE0: clearedEdgeGE0, gate: clearedGate },
        cost,
        parlay,
        parlayLegs,
        parlayNote,
        board,
        errors,
        params: { legs, costCapUsd, perLeagueMaxPicks, prompt: base.prompt, model: base.model },
        timing: { totalMs: Date.now() - started },
      },
    });
    return { statusCode: 202 };
  } catch (err) {
    if (jobId) await store.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    return { statusCode: 202 };
  }
};

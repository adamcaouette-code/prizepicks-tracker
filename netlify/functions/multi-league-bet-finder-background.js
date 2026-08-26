// netlify/functions/multi-league-bet-finder-background.js
//
// Multi-league orchestration: one judge call per selected league, merged
// post-judgment. Each league is judged identically to single-league runs;
// only the orchestration and merge are new. This preserves the config freeze.
//
// Per-league judge calls run in parallel. Results merge into one ranked board
// tagged by league. If one league fails, others still return.

import { getStore } from '@netlify/blobs';

const ORCHESTRATOR_TIMEOUT_MS = 300000; // 5 min for all leagues to finish

export const handler = async (event) => {
  const store = getStore({
    name: 'bet-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });

  try {
    const body = JSON.parse(event.body || '{}');
    const masterJobId = body.jobId;
    if (!masterJobId) return { statusCode: 400, body: 'Missing jobId' };

    // Support both 'league' (single, backward compat) and 'leagues' (new)
    let leagues = Array.isArray(body.leagues) ? body.leagues :
                  body.league ? [body.league] : ['mlb'];

    // Validate supported leagues. Warn about unsupported ones but don't fail.
    const SUPPORTED = new Set(['mlb', 'wnba', 'nba', 'nfl', 'nhl', 'cfb', 'cbb']);
    const UNSUPPORTED = new Set(['tennis']); // No rolesFor rules, zero gradeable rate

    const unsupported = leagues.filter(l => UNSUPPORTED.has(l.toLowerCase()));
    const unknown = leagues.filter(l => !SUPPORTED.has(l.toLowerCase()) && !UNSUPPORTED.has(l.toLowerCase()));

    if (unsupported.length || unknown.length) {
      const warnings = [
        unsupported.length ? `Tennis has no judge rules and 0% gradeable rate (skipped: ${unsupported.join(', ')})` : '',
        unknown.length ? `Unknown leagues: ${unknown.join(', ')}` : '',
      ].filter(Boolean);
      await store.setJSON(masterJobId, {
        status: 'warnings',
        message: warnings.join('. '),
        leagues: leagues.filter(l => !UNSUPPORTED.has(l.toLowerCase()) && SUPPORTED.has(l.toLowerCase())),
      });
    }

    leagues = leagues.filter(l => SUPPORTED.has(l.toLowerCase()));
    if (!leagues.length) {
      return {
        statusCode: 400,
        body: 'No supported leagues selected. MLB, WNBA, NBA, NFL, NHL, CFB, CBB are ready. Tennis coming later.'
      };
    }

    // Note: cross-league ranking assumes equal tier rates. MLB goblins ~70%, WNBA ~48%.
    // Merging them into one board systematically favors miscalibrated tiers.
    const calibrationWarning = leagues.length > 1 ?
      'Cross-league ranking: Tier rates differ by league. Results are approximate.' : '';

    // Spawn a background job per league
    const subJobIds = leagues.map((l, i) => `${masterJobId}__${l}__${i}`);
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';

    const promises = leagues.map((league, i) =>
      fetch(`${base}/api/bet-finder-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          league,  // single league per call
          jobId: subJobIds[i],
        }),
      }).then(r => r.json().catch(() => ({ error: 'No JSON response' })))
       .then(res => ({ league, jobId: subJobIds[i], response: res }))
       .catch(e => ({ league, jobId: subJobIds[i], error: String(e.message || e) }))
    );

    // Record that we spawned sub-jobs
    await store.setJSON(masterJobId, {
      status: 'orchestrating',
      subJobs: subJobIds,
      calibrationWarning,
    });

    // Fire off the sub-jobs (they return 202 immediately)
    await Promise.all(promises);

    // Poll for all sub-jobs to complete
    const pollInterval = 500; // ms
    const startTime = Date.now();
    const results = new Map();
    const errors = new Map();

    while (Date.now() - startTime < ORCHESTRATOR_TIMEOUT_MS) {
      const allDone = await Promise.all(subJobIds.map(async (jobId) => {
        if (results.has(jobId) || errors.has(jobId)) return true; // already got this one
        try {
          const job = await store.get(jobId, { type: 'json' });
          if (!job) return false; // not ready yet
          if (job.status === 'error') {
            errors.set(jobId, job.message);
            return true;
          }
          if (job.status === 'done') {
            results.set(jobId, job.result);
            return true;
          }
          return false; // still running
        } catch {
          return false;
        }
      }));

      if (allDone.every(Boolean)) break;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Merge results
    const merged = mergeLeagueResults(
      Array.from(results.entries()).map(([jobId, res]) => {
        const league = leagues[subJobIds.indexOf(jobId)];
        return { league, result: res };
      }),
      errors,
      calibrationWarning
    );

    // Save merged result
    await store.setJSON(masterJobId, {
      status: 'done',
      mergedAt: new Date().toISOString(),
      result: merged,
      errors: Object.fromEntries(errors),
    });

    return { statusCode: 202 };
  } catch (err) {
    const jobId = JSON.parse(event.body || '{}').jobId;
    if (jobId) await store.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    return { statusCode: 202 };
  }
};

function mergeLeagueResults(leagueResults, errors, calibrationWarning) {
  if (!leagueResults.length) {
    return {
      board: [],
      players: {},
      parlay: null,
      parlayLegs: [],
      traps: [],
      teamRecords: {},
      winProbs: {},
      merged: true,
      calibrationWarning,
      errors: Object.fromEntries(errors),
    };
  }

  // Tag each pick with its league, combine all boards
  const allPicks = [];
  const allPlayers = {};
  const allTeamRecords = {};
  const allWinProbs = {};
  let combinedParlay = null;
  let combinedParlayLegs = [];

  for (const { league, result } of leagueResults) {
    if (!result) continue;

    // Tag picks with league
    if (result.board && Array.isArray(result.board)) {
      allPicks.push(...result.board.map(p => ({ ...p, league })));
    }

    // Merge metadata
    Object.assign(allPlayers, result.players || {});
    Object.assign(allTeamRecords, result.teamRecords || {});
    Object.assign(allWinProbs, result.winProbs || {});

    // Parlay: take the best one (highest expected value), or first non-null
    if (result.parlay && (!combinedParlay || (result.parlay.expectedValue ?? -Infinity) > (combinedParlay.expectedValue ?? -Infinity))) {
      combinedParlay = result.parlay;
    }
  }

  // Sort combined board by probability (descending) to maintain ranking
  allPicks.sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0));

  // Recompute parlay legs from top picks (simplified — just take from first league)
  combinedParlayLegs = leagueResults[0]?.result?.parlayLegs || [];

  return {
    board: allPicks,
    players: allPlayers,
    parlay: combinedParlay,
    parlayLegs: combinedParlayLegs,
    traps: [], // could merge but not critical for MVP
    teamRecords: allTeamRecords,
    winProbs: allWinProbs,
    merged: true,
    calibrationWarning,
    leagueStats: leagueResults.map(({ league, result }) => ({
      league,
      count: (result.board || []).length,
    })),
  };
}

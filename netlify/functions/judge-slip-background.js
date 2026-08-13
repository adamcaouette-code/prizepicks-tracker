// netlify/functions/judge-slip-background.js
//
// BACKGROUND FUNCTION (filename MUST end in -background.js -> up to 15 min runtime).
// It returns 202 instantly; the browser polls judge-slip-status.js for the result.
// This grade takes ~30-40s (research fan-out + Opus with web search), which is well
// past Netlify's synchronous function ceiling, so it cannot run as a plain endpoint.
//
// Grades a slip the user ALREADY BUILT (the "Rate a Slip" upload flow). Takes the
// normalized output of parse-slip.js, tries to match each leg to today's live
// PrizePicks projection (for recent form + MLB starter/park context, ESPN records,
// win% via The Odds API — the same research bet-finder-background.js gathers for
// board mode — plus DraftKings' own line per leg via attachBookLines below), then
// hands the whole slip to slip-judge-prompt.js's SLIP MODE prompt and asks Opus
// (same model/pricing as board mode) to grade each locked side.
//
// A leg that can't be matched to a live projection (line already off the board,
// OCR misread the name, league not supported) still gets judged — just with no
// research attached, which the prompt is written to handle (rule 4: widen toward
// 0.50 when data is thin).
//
// POST /api/judge-slip-background
// body: { jobId, slip: <normalized slip from parse-slip.js, legs optionally edited> }
// -> 202 immediately; poll GET /api/judge-slip-status?jobId=… until status is
//    "done" (carrying .result) or "error".
// result: { ok:true, legs:[...judged], slip:{weakestLeg,correlationFlag,overall,overallReasoning},
//            dataStatus:{ matchedLegs, totalLegs, oddsStatus, bookLineStatus } }
//
// Env: ANTHROPIC_API_KEY (required), JUDGE_MODEL (optional, defaults claude-opus-4-8),
//      ODDS_API_KEY (optional — same key as board mode; without it, win% and the
//      DraftKings line comparison both silently skip)

import { getStore } from '@netlify/blobs';
import { buildSlipJudge } from './slip-judge-prompt.js';
import {
  PP_LEAGUE_IDS, ODDS_SPORT_KEYS, PP_TO_ESPN_ABBR,
  fetchProps, attachHistory,
  fetchMlbStarters, attachStarters, mlbRole,
  fetchTeamRecords, resolveRecords, fetchTeamFullNames,
  fetchWinProbs, fetchOppDefense, normStat, normKey,
  recordCost,
} from './bet-finder-background.js';

const MODEL = process.env.JUDGE_MODEL || 'claude-opus-4-8';
const MAX_SEARCHES = Number(process.env.SLIP_JUDGE_MAX_SEARCHES) || 4;

// ---- DraftKings player-prop line lookup ------------------------------------
// The judge prompt calls the PP-vs-book line gap its "sharpest signal" (rule 3
// in slip-judge-prompt.js), so we try to attach it — but it's a distinct cost
// from the h2h win% call: player props are priced per (event × market), not
// one bulk pull for the whole slate, so we only fetch the exact markets this
// slip's legs need and cache each (event, market-set) for a short window.
const DK_LINE_CACHE_MS = 15 * 60 * 1000;

const MLB_HIT_MARKETS = {
  hits: 'batter_hits', totalbases: 'batter_total_bases', rbi: 'batter_rbis', rbis: 'batter_rbis',
  runs: 'batter_runs_scored', runsscored: 'batter_runs_scored',
  homeruns: 'batter_home_runs', hr: 'batter_home_runs',
  singles: 'batter_singles', doubles: 'batter_doubles', triples: 'batter_triples',
  walks: 'batter_walks', strikeouts: 'batter_strikeouts', stolenbases: 'batter_stolen_bases',
  hitsrunsrbis: 'batter_hits_runs_rbis', fantasyscore: 'batter_fantasy_score',
};
const MLB_PIT_MARKETS = {
  strikeouts: 'pitcher_strikeouts', hitsallowed: 'pitcher_hits_allowed',
  walks: 'pitcher_walks', walksallowed: 'pitcher_walks',
  earnedruns: 'pitcher_earned_runs', outsrecorded: 'pitcher_outs', pitchingouts: 'pitcher_outs',
};
const HOOPS_MARKETS = {
  points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists',
  threes: 'player_threes', threepointersmade: 'player_threes',
  blocks: 'player_blocks', steals: 'player_steals', turnovers: 'player_turnovers',
  ptsrebsasts: 'player_points_rebounds_assists', pra: 'player_points_rebounds_assists',
  ptsrebs: 'player_points_rebounds', pr: 'player_points_rebounds',
  ptsasts: 'player_points_assists', pa: 'player_points_assists',
  rebsasts: 'player_rebounds_assists', ra: 'player_rebounds_assists',
  fantasyscore: 'player_fantasy_points', fantasypoints: 'player_fantasy_points',
};
const NFL_MARKETS = {
  passyards: 'player_pass_yards', passingyards: 'player_pass_yards',
  passtds: 'player_pass_tds', passingtds: 'player_pass_tds',
  rushyards: 'player_rush_yards', rushingyards: 'player_rush_yards',
  rushtds: 'player_rush_tds', rushingtds: 'player_rush_tds',
  receptions: 'player_receptions',
  receivingyards: 'player_reception_yards', recyards: 'player_reception_yards',
  receivingtds: 'player_reception_tds', rectds: 'player_reception_tds',
  sacks: 'player_sacks',
};

// exact-key only (no fuzzy contains) — a wrong market is worse than no market
function marketFor(league, stat, role) {
  const k = statKey(stat);
  if (league === 'mlb') return (role === 'PIT' ? MLB_PIT_MARKETS : MLB_HIT_MARKETS)[k] || null;
  if (league === 'nba' || league === 'wnba') return HOOPS_MARKETS[k] || null;
  if (league === 'nfl') return NFL_MARKETS[k] || null;
  return null; // no DK player-prop coverage wired for this league (e.g. soccer's defensive stats)
}

function findBookLine(dkMarkets, marketKey, playerName) {
  const pk = normKey(playerName);
  for (const m of dkMarkets) {
    if (m.key !== marketKey) continue;
    const hit = (m.outcomes || []).find((o) => normKey(o.description || o.name) === pk);
    if (hit && hit.point != null) return Number(hit.point);
  }
  return null;
}

async function fetchEventPlayerMarkets(sport, eventId, marketsCsv) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return null;
  const cacheKey = `${eventId}:${marketsCsv}`;
  let cacheStore = null;
  try {
    cacheStore = getStore({ name: 'dk-lines-cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const cached = await cacheStore.get(cacheKey, { type: 'json' });
    if (cached && cached.at && Date.now() - cached.at < DK_LINE_CACHE_MS) return cached.markets;
  } catch { /* cache is best-effort */ }

  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?regions=us&markets=${encodeURIComponent(marketsCsv)}&oddsFormat=american&bookmakers=draftkings&apiKey=${key}`;
  let data;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    data = await res.json();
  } catch { return null; }

  const dk = (data.bookmakers || []).find((b) => b.key === 'draftkings');
  const markets = dk ? dk.markets || [] : [];
  if (cacheStore) { try { await cacheStore.setJSON(cacheKey, { at: Date.now(), markets }); } catch {} }
  return markets;
}

// Attach leg.bookLine in place. Best-effort throughout — a miss anywhere (no
// Odds API key, team name doesn't resolve to a game, no DK market for that
// stat) just leaves bookLine unset; the judge already treats missing research
// as a reason to widen toward 0.50, never as a blocker.
async function attachBookLines(working, league, games) {
  const sport = ODDS_SPORT_KEYS[league];
  if (!sport || !games || !games.length) return 'skipped';

  const fullNames = await fetchTeamFullNames(league);
  function resolveGame(teamAbbr) {
    if (!teamAbbr) return null;
    let full = fullNames[teamAbbr.toLowerCase()];
    if (!full) {
      const alias = PP_TO_ESPN_ABBR[teamAbbr.toUpperCase()];
      if (alias) full = fullNames[alias.toLowerCase()];
    }
    if (!full) return null;
    const fk = full.toLowerCase();
    return games.find((g) => {
      const h = (g.home || '').toLowerCase(), a = (g.away || '').toLowerCase();
      return h === fk || a === fk || h.includes(fk) || fk.includes(h) || a.includes(fk) || fk.includes(a);
    }) || null;
  }

  const byEvent = new Map(); // eventId -> { markets:Set<string>, legs:[{leg,market}] }
  for (const leg of working) {
    const role = league === 'mlb' ? mlbRole(leg.position) : null;
    const market = marketFor(league, leg.stat, role);
    if (!market) continue;
    const game = resolveGame(leg.team);
    if (!game) continue;
    if (!byEvent.has(game.id)) byEvent.set(game.id, { markets: new Set(), legs: [] });
    const entry = byEvent.get(game.id);
    entry.markets.add(market);
    entry.legs.push({ leg, market });
  }
  if (!byEvent.size) return 'no-match';

  let matched = 0;
  for (const [eventId, entry] of byEvent) {
    const dkMarkets = await fetchEventPlayerMarkets(sport, eventId, [...entry.markets].join(','));
    if (!dkMarkets) continue;
    for (const { leg, market } of entry.legs) {
      const line = findBookLine(dkMarkets, market, leg.player);
      if (line != null) { leg.bookLine = line; matched++; }
    }
  }
  return matched > 0 ? 'ok' : 'no-lines';
}

// Loose stat-name match: PP's own board text vs whatever parse-slip's vision pass
// read off the card ("PRA" vs "Pts+Rebs+Asts", "Rebounds" vs "Rebounds", etc).
// Exact (normalized) match wins; otherwise fall back to substring overlap.
function statKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function statsLikelyMatch(a, b) {
  const ka = statKey(a), kb = statKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Substring is a useful fallback for wording drift ("Earned Runs" vs "Earned Runs
  // Allowed"), but PrizePicks' display names are littered with 2-3 character
  // abbreviations — Ks, TB, PO, SB — and "Hitter Ks" contains "Ks", so a hitter's
  // strikeout leg would bind to a PITCHER's strikeout row and inherit its research.
  // Anything that short has to match exactly.
  const MIN_FUZZY = 5;
  if (ka.length < MIN_FUZZY || kb.length < MIN_FUZZY) return false;
  return ka.includes(kb) || kb.includes(ka);
}

// A slip screenshot shows PrizePicks' DISPLAY name ("Hitter Ks", "Ks", "TB"), while
// a projection's stat_type is the long form ("Hitter Strikeouts", "Total Bases").
// Neither contains the other, so comparing against stat_type alone silently failed
// to match the most common MLB props. Compare against both names PP gives us.
function rowMatchesStat(legStat, row) {
  return statsLikelyMatch(legStat, row.stat) || statsLikelyMatch(legStat, row.statDisplay);
}

// Find the live PrizePicks row for one OCR'd leg. Prefers an exact normalized
// player+team match with a stat overlap; falls back to player-only if team is
// missing/wrong (PP's team field on the card can be an outdated abbreviation).
function matchProjection(leg, rows) {
  const legPlayer = normKey(leg.player);
  if (!legPlayer) return null;
  let best = null, bestScore = -1;
  for (const r of rows) {
    if (normKey(r.player) !== legPlayer) continue;
    if (!rowMatchesStat(leg.stat, r)) continue;
    let score = 1;
    if (leg.team && r.team && leg.team.toUpperCase() === String(r.team).toUpperCase()) score += 2;
    if (leg.line != null && Number(r.line) === Number(leg.line)) score += 1;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

function extractJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

export const handler = async (event) => {
  // A background function's HTTP response is sent immediately, so every outcome —
  // including failure — has to be reported through the job blob, not the response.
  const jobs = getStore({ name: 'slip-jobs', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  let jobId;
  const fail = async (message) => {
    if (jobId) { try { await jobs.setJSON(jobId, { status: 'error', message }); } catch {} }
    return { statusCode: 202 };
  };
  const step = async (s) => { try { await jobs.setJSON(jobId, { status: 'running', step: s }); } catch {} };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'invalid JSON body' }; }
  jobId = payload.jobId;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fail('ANTHROPIC_API_KEY is not set on this site — add it in Netlify → Site settings → Environment variables.');

  const slip = payload.slip;
  const legs = Array.isArray(slip?.legs) ? slip.legs : null;
  if (!legs || !legs.length) return fail('provide slip with a non-empty legs array');

  try {
    await step('matching legs to live projections');
    const league = (slip.league || '').toLowerCase();
    const supported = !!PP_LEAGUE_IDS[league];

    // ---- match each leg to a live projection, when the league is one we can pull ----
    let matchedCount = 0;
    const working = legs.map((l) => ({ ...l }));
    let rows = [];
    if (supported) {
      try { rows = await fetchProps(league); } catch { rows = []; }
    }
    for (const leg of working) {
      const row = rows.length ? matchProjection(leg, rows) : null;
      if (row) {
        matchedCount++;
        leg.id = row.id;
        leg.oppTeam = row.opp;
        leg.matchup = row.matchupLabel || row.matchup;
        leg.image = row.image;
        leg.position = leg.position || row.position;
      }
    }

    // ---- gather research in parallel, same sources bet-finder-background.js uses ----
    await step('gathering recent form, records and win%');
    const [historyR, recordsR, oddsR, startersR, defenseR] = await Promise.allSettled([
      attachHistory(working.filter((l) => l.id)),                          // mutates: last5, avg
      fetchTeamRecords(league),
      fetchWinProbs(league, working),
      league === 'mlb' ? fetchMlbStarters() : Promise.resolve(null),
      fetchOppDefense(league),
    ]);

    const teamRecords = recordsR.status === 'fulfilled' ? resolveRecords(working, recordsR.value) : {};
    const odds = oddsR.status === 'fulfilled' ? oddsR.value : { status: 'error', message: 'win% fetch failed', teamWinProbs: {} };
    const oppDef = defenseR.status === 'fulfilled' && defenseR.value ? defenseR.value : {};

    if (league === 'mlb' && startersR.status === 'fulfilled' && startersR.value) {
      attachStarters(working, startersR.value.teamMap);
    }

    // ---- DraftKings line comparison (best-effort; see attachBookLines for why this is separate) ----
    await step('comparing DraftKings lines');
    let bookLineStatus = 'skipped';
    try { bookLineStatus = await attachBookLines(working, league, odds.games); }
    catch { bookLineStatus = 'error'; }

    // ---- fold everything gathered into leg.research, per slip-judge-prompt.js ----
    const enrichedLegs = working.map((leg) => {
      const research = {};
      if (leg.last5) { research.recent5 = leg.last5; research.recentAvg = leg.avg; }
      if (teamRecords[leg.team]) research.teamRecord = teamRecords[leg.team];
      if (odds.teamWinProbs?.[leg.team] != null) research.teamWinPct = Math.round(odds.teamWinProbs[leg.team] * 100);
      if (leg.oppSP) research.oppSP = leg.oppSP;
      if (leg.selfSP) research.selfSP = leg.selfSP;
      if (leg.park != null) research.parkIndex = leg.park;
      if (leg.bookLine != null) research.bookLine = leg.bookLine;
      const oppName = leg.oppTeam || leg.team;
      const dr = oppDef?.[oppName]?.[normStat(leg.stat)];
      if (dr != null) research.oppStatRank = dr;
      if (!leg.id) research.note = 'no live PrizePicks projection matched — treat as thin data';
      return { ...leg, research: Object.keys(research).length ? research : null };
    });

    // ---- judge ----
    await step('Claude grading each leg');
    const { system, userContent } = buildSlipJudge(slip, enrichedLegs);
    const gameCount = new Set(enrichedLegs.map((l) => l.matchup || l.team).filter(Boolean)).size;
    const maxSearches = Math.max(1, Math.min(MAX_SEARCHES, gameCount || 1));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      return fail(data?.error?.message || `Anthropic API error (${res.status})`);
    }
    recordCost('judge-slip', MODEL, data).catch(() => {});

    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const judged = extractJSON(text);
    if (!judged || !Array.isArray(judged.legs)) {
      return fail('could not parse the judge response: ' + text.slice(0, 200));
    }

    // re-attach display fields (team/matchup/image) the judge wasn't asked to echo back
    const lookup = new Map(enrichedLegs.map((l) => [`${l.player}|${l.stat}`, l]));
    for (const l of judged.legs) {
      const src = lookup.get(`${l.player}|${l.stat}`);
      if (!src) continue;
      l.team ??= src.team || null;
      l.matchup ??= src.matchup || null;
      l.image ??= src.image || null;
    }

    // ---- log judged legs for auto-grading + calibration -----------------------
    // Same pick-log the board engine writes, so grade-picks.js and calibration.js
    // pick these up with no changes on their side. Two things matter here:
    //
    //  1. grade-picks.js grades with `hit = actual > line` — i.e. "did the OVER
    //     hit", never "did the user's side hit". Board mode only ever logs
    //     over-probabilities, so we convert: an under leg at P(under)=0.66 is
    //     logged as prob 0.34. Logging the side-probability raw would invert
    //     every under and quietly poison the calibration curve.
    //  2. grade-picks.js requires projectionId; a leg that matched no live
    //     projection can never be graded, so logging it would just park a row in
    //     "pending" forever. Those are skipped, and counted in the response.
    let loggedForCalibration = 0, skippedNoProjection = 0;
    try {
      const logStore = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      const day = new Date().toISOString().slice(0, 10);
      const stamp = new Date().toISOString();

      const rows = [];
      for (const l of judged.legs) {
        const src = lookup.get(`${l.player}|${l.stat}`);
        const projectionId = src?.id || null;
        if (!projectionId) { skippedNoProjection++; continue; }

        const line = l.line ?? src?.line ?? null;
        const sideProb = Number(l.prob);
        if (line == null || !isFinite(sideProb)) { skippedNoProjection++; continue; }

        const side = String(l.pick || src?.pick || 'over').toLowerCase() === 'under' ? 'under' : 'over';
        rows.push({
          date: day, loggedAt: stamp, league,
          projectionId,
          player: l.player, stat: l.stat, line,
          prob: side === 'under' ? 1 - sideProb : sideProb,  // ALWAYS P(over) — see note above
          verdict: l.verdict, oddsType: l.oddsType || src?.oddsType || null,
          team: l.team || src?.team || null,
          matchup: l.matchup || src?.matchup || null,
          image: l.image || src?.image || null,
          source: 'slip',        // separates slip grades from board picks in calibration
          sidePick: side,        // the side the user actually locked
          sideProb,              // P(that side hits), as the judge stated it
          result: null, hit: null, gradedAt: null,
        });
      }

      if (rows.length) {
        let existing = [];
        try { existing = (await logStore.get(day, { type: 'json' })) || []; } catch {}
        // Key on source too: a slip leg and a board pick can share a projectionId
        // on the same day, and they're separate predictions worth scoring apart.
        const keyOf = (p) => `${p.source || 'board'}|${p.projectionId || `${p.player}|${p.stat}|${p.line}`}`;
        const byKey = new Map();
        for (const p of existing) byKey.set(keyOf(p), p);
        for (const p of rows) {
          const prev = byKey.get(keyOf(p));
          if (prev && (prev.hit === true || prev.hit === false)) continue; // never overwrite a graded row
          byKey.set(keyOf(p), p);
        }
        await logStore.setJSON(day, [...byKey.values()]);
        loggedForCalibration = rows.length;
      }
    } catch {
      // logging is best-effort — never let it break a grade
    }

    await jobs.setJSON(jobId, {
      status: 'done',
      result: {
        ok: true,
        legs: judged.legs,
        slip: judged.slip || null,
        dataStatus: {
          matchedLegs: matchedCount,
          totalLegs: legs.length,
          leagueSupported: supported,
          oddsStatus: odds.status,
          bookLineStatus,
          loggedForCalibration,
          skippedNoProjection,
        },
      },
    });
    return { statusCode: 202 };
  } catch (err) {
    return fail(String(err.message || err));
  }
};

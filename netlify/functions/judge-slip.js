// netlify/functions/judge-slip.js
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
// POST /api/judge-slip
// body: { slip: <normalized slip object from parse-slip.js, legs optionally edited> }
// returns: { ok:true, legs:[...judged], slip:{weakestLeg,correlationFlag,overall,overallReasoning},
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
  return ka === kb || ka.includes(kb) || kb.includes(ka);
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
    if (!statsLikelyMatch(leg.stat, r.stat)) continue;
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
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const slip = payload.slip;
  const legs = Array.isArray(slip?.legs) ? slip.legs : null;
  if (!legs || !legs.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'provide slip with a non-empty legs array' }) };

  try {
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
      return { statusCode: res.status || 502, headers, body: JSON.stringify({ error: data?.error?.message || 'Anthropic API error' }) };
    }
    recordCost('judge-slip', MODEL, data).catch(() => {});

    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const judged = extractJSON(text);
    if (!judged || !Array.isArray(judged.legs)) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'could not parse judge response', raw: text.slice(0, 500) }) };
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        legs: judged.legs,
        slip: judged.slip || null,
        dataStatus: {
          matchedLegs: matchedCount,
          totalLegs: legs.length,
          leagueSupported: supported,
          oddsStatus: odds.status,
          bookLineStatus,
        },
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

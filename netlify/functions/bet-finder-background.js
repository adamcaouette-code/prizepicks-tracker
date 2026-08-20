// netlify/functions/bet-finder-background.js
//
// BACKGROUND FUNCTION (filename MUST end in -background.js -> up to 15 min runtime).
// It returns 202 instantly; the browser polls bet-finder-status.js for the result.
// Engine = JS port of bet_finder.py: pull props -> screen -> Claude judges -> size.
//
// Requires: npm install @netlify/blobs
// Env var:  ANTHROPIC_API_KEY  (set in Netlify, same place as ODDS_API_KEY)

import { getStore } from '@netlify/blobs';
// Raw MLB data (injuries, personIds, logos). No model involved — see mlb-stats.js.
import { slate as mlbSlate, normKey as mlbNormKey, PP_TO_MLB_ABBR } from './mlb-stats.js';
import { attachMlbForm } from './mlb-grade.js';
import { attachEspnForm, markEspnVoids, SLUGS as ESPN_SLUGS_FOR_FORM } from './espn-grade.js';
import { promptSet, verdictFor } from './judge-prompts.js';

const MODEL = process.env.JUDGE_MODEL || 'claude-opus-4-8';
const JUDGE_MAX_SEARCHES = Number(process.env.JUDGE_MAX_SEARCHES) || 8; // cap web searches so runs don't blow past the timeout

// ---- Spend metering (best-effort, never blocks the run) --------------------
// Prices in USD per million tokens, verified 2026-07: opus-4-8 $5/$25;
// sonnet-5 $2/$10 intro until Aug 31 2026 (then $3/$15). Web search ~$0.01/search.
// Update these if Anthropic pricing changes.
const PRICES = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const SEARCH_PRICE = 0.01;
async function recordCost(feature, model, apiResponse) {
  try {
    const u = apiResponse?.usage || {};
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const searches = u.server_tool_use?.web_search_requests || 0;
    const p = PRICES[model] || { in: 5, out: 25 };   // unknown model: assume Opus rates (conservative)
    const usd = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out + searches * SEARCH_PRICE;
    const store = getStore({ name: 'cost-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const day = new Date().toISOString().slice(0, 10);
    let arr = [];
    try { arr = (await store.get(day, { type: 'json' })) || []; } catch {}
    arr.push({ at: new Date().toISOString(), feature, model, inTok, outTok, searches, usd: Math.round(usd * 10000) / 10000 });
    await store.setJSON(day, arr);
  } catch { /* metering must never break anything */ }
}
// ----------------------------------------------------------------------------
// Leagues whose ids are pinned here. Everything else PrizePicks posts is resolved
// live via resolveLeagueId() below, so a new sport (or a tournament ending, like the
// World Cup) needs no code change — the catalog is the source of truth.
const PP_LEAGUE_IDS = { mlb: '2', wnba: '3', nba: '7', nfl: '9' };

// ---- league catalog: every league PrizePicks is posting right now ----------
// Cached hard: it changes on the order of days, and PrizePicks throttles.
const LEAGUE_CATALOG_MS = 6 * 60 * 60 * 1000;

// "World Cup" -> world_cup, "College Football" -> college_football
function leagueTagOf(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function fetchLeagueCatalog() {
  let store = null;
  try {
    store = getStore({ name: 'pp-league-catalog', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const c = await store.get('catalog-v2', { type: 'json' });
    if (c && c.at && Date.now() - c.at < LEAGUE_CATALOG_MS) return c.leagues;
  } catch { /* cache is best-effort */ }

  const res = await fetch('https://partner-api.prizepicks.com/leagues?per_page=250', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
      Referer: 'https://app.prizepicks.com/',
    },
  });
  if (!res.ok) throw new Error(`PrizePicks /leagues returned ${res.status}`);
  const full = await res.json();

  const leagues = (full.data || []).map((d) => {
    const a = d.attributes || {};
    const name = a.name || a.display_name || '';
    return {
      id: String(d.id),
      name,
      tag: leagueTagOf(name),
      projections: a.projections_count ?? a.props_count ?? null,
      active: a.active ?? null,
      // parent_id marks a half/quarter split of another league (WNBA1H -> WNBA).
      // Season boards (NFLSZN) report null here, so they need the name suffix.
      parentId: a.parent_id ?? null,
      parentName: a.parent_name ?? null,
      lastFiveGames: a.last_five_games_enabled ?? null,
    };
  }).filter((l) => l.tag);

  if (store) { try { await store.setJSON('catalog-v2', { at: Date.now(), leagues }); } catch {} }
  return leagues;
}

// Wired tag -> pinned id; anything else -> looked up in the live catalog.
async function resolveLeagueId(leagueTag) {
  const tag = leagueTagOf(leagueTag);
  if (PP_LEAGUE_IDS[tag]) return PP_LEAGUE_IDS[tag];
  const catalog = await fetchLeagueCatalog();
  const hit = catalog.find((l) => l.tag === tag);
  return hit ? hit.id : null;
}
const ODDS_PRIOR = { goblin: 0.62, standard: 0.55, demon: 0.45 };

// PrizePicks payout tables (typical — adjust if your region differs)
const POWER = { 2: 3.0, 3: 5.0, 4: 10.0, 5: 20.0, 6: 25.0 };
const FLEX = {
  3: { 3: 2.25, 2: 1.25 },
  4: { 4: 5.0, 3: 1.5 },
  5: { 5: 10.0, 4: 2.0, 3: 0.4 },
  6: { 6: 25.0, 5: 2.0, 4: 0.4 },
};

// ---------- data: pull + trim PrizePicks props (all pages) ----------
// Shared PrizePicks fetch with real throttle handling. The old inline retry used a
// fixed 1s/2s/3s/4s ladder and ignored Retry-After, which is why paging MLB's 13
// pages could still 429 out mid-slate.
async function ppFetch(url, headers, maxRetries = 5) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status !== 429 || attempt >= maxRetries) return res;
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(15000, retryAfter * 1000)
      : Math.min(9000, 600 * 2 ** attempt) + Math.floor(Math.random() * 400); // jitter: avoid lockstep retries
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function fetchProps(leagueTag, opts = {}) {
  const lid = await resolveLeagueId(leagueTag);
  if (!lid) throw new Error(`PrizePicks isn't posting a league called '${leagueTag}' right now`);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
    Referer: 'https://app.prizepicks.com/',
  };

  // Page through the whole slate. One page (250) is often just the next game or
  // two; we want every game today, so we follow pagination to the end.
  // MLB posts ~3000 props (13 pages), so this is where throttling actually bites —
  // callers that only need a sample (stat-name discovery) should pass maxPages.
  //
  // Page 1 goes alone (its errors are fatal, and it carries meta.total_pages);
  // the REST fetch in parallel waves of 4. Fetching them one at a time made the
  // props pull the single slowest stretch of a run — ~12 sequential round trips,
  // each able to eat its own 429 backoff. The pages are independent, wave size 4
  // stays under PrizePicks' throttle radar, and ppFetch still backs off politely
  // on any 429 inside a wave.
  const players = {};
  const allData = [];
  const MAX_PAGES = Math.max(1, opts.maxPages || 12); // safety cap (~3000 props)
  const WAVE = 4;
  const getPage = async (page) => {
    const url = `https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&league_id=${lid}&page=${page}`;
    const res = await ppFetch(url, headers);
    if (!res.ok) {
      if (page === 1) throw new Error(`PrizePicks returned ${res.status}${res.status === 429 ? ' (rate limited — try again in a minute)' : ''}`);
      return null; // a later page failing just ends pagination
    }
    return res.json();
  };
  // Absorbs one page; returns true when it was the board's last (short) page.
  const absorb = (full) => {
    for (const i of full.included || []) {
      if (i.type === 'new_player') players[i.id] = i.attributes || {};
    }
    const data = full.data || [];
    allData.push(...data);
    return data.length < 250;
  };

  const first = await getPage(1);
  let done = absorb(first);
  // Trust meta.total_pages when PP sends it; otherwise probe up to the cap and
  // stop at the first short/failed page, same as the sequential loop did.
  const lastPage = Math.min(MAX_PAGES, Number(first?.meta?.total_pages) || MAX_PAGES);
  for (let base = 2; base <= lastPage && !done; base += WAVE) {
    const wave = [];
    for (let p = base; p < base + WAVE && p <= lastPage; p++) wave.push(getPage(p));
    for (const full of await Promise.all(wave)) {
      if (!full || absorb(full)) { done = true; break; } // absorbed in page order
    }
  }

  return allData.map((d) => {
    const a = d.attributes || {};
    const pa = players[d.relationships?.new_player?.data?.id] || {};
    const team = pa.team || '';
    const opp = a.description || '';
    return {
      id: d.id,
      player: pa.display_name || pa.name || 'Unknown',
      // PrizePicks carries TWO stat names and they differ constantly:
      //   stat_type "Hitter Strikeouts"  <->  stat_display_name "Hitter Ks"
      //   stat_type "Pitcher Strikeouts" <->  stat_display_name "Ks"
      //   stat_type "Total Bases"        <->  stat_display_name "TB"
      // The card in the app shows the DISPLAY name, so that's what a screenshot
      // (and therefore parse-slip's OCR) reads. Keeping only stat_type meant
      // every one of those legs failed to match a live projection.
      stat: a.stat_type || a.stat_display_name || '',
      statDisplay: a.stat_display_name || '',
      line: a.line_score,
      position: pa.position || '',
      gameId: a.game_id || null,          // authoritative game key (beats string matchups)
      status: a.status || '',             // pre_game | in_progress | final
      isPromo: a.is_promo === true,
      isLive: a.is_live === true || a.in_game === true,
      combo: pa.combo === true || a.event_type === 'combo',
      today: typeof a.today === 'boolean' ? a.today : null,
      image: pa.image_url || '',
      oddsType: (a.odds_type || 'standard').toLowerCase(),
      team: team || '(unknown)',
      opp: opp || '',
      matchup: team && opp ? [team, opp].sort().join(' vs ') : opp || team || '(unknown game)',
      matchupLabel: team && opp ? `${team} vs ${opp}` : opp || team || '(unknown game)',
      game: team && opp ? `${team} vs ${opp}` : opp || team || '(unknown game)',
      start: a.start_time || '',
      league: leagueTag,
    };
  });
}

function filterToday(rows, todayOnly) {
  if (!todayOnly) return rows;
  // PrizePicks stamps start_time with a local offset ("2026-08-13T19:30:00.000-04:00"),
  // so comparing its date prefix against the UTC date drops every late game once UTC
  // rolls over — a 10pm ET first pitch is already "tomorrow" in UTC. PP ships its own
  // `today` boolean; trust that when present and only fall back to the string compare.
  const td = new Date().toISOString().slice(0, 10);
  return rows.filter((r) => (typeof r.today === 'boolean' ? r.today : String(r.start).startsWith(td)));
}

// ---------- PrizePicks last-5 history (their own data, perfect name match) ----------
// One call per candidate: /projections/{id}/history -> last 5 stat_values for THAT prop.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(projectionId, attempt = 0) {
  const url = `https://api.prizepicks.com/projections/${projectionId}/history`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://app.prizepicks.com/',
      },
    });
    if (res.status === 429) {                       // throttled — back off and retry
      if (attempt >= 3) return null;
      await sleep(800 * (attempt + 1));
      return fetchHistory(projectionId, attempt + 1);
    }
    if (!res.ok) return null;
    const data = await res.json();
    const games = (data.games || []).map((g) => ({
      v: g.stat_value, opp: g.opponent_abbreviation, away: g.is_away,
    }));
    if (!games.length) return null;
    const values = games.map((g) => Number(g.v)).filter((v) => isFinite(v));
    if (!values.length) return null;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    return { last5: values, avg: Math.round(avg * 100) / 100, games };
  } catch {
    return null; // history is a bonus; never break the run
  }
}

// Attach history gently: small batches with a pause between, so we don't trip
// PrizePicks' rate limit (which can sink the whole run). 8×150ms instead of the
// old 6×300ms — a 44-candidate board drops from 8 pauses to 5 and each is half
// as long, and a 429 here only costs that one candidate's last-5 (fetchHistory
// retries, then returns null), never the run.
async function attachHistory(candidates, batchSize = 8, pauseMs = 150) {
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((c) => (c.id ? fetchHistory(c.id) : null)));
    results.forEach((h, j) => { if (h) { batch[j].last5 = h.last5; batch[j].avg = h.avg; batch[j].histGames = h.games; } });
    if (i + batchSize < candidates.length) await sleep(pauseMs);
  }
  return candidates;
}

// ---------- MLB starting-pitcher context (ESPN, free, no key) ----------
// On MLB runs we attach, per candidate: the OPPOSING starter (hand + ERA/WHIP/K) for
// hitter props, and the pitcher's OWN season line for pitcher props, plus the home
// park's run index. Purely additive — every fetch is wrapped, so a hiccup just yields
// nulls and the engine runs exactly as before.

async function espnJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const normKey = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '').trim();

// Run-scoring park index by team abbreviation (100 = neutral). Static — parks barely
// move year to year. Unlisted teams are treated as ~neutral.
const PARK_INDEX = {
  COL: 112, BOS: 108, CIN: 106, KC: 104, PHI: 104, ARI: 103, BAL: 103, NYY: 103,
  TEX: 102, LAA: 101, CHC: 101, TOR: 101, ATL: 100, MIN: 100, HOU: 100, WSH: 100,
  CLE: 98, LAD: 98, STL: 99, MIL: 99, PIT: 99, CWS: 99, CHW: 99, NYM: 97, TB: 97,
  SD: 96, MIA: 96, DET: 96, ATH: 96, OAK: 96, SF: 92, SEA: 92,
};

// Pull only the probable-starter entries out of a summary. We target the "probables"
// arrays specifically (each entry = one starter with season statistics) rather than
// every athlete in the boxscore — otherwise we'd grab single-game lines by mistake.
function collectProbables(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { node.forEach((n) => collectProbables(n, out, seen)); return out; }
  if (Array.isArray(node.probables)) {
    for (const p of node.probables) if (p && p.athlete && p.athlete.id) out.push(p);
  }
  for (const v of Object.values(node)) collectProbables(v, out, seen);
  return out;
}

// Find ERA / WHIP / strikeouts anywhere inside a statistics node.
function pluckPitcherStats(node, found = {}, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return found;
  seen.add(node);
  const label = String(node.abbreviation || node.name || '').toLowerCase();
  const val = node.displayValue ?? node.value;
  if (label && val !== undefined && val !== null) {
    if (label === 'era' && found.era === undefined) found.era = val;
    if (label === 'whip' && found.whip === undefined) found.whip = val;
    if ((label === 'k' || label === 'so' || label.includes('strikeout')) && found.k === undefined) found.k = val;
  }
  for (const v of Object.values(node)) pluckPitcherStats(v, found, seen);
  return found;
}

// Build team -> { ownStarter, oppTeam, oppStarter, park } from today's MLB slate.
async function fetchMlbStarters() {
  const sb = await espnJSON('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard');
  const events = sb?.events || [];
  if (!events.length) return { teamMap: {}, status: { games: 0, starters: 0, message: 'no ESPN games' } };

  // 1) enrich by athlete id via one summary call per game: throws + ERA/WHIP/K.
  // Four games at a time — one-at-a-time with a 120ms sleep took ~10s on a full
  // slate, and this sits on the judge's critical path. ESPN's public API takes
  // this in stride, and espnJSON already degrades any single miss to null.
  const byId = {};
  let ei = 0;
  await Promise.all(Array.from({ length: Math.min(4, events.length) }, async () => {
    while (ei < events.length) {
      const e = events[ei++];
      const sum = await espnJSON(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${e.id}`);
      for (const entry of collectProbables(sum)) {
        const a = entry.athlete || {};
        if (!a.id || byId[a.id]) continue;
        byId[a.id] = { throws: a.throws?.abbreviation || null, ...pluckPitcherStats(entry.statistics || {}) };
      }
    }
  }));

  // 2) team -> game info, keyed by every name form so PP's nickname matches
  const teamMap = {};
  let starterCount = 0;
  for (const e of events) {
    const cs = e.competitions?.[0]?.competitors || [];
    if (cs.length < 2) continue;
    const home = cs.find((c) => c.homeAway === 'home') || cs[0];
    const park = PARK_INDEX[(home.team?.abbreviation || '').toUpperCase()] ?? 100;
    const sides = cs.map((c) => {
      const t = c.team || {};
      const sp = c.probables?.[0]?.athlete || null;
      const id = sp?.id;
      const starter = sp
        ? { name: sp.displayName, throws: byId[id]?.throws || null, era: byId[id]?.era ?? null, whip: byId[id]?.whip ?? null, k: byId[id]?.k ?? null }
        : null;
      if (starter) starterCount++;
      return { keys: [t.name, t.nickname, t.displayName, t.shortDisplayName, t.location, t.abbreviation], teamName: t.displayName || t.name, starter };
    });
    for (let s = 0; s < sides.length; s++) {
      const me = sides[s], opp = sides[1 - s] || {};
      const info = { ownStarter: me.starter, oppTeam: opp.teamName || null, oppStarter: opp.starter || null, park };
      for (const k of me.keys) { const nk = normKey(k); if (nk) teamMap[nk] = info; }
    }
  }
  return { teamMap, status: { games: events.length, starters: starterCount, enriched: Object.keys(byId).length } };
}

// PrizePicks and ESPN disagree on a few team abbreviations; map PP's to ESPN's so
// those teams still match. (PP's MLB "team" field is the abbreviation.)
const PP_TO_ESPN_ABBR = { CWS: 'CHW', AZ: 'ARI', WAS: 'WSH', SDP: 'SD', SFG: 'SF', TBR: 'TB', KCR: 'KC', WSN: 'WSH' };

// Attach SP context to MLB candidates (mutates). Null-safe; unmatched teams just skip.
function attachStarters(candidates, teamMap) {
  let hit = 0;
  for (const c of candidates) {
    const alias = PP_TO_ESPN_ABBR[String(c.team || '').toUpperCase()];
    const info = teamMap[normKey(c.team)] || (alias && teamMap[normKey(alias)]);
    if (!info) continue;
    hit++;
    if (info.oppTeam) c.oppTeam = info.oppTeam;
    if (info.park != null) c.park = info.park;
    const pitcherProp = mlbRole(c.position) === 'PIT' || mlbStatKind(c.stat) === 'PIT';
    if (pitcherProp) { if (info.ownStarter) c.selfSP = info.ownStarter; }
    else { if (info.oppStarter) c.oppSP = info.oppStarter; }
  }
  return hit;
}

// ---------- ESPN team records (free, no key). Stored now, not yet judged. ----------
// Keyed by PrizePicks league tag (leagueTagOf of its display name). A league absent
// here simply gets no standings — fetchTeamRecords returns {} and the run continues.
const ESPN_SLUGS = {
  mlb: { sport: 'baseball', league: 'mlb' },
  nba: { sport: 'basketball', league: 'nba' },
  wnba: { sport: 'basketball', league: 'wnba' },
  nfl: { sport: 'football', league: 'nfl' },
  nhl: { sport: 'hockey', league: 'nhl' },
  cfb: { sport: 'football', league: 'college-football' },
  college_football: { sport: 'football', league: 'college-football' },
  cbb: { sport: 'basketball', league: 'mens-college-basketball' },
  college_basketball: { sport: 'basketball', league: 'mens-college-basketball' },
};

function recordFromStats(stats, team) {
  let summary = null, w = null, l = null, d = null;
  for (const s of stats || []) {
    const nm = (s.name || s.type || '').toLowerCase();
    if ((s.type === 'total' || nm === 'overall' || nm === 'record') && s.summary) summary = s.summary;
    if (nm === 'wins') w = s.value;
    if (nm === 'losses') l = s.value;
    if (nm === 'ties' || nm === 'draws' || nm === 'draw') d = s.value;
  }
  if (summary) return summary;
  if (w != null && l != null) {
    const base = `${Math.round(w)}-${Math.round(l)}`;
    return d != null ? `${base}-${Math.round(d)}` : base;
  }
  if (team?.record?.items?.[0]?.summary) return team.record.items[0].summary;
  return null;
}

function parseStandings(data) {
  const map = {};
  const add = (names, rec) => { for (const n of names) if (n) map[String(n).toLowerCase()] = rec; };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.team && node.stats) {
      const t = node.team;
      const rec = recordFromStats(node.stats, t);
      if (rec) add([t.displayName, t.shortDisplayName, t.name, t.location, t.abbreviation, t.nickname], rec);
    }
    for (const k in node) visit(node[k]);
  };
  visit(data);
  return map;
}

async function fetchTeamRecords(leagueTag) {
  const slug = ESPN_SLUGS[leagueTag];
  if (!slug) return {};
  const url = `https://site.api.espn.com/apis/v2/sports/${slug.sport}/${slug.league}/standings`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    return parseStandings(await res.json());
  } catch {
    return {}; // records are a nice-to-have; never break the run
  }
}

// abbreviation (lowercased) -> ESPN's full display name, e.g. "lad" -> "Los Angeles Dodgers".
// Used by judge-slip.js to match a PP leg's team abbreviation to an Odds API game, which
// only gives home_team/away_team as full names. Same ESPN standings payload as records above.
function collectTeamNames(node, out = {}, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { node.forEach((n) => collectTeamNames(n, out, seen)); return out; }
  if (node.team && node.stats) {
    const t = node.team;
    if (t.abbreviation && t.displayName) out[String(t.abbreviation).toLowerCase()] = t.displayName;
  }
  for (const v of Object.values(node)) collectTeamNames(v, out, seen);
  return out;
}

async function fetchTeamFullNames(leagueTag) {
  const slug = ESPN_SLUGS[leagueTag];
  if (!slug) return {};
  const url = `https://site.api.espn.com/apis/v2/sports/${slug.sport}/${slug.league}/standings`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    return collectTeamNames(await res.json());
  } catch {
    return {};
  }
}

// Map ESPN records onto the exact team strings PrizePicks uses.
function resolveRecords(rows, espnMap) {
  const out = {};
  const teams = [...new Set(rows.map((r) => r.team).filter((t) => t && t !== '(unknown)'))];
  for (const team of teams) {
    const key = team.toLowerCase();
    let rec = espnMap[key];
    if (!rec) {
      const hit = Object.keys(espnMap).find((k) => k.includes(key) || key.includes(k));
      if (hit) rec = espnMap[hit];
    }
    if (rec) out[team] = rec;
  }
  return out;
}

// ---------- win% via The Odds API. Degrades gracefully; reports WHY it failed. ----------
// The Odds API sport keys, keyed by PrizePicks league tag. Absent = win% and the
// DraftKings line comparison are skipped for that league, never an error.
const ODDS_SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  nfl: 'americanfootball_nfl',
  nhl: 'icehockey_nhl',
  cfb: 'americanfootball_ncaaf',
  college_football: 'americanfootball_ncaaf',
  cbb: 'basketball_ncaab',
  college_basketball: 'basketball_ncaab',
};

function americanToProb(price) {
  const n = Number(price);
  if (!isFinite(n) || n === 0) return 0;
  return n > 0 ? 100 / (n + 100) : (-n) / ((-n) + 100);
}

// Returns { status, message, remaining, used, teamWinProbs }.
// status is one of: ok | capped | error | skipped. NEVER throws — the run goes on.
//
// `rows` may be an ARRAY or a PROMISE of one. Nothing above the team-name mapping
// at the bottom touches it, so the caller can start this fetch before PrizePicks
// has answered and hand in the rows as a promise; we await it only at the point we
// actually need it. `await` on a plain array is a no-op, so array callers are
// unchanged.
async function fetchWinProbs(leagueTag, rows) {
  const sport = ODDS_SPORT_KEYS[leagueTag];
  if (!sport) return { status: 'skipped', message: `No odds mapping for ${leagueTag}.`, teamWinProbs: {} };

  // ---- 60-min blob cache: win% barely moves within an hour, and the Odds API ----
  // quota is 500 req/month. Re-runs (statFilter passes, retries) hit the cache free.
  const ODDS_CACHE_MS = 60 * 60 * 1000;
  let cacheStore = null;
  try {
    cacheStore = getStore({ name: 'odds-cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    const cached = await cacheStore.get(leagueTag, { type: 'json' });
    if (cached && cached.at && Date.now() - cached.at < ODDS_CACHE_MS && cached.data?.status === 'ok') {
      const ageMin = Math.round((Date.now() - cached.at) / 60000);
      return { ...cached.data, message: `${cached.data.message} (cached ${ageMin}m ago — no quota used)` };
    }
  } catch { /* cache is best-effort; fall through to live fetch */ }
  const key = process.env.ODDS_API_KEY;
  if (!key) return { status: 'error', message: 'ODDS_API_KEY is not set in Netlify — that\'s a config error, not the cap.', teamWinProbs: {} };

  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${key}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    return { status: 'error', message: `Couldn't reach the Odds API (network or code issue): ${e.message}`, teamWinProbs: {} };
  }

  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');

  // 429 = rate limit, 401 = bad key OR out of monthly credits — distinguish by body text
  if (res.status === 429) {
    return { status: 'capped', message: 'Odds API rate limit hit — wait a moment and try again.', remaining, used, teamWinProbs: {} };
  }
  if (res.status === 401) {
    let body = '';
    try { body = await res.text(); } catch {}
    const capLike = /quota|usage|credit|limit|exceed/i.test(body);
    return capLike
      ? { status: 'capped', message: 'Odds API monthly cap reached — win% is paused until your quota resets. (Not a bug.)', remaining, used, teamWinProbs: {} }
      : { status: 'error', message: 'Odds API rejected the key — check ODDS_API_KEY. (Config error, not the cap.)', remaining, used, teamWinProbs: {} };
  }
  if (!res.ok) {
    return { status: 'error', message: `Odds API returned an unexpected error (HTTP ${res.status}).`, remaining, used, teamWinProbs: {} };
  }

  let games;
  try { games = await res.json(); } catch {
    return { status: 'error', message: 'Odds API returned data we couldn\'t read.', remaining, used, teamWinProbs: {} };
  }

  // de-vig each game's moneyline into win probabilities, keyed by odds team name
  const oddsMap = {};
  for (const g of games || []) {
    const book = (g.bookmakers || [])[0];
    const h2h = book && (book.markets || []).find((m) => m.key === 'h2h');
    if (!h2h) continue;
    const implied = (h2h.outcomes || []).map((o) => ({ name: o.name, p: americanToProb(o.price) }));
    const sum = implied.reduce((s, o) => s + o.p, 0) || 1;
    for (const o of implied) {
      if (o.name && o.name.toLowerCase() !== 'draw') oddsMap[o.name.toLowerCase()] = o.p / sum;
    }
  }

  // resolve to the exact PP team strings — the first point that needs the board.
  // If the board itself failed we still return the odds we already paid for, but we
  // must NOT cache a team-less result: the 60-min cache would then starve the next
  // run of win% for an hour over an unrelated PrizePicks blip.
  let resolvedRows = null, rowsOk = true;
  try { resolvedRows = (await rows) || []; } catch { resolvedRows = []; rowsOk = false; }
  const teamWinProbs = {};
  const teams = [...new Set((resolvedRows || []).map((r) => r.team).filter((t) => t && t !== '(unknown)'))];
  for (const team of teams) {
    const k = team.toLowerCase();
    let p = oddsMap[k];
    if (p == null) {
      const hit = Object.keys(oddsMap).find((n) => n.includes(k) || k.includes(n));
      if (hit) p = oddsMap[hit];
    }
    if (p != null) teamWinProbs[team] = Math.round(p * 100) / 100;
  }

  const found = Object.keys(teamWinProbs).length;
  // Carry the event id + team names forward too — judge-slip.js reuses this same
  // (already-cached) h2h fetch to resolve games for DraftKings player-prop lookups,
  // instead of spending a second Odds API call just to find event ids.
  const gamesOut = (games || []).map((g) => ({ id: g.id, home: g.home_team, away: g.away_team, commenceTime: g.commence_time }));
  const result = {
    status: 'ok',
    message: `Win% loaded for ${found} team(s).${remaining != null ? ` ${remaining} Odds API requests left this month.` : ''}`,
    remaining, used, teamWinProbs, games: gamesOut,
  };
  if (cacheStore && rowsOk) { try { await cacheStore.setJSON(leagueTag, { at: Date.now(), data: result }); } catch {} }
  return result;
}

// ---------- opponent defensive rank vs a stat (ESPN, free) --------------------
// oppDef shape: { [teamName]: { [statKey]: rank } }  (1 = stingiest, high = softest).
// Purely additive: any failure returns {} and the judge runs exactly as today.
// NOTE: the fetch body is a stub until def-probe locks ESPN's exact opponent-stats
// shape for the target league. Wired now so activation is a one-function fill.
function normStat(stat = '') {
  const s = String(stat).toLowerCase();
  if (s.includes('assist')) return 'assists';
  if (s.includes('rebound')) return 'rebounds';
  if (s.includes('point'))  return 'points';
  if (s.includes('3-pt') || s.includes('three') || s.includes('3pt')) return 'threes';
  if (s.includes('steal'))  return 'steals';
  if (s.includes('block'))  return 'blocks';
  if (s.includes('hit'))    return 'hits';
  return s; // fall through; refined when the parser lands
}

async function fetchOppDefense(leagueTag /*, rows */) {
  try {
    // TODO(fill after def-probe): hit the ESPN team-statistics endpoint for this
    // league, read each team's OPPONENT (defense) per-game numbers, rank every
    // team per stat (1 = allows least), return { teamName: { statKey: rank } }.
    // Return {} on any miss so the run is never blocked.
    return {};
  } catch { return {}; }
}

// ---------- hard position gate: kill physically-wrong props pre-Claude ----------
// League-aware. Each sport has its own role/stat vocabulary; a league with no gate
// defined fails OPEN (everything passes) so we never invent traps for a sport we
// don't understand yet.

// ===== soccer =====
function roleOf(pos) {
  const p = (pos || '').toUpperCase();
  if (!p.replace(/[^A-Z]/g, '')) return 'UNK';
  if (p.includes('GOAL') || p.includes('KEEPER') || /\bGK?\b/.test(p)) return 'GK';
  if (p.includes('DEF') || /\b(CB|LB|RB|FB|WB|RWB|LWB|D)\b/.test(p)) return 'DEF';
  if (p.includes('MID') || /\b(CM|CDM|CAM|DM|AM|LM|RM|MF|M)\b/.test(p)) return 'MID';
  if (p.includes('FORWARD') || p.includes('STRIK') || p.includes('WING') ||
      /\b(ST|CF|LW|RW|FW|SS|W|F)\b/.test(p)) return 'FWD';
  return 'UNK';
}

function statKind(stat) {
  const s = (stat || '').toLowerCase();
  if (s.includes('save') || s.includes('goalie') || s.includes('goals allowed') ||
      s.includes('goals against')) return 'GK';
  if (s.includes('clearance') || s.includes('block') || s.includes('tackle') ||
      s.includes('interception')) return 'DEF';
  if (s.includes('shot') || s.includes('goal') || s.includes('assist') ||
      s.includes('cross') || s.includes('dribble') || s.includes('offside')) return 'ATK';
  return 'NEUTRAL';
}

// Conservative: only block UNAMBIGUOUS impossibilities. Unknown position or
// neutral stat (passes, fouls, fantasy score) always passes through.
function soccerAllows(pos, stat) {
  const role = roleOf(pos), kind = statKind(stat);
  if (role === 'UNK' || kind === 'NEUTRAL') return true;
  if (kind === 'GK') return role === 'GK';            // only keepers get saves
  if (role === 'GK' && kind === 'ATK') return false;  // keepers don't shoot/cross
  if (role === 'GK' && kind === 'DEF') return false;  // keeper clearance line = trap
  if (kind === 'DEF' && role === 'FWD') return false; // the attacker-clearances trap
  return true;
}

// ===== baseball (MLB) =====
// The one axis that creates impossible props is pitcher vs position-player.
function mlbRole(pos) {
  const p = (pos || '').toUpperCase();
  if (!p.replace(/[^A-Z0-9]/g, '')) return 'UNK';
  if (/\b(SP|RP|P)\b/.test(p) || p.includes('PITCH')) return 'PIT';
  if (/\b(C|1B|2B|3B|SS|LF|CF|RF|DH|OF|IF|UT|UTIL)\b/.test(p) ||
      p.includes('CATCH') || p.includes('INFIELD') || p.includes('OUTFIELD') ||
      p.includes('DESIGNATED') || p.includes('BASE') || p.includes('SHORT')) return 'BAT';
  return 'UNK';
}

function mlbStatKind(stat) {
  const s = (stat || '').toLowerCase();
  // explicit role-prefixed stats win (PP often labels "Hitter ..." / "Pitcher ...")
  if (s.includes('hitter') || s.includes('batter')) return 'HIT';
  if (s.includes('pitcher') || s.includes('pitching')) return 'PIT';
  // unambiguous pitching stats
  if (s.includes('earned run') || s.includes('hits allowed') || s.includes('walks allowed') ||
      s.includes('outs recorded') || s.includes('pitching out')) return 'PIT';
  // unambiguous hitting stats
  if (s.includes('total bases') || s.includes('rbi') || s.includes('stolen base') ||
      s.includes('home run') || s.includes('double') || s.includes('triple') ||
      s.includes('single') || s.includes('at bat') || s.includes('hits+runs') ||
      s.includes('hits + runs')) return 'HIT';
  // deliberately AMBIGUOUS -> NEUTRAL -> pass: bare "strikeouts", "hits", "runs",
  // "walks", "fantasy score" can belong to either side; never block on those.
  return 'NEUTRAL';
}

// Block ONLY the unambiguous trap: a pitching stat on a position player. A hitting
// stat on a pitcher PASSES on purpose — two-way players (Ohtani) are real, and PP
// almost never posts a truly impossible hitting line for a pitcher.
function mlbAllows(pos, stat) {
  const role = mlbRole(pos), kind = mlbStatKind(stat);
  if (role === 'UNK' || kind === 'NEUTRAL') return true;
  if (kind === 'PIT') return role === 'PIT';          // only pitchers record pitching stats
  return true;
}

// ===== dispatch =====
// PrizePicks posts many soccer competitions (EPL, MLS, UCL, ...). The gate is about
// the sport, not one tournament, so match on the sport's stat vocabulary rather than
// naming every league.
function isSoccerStat(stat) {
  const s = String(stat || '').toLowerCase();
  return s.includes('shots on target') || s.includes('goalie saves') || s.includes('goals') ||
         s.includes('assists') && s.includes('goal') || s.includes('clearances') || s.includes('tackles');
}
function positionAllows(pos, stat, league) {
  if (league === 'mlb') return mlbAllows(pos, stat);
  if (isSoccerStat(stat)) return soccerAllows(pos, stat);
  return true; // no gate defined for this league yet -> fail open, never invent traps
}

// ---------- screen: keep selected tiers, spread across ALL games ----------
// Two PrizePicks rows can describe the SAME logical prop — most often a combo posted
// under each participant — which otherwise reaches the board as two identical cards.
// Identity = the set of players (order-independent) + stat + line + tier. Team and
// matchup are deliberately excluded so a combo listed under either side collapses to one.
function propIdentity(r) {
  const players = String(r.player || '')
    .split('+').map((s) => s.trim().toLowerCase()).filter(Boolean).sort().join('+');
  const stat = String(r.stat || '').toLowerCase().trim();
  return `${players}|${stat}|${r.line}|${r.oddsType}`;
}

function findCandidates(rows, tiers, perGame = 4, maxTotal = 44, statFilter = null) {
  const allow = new Set(tiers && tiers.length ? tiers : ['goblin', 'standard']);
  // Optional prop-type filter. The UI now sends PrizePicks' own stat_type (sourced
  // live via pp-stats.js), so prefer an exact match when the board actually carries
  // that stat — plain substring would quietly widen "Hits" to include "Hits Allowed"
  // (a pitching prop) and "Hits+Runs+RBIs". Substring stays as the fallback so
  // partial values still work: "Earned Runs" -> "Earned Runs Allowed".
  // Checked against BOTH names PrizePicks carries: the filter may hold either the
  // stat_type ("Hitter Strikeouts") or the display name the user sees ("Hitter Ks").
  const wantStat = statFilter ? String(statFilter).trim().toLowerCase() : null;
  const namesOf = (r) => [String(r.stat || ''), String(r.statDisplay || '')]
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hasExact = wantStat ? rows.some((r) => namesOf(r).includes(wantStat)) : false;
  const matchesStat = (r) => !wantStat ||
    (hasExact ? namesOf(r).includes(wantStat) : namesOf(r).some((n) => n.includes(wantStat)));
  // When filtering to one prop type, widen the net so the BEST available shows even
  // if probabilities are low (you've already chosen the prop; you just want the top of it).
  const pg = wantStat ? 8 : perGame;
  const max = wantStat ? 60 : maxTotal;

  const byMatchup = {};
  const seen = new Set();
  for (const r of rows) {
    if (!allow.has(r.oddsType)) continue;
    if (!positionAllows(r.position, r.stat, r.league)) continue;  // hard trap gate
    if (!matchesStat(r)) continue;                                 // prop-type filter
    const idk = propIdentity(r);
    if (seen.has(idk)) continue;                                   // same prop listed twice (e.g. combo under both players)
    seen.add(idk);
    (byMatchup[r.matchup] ||= []).push({ ...r, fairProb: ODDS_PRIOR[r.oddsType] ?? 0.55 });
  }
  const out = [];
  for (const m in byMatchup) {
    const top = byMatchup[m].sort((a, b) => b.fairProb - a.fairProb).slice(0, pg);
    out.push(...top);                              // every matchup gets represented
  }
  return out.sort((a, b) => b.fairProb - a.fairProb).slice(0, max);
}

function groupByGame(items) {
  const g = {};
  for (const it of items) (g[it.matchup || it.game] ||= []).push(it);
  return g;
}

// ---------- judgment: Claude with web search ----------

function extractBalanced(text) {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          const chunk = text.slice(start, i + 1);
          if (chunk.includes('"picks"')) return chunk;
          break;
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

function parsePicks(text) {
  if (!text) return [];
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  for (const c of [cleaned, extractBalanced(cleaned)]) {
    if (!c) continue;
    try {
      const data = JSON.parse(c);
      if (Array.isArray(data?.picks)) return data.picks;
      if (Array.isArray(data)) return data;
    } catch {}
  }
  return [];
}

// ---------- re-attach the source projection to each judged pick ----------
/**
 * The judge is sent a slim view of each candidate and echoes back only
 * player/stat/line/verdict/prob. Everything else the board and the grader need
 * has to be re-attached from the candidate row it came from.
 *
 * Exported for tests: this is the join, and a join on the wrong key is silent.
 */
export function attachSource(picks, candidates) {
  // Keyed by player + stat + LINE. PrizePicks posts the same prop at several
  // lines — a goblin below the standard, demons above — and every one of them
  // reaches the judge as its own entry. Keying on player+stat alone collapsed
  // them, and last-write-wins handed every pick on that prop the attributes of
  // whichever line happened to be last in the array.
  //
  // Two things ride on that and both are line-SPECIFIC:
  //   oddsType     — the tier. A goblin line labelled "standard" is treated as
  //                  having an under, and PrizePicks offers no under on it. That
  //                  is how the board came to recommend "under 3.5" on Parker
  //                  Messick's Ks when the only under he had was at 6: the 3.5
  //                  goblin borrowed the tier of the 6 standard sitting next to
  //                  it, so attachSides believed an under existed and took it.
  //   projectionId — the grading key. Pointed at the wrong line, a pick grades
  //                  against a threshold nobody bet, silently and forever.
  // Everything else copied below (team, matchup, headshot, recent form, the
  // opposing starter, park) is a property of the PLAYER, not of the line, so a
  // near-miss on the line is still safe to take those from.
  const norm = (v) => Number(v);
  const lookup = {};
  const byProp = {};
  for (const c of candidates) {
    lookup[`${c.player}|${c.stat}|${norm(c.line)}`] = c;
    byProp[`${c.player}|${c.stat}`] ??= c;         // first, not last — for player-level fields only
  }
  for (const p of picks) {
    const exact = lookup[`${p.player}|${p.stat}|${norm(p.line)}`];
    const src = exact || byProp[`${p.player}|${p.stat}`] || {};
    // Whether we are looking at the row the judge actually judged. When the
    // judge echoes a line no candidate carries, the tier and the projection id
    // are unknown — and guessing them is how the bug above happened. Say so
    // instead, and let the consumers refuse rather than assume.
    p.lineMatched = !!exact;
    // The PrizePicks projection id. Without it a pick can never be graded — it's
    // the key every history lookup uses — and a slip saved from this board would
    // sit "ungradeable" forever. It was previously only written into the pick-log
    // rows, so it never reached the page. Only ever taken from the exact line:
    // an id for a different line is worse than no id, because it grades cleanly
    // against the wrong number.
    if (exact?.id) p.projectionId ??= exact.id;
    p.game ??= src.game || '(unknown game)';
    p.oddsType ??= exact?.oddsType || null;        // so the board can show the tier
    p.team ??= src.team || '';                      // for team dropdowns
    p.matchup ??= src.matchup || src.game || '(unknown game)';
    p.matchupLabel ??= src.matchupLabel || src.game || p.matchup;
    p.position ??= src.position || '';
    p.image ??= src.image || '';                    // player headshot
    if (src.last5) { p.recent5 ??= src.last5; p.recentAvg ??= src.avg; } // last-5 for the UI
    if (src.histGames) p.histGames ??= src.histGames; // per-game value + opponent + home/away, for the stats panel
    if (src.oppSP) p.oppSP ??= src.oppSP;            // opposing starter (hitter props) — for UI/validation
    if (src.selfSP) p.selfSP ??= src.selfSP;         // own season line (pitcher props)
    if (src.park != null) p.parkIndex ??= src.park;  // home park run index
    // First pitch / tipoff, straight from PrizePicks' start_time. DISPLAY ONLY —
    // the board shows it so you know how long you have to place the bet. It is
    // deliberately absent from the judge's payload above and from the calibration
    // log below: a clock skew or a postponed game must never move a probability.
    if (src.start) p.start ??= src.start;
    // MLB Stats API extras (raw data, never the judge's): headshot, cap logo,
    // personId for the lazy stats lookup, and the injury flag.
    if (src.headshot) p.headshot ??= src.headshot;
    if (src.teamLogo) { p.teamLogo ??= src.teamLogo; p.teamLogoFallback ??= src.teamLogoFallback; }
    if (src.mlbId) p.mlbId ??= src.mlbId;
    if (src.injured) p.injured ??= src.injured;
  }
  return picks;
}

async function judge(candidates, teamRecords = {}, winProbs = {}, league = 'mlb', oppDef = {}, version = null) {
  // Only send what Claude reasons with — not image, timestamps, league tags, ids.
  // Saves input tokens on every run; the full objects stay in our code.
  //
  // WHICH fields go in the per-prop entry belongs to the judge version, not to
  // this function: Aphrodite adds the payout tier, and a prompt that talks about
  // a field the payload does not carry is worse than either version alone.
  const V = promptSet(version);
  const slim = {};
  for (const c of candidates) {
    const key = c.matchup || c.game;
    const entry = V.entryFor(c);
    if (c.last5) { entry.recent5 = c.last5; entry.recentAvg = c.avg; }  // last 5 for THIS stat
    if (teamRecords[c.team]) entry.teamRecord = teamRecords[c.team];     // e.g. "55-30"
    if (winProbs[c.team] != null) entry.teamWinPct = Math.round(winProbs[c.team] * 100); // favored?
    if (c.oppTeam) entry.opponent = c.oppTeam;       // real opponent name when ESPN gave it
    if (c.oppSP) entry.oppSP = c.oppSP;              // opposing starter (hitter props)
    if (c.selfSP) entry.selfSP = c.selfSP;           // own season line (pitcher props)
    if (c.park != null) entry.parkIndex = c.park;    // home venue run index (100 = neutral)
    const oppName = c.oppTeam || c.opp;              // whoever they're facing
    const dr = oppDef?.[oppName]?.[normStat(c.stat)]; // opponent's league rank vs THIS stat
    if (dr != null) entry.oppStatRank = dr;          // 1 = stingiest defense ... high = softest
    (slim[key] ||= []).push(entry);
  }
  // Never allot more searches than there are games — small slates (WNBA nights,
  // late MLB) don't need the full cap, and every search result bills as Opus input.
  const gameCount = Object.keys(slim).length;
  const maxSearches = Math.max(1, Math.min(JUDGE_MAX_SEARCHES, gameCount));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: V.promptFor(league),
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
      messages: [{ role: 'user', content: `League: ${String(league).toUpperCase()}\nShortlist grouped by game:\n` + JSON.stringify(slim, null, 2) }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  recordCost('judge', MODEL, data).catch(() => {});   // best-effort spend metering
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const picks = parsePicks(text);
  for (const p of picks) {
    // The verdict is DERIVED from the probability, never read from the model.
    // Asking for a label and a number in the same breath lets the label be
    // chosen first and the number written to justify it. Psyche's own stated
    // thresholds are the ones applied here, so this does not change how a Psyche
    // run scores — it only removes a way for the two to disagree.
    p.verdict = verdictFor(Number(p.prob));
    p.promptVersion = V.name;    // so calibration can score the versions apart
  }
  return attachSource(picks, candidates);
}

// ---------- selection + sizing ----------
const clamp = (p) => Math.min(0.99, Math.max(0.01, Number(p)));

// Nest props under each player so the UI can show one player with a prop dropdown
function groupByPlayer(board) {
  const map = new Map();
  for (const p of board) {
    const key = `${p.matchup}|${p.team}|${p.player}`;
    if (!map.has(key)) {
      map.set(key, {
        player: p.player, team: p.team, matchup: p.matchupLabel || p.matchup,
        image: p.image || '', position: p.position || '',
        inParlay: false, bestProb: 0, props: [],
      });
    }
    const g = map.get(key);
    g.props.push({
      stat: p.stat, line: p.line, verdict: p.verdict, prob: p.prob,
      oddsType: p.oddsType, key_risk: p.key_risk, reasoning: p.reasoning,
      recent5: p.recent5 || null, recentAvg: p.recentAvg ?? null,
      inParlay: !!p.inParlay,
    });
    if (p.inParlay) g.inParlay = true;
    if ((p.prob || 0) > g.bestProb) g.bestProb = p.prob || 0;
  }
  const arr = [...map.values()];
  for (const g of arr) g.props.sort((a, b) => (b.prob || 0) - (a.prob || 0));
  arr.sort((a, b) => (b.inParlay - a.inParlay) || (b.bestProb - a.bestProb));
  return arr;
}

// Break a leg into the individual players it actually depends on. A combo like
// "Jackie Young + Aliyah Boston" depends on BOTH, so deduping on the raw player
// string misses that Young is also in her own single-player leg. Split on '+'.
function playersOf(p) {
  return String(p.player || '')
    .split('+')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Every judged probability is P(OVER) — that is the contract with the prompt and
// with the calibration log. An UNDER is therefore just 1 minus it, which means
// the props the board discarded as weak overs are its strongest unders: a 0.30
// over is a 0.70 under. Half the board was being thrown away.
//
// p.prob stays P(over) untouched (grade-picks and calibration both depend on it);
// the side view lives in p.side / p.sideProb / p.sideVerdict.
const sideVerdictFor = (q) => (q >= 0.62 ? 'play' : q >= 0.54 ? 'lean' : 'pass');

// A prop on someone who is confirmed NOT to play does not settle at 0 — PrizePicks
// VOIDS it (DNP) and refunds the leg. That distinction is the whole game here:
// treated as a 0 it looks like a near-certain under, so the judge was handing out
// 90%+ on pitcher unders precisely BECAUSE the pitcher wasn't starting. Those were
// the best-looking numbers on the board and every one of them was worthless.
//
// So these are removed BEFORE the judge sees them: it saves the tokens, and more
// importantly it stops a void from being scored as a win.
//
// Only CONFIRMED absences count. "No probable posted yet" is not a confirmation,
// and a prop we can't verify stays on the board.
function markVoids(candidates, mlb) {
  const starters = {};   // team abbr -> Set of confirmed starter name keys
  const lineups = {};    // team abbr -> Set of posted batting-order name keys
  for (const g of mlb?.games || []) {
    for (const side of [g.home, g.away]) {
      const abbr = String(side?.abbr || '').toUpperCase();
      if (!abbr) continue;
      if (side?.probablePitcher?.name) {
        (starters[abbr] ||= new Set()).add(mlbNormKey(side.probablePitcher.name));
      }
      // Only a POSTED lineup counts. Absent means "not announced yet", which is
      // not evidence that anyone is out — voiding on it would wipe the whole
      // early-afternoon board.
      if (Array.isArray(side?.lineup) && side.lineup.length) {
        lineups[abbr] = new Set(side.lineup.map((pl) => mlbNormKey(pl.name)));
      }
    }
  }

  let inactive = 0, notStarting = 0, notInLineup = 0;
  for (const c of candidates) {
    if (/ \+ /.test(c.player)) continue;                 // combo: no single player to confirm
    if (c.injured) { c.voidReason = `${c.injured} — PrizePicks voids this, it does not settle at 0`; inactive++; continue; }

    const abbrOf = PP_TO_MLB_ABBR[String(c.team || '').toUpperCase()] || String(c.team || '').toUpperCase();
    const isPitcherProp = mlbStatKind(c.stat) === 'PIT' || mlbRole(c.position) === 'PIT';

    if (!isPitcherProp) {
      // A hitter who is not in the posted lineup is a void, not a zero — the
      // same rule that already applied to pitchers. Only pitchers were checked
      // before, so hitters like these were served as live picks at 80%+ with
      // the model itself noting "not in confirmed lineup" in its own reasoning.
      const posted = lineups[abbrOf];
      if (posted && posted.size && !posted.has(mlbNormKey(c.player))) {
        c.voidReason = 'not in the confirmed lineup — PrizePicks voids this, it does not settle at 0';
        notInLineup++;
      }
      continue;
    }

    // Prefer MLB's own probable; fall back to the ESPN starter attachStarters found.
    const confirmed = starters[abbrOf] || (c.selfSP?.name ? new Set([mlbNormKey(c.selfSP.name)]) : null);
    if (!confirmed || !confirmed.size) continue;         // nothing posted — can't confirm, leave it
    if (confirmed.has(mlbNormKey(c.player))) continue;   // he IS the starter
    c.voidReason = 'not the confirmed starter — PrizePicks voids this, it does not settle at 0';
    notStarting++;
  }
  return { inactive, notStarting, notInLineup, total: inactive + notStarting + notInLineup };
}

// Per-leg hit rate a pure-tier 3-pick Power needs just to return the stake,
// from the real payout tables in bet-finder-size.js: goblin 2.0x, standard
// 4.75x, demon 12.0x. Three legs is the reference because it is the most common
// slip; the ORDERING between tiers is the same at every size.
const BREAK_EVEN_3PICK = {
  goblin: Math.pow(1 / 2.0, 1 / 3),      // 0.794
  standard: Math.pow(1 / 4.75, 1 / 3),   // 0.595
  demon: Math.pow(1 / 12.0, 1 / 3),      // 0.437
};

function attachSides(picks, mode = 'both') {
  for (const p of picks) {
    const over = clamp(p.prob);
    const tier = String(p.oddsType || 'standard').toLowerCase();

    // PrizePicks offers Over AND Under on the STANDARD line only. Every other
    // line on a prop — the goblin below it and the demons above — is OVER-ONLY:
    // the card shows a single "More" button with no "Less".
    //
    // The engine did not know this. It picked whichever side its probability
    // favoured, so a demon line with a low P(over) came out as an UNDER and was
    // recommended at 80% — a bet that does not exist and cannot be placed. Every
    // under on a goblin or demon line was in that category.
    //
    // On those lines the only real bet is the over, so that is what it becomes.
    // A weak over then scores as the weak bet it is and drops out of the board
    // on its own merits, which is the correct outcome — no special-casing needed.
    //
    // A tier we could not confirm is treated as over-only too. p.oddsType is
    // null when the judge echoed a line no candidate carried, so we do not know
    // which of the prop's lines this is. Defaulting an unknown tier to
    // "standard" is what let an unplaceable under through in the first place —
    // and the two errors are not symmetric. Assuming no under costs at most one
    // real bet we skip; assuming an under that does not exist puts a bet on the
    // board that cannot be placed at all.
    const tierKnown = !!p.oddsType;
    const underAvailable = tierKnown && tier === 'standard';
    p.underAvailable = underAvailable;
    p.tierKnown = tierKnown;

    const side = !underAvailable ? 'over'
               : mode === 'over' ? 'over'
               : mode === 'under' ? 'under'
               : (over < 0.5 ? 'under' : 'over');     // 'both': whichever side is the bet
    p.side = side;
    p.sideProb = side === 'under' ? 1 - over : over;
    p.sideVerdict = sideVerdictFor(p.sideProb);

    // In unders-only mode an alt line has nothing to offer, since its under does
    // not exist. Mark it so the selector skips it rather than silently serving
    // an over the user did not ask for.
    p.sideUnavailable = mode === 'under' && !underAvailable;

    // Kept for the payout note: our multiplier tables are captured per tier, not
    // per tier+side. Only a standard-line under can now be "against the grain",
    // because the alt lines no longer produce unders at all.
    p.tierAgainstSide = false;

    // REAL edge: how far the probability clears what the tier has to pay for.
    //
    // The board sorted by raw probability and called it "EDGE %", which is
    // exactly backwards. A goblin line is set LOW so the over is easy, and it
    // pays 2.0x on a 3-pick Power — needing 79.4% a leg just to break even. A
    // standard pays 4.75x and needs 59.5%. So an 80% goblin is worth about
    // +0.6pp while a 65% standard is worth +5.5pp, roughly nine times more —
    // and sorting on probability floated the goblin to the top every time.
    p.breakEven = BREAK_EVEN_3PICK[tier] ?? BREAK_EVEN_3PICK.standard;
    p.edge = Math.round((p.sideProb - p.breakEven) * 10000) / 10000;
  }
  return picks;
}

function selectLegs(picks, n, opts = {}) {
  const ord = { play: 0, lean: 1 };
  const pool = picks
    .filter((p) => (p.sideVerdict || p.verdict) === 'play' || (p.sideVerdict || p.verdict) === 'lean')
    // A player MLB says isn't active is not a bet at any price. Never in a
    // recommendation, whatever the number says.
    .filter((p) => !p.injured)
    // Nor is a player who is not in the confirmed lineup. PrizePicks voids those
    // rather than settling them at 0, so a "win" on one pays nothing.
    .filter((p) => !p.voidReason)
    // In unders-only mode, an alt line has no under to take — see attachSides.
    .filter((p) => !p.sideUnavailable)
    .sort((a, b) => {
      const q = (x) => (x.sideProb != null ? x.sideProb : clamp(x.prob));
      if (q(b) !== q(a)) return q(b) - q(a);
      // Tie-break toward the leg with real recent form behind it. Two legs at the
      // same number are not equally trustworthy if one was read off a profile.
      const data = (x) => (Array.isArray(x.recent5) && x.recent5.length ? 1 : 0);
      if (data(b) !== data(a)) return data(b) - data(a);
      return (ord[a.verdict] ?? 9) - (ord[b.verdict] ?? 9);
    });

  const target = Math.max(2, Math.min(n, 6));
  // A single player may anchor at most this many legs. Legs are multiplied as if
  // independent, but props sharing a player are highly correlated — one cold night
  // sinks them together. Cap keeps the slip from being a disguised single-player bet.
  const MAX_PER_PLAYER = 2;

  const playerCount = {};   // player -> legs they appear in so far
  const gameCount = {};     // matchup -> legs from that game so far
  const propSeen = new Set();  // player+stat -> already on the slip
  const chosen = [];

  // One leg per player PER STAT, hard. Two lines of the same prop (Total Games
  // Won under 7.5 AND under 6.5) is not a parlay:
  //   - PrizePicks won't accept it; you can't take one prop twice.
  //   - They're NESTED, not independent. Under 6.5 already means under 7.5, so
  //     multiplying them as if independent gives a number that is simply wrong —
  //     it understates the pair here and would overstate other pairs.
  // MAX_PER_PLAYER still allows a second leg on the same player for a DIFFERENT
  // stat, which is legal and only correlated rather than duplicated.
  const propKeyOf = (p) => `${normKey(p.player)}|${normKey(p.statDisplay || p.stat)}`;

  // Two passes. Pass 1 also caps games so we spread the slip across matchups when
  // the slate allows it. Pass 2 relaxes the game cap (small slates may be one game)
  // but ALWAYS keeps the per-player correlation cap.
  const tryFill = (maxPerGame) => {
    for (const p of pool) {
      if (chosen.length >= target) break;
      if (chosen.includes(p)) continue;
      if (propSeen.has(propKeyOf(p))) continue;                                 // same prop, another line — never
      const who = playersOf(p);
      if (who.some((w) => (playerCount[w] || 0) >= MAX_PER_PLAYER)) continue;   // correlation cap (hard)
      const game = p.matchup || p.game || '';
      if (maxPerGame && game && (gameCount[game] || 0) >= maxPerGame) continue;  // game spread (soft)
      chosen.push(p);
      propSeen.add(propKeyOf(p));
      who.forEach((w) => { playerCount[w] = (playerCount[w] || 0) + 1; });
      if (game) gameCount[game] = (gameCount[game] || 0) + 1;
    }
  };

  // Aim for no more than half the legs from a single game on the first pass.
  tryFill(Math.max(1, Math.ceil(target / 2)));
  if (chosen.length < target) tryFill(0);   // relax game spread, keep player cap

  // Deliberately NOT padded to `target` with weaker legs. A slip is only as good
  // as its worst leg, and filling a 5-leg request with two coinflips makes it
  // worse than the 3-leg version. The caller reports the shortfall instead.
  chosen.shortfall = target - chosen.length;
  chosen.poolSize = pool.length;
  return chosen;
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
  if (edge <= 0) return { label, evPerDollar: edge, stake: 0, note: 'NO BET — non-positive EV' };
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
  const dist = hitDistribution(probs);
  const out = { legs, hitDistribution: dist, entries: {} };
  let best = null, bestG = -Infinity;
  for (const entry of ['power', 'flex']) {
    if (entry === 'flex' && n < 3) continue;
    const table = entry === 'power' ? { [n]: POWER[n] } : FLEX[n];
    const rec = priceEntry(probs, table, bankroll, floor, maxStake, entry.toUpperCase());
    rec.payouts = Object.entries(table)
      .map(([hits, m]) => ({ hits: Number(hits), pays: Math.round(rec.stake * m * 100) / 100 }))
      .sort((a, b) => b.hits - a.hits);
    out.entries[entry] = rec;
    if (rec.stake > 0) {
      const g = expectedLogGrowth(probs, table, rec.stake / bankroll);
      if (g > bestG) { bestG = g; best = entry.toUpperCase(); }
    }
  }
  out.recommended = best;
  return out;
}

// ---------- orchestration ----------
export const handler = async (event) => {
  let jobId;
  const store = getStore({
    name: 'bet-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

    const params = {
      league: body.league || 'mlb',
      bankroll: Number(body.bankroll) || 0,
      floor: Number(body.floor) || 0,
      legs: Number(body.legs) || 3,
      today: body.today !== false,
      maxStake: body.maxStake ? Number(body.maxStake) : null,
      tiers: Array.isArray(body.tiers) && body.tiers.length ? body.tiers : ['goblin', 'standard'],
      statFilter: body.statFilter ? String(body.statFilter) : null, // e.g. "home runs" — judge only this prop type
      // 'both' (default) shows whichever side is the bet per prop; 'over'/'under'
      // force one. Unders come free: they are 1 - P(over) on the same judgement.
      sides: ['both', 'over', 'under'].includes(String(body.sides || '').toLowerCase())
        ? String(body.sides).toLowerCase() : 'both',
      maxPicks: body.maxPicks ? Math.max(3, Math.min(60, Number(body.maxPicks))) : null, // cap candidates → faster/cheaper
      // Which judge version to run: 'psyche' (the original) or 'aphrodite'.
      // Per-run so the two can be compared on the SAME slate, which is the only
      // comparison worth much — different nights differ more than the prompts do.
      prompt: body.prompt ? String(body.prompt).toLowerCase() : null,
    };

    // ---- Run timer: timestamped phase log + typical-duration ETA ----------
    // Each phase update carries startedAt, elapsedMs, and a log of completed
    // phases with their durations. typicalMs is the average of the last runs
    // for this league (from the run-stats blob), so the UI can show a real ETA.
    const runStart = Date.now();
    const phaseLog = [];           // [{ phase, ms }]
    let lastPhaseAt = runStart;
    let typicalMs = null;
    const statsStore = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    try {
      const hist = await statsStore.get(params.league, { type: 'json' });
      if (Array.isArray(hist) && hist.length) typicalMs = Math.round(hist.reduce((a, r) => a + r.totalMs, 0) / hist.length);
    } catch { /* no history yet — ETA shows once a run has completed */ }

    const tick = async (step) => {
      const now = Date.now();
      await store.setJSON(jobId, {
        status: 'running', step,
        startedAt: new Date(runStart).toISOString(),
        elapsedMs: now - runStart,
        typicalMs,                               // null until at least one run has finished
        phases: phaseLog.slice(),                // completed phases with durations
      });
    };
    const phaseDone = (phase) => {
      const now = Date.now();
      phaseLog.push({ phase, ms: now - lastPhaseAt });
      lastPhaseAt = now;
    };
    const recordRun = async () => {
      try {
        const totalMs = Date.now() - runStart;
        let hist = [];
        try { hist = (await statsStore.get(params.league, { type: 'json' })) || []; } catch {}
        hist.push({ at: new Date().toISOString(), totalMs, phases: phaseLog.slice(), model: MODEL });
        await statsStore.setJSON(params.league, hist.slice(-20));   // keep last 20 runs
      } catch { /* stats are best-effort */ }
    };
    // ------------------------------------------------------------------------

    await tick('pulling props + gathering data');

    // ---- Overlap phase -----------------------------------------------------
    // Team records, MLB starters and opponent-defense ranks need NOTHING from
    // PrizePicks — only the league tag — and the Odds API call needs the board
    // only at the very end, to map odds team names onto PP's team strings. So
    // they all start NOW, alongside the props pull, instead of waiting for it.
    // Only recent form (attachHistory) genuinely depends on the candidate list,
    // because it looks up each prop by its PrizePicks projection id.
    //
    // guard() attaches a no-op catch so a research fetch that rejects during the
    // props wait can't surface as an unhandled rejection (which Node treats as
    // fatal). Promise.allSettled below still sees the real rejection.
    const guard = (p) => { p.catch(() => {}); return p; };
    // track() stamps each piece's wall time into result.timing so a slow run can
    // be diagnosed from the browser console instead of guessed at. Pieces run
    // concurrently, so these overlap — wall clock is NOT their sum.
    const pieceMs = {};
    const track = (label, p) => {
      const t0 = Date.now();
      Promise.resolve(p).catch(() => {}).then(() => { pieceMs[label] = Date.now() - t0; });
      return p;
    };

    const rowsP = guard(track('props', fetchProps(params.league).then((r) => filterToday(r, params.today))));
    const recordsP  = guard(track('records', fetchTeamRecords(params.league)));
    const oddsP     = guard(track('odds', fetchWinProbs(params.league, rowsP)));   // awaits rowsP internally
    const startersP = guard(track('starters', params.league === 'mlb' ? fetchMlbStarters() : Promise.resolve(null)));
    const defenseP  = guard(track('defense', fetchOppDefense(params.league)));
    // MLB Stats API: the injury report, personIds (headshots) and team logos.
    // Injuries are the one enrichment that must be known BEFORE you bet, so this
    // rides in the concurrent wave rather than loading lazily — starting at t=0
    // means it costs no wall time. Everything deeper (season lines, splits,
    // game logs) is fetched lazily by the page instead. Blob-cached 20 min, so
    // most runs pay nothing at all for it.
    const mlbP = guard(track('mlbSlate', params.league === 'mlb'
      ? mlbSlate().catch(() => null)          // enrichment: never fails a run
      : Promise.resolve(null)));

    const rows = await rowsP;
    const candidates = findCandidates(rows, params.tiers, 4, params.maxPicks || 44, params.statFilter);
    const traps = rows
      .filter((r) => !positionAllows(r.position, r.stat, r.league))
      .slice(0, 15)
      .map((r) => ({ player: r.player, stat: r.stat, line: r.line, position: r.position, matchup: r.matchup }));
    if (!candidates.length) {
      await store.setJSON(jobId, { status: 'done', result: { board: [], parlay: { error: 'No candidates — props not posted yet.' }, params } });
      return { statusCode: 202 };
    }
    phaseDone('pulling props');

    // ---- Completion gate ---------------------------------------------------
    // Four of the five pieces have been in flight since the run started; recent
    // form starts here because it needs the candidate ids. The judge MUST NOT
    // start until every piece has settled — Promise.allSettled waits for ALL of
    // them, success or failure, and the checklist below records which pieces
    // arrived. A failed piece degrades gracefully (judge runs without it)
    // instead of blocking the run.
    await tick('gathering data (records, odds, form, starters)');

    // Recent form. PrizePicks' history endpoint now answers 403 to every request,
    // which silently emptied `last5` — the signal the judge weights most heavily
    // and the input to both statistical anchors. MLB's game log replaces it for
    // MLB; other leagues still try PrizePicks, which is all they have.
    const historyP = guard(track('history', (async () => {
      if (params.league === 'mlb') {
        const mlb = await mlbP;                    // in flight since t=0, usually cached
        // `before` = the slate date, so a re-run after the games can't feed
        // tonight's own result back in as "recent form".
        const attached = await attachMlbForm(candidates, mlb?.people, { before: mlb?.date });
        if (attached) return attached;
        return attachHistory(candidates);          // fall back if MLB gave nothing
      }
      // Every other ESPN league gets form from the same box scores that grade
      // it. attachHistory below reads api.prizepicks.com, which is behind
      // DataDome and answers 403 to everything — so before this, every NFL, NBA
      // and NHL candidate reached the judge with recent5 null.
      if (ESPN_SLUGS_FOR_FORM[String(params.league || '').toLowerCase()]) {
        const slate = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const attached = await attachEspnForm(candidates, params.league, { before: slate });
        if (attached) return attached;
      }
      return attachHistory(candidates);
    })()));

    const [recordsR, oddsR, historyR, startersR, defenseR, mlbR] =
      await Promise.allSettled([recordsP, oddsP, historyP, startersP, defenseP, mlbP]);

    const checklist = {
      records: recordsR.status === 'fulfilled',
      odds: oddsR.status === 'fulfilled',
      history: historyR.status === 'fulfilled',
      starters: params.league !== 'mlb' ? 'n/a' : startersR.status === 'fulfilled',
    };

    const teamRecords = resolveRecords(rows, recordsR.status === 'fulfilled' ? recordsR.value : {});
    const odds = oddsR.status === 'fulfilled' ? oddsR.value : { status: 'error', message: 'win% fetch failed', teamWinProbs: {} };
    const oppDef = defenseR.status === 'fulfilled' && defenseR.value ? defenseR.value : {};

    let mlbStatus = null;
    let mlbSlateData = null;
    if (params.league === 'mlb') {
      const sp = startersR.status === 'fulfilled' && startersR.value ? startersR.value : { teamMap: {}, status: { games: 0, starters: 0, message: 'starters fetch failed' } };
      const attached = attachStarters(candidates, sp.teamMap);
      mlbStatus = { ...sp.status, attached, checklist,
        // How many candidates actually carry recent form. If this is 0 the judge
        // is reading profiles, not production, and every probability is softer
        // than it looks.
        recentForm: candidates.filter((c) => Array.isArray(c.last5) && c.last5.length).length };

      // ---- MLB Stats API enrichment (raw data, no model) ------------------
      // Three things per candidate, all from the single roster call already
      // made: the personId (which IS the headshot), the team's cap logo, and
      // whether this exact player is on the injured list. The last one is the
      // reason injuries aren't lazy — a prop on a player who isn't playing is
      // not a bet, and you need to know that before you tap, not after.
      mlbSlateData = mlbR.status === 'fulfilled' && mlbR.value ? mlbR.value : null;
      if (mlbSlateData) {
        let hs = 0, flagged = 0;
        for (const c of candidates) {
          const abbr = PP_TO_MLB_ABBR[String(c.team || '').toUpperCase()] || String(c.team || '').toUpperCase();
          const t = mlbSlateData.teams?.[abbr];
          if (t) { c.teamLogo = t.logo; c.teamLogoFallback = t.espnLogo; c.mlbTeamId = t.id; }
          // A combo prop names two players; there is no single person to resolve.
          const person = / \+ /.test(c.player) ? null : mlbSlateData.people?.[mlbNormKey(c.player)];
          if (!person) continue;
          c.mlbId = person.id;
          if (person.headshot) { c.headshot = person.headshot; hs++; }
          if (person.out) { c.injured = person.status || 'Not active'; flagged++; }
        }
        mlbStatus.mlb = {
          games: mlbSlateData.counts?.games ?? null,
          headshots: hs,
          injuredOnBoard: flagged,
          injuredLeaguewide: mlbSlateData.counts?.injured ?? null,
          cached: mlbSlateData.cached === true,
        };
      } else {
        mlbStatus.mlb = { error: 'MLB Stats API unavailable — headshots and injury flags are off for this run.' };
      }
    }
    // ---- Drop props that will VOID before spending a judgement on them -----
    // A DNP is refunded, not scored 0. Rating them produced 90%+ "unders" on
    // pitchers who weren't starting — the best numbers on the board, all of them
    // worthless. Filtering here also keeps them out of the judge's token bill.
    // MLB voids off confirmed lineups; every ESPN league voids off the injury
    // report. Before this only MLB had any check at all, so an NFL prop on a
    // player ruled OUT would be rated and recommended like any other.
    const voids = params.league === 'mlb'
      ? markVoids(candidates, mlbSlateData)
      : ESPN_SLUGS_FOR_FORM[String(params.league || '').toLowerCase()]
        ? await (async () => {
          const r = await markEspnVoids(candidates, params.league).catch(() => ({ checked: 0, out: 0 }));
          return { inactive: r.out, notStarting: 0, notInLineup: 0, total: r.out, injuryRowsChecked: r.checked };
        })()
        : { inactive: 0, notStarting: 0, total: 0 };
    const voided = candidates.filter((c) => c.voidReason);
    const live = candidates.filter((c) => !c.voidReason);
    if (mlbStatus) mlbStatus.voided = { ...voids, examples: voided.slice(0, 6).map((c) => `${c.player} · ${c.statDisplay || c.stat}`) };
    if (!live.length) {
      await store.setJSON(jobId, { status: 'done', result: { board: [], parlay: { error: 'Every candidate on this slate is a confirmed DNP — nothing to rate.' }, mlbStatus, params } });
      return { statusCode: 202 };
    }

    // ---- Gate passed: every piece settled. Hand the full puzzle to Claude. --
    phaseDone('gathering data');

    await tick('Claude researching lineups');
    const judgeStart = Date.now();
    const judged = await judge(live, teamRecords, odds.teamWinProbs, params.league, oppDef, params.prompt);
    // Resolve the name back into params so the result payload, the run report
    // and the page all state which judge actually ran. A version you cannot see
    // from the output is one you will misattribute results to.
    const judgeVersion = promptSet(params.prompt).name;
    params.prompt = judgeVersion;
    pieceMs.judge = Date.now() - judgeStart;
    if (!judged.length) throw new Error('Claude returned no parseable picks.');
    // Keep only picks that tie back to a prop we actually sent. A name the model
    // produced on its own has no projection id behind it, so it could never be
    // graded or logged — and after the DNP filter above, an echoed-back voided
    // prop would sneak straight past it.
    const sentKeys = new Set(live.map((c) => `${c.player}|${c.stat}`));
    const picks = judged.filter((p) => sentKeys.has(`${p.player}|${p.stat}`));
    const invented = judged.length - picks.length;
    if (!picks.length) throw new Error('Claude returned no picks that match the board.');

    // Decide each prop's side BEFORE selecting or filtering, so unders compete
    // with overs on equal terms instead of being discarded as weak overs.
    attachSides(picks, params.sides);

    const chosen = selectLegs(picks, params.legs);
    // Size on the probability of the side actually taken, not P(over).
    const parlay = sizeParlay(chosen.map((p) => ({ ...p, prob: p.sideProb != null ? p.sideProb : p.prob })), params);
    const parlayLegs = chosen.map((p) => ({
      player: p.player, stat: p.stat, statDisplay: p.statDisplay, line: p.line,
      prob: p.sideProb != null ? p.sideProb : p.prob,   // P(the side we're recommending)
      probOver: p.prob, pick: p.side || 'over', verdict: p.sideVerdict || p.verdict,
      oddsType: p.oddsType, tierAgainstSide: !!p.tierAgainstSide,
      edge: p.edge, breakEven: p.breakEven,
      team: p.team, matchup: p.matchupLabel || p.matchup,
      projectionId: p.projectionId || null, start: p.start || null,
      headshot: p.headshot || null, teamLogo: p.teamLogo || null, teamLogoFallback: p.teamLogoFallback || null,
      key_risk: p.key_risk || null, mlbId: p.mlbId || null,
    }));
    // How the slip was built, so the card can say it rather than implying it.
    const parlayNote = {
      requested: Math.max(2, Math.min(params.legs, 6)),
      built: chosen.length,
      shortfall: chosen.shortfall || 0,
      poolSize: chosen.poolSize || 0,
      sides: params.sides,
      againstTier: parlayLegs.filter((l) => l.tierAgainstSide).length,
    };
    // Normally the board shows only plays/leans. But when the user filtered to a
    // specific prop type, show ALL of them sorted by prob (best on top) — they've
    // chosen the prop and want the strongest option even if it's a low-prob "pass".
    // Guard: never render the same prop twice (belt-and-suspenders on the dedupe above).
    const boardSeen = new Set();
    const sideProbOf = (p) => (p.sideProb != null ? p.sideProb : p.prob || 0);
    const board = (params.statFilter
      ? picks.slice().sort((a, b) => sideProbOf(b) - sideProbOf(a))
      : picks.filter((p) => p.sideVerdict === 'play' || p.sideVerdict === 'lean')
    ).filter((p) => { const k = propIdentity(p); if (boardSeen.has(k)) return false; boardSeen.add(k); return true; });
    const chosenKeys = new Set(chosen.map((p) => `${p.player}|${p.stat}|${p.line}`));
    for (const p of board) p.inParlay = chosenKeys.has(`${p.player}|${p.stat}|${p.line}`);
    const players = groupByPlayer(board);

    // Log every pick for later auto-grading + calibration. Keyed by date so each
    // day is one record. Stores what we need to grade: projection id, line, the
    // probability Claude gave, verdict, tier — plus graded:null to fill in later.
    try {
      const logStore = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      const day = new Date().toISOString().slice(0, 10);
      const stamp = new Date().toISOString();
      // Keyed by LINE as well as player and stat. The same collision fixed in
      // attachSource lives here: a prop posted at three lines wrote all three log
      // rows against whichever id came last, so a pick could grade against a line
      // nobody bet. attachSource has already resolved the right id — prefer it,
      // and fall back to a line-aware lookup only if it is missing.
      const idByKey = {};
      for (const c of live) idByKey[`${c.player}|${c.stat}|${Number(c.line)}`] = c.id;
      const logged = picks.map((p) => ({
        date: day, loggedAt: stamp, league: params.league,
        projectionId: p.projectionId || idByKey[`${p.player}|${p.stat}|${Number(p.line)}`] || null,
        player: p.player, stat: p.stat, line: p.line,
        prob: p.prob, verdict: p.verdict, oddsType: p.oddsType,
        // Which judge version produced this probability. Without it a prompt
        // change cannot be evaluated — the log would mix two forecasters and
        // report one blended, uninterpretable calibration curve.
        promptVersion: p.promptVersion || judgeVersion,
        cleared: p.cleared ?? null,     // how many of the last 5 cleared, per the judge
        recentAvg: p.recentAvg ?? null,
        mlbId: p.mlbId ?? null,   // lets the MLB fallback grader skip a name lookup
        image: p.image || null, team: p.team || null, matchup: p.matchupLabel || p.matchup || null, // for the top-picks feed UI
        result: null, hit: null, gradedAt: null,   // filled by the grader later
      }));
      let existing = [];
      try { existing = (await logStore.get(day, { type: 'json' })) || []; } catch {}
      // Merge by projectionId (fallback to player|stat|line) instead of appending,
      // so re-running the same day updates picks in place rather than duplicating.
      // An already-graded entry is preserved over a fresh (ungraded) re-log.
      // Source-scoped so a re-run only replaces this engine's own rows — slip-judge
      // entries for the same projection are separate predictions and must survive.
      const keyOf = (p) => `${p.source || 'board'}|${p.projectionId || `${p.player}|${p.stat}|${p.line}`}`;
      const byKey = new Map();
      for (const p of existing) byKey.set(keyOf(p), p);
      for (const p of logged) {
        const prev = byKey.get(keyOf(p));
        if (prev && (prev.hit === true || prev.hit === false)) continue; // keep graded
        byKey.set(keyOf(p), p);
      }
      await logStore.setJSON(day, [...byKey.values()]);
    } catch {
      // logging is best-effort — never let it break a run
    }

    phaseDone('Claude researching lineups');
    await recordRun();
    // Per-piece wall times ride back with the result so the browser console can
    // print a real breakdown of where a slow run spent its time.
    const timing = {
      totalMs: Date.now() - runStart,
      pieces: pieceMs,                    // concurrent — wall clock ≠ sum
      rows: rows.length,
      candidates: candidates.length,
      phases: phaseLog.slice(),
    };
    await store.setJSON(jobId, { status: 'done', totalMs: Date.now() - runStart, phases: phaseLog.slice(), result: { board, players, parlay, parlayLegs, traps, teamRecords, winProbs: odds.teamWinProbs, oddsStatus: { status: odds.status, message: odds.message, remaining: odds.remaining, used: odds.used }, parlayNote, voidedCount: voids.total, unmatchedPicks: invented, mlbStatus, mlbInjuries: mlbSlateData?.injuries || null, mlbGames: mlbSlateData?.games || null, timing, allPicks: picks, params } });
    return { statusCode: 202 };
  } catch (err) {
    if (jobId) await store.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    return { statusCode: 202 };
  }
};

// ---- shared research helpers, reused by judge-slip.js (single-slip judging) ----
// so both entry points pull PrizePicks/ESPN/Odds-API data through one implementation.
export {
  PP_LEAGUE_IDS, PARK_INDEX, PP_TO_ESPN_ABBR, ODDS_SPORT_KEYS, ESPN_SLUGS,
  fetchLeagueCatalog, resolveLeagueId, leagueTagOf,
  fetchProps, fetchHistory, attachHistory,
  fetchMlbStarters, attachStarters, mlbRole, mlbStatKind,
  fetchTeamRecords, resolveRecords, fetchTeamFullNames,
  fetchWinProbs, fetchOppDefense, normStat, normKey, americanToProb,
  recordCost, PRICES,
  filterToday, findCandidates, positionAllows, propIdentity,   // pure helpers, exported for tests
  attachSides, selectLegs, sideVerdictFor, markVoids,
};

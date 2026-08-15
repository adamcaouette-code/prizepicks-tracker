// netlify/functions/mlb-stats.js
//
// MLB Stats API (statsapi.mlb.com) — free, no key. Everything here is raw data:
// no model is ever called, so this is cheap to hit and safe to hit often.
//
//   ?mode=slate            today's games, probable pitchers, team ids/logos,
//                          the injury report per playing team, and a
//                          name -> personId map (which is what gives us
//                          headshots for free). Cached 20 min.
//   ?mode=player&id=123    one player's season line, last-10 game log and
//                          platoon splits. Cached 6h. Called LAZILY by the page
//                          when you open a card, so it never delays a run.
//   ?mode=probe            small raw sample of each upstream response, for
//                          checking the shapes against the live API.
//
// SHAPES: ?mode=player was verified against the live API and corrected — see the
// notes on hydrate=currentTeam, opponent-name resolution and two-way players
// below. ?mode=slate is still written against documented shapes only; run
// ?mode=probe against production to confirm it. Every reader is defensive either
// way: an unexpected shape yields null/[] and the caller carries on.

import { getStore } from '@netlify/blobs';

const API = 'https://statsapi.mlb.com/api/v1';
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const SLATE_TTL = 20 * 60 * 1000;      // injuries move during the day
const PLAYER_TTL = 6 * 60 * 60 * 1000; // a season line doesn't
const TEAMS_TTL = 7 * 24 * 60 * 60 * 1000;

const store = () => {
  try { return getStore({ name: 'mlb-cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }); }
  catch { return null; }
};

async function cached(key, ttl, fn) {
  const s = store();
  if (s) {
    try {
      const hit = await s.get(key, { type: 'json' });
      if (hit && hit.at && Date.now() - hit.at < ttl) return { ...hit.data, cached: true, ageMin: Math.round((Date.now() - hit.at) / 60000) };
    } catch { /* cache is best-effort */ }
  }
  const data = await fn();
  if (s) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }
  return { ...data, cached: false };
}

async function api(path, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'AtomBets/1.0' } });
      if (res.ok) return await res.json();
      if (res.status < 500) return null;         // 4xx won't get better on retry
    } catch { /* network blip — retry once */ }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const normKey = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// ---- images -----------------------------------------------------------------
// Both are deterministic from an id, so once we know a personId/teamId the
// artwork costs nothing. The CAP mark (not the primary logo) is the one that
// stays legible at 32-48px — primary logos are wordmarks and turn to mush. The
// app is dark, hence cap-on-dark.
const headshotUrl = (personId) => personId
  ? `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best,f_auto/v1/people/${personId}/headshot/67/current`
  : null;
const teamLogoUrl = (teamId) => teamId ? `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${teamId}.svg` : null;
// PNG fallback the page uses if the SVG 404s. Undocumented but stable for years.
const espnLogoUrl = (abbr) => abbr ? `https://a.espncdn.com/i/teamlogos/mlb/500/${String(abbr).toLowerCase()}.png` : null;

// PrizePicks and MLB disagree on a few abbreviations.
const PP_TO_MLB_ABBR = { CWS: 'CWS', CHW: 'CWS', AZ: 'ARI', WAS: 'WSH', SDP: 'SD', SFG: 'SF', TBR: 'TB', KCR: 'KC', WSN: 'WSH', OAK: 'ATH' };

// A status is "out" unless MLB says the player is active. Codes drift (D7/D10/
// D15/D60/DL/RM/BRV/FMD...), so allow-list ACTIVE rather than deny-list injuries —
// a new code then reads as out, which is the safe direction for a bet.
const ACTIVE_CODES = new Set(['A', 'ACT', 'RM']);   // RM = rehab assignment, still on the roster
// Code and description are matched SEPARATELY: the code patterns are anchored
// (^D\d+$ for the day-count ILs, ^DL$ for the legacy one) and would never match
// inside a joined "DL Disabled List" string.
const OUT_CODE = /^(D\d+|DL|IL|PL|BRV|RL|SU|FMD|NRI)$/;
const OUT_DESC = /injur|disabled|paternity|bereave|restricted|suspend|leave|minors|assigned/i;
function isOut(status) {
  const code = String(status?.code || '').toUpperCase();
  const desc = String(status?.description || '');
  if (!code && !desc) return false;              // nothing said — don't invent an injury
  if (ACTIVE_CODES.has(code)) return false;
  if (OUT_CODE.test(code)) return true;
  if (OUT_DESC.test(desc)) return true;
  // An unrecognised, non-active status errs toward OUT: for a bet, wrongly
  // flagging a healthy player costs you one leg, while missing a real absence
  // costs you the whole card.
  return !!code && !ACTIVE_CODES.has(code);
}

// How much an absence bears on TONIGHT. Lower sorts first.
function absenceRank(status) {
  const d = String(status?.description || '');
  if (/day-to-day|day to day/i.test(d)) return 0;
  const days = d.match(/(\d+)\s*-?\s*day/i);
  if (days) return Math.min(4, 1 + Math.floor(Number(days[1]) / 15));   // 7/10-day -> 1, 15 -> 2, 60 -> 4
  if (/full season/i.test(d)) return 5;
  if (/rehab/i.test(d)) return 3;
  return 2;
}

async function teamMap() {
  return cached('teams-v1', TEAMS_TTL, async () => {
    const data = await api('/teams?sportId=1');
    const byAbbr = {};
    const byId = {};
    for (const t of data?.teams || []) {
      if (!t.id) continue;
      const abbr = String(t.abbreviation || '').toUpperCase();
      const rec = { id: t.id, abbr, name: t.name || t.teamName || abbr, logo: teamLogoUrl(t.id), espnLogo: espnLogoUrl(abbr) };
      if (abbr) byAbbr[abbr] = rec;
      byId[t.id] = rec;
    }
    return { byAbbr, byId };
  });
}

// ---- slate: games + probables + injuries + personIds -------------------------
async function slate(dateStr) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  return cached(`slate-${date}`, SLATE_TTL, async () => {
    const sched = await api(`/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`);
    const games = [];
    const teamIds = new Set();
    for (const d of sched?.dates || []) {
      for (const g of d.games || []) {
        const side = (s) => {
          const t = s?.team || {};
          if (t.id) teamIds.add(t.id);
          return {
            id: t.id || null, name: t.name || null, abbr: (t.abbreviation || '').toUpperCase() || null,
            logo: teamLogoUrl(t.id), espnLogo: espnLogoUrl(t.abbreviation),
            probablePitcher: s?.probablePitcher
              ? { id: s.probablePitcher.id, name: s.probablePitcher.fullName, headshot: headshotUrl(s.probablePitcher.id) }
              : null,
          };
        };
        games.push({
          gamePk: g.gamePk || null,
          gameDate: g.gameDate || null,
          status: g.status?.detailedState || null,
          venue: g.venue?.name || null,
          home: side(g.teams?.home), away: side(g.teams?.away),
        });
      }
    }

    // One roster call per PLAYING team — that single call yields the injury
    // report AND every personId (i.e. every headshot) for that team, so it is
    // deliberately the only fan-out here.
    // 40Man, NOT fullRoster. fullRoster returns the whole organisation — minor
    // leaguers, non-roster invitees, everyone parked on the 60-day since March —
    // which produced ~90-name injury lists per team that nobody would read. The
    // 40-man is the population that can actually appear in tonight's game, and
    // going on the 60-day IL removes you from it, so the long-term absences drop
    // out on their own.
    const ids = [...teamIds];
    const rosters = await mapLimit(ids, 6, async (id) => ({ id, data: await api(`/teams/${id}/roster?rosterType=40Man`) }));

    const people = {};      // normKey(name) -> { id, teamId, position, out, status, headshot }
    const injuries = {};    // ABBR -> [{ name, position, status }]
    const tm = await teamMap();
    for (const { id, data } of rosters) {
      const abbr = tm.byId?.[id]?.abbr || String(id);
      for (const r of data?.roster || []) {
        const pid = r.person?.id;
        const name = r.person?.fullName;
        if (!pid || !name) continue;
        const out = isOut(r.status);
        people[normKey(name)] = {
          id: pid, teamId: id, position: r.position?.abbreviation || null,
          out, status: r.status?.description || null, headshot: headshotUrl(pid),
        };
        if (out) (injuries[abbr] ||= []).push({
          name, position: r.position?.abbreviation || null,
          status: r.status?.description || 'Not active',
          rank: absenceRank(r.status),
        });
      }
    }
    // Most-relevant first: a day-to-day or 7-day absence changes tonight's
    // lineup, a 60-day one was decided months ago. Alphabetical order buried the
    // only names that mattered.
    for (const k in injuries) injuries[k].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

    return { date, games, people, injuries, teams: tm.byAbbr, counts: { games: games.length, teams: ids.length, people: Object.keys(people).length, injured: Object.values(injuries).reduce((a, v) => a + v.length, 0) } };
  });
}

// ---- one player's numbers (lazy; never on the run's critical path) ----------
const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };

function seasonLine(splits, group) {
  const s = splits?.[0]?.stat;
  if (!s) return null;
  if (group === 'pitching') {
    return { era: s.era ?? null, whip: s.whip ?? null, so: num(s.strikeOuts), ip: s.inningsPitched ?? null,
      w: num(s.wins), l: num(s.losses), k9: s.strikeoutsPer9Inn ?? null };
  }
  return { avg: s.avg ?? null, obp: s.obp ?? null, slg: s.slg ?? null, ops: s.ops ?? null,
    hr: num(s.homeRuns), rbi: num(s.rbi), sb: num(s.stolenBases), so: num(s.strikeOuts), ab: num(s.atBats), games: num(s.gamesPlayed) };
}

async function player(id, season, groupOverride) {
  const yr = season || String(new Date().getUTCFullYear());
  return cached(`player-${id}-${yr}-${groupOverride || 'auto'}`, PLAYER_TTL, async () => {
    // hydrate=currentTeam: the bare /people/{id} response came back with a null
    // currentTeam against the live API, which left every player logo-less.
    const info = await api(`/people/${id}?hydrate=currentTeam`);
    const p = info?.people?.[0] || null;
    const posAbbr = String(p?.primaryPosition?.abbreviation || '').toUpperCase();
    const posName = String(p?.primaryPosition?.name || '');
    // TWP = two-way player. Their prop board is mostly hitting, so that stays the
    // default, but the caller can ask for the pitching side explicitly.
    const twoWay = posAbbr === 'TWP' || /two-way/i.test(posName);
    const group = groupOverride === 'pitching' || groupOverride === 'hitting'
      ? groupOverride
      : (!twoWay && (posAbbr === 'P' || /pitcher/i.test(posName)) ? 'pitching' : 'hitting');

    const [seasonR, logR, splitR, tm] = await Promise.all([
      api(`/people/${id}/stats?stats=season&season=${yr}&group=${group}`),
      api(`/people/${id}/stats?stats=gameLog&season=${yr}&group=${group}`),
      api(`/people/${id}/stats?stats=statSplits&sitCodes=vl,vr&season=${yr}&group=${group}`),
      teamMap(),
    ]);

    // The game log names opponents in full ("Milwaukee Brewers"), which blows out
    // a 60px cell. Resolve to the abbreviation via the cached team map, keyed by
    // id first and name second.
    const byName = {};
    for (const t of Object.values(tm.byId || {})) byName[normKey(t.name)] = t.abbr;
    const abbrOf = (opp) => {
      if (!opp) return null;
      return opp.abbreviation || tm.byId?.[opp.id]?.abbr || byName[normKey(opp.name)] || opp.name || null;
    };

    const log = (logR?.stats?.[0]?.splits || []).slice(-10).reverse().map((s) => ({
      date: s.date || null, opp: abbrOf(s.opponent), home: s.isHome ?? null,
      ...(group === 'pitching'
        ? { ip: s.stat?.inningsPitched ?? null, so: num(s.stat?.strikeOuts), er: num(s.stat?.earnedRuns), h: num(s.stat?.hits) }
        : { ab: num(s.stat?.atBats), h: num(s.stat?.hits), hr: num(s.stat?.homeRuns), rbi: num(s.stat?.rbi), so: num(s.stat?.strikeOuts), tb: num(s.stat?.totalBases) }),
    }));

    const splits = {};
    for (const s of splitR?.stats?.[0]?.splits || []) {
      const code = String(s.split?.code || '').toLowerCase();
      if (code !== 'vl' && code !== 'vr') continue;
      splits[code === 'vl' ? 'vsLHP' : 'vsRHP'] = group === 'pitching'
        ? { avgAgainst: s.stat?.avg ?? null, so: num(s.stat?.strikeOuts), ops: s.stat?.ops ?? null }
        : { avg: s.stat?.avg ?? null, ops: s.stat?.ops ?? null, hr: num(s.stat?.homeRuns), ab: num(s.stat?.atBats) };
    }

    // Team: prefer the hydrated currentTeam, but fall back to the team on the
    // season split — that one is always present when the player has played.
    const statTeam = seasonR?.stats?.[0]?.splits?.[0]?.team
                  || logR?.stats?.[0]?.splits?.slice(-1)[0]?.team || null;
    const teamId = p?.currentTeam?.id || statTeam?.id || null;
    const teamAbbr = tm.byId?.[teamId]?.abbr || statTeam?.abbreviation || null;

    return {
      id: Number(id), name: p?.fullName || null, group, twoWay,
      position: posAbbr || null,
      bats: p?.batSide?.code || null, throws: p?.pitchHand?.code || null,
      age: p?.currentAge ?? null,
      teamId, teamAbbr,
      teamLogo: teamLogoUrl(teamId), teamLogoFallback: espnLogoUrl(teamAbbr),
      headshot: headshotUrl(id),
      season: seasonLine(seasonR?.stats?.[0]?.splits, group),
      last10: log, splits,
    };
  });
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const mode = q.mode || 'slate';
  try {
    if (mode === 'player') {
      if (!q.id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'mode=player needs an id' }) };
      // ?group=pitching forces the pitching side of a two-way player.
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(await player(q.id, q.season, q.group)) };
    }
    if (mode === 'teams') {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(await teamMap()) };
    }
    if (mode === 'probe') {
      // Raw slices, for checking the real shapes against what this file assumes.
      const date = q.date || new Date().toISOString().slice(0, 10);
      const sched = await api(`/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`);
      const firstTeam = sched?.dates?.[0]?.games?.[0]?.teams?.home?.team?.id;
      const roster = firstTeam ? await api(`/teams/${firstTeam}/roster?rosterType=fullRoster`) : null;
      const somePerson = roster?.roster?.[0]?.person?.id;
      const stats = somePerson ? await api(`/people/${somePerson}/stats?stats=season&season=${new Date().getUTCFullYear()}&group=hitting`) : null;
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
        note: 'raw samples — compare against the parsers in mlb-stats.js',
        scheduleGame: sched?.dates?.[0]?.games?.[0] ?? null,
        rosterEntries: (roster?.roster || []).slice(0, 6),
        distinctStatuses: [...new Set((roster?.roster || []).map((r) => `${r.status?.code} = ${r.status?.description}`))],
        seasonStat: stats?.stats?.[0]?.splits?.[0] ?? null,
      }, null, 2) };
    }
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(await slate(q.date)) };
  } catch (err) {
    // Never 500 into the page: this is enrichment, and the board must survive it.
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err), games: [], people: {}, injuries: {} }) };
  }
};

export { slate, player, teamMap, isOut, absenceRank, headshotUrl, teamLogoUrl, espnLogoUrl, normKey, PP_TO_MLB_ABBR };

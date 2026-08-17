// netlify/functions/mlb-grade.js
//
// A SECOND, independent source of truth for grading MLB picks.
//
// Why this exists: grading reads PrizePicks' /projections/{id}/history, and a
// projection is retired from that API once it leaves the board. We grade ~36h
// later, so by then the id can simply be gone — a 404, forever. A pick that
// can never be graded is not a neutral gap: it drops out of the calibration
// sample entirely, so the Brier score ends up computed on whatever subset
// happened to still be reachable. That is a silent, biased sample.
//
// MLB's Stats API has no such problem. Game logs are permanent, free, and
// authoritative, and we already resolve personIds for headshots. So when
// PrizePicks can't answer, we ask MLB instead.
//
// No model is involved. This is arithmetic over a box score.

import { getStore } from '@netlify/blobs';

const API = 'https://statsapi.mlb.com/api/v1';
const INDEX_TTL = 7 * 24 * 60 * 60 * 1000;
const LOG_TTL = 6 * 60 * 60 * 1000;

const normKey = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const store = () => {
  try { return getStore({ name: 'mlb-cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }); }
  catch { return null; }
};

async function api(path) {
  try {
    const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'AtomBets/1.0' } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function cached(key, ttl, fn) {
  const s = store();
  if (s) {
    try {
      const hit = await s.get(key, { type: 'json' });
      if (hit && hit.at && Date.now() - hit.at < ttl) return hit.data;
    } catch {}
  }
  const data = await fn();
  if (s && data) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }
  return data;
}

// Every player in the league, name -> personId. One call, cached a week; this is
// what lets us grade a pick logged before mlbId was carried on it.
async function playerIndex(season) {
  return cached(`players-${season}`, INDEX_TTL, async () => {
    const d = await api(`/sports/1/players?season=${season}`);
    const byName = {};
    for (const p of d?.people || []) {
      if (!p.id || !p.fullName) continue;
      byName[normKey(p.fullName)] = p.id;
    }
    return byName;
  });
}

// ---- PrizePicks stat name -> a number from an MLB game-log split -------------
// Only stats that map EXACTLY. A guess here would write a wrong hit/miss into
// the calibration log, which is worse than leaving the pick ungraded.
const HIT = {
  hits: (s) => s.hits,
  totalbases: (s) => s.totalBases,
  homeruns: (s) => s.homeRuns,
  hr: (s) => s.homeRuns,
  rbis: (s) => s.rbi,
  rbi: (s) => s.rbi,
  runs: (s) => s.runs,
  runsscored: (s) => s.runs,
  doubles: (s) => s.doubles,
  triples: (s) => s.triples,
  singles: (s) => num(s.hits) - num(s.doubles) - num(s.triples) - num(s.homeRuns),
  walks: (s) => s.baseOnBalls,
  stolenbases: (s) => s.stolenBases,
  sb: (s) => s.stolenBases,
  hitterstrikeouts: (s) => s.strikeOuts,
  hitterks: (s) => s.strikeOuts,
  hitsrunsrbis: (s) => num(s.hits) + num(s.runs) + num(s.rbi),
  atbats: (s) => s.atBats,
};
const PIT = {
  pitcherstrikeouts: (s) => s.strikeOuts,
  ks: (s) => s.strikeOuts,
  strikeouts: (s) => s.strikeOuts,
  hitsallowed: (s) => s.hits,
  earnedrunsallowed: (s) => s.earnedRuns,
  earnedruns: (s) => s.earnedRuns,
  runsallowed: (s) => s.runs,
  walksallowed: (s) => s.baseOnBalls,
  pitchingouts: (s) => s.outs,
  outsrecorded: (s) => s.outs,
  pitchesthrown: (s) => s.numberOfPitches ?? s.pitchesThrown,
  battersfaced: (s) => s.battersFaced,
};

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const statKey = (s) => normKey(s);

// Which side of the box score a stat lives on, and how to read it.
function resolveStat(stat) {
  const k = statKey(stat);
  if (PIT[k]) return { group: 'pitching', read: PIT[k] };
  if (HIT[k]) return { group: 'hitting', read: HIT[k] };
  return null;
}

async function gameLog(personId, season, group) {
  return cached(`gamelog-${personId}-${season}-${group}`, LOG_TTL, async () => {
    const d = await api(`/people/${personId}/stats?stats=gameLog&season=${season}&group=${group}`);
    return (d?.stats?.[0]?.splits || []).map((s) => ({ date: s.date, stat: s.stat || {} }));
  });
}

/**
 * Grade one MLB pick from MLB's own box score.
 * Returns { result, hit, source } — hit is "did the OVER hit", matching
 * grade-picks' convention so callers flip it for an under exactly as before.
 * Returns null (never a guess) when anything is unresolvable.
 */
export async function gradeFromMlb({ player, mlbId, date, stat, line }) {
  if (!date || line == null) return null;
  const mapped = resolveStat(stat);
  if (!mapped) return null;                       // unmapped stat: leave it ungraded

  const season = String(date).slice(0, 4);
  let id = mlbId;
  if (!id) {
    const idx = await playerIndex(season);
    id = idx?.[normKey(player)];
  }
  if (!id) return null;

  const log = await gameLog(id, season, mapped.group);
  if (!log || !log.length) return null;

  // MLB dates the log by the game's LOCAL date, same convention the slate uses.
  // Accept ±1 day for the same UTC-rollover reason the PrizePicks matcher does.
  const shift = (n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const window = new Set([shift(-1), date, shift(1)]);
  const games = log.filter((g) => window.has(String(g.date)));
  if (!games.length) return null;
  // Exact date wins; otherwise the single neighbour. A doubleheader would give
  // two on one date — refuse rather than guess which leg the prop referred to.
  const exact = games.filter((g) => g.date === date);
  const pick = exact.length === 1 ? exact[0] : (games.length === 1 ? games[0] : null);
  if (!pick) return null;

  const value = Number(mapped.read(pick.stat));
  if (!isFinite(value)) return null;
  return { result: value, hit: value > Number(line), source: 'mlb' };
}

export { resolveStat, playerIndex };

// Small HTTP wrapper so the mapping can be checked from the dev console.
export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!q.player && !q.id) {
    return { statusCode: 200, headers, body: JSON.stringify({
      usage: '/api/mlb-grade?player=Elly De La Cruz&date=2026-08-14&stat=Hits&line=0.5',
      mappedStats: { hitting: Object.keys(HIT), pitching: Object.keys(PIT) },
    }, null, 2) };
  }
  const out = await gradeFromMlb({
    player: q.player, mlbId: q.id ? Number(q.id) : null,
    date: q.date, stat: q.stat, line: q.line,
  });
  return { statusCode: 200, headers, body: JSON.stringify({
    query: q, graded: out,
    note: out ? null : 'unresolvable — unmapped stat, unknown player, or no game on that date',
  }, null, 2) };
};

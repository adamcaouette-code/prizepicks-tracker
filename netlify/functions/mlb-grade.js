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

import { normKey, buildIndex, matchPlayer } from './player-match.js';
import { fantasyKind, mlbHitterFantasy, mlbPitcherFantasy, MLB_VERIFIED } from './fantasy-score.js';
import { settle } from './grade-picks.js';   // one push rule, shared

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
  // CACHE THE PLAIN ROWS, NOT THE INDEX.
  //
  // buildIndex returns Maps and a Set, and this cache writes through JSON to a
  // Netlify blob. A Map serializes to {} — so the first (cold) call worked and
  // every cached call afterwards blew up with "index.exact.get is not a
  // function". Rows are a plain array, survive the round trip intact, and
  // rebuilding the index from them is microseconds; the network call was always
  // the expensive part.
  const rows = await cached(`player-rows-${season}`, INDEX_TTL, async () => {
    const d = await api(`/sports/1/players?season=${season}`);
    const out = [];
    for (const p of d?.people || []) {
      if (!p.id || !p.fullName) continue;
      out.push([p.fullName, p.id]);
    }
    return out;
  });
  // Indexed for fuzzy-but-safe matching: PrizePicks and MLB disagree about
  // suffixes ("Luis Robert" vs "Luis Robert Jr.") and short forms ("Nate Lowe"
  // vs "Nathaniel Lowe"), and an exact-only match silently drops both.
  return Array.isArray(rows) ? buildIndex(rows) : null;
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
  plateappearances: (s) => s.plateAppearances,
  pa: (s) => s.plateAppearances,
  // For a HITTER, numberOfPitches in the hitting group is pitches SEEN. The live
  // sample confirmed it: Miguel Vargas, 5 plate appearances, numberOfPitches 24.
  pitchesseen: (s) => s.numberOfPitches,
  // Props PrizePicks posts that had no mapping, so they never graded.
  runsrbis: (s) => num(s.runs) + num(s.rbi),
  rbisruns: (s) => num(s.runs) + num(s.rbi),
  batterstrikeouts: (s) => s.strikeOuts,
  strikeoutsbatting: (s) => s.strikeOuts,
  hitsruns: (s) => num(s.hits) + num(s.runs),
  hitswalks: (s) => num(s.hits) + num(s.baseOnBalls),
  walksbatting: (s) => s.baseOnBalls,
  hitterwalks: (s) => s.baseOnBalls,
  extrabasehits: (s) => num(s.doubles) + num(s.triples) + num(s.homeRuns),
  hbp: (s) => s.hitByPitch,
  hitbypitch: (s) => s.hitByPitch,
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
  // Same again on the pitching side.
  pitcherwalks: (s) => s.baseOnBalls,
  walksissued: (s) => s.baseOnBalls,
  hitsallowedwalksallowed: (s) => num(s.hits) + num(s.baseOnBalls),
  inningspitched: (s) => (s.outs != null ? num(s.outs) / 3 : null),
  pitcherouts: (s) => s.outs,
  strikeoutspitching: (s) => s.strikeOuts,
  totalstrikeouts: (s) => s.strikeOuts,
  homerunsallowed: (s) => s.homeRuns,
  pitcherearnedruns: (s) => s.earnedRuns,
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
export async function gradeFromMlb({ player, mlbId, date, stat, line, allowUnverifiedFantasy = false, debug = false }) {
  if (!date || line == null) return null;

  // Fantasy Score is a weighted formula rather than a column, so it resolves
  // through its own table. It stays disabled until the weights are checked
  // against the lines — see fantasy-score.js. Grading 335 picks on unverified
  // weights would be worse than leaving them ungraded.
  const fantasy = fantasyKind('mlb', stat);
  const mapped = fantasy
    ? { group: fantasy === 'mlb-pitcher' ? 'pitching' : 'hitting', fantasy }
    : resolveStat(stat);
  if (!mapped) return null;                       // unmapped stat: leave it ungraded
  // fantasy-check passes allowUnverifiedFantasy so it can SEE what the formula
  // produces without those numbers ever reaching the pick log.
  if (fantasy && !MLB_VERIFIED && !allowUnverifiedFantasy) return null;

  const season = String(date).slice(0, 4);
  let id = mlbId;
  let how = mlbId ? 'id' : null;
  if (!id) {
    const idx = await playerIndex(season);
    const m = matchPlayer(idx, player);
    id = m?.value;
    how = m?.how;
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

  const raw = mapped.fantasy
    ? (mapped.fantasy === 'mlb-pitcher' ? mlbPitcherFantasy(pick.stat) : mlbHitterFantasy(pick.stat))
    : mapped.read(pick.stat);
  const value = Number(raw);
  if (!isFinite(value)) return null;
  // `matchedVia` records how the name was resolved, so a loose match stays
  // visible in the pick log rather than blending in with the exact ones.
  // `line` is the raw box-score line for the game that settled it. Only attached
  // when asked for: fantasy-check needs it to tell a genuine 0-for-4 from a
  // lookup that found the wrong game, and a computed 0 looks identical either way
  // without it.
  return { ...settle(value, line), source: 'mlb', matchedVia: how || 'exact',
    ...(debug ? { statLine: pick.stat, gameDate: pick.date } : {}) };
}

/**
 * Recent form for ONE player and stat, straight from MLB's game log.
 *
 * This replaces PrizePicks' /projections/{id}/history, which now answers 403 to
 * us for every request. That endpoint fed `last5` — the signal the judge prompt
 * weights most heavily and the input to both statistical anchors — so while it
 * has been blocked, every probability has been a profile guess with no recent
 * production behind it. That is a much bigger accuracy problem than the grading
 * gap it also caused.
 *
 * Returns { last5, avg, games } newest-last (the order the prompt expects), or
 * null when the stat isn't mapped or the player can't be resolved.
 */
export async function formFor({ player, mlbId, stat, season, before, n = 5 }) {
  const mapped = resolveStat(stat);
  if (!mapped) return null;
  const yr = season || String(new Date().getUTCFullYear());

  let id = mlbId;
  if (!id) {
    const idx = await playerIndex(yr);
    id = matchPlayer(idx, player)?.value;
  }
  if (!id) return null;

  const log = await gameLog(id, yr, mapped.group);
  if (!log || !log.length) return null;

  // Only games BEFORE the slate being judged — otherwise a re-run after the game
  // would feed tonight's result back in as "recent form" and inflate the read.
  const usable = log
    .filter((g) => !before || String(g.date) < String(before))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recent = usable.slice(-n);
  if (!recent.length) return null;

  const values = recent.map((g) => Number(mapped.read(g.stat))).filter((v) => isFinite(v));
  if (!values.length) return null;
  return {
    last5: values,
    avg: Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 100) / 100,
    games: recent.map((g, i) => ({ v: values[i], date: g.date })),
  };
}

/** Attaches MLB-sourced recent form to candidates in place. Never throws. */
export async function attachMlbForm(candidates, people, { season, before, limit = 6 } = {}) {
  let hit = 0;
  const list = candidates.filter((c) => !/ \+ /.test(c.player || ''));
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const c = list[i++];
      try {
        const key = normKey(c.player);
        const form = await formFor({
          player: c.player, mlbId: c.mlbId || people?.[key]?.id,
          stat: c.statDisplay || c.stat, season, before,
        });
        if (form) { c.last5 = form.last5; c.avg = form.avg; c.histGames = form.games; hit++; }
      } catch { /* form is a bonus; a miss must never fail the run */ }
    }
  }));
  return hit;
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

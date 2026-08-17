// netlify/functions/espn-grade.js
//
// Grading for the leagues MLB's API doesn't cover. ESPN publishes free box
// scores for NFL, NBA, WNBA, NHL and college, and they don't expire.
//
// This is PRIMARY for those leagues, not a fallback. PrizePicks answers 403 to
// every request we make now — not just for MLB — so putting it first would mean
// spending a guaranteed-failing round trip on every pick before reaching the
// source that actually works. The chain per league is: the sport's own data
// first, PrizePicks last (kept only so it resumes silently if they ever unblock
// us).
//
// No model is involved. This is arithmetic over a box score.
//
// SHAPE CAUTION: written against ESPN's documented summary shape but not
// verifiable from the build environment. Every reader is defensive, and
// ?mode=probe dumps the raw stat keys a real game returns so the mapping can be
// checked rather than trusted.

import { getStore } from '@netlify/blobs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const DAY_TTL = 6 * 60 * 60 * 1000;
const LIVE_TTL = 10 * 60 * 1000;   // a slate still in progress; recheck soon
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const SLUGS = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  nhl: 'hockey/nhl',
  cfb: 'football/college-football',
  college_football: 'football/college-football',
  cbb: 'basketball/mens-college-basketball',
  college_basketball: 'basketball/mens-college-basketball',
};

const normKey = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const store = () => {
  try { return getStore({ name: 'espn-cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }); }
  catch { return null; }
};

async function api(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// `ttl` may be a function of the data. A day whose games are still running must
// not be pinned for six hours — that would freeze a partial slate and leave every
// pick on it pending long after the games ended.
async function cached(key, ttl, fn) {
  const s = store();
  const ttlOf = (d) => (typeof ttl === 'function' ? ttl(d) : ttl);
  if (s) {
    try {
      const hit = await s.get(key, { type: 'json' });
      if (hit && hit.at && Date.now() - hit.at < ttlOf(hit.data)) return hit.data;
    } catch {}
  }
  const data = await fn();
  if (s && data && ttlOf(data) > 0) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }
  return data;
}

// A game that hasn't finished has no final stat line — and ESPN happily serves
// a PARTIAL box score for one in progress. Grading off that records a
// points-at-halftime as the result, which is a wrong grade written into
// calibration: worse than leaving the pick pending. Nothing is read from a
// game until ESPN says it is complete.
const isFinished = (ev) => {
  const t = ev?.status?.type || ev?.competitions?.[0]?.status?.type || {};
  if (t.completed === true) return true;
  if (t.completed === false) return false;
  return t.state === 'post' || /FINAL/i.test(String(t.name || ''));
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// ---- reading ESPN's positional stat arrays ----------------------------------
// Each statistics group carries `keys` (or `labels`) and every athlete a `stats`
// array in the same order. Several keys hold a PAIR in one cell ("8-15" for
// made-attempted), so a made/attempted prop has to split it rather than parse
// the whole string as a number.
function readStat(row, keyName, part) {
  const i = row.index[keyName];
  if (i == null) return null;
  const raw = String(row.stats[i] ?? '');
  if (part != null) {
    const halves = raw.split(/[-/]/);
    return halves[part] != null ? Number(halves[part]) : null;
  }
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

const N = (v) => (isFinite(Number(v)) ? Number(v) : 0);

// PrizePicks stat -> how to read it from an ESPN row. Only exact mappings; a
// guess would write a false result into the calibration log, which is worse than
// leaving a pick ungraded.
const MAPS = {
  basketball: {
    points: (r) => readStat(r, 'points'),
    rebounds: (r) => readStat(r, 'rebounds'),
    assists: (r) => readStat(r, 'assists'),
    steals: (r) => readStat(r, 'steals'),
    blocks: (r) => readStat(r, 'blocks'),
    turnovers: (r) => readStat(r, 'turnovers'),
    threepointersmade: (r) => readStat(r, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 0),
    '3ptmade': (r) => readStat(r, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 0),
    threes: (r) => readStat(r, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 0),
    fgmade: (r) => readStat(r, 'fieldGoalsMade-fieldGoalsAttempted', 0),
    fieldgoalsmade: (r) => readStat(r, 'fieldGoalsMade-fieldGoalsAttempted', 0),
    freethrowsmade: (r) => readStat(r, 'freeThrowsMade-freeThrowsAttempted', 0),
    ptsrebsasts: (r) => N(readStat(r, 'points')) + N(readStat(r, 'rebounds')) + N(readStat(r, 'assists')),
    pra: (r) => N(readStat(r, 'points')) + N(readStat(r, 'rebounds')) + N(readStat(r, 'assists')),
    ptsrebs: (r) => N(readStat(r, 'points')) + N(readStat(r, 'rebounds')),
    ptsasts: (r) => N(readStat(r, 'points')) + N(readStat(r, 'assists')),
    rebsasts: (r) => N(readStat(r, 'rebounds')) + N(readStat(r, 'assists')),
    blockedshots: (r) => readStat(r, 'blocks'),
    blksstls: (r) => N(readStat(r, 'blocks')) + N(readStat(r, 'steals')),
    // Straight off the box score — the probe found these sitting unread while
    // the props for them were going ungraded. Direct key reads, no derivation.
    offensiverebounds: (r) => readStat(r, 'offensiveRebounds'),
    defensiverebounds: (r) => readStat(r, 'defensiveRebounds'),
    personalfouls: (r) => readStat(r, 'fouls'),
    fouls: (r) => readStat(r, 'fouls'),
    minutes: (r) => readStat(r, 'minutes'),
    minutesplayed: (r) => readStat(r, 'minutes'),
    // The attempted halves of the pairs we already split for the made halves.
    fgattempted: (r) => readStat(r, 'fieldGoalsMade-fieldGoalsAttempted', 1),
    fieldgoalsattempted: (r) => readStat(r, 'fieldGoalsMade-fieldGoalsAttempted', 1),
    threepointersattempted: (r) => readStat(r, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 1),
    '3ptattempted': (r) => readStat(r, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 1),
    freethrowsattempted: (r) => readStat(r, 'freeThrowsMade-freeThrowsAttempted', 1),
  },
  football: {
    passyards: (r) => readStat(r, 'passingYards'),
    passingyards: (r) => readStat(r, 'passingYards'),
    passtds: (r) => readStat(r, 'passingTouchdowns'),
    passingtds: (r) => readStat(r, 'passingTouchdowns'),
    passcompletions: (r) => readStat(r, 'completions/passingAttempts', 0),
    passattempts: (r) => readStat(r, 'completions/passingAttempts', 1),
    interceptionsthrown: (r) => readStat(r, 'interceptions'),
    rushyards: (r) => readStat(r, 'rushingYards'),
    rushingyards: (r) => readStat(r, 'rushingYards'),
    rushattempts: (r) => readStat(r, 'rushingAttempts'),
    rushtds: (r) => readStat(r, 'rushingTouchdowns'),
    receptions: (r) => readStat(r, 'receptions'),
    receivingyards: (r) => readStat(r, 'receivingYards'),
    recyards: (r) => readStat(r, 'receivingYards'),
    receivingtds: (r) => readStat(r, 'receivingTouchdowns'),
    rushrecyards: (r) => N(readStat(r, 'rushingYards')) + N(readStat(r, 'receivingYards')),
    rushingreceivingyards: (r) => N(readStat(r, 'rushingYards')) + N(readStat(r, 'receivingYards')),
    sacks: (r) => readStat(r, 'sacks'),
    tackles: (r) => readStat(r, 'totalTackles'),
  },
  hockey: {
    goals: (r) => readStat(r, 'goals'),
    assists: (r) => readStat(r, 'assists'),
    points: (r) => N(readStat(r, 'goals')) + N(readStat(r, 'assists')),
    shotsongoal: (r) => readStat(r, 'shotsTotal'),
    shots: (r) => readStat(r, 'shotsTotal'),
    goaliesaves: (r) => readStat(r, 'saves'),
    saves: (r) => readStat(r, 'saves'),
    blockedshots: (r) => readStat(r, 'blockedShots'),
  },
};

const sportOf = (league) => String(SLUGS[String(league).toLowerCase()] || '').split('/')[0] || null;

function resolveStat(league, stat) {
  const sport = sportOf(league);
  if (!sport) return null;
  const table = MAPS[sport];
  if (!table) return null;
  return table[normKey(stat)] || null;
}

// ---- one day's box scores, indexed by player --------------------------------
// Fetched once per league-day and cached: every pick for that slate is then a
// lookup rather than another round trip.
async function dayIndex(league, date) {
  const slug = SLUGS[String(league).toLowerCase()];
  if (!slug) return null;
  const ymd = String(date).replace(/-/g, '');
  // A settled slate never changes, so it caches for hours. A slate with games
  // still running gets a short TTL so the rest of them land promptly.
  const ttl = (d) => (d?.unfinished ? LIVE_TTL : DAY_TTL);
  return cached(`box-${league}-${date}`, ttl, async () => {
    const sb = await api(`${SITE}/${slug}/scoreboard?dates=${ymd}`);
    const all = (sb?.events || []).filter((e) => e?.id);
    // Only completed games. An in-progress game would otherwise be indexed with
    // its partial line and graded as final. Unfinished ones are simply left out,
    // so the pick stays pending and gets graded on a later pass.
    const events = all.filter(isFinished).map((e) => e.id);
    const unfinished = all.length - events.length;
    if (!events.length) return { players: {}, games: 0, unfinished };

    const players = {};
    await mapLimit(events, 4, async (id) => {
      const sum = await api(`${SITE}/${slug}/summary?event=${id}`);
      for (const team of sum?.boxscore?.players || []) {
        for (const group of team?.statistics || []) {
          const names = group.keys || group.labels || [];
          const index = {};
          names.forEach((k, i) => { index[k] = i; });
          for (const a of group.athletes || []) {
            const name = a?.athlete?.displayName || a?.athlete?.fullName;
            if (!name) continue;
            const key = normKey(name);
            // A player can appear in several groups (passing AND rushing). Merge
            // the indices so one lookup can read any of their stats.
            const prev = players[key];
            if (prev) {
              const offset = prev.stats.length;
              for (const k of names) if (!(k in prev.index)) prev.index[k] = offset + index[k];
              prev.stats = prev.stats.concat(a.stats || []);
            } else {
              players[key] = { name, index: { ...index }, stats: [...(a.stats || [])] };
            }
          }
        }
      }
    });
    return { players, games: events.length, unfinished };
  });
}

/**
 * Grade one non-MLB pick from ESPN's box score.
 * Same convention as every other grader: hit = actual > line, so callers flip
 * it for an under exactly as before. Returns null — never a guess — when the
 * stat isn't mapped, the league isn't covered, or the player didn't appear.
 */
export async function gradeFromEspn({ league, player, date, stat, line }) {
  if (!date || line == null) return null;
  const read = resolveStat(league, stat);
  if (!read) return null;

  // A game can be listed on the next day in ESPN's scoreboard for a late start,
  // same rollover the other graders allow for.
  const shift = (n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  for (const d of [date, shift(1), shift(-1)]) {
    const idx = await dayIndex(league, d);
    const row = idx?.players?.[normKey(player)];
    if (!row) continue;
    const value = read(row);
    if (value == null || !isFinite(Number(value))) continue;
    return { result: Number(value), hit: Number(value) > Number(line), source: 'espn' };
  }
  return null;
}

// ---- which ESPN keys the mapping actually depends on -------------------------
// Rather than eyeballing `keys` against the table by hand, run every mapper
// against a row whose index records the lookups. Each mapper then reports the
// exact key names it needs, and those can be diffed against what ESPN really
// returned. Combos read several keys, so this catches a stat that half-works.
export function keysNeeded(sport) {
  const table = MAPS[sport];
  if (!table) return {};
  const out = {};
  for (const [stat, fn] of Object.entries(table)) {
    const seen = [];
    const row = {
      stats: [],
      index: new Proxy({}, { get: (_t, k) => { if (typeof k === 'string') seen.push(k); return undefined; } }),
    };
    try { fn(row); } catch {}
    out[stat] = [...new Set(seen)];
  }
  return out;
}

// The most recent day this league actually played. ESPN accepts a date RANGE,
// so an offseason probe widens the window instead of returning nothing useful —
// asking an August scoreboard for NBA games is a calendar problem, not a bug.
async function latestGameDay(slug, from) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date(Date.parse(`${from}T00:00:00Z`));
  for (const back of [0, 45, 180, 400]) {
    const start = new Date(end.getTime() - back * 86400000);
    const range = back === 0 ? ymd(end) : `${ymd(start)}-${ymd(end)}`;
    const sb = await api(`${SITE}/${slug}/scoreboard?dates=${range}`);
    // Only games that have FINISHED. ESPN's scoreboard includes scheduled and
    // in-progress games, and the newest event on a range query is very often
    // tonight's tip-off — which carries no box score at all.
    const events = (sb?.events || []).filter((e) => e?.id && isFinished(e));
    if (!events.length) continue;
    events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const hit = events[0];
    return { id: hit.id, date: String(hit.date || '').slice(0, 10), searched: range, count: events.length };
  }
  return null;
}

export { resolveStat, dayIndex, SLUGS };

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    if (q.mode === 'probe') {
      // Raw stat KEYS a real game returns, which is the thing most likely to
      // differ from what the mapping above assumes.
      const league = String(q.league || 'nba').toLowerCase();
      const slug = SLUGS[league];
      if (!slug) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ error: `no ESPN slug for ${league}`, leagues: Object.keys(SLUGS) }) };

      const from = q.date || new Date().toISOString().slice(0, 10);
      const found = await latestGameDay(slug, from);
      if (!found) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          league, searchedBack: '400 days', games: 0,
          verdict: 'ESPN returned no games for this league in the last 400 days — that is a league/slug problem, not an offseason one',
        }, null, 2) };
      }

      const sum = await api(`${SITE}/${slug}/summary?event=${found.id}`);
      const groups = (sum?.boxscore?.players || []).flatMap((t) => (t.statistics || []).map((g) => ({
        group: g.name || g.type || null, keys: g.keys || null, labels: g.labels || null,
        sampleAthlete: g.athletes?.[0]?.athlete?.displayName || null,
        sampleStats: g.athletes?.[0]?.stats || null,
      })));

      // The actual check: every key the mapping reaches for, against every key
      // ESPN really sent. A mapped stat missing its key grades NOTHING, silently.
      const actual = new Set(groups.flatMap((g) => g.keys || g.labels || []));
      const needs = keysNeeded(sportOf(league));
      const broken = {}, working = [];
      for (const [stat, keys] of Object.entries(needs)) {
        const missing = keys.filter((k) => !actual.has(k));
        if (missing.length) broken[stat] = { missing, needs: keys };
        else working.push(stat);
      }
      const nBroken = Object.keys(broken).length;

      // An empty box score proves nothing about the mapping — every key looks
      // "missing" because there are no keys at all. Say that, rather than
      // reporting every mapped stat as broken and sending someone chasing it.
      if (!actual.size) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          league, gameUsed: { date: found.date, eventId: found.id },
          verdict: 'INCONCLUSIVE — ESPN served this game with no box score at all, so the mapping could not be checked. Most likely the game has not been played yet or was postponed.',
          nextStep: 'probe a date that is definitely in the past: /api/espn-grade?mode=probe&league=' + league + '&date=YYYY-MM-DD',
        }, null, 2) };
      }

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
        league,
        gameUsed: { date: found.date, eventId: found.id },
        ...(found.date !== from ? { note: `no finished games on ${from} — used the most recent completed slate instead` } : {}),
        verdict: nBroken === 0 ? `mapping verified against a real box score: all ${working.length} mapped stats resolve`
          : `${nBroken} of ${working.length + nBroken} mapped stats reference keys ESPN did not send — those grade NOTHING until fixed`,
        brokenStats: nBroken ? broken : undefined,
        verifiedStats: working,
        unmappedEspnKeys: [...actual].filter((k) => !Object.values(needs).flat().includes(k)),
        groups,
      }, null, 2) };
    }
    if (!q.player) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
        usage: '/api/espn-grade?league=nba&player=Some Player&date=2026-08-14&stat=Points&line=15.5',
        probe: '/api/espn-grade?mode=probe&league=nba&date=2026-08-14',
        leagues: Object.keys(SLUGS),
        mappedStats: Object.fromEntries(Object.entries(MAPS).map(([k, v]) => [k, Object.keys(v)])),
      }, null, 2) };
    }
    const out = await gradeFromEspn({ league: q.league, player: q.player, date: q.date, stat: q.stat, line: q.line });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ query: q, graded: out,
      note: out ? null : 'unresolvable — league not covered, stat not mapped, or the player did not appear' }, null, 2) };
  } catch (err) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

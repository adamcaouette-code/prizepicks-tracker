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

  // Soccer and tennis. PrizePicks posts these and nothing could grade them, so
  // every pick on them was logged and abandoned. ESPN covers both for free
  // under the same scoreboard/summary shape the rest of this file already uses.
  //
  // Soccer is per-competition on ESPN, so each competition needs its own slug.
  // The tags on the left are what leagueTagOf() produces from the PrizePicks
  // league NAME, which is why several spellings map to one slug.
  soccer: 'soccer/eng.1',
  epl: 'soccer/eng.1',
  premier_league: 'soccer/eng.1',
  eng_1: 'soccer/eng.1',
  ucl: 'soccer/uefa.champions',
  champions_league: 'soccer/uefa.champions',
  uefa_champions_league: 'soccer/uefa.champions',
  europa_league: 'soccer/uefa.europa',
  mls: 'soccer/usa.1',
  liga_mx: 'soccer/mex.1',
  la_liga: 'soccer/esp.1',
  laliga: 'soccer/esp.1',
  serie_a: 'soccer/ita.1',
  bundesliga: 'soccer/ger.1',
  ligue_1: 'soccer/fra.1',

  world_cup: 'soccer/fifa.world',
  fifa_world_cup: 'soccer/fifa.world',

  tennis: 'tennis/atp',
  atp: 'tennis/atp',
  wta: 'tennis/wta',
};

import { normKey, buildIndex, matchPlayer } from './player-match.js';
import { fantasyKind, basketballFantasy, nflFantasy } from './fantasy-score.js';
import { settle } from './grade-picks.js';   // one push rule, shared

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

// A combo stat built as N(a) + N(b) hides its own breakage: if ESPN stops
// sending `rebounds`, N(null) is 0 and Pts+Rebs+Asts quietly grades as Pts+Asts
// — a confident WRONG result, which is the one outcome worse than not grading.
//
// The fix needs to tell two cases apart:
//   key missing from the whole day's box score  -> the mapping is broken, refuse
//   key present that day but not on this row    -> the player genuinely had none
//                                                  of it (a RB with no catches),
//                                                  so it is a real zero
// dayIndex records the union of every key it saw, which makes that distinction
// available here.
function sum(row, keys) {
  let total = 0;
  for (const k of keys) {
    if (row.schema && !row.schema.has(k)) return null;   // never sent: refuse
    total += N(readStat(row, k));
  }
  return total;
}

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
    ptsrebsasts: (r) => sum(r, ['points', 'rebounds', 'assists']),
    pra: (r) => sum(r, ['points', 'rebounds', 'assists']),
    ptsrebs: (r) => sum(r, ['points', 'rebounds']),
    ptsasts: (r) => sum(r, ['points', 'assists']),
    rebsasts: (r) => sum(r, ['rebounds', 'assists']),
    blockedshots: (r) => readStat(r, 'blocks'),
    blksstls: (r) => sum(r, ['blocks', 'steals']),
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
    // Weighted formula, not a column. Every component must be present — a
    // missing turnover count would silently inflate the score.
    fantasyscore: (r) => (r.schema && ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers'].some((k) => !r.schema.has(k))
      ? null
      : basketballFantasy({
        points: readStat(r, 'points'), rebounds: readStat(r, 'rebounds'),
        assists: readStat(r, 'assists'), steals: readStat(r, 'steals'),
        blocks: readStat(r, 'blocks'), turnovers: readStat(r, 'turnovers'),
      })),
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
    rushrecyards: (r) => sum(r, ['rushingYards', 'receivingYards']),
    rushingreceivingyards: (r) => sum(r, ['rushingYards', 'receivingYards']),
    sacks: (r) => readStat(r, 'sacks'),
    tackles: (r) => readStat(r, 'totalTackles'),
    // Props PrizePicks posts that had no mapping and so never graded. An
    // unmapped stat is a guaranteed miss; a mapping against a key ESPN does not
    // send simply refuses (readStat returns null), and ?mode=probe names it.
    passrushyards: (r) => sum(r, ['passingYards', 'rushingYards']),
    passingrushingyards: (r) => sum(r, ['passingYards', 'rushingYards']),
    rushrectds: (r) => sum(r, ['rushingTouchdowns', 'receivingTouchdowns']),
    receivingtargets: (r) => readStat(r, 'receivingTargets'),
    targets: (r) => readStat(r, 'receivingTargets'),
    longestrush: (r) => readStat(r, 'longRushing'),
    longrush: (r) => readStat(r, 'longRushing'),
    longestreception: (r) => readStat(r, 'longReception'),
    longreception: (r) => readStat(r, 'longReception'),
    solotackles: (r) => readStat(r, 'soloTackles'),
    tacklesassists: (r) => readStat(r, 'totalTackles'),
    tacklesforloss: (r) => readStat(r, 'tacklesForLoss'),
    passesdefended: (r) => readStat(r, 'passesDefended'),
    fumbleslost: (r) => readStat(r, 'fumblesLost'),
    kickingpoints: (r) => readStat(r, 'totalKickingPoints'),
    fgmade: (r) => readStat(r, 'fieldGoalsMade/fieldGoalAttempts', 0),
    fieldgoalsmade: (r) => readStat(r, 'fieldGoalsMade/fieldGoalAttempts', 0),
    extrapointsmade: (r) => readStat(r, 'extraPointsMade/extraPointAttempts', 0),
    punts: (r) => readStat(r, 'punts'),
    // Full-PPR weighted formula from the published chart, not a column.
    fantasyscore: (r) => nflFantasy({
      passingYards: readStat(r, 'passingYards'), passingTouchdowns: readStat(r, 'passingTouchdowns'),
      interceptions: readStat(r, 'interceptions'),
      rushingYards: readStat(r, 'rushingYards'), rushingTouchdowns: readStat(r, 'rushingTouchdowns'),
      receptions: readStat(r, 'receptions'), receivingYards: readStat(r, 'receivingYards'),
      receivingTouchdowns: readStat(r, 'receivingTouchdowns'), fumblesLost: readStat(r, 'fumblesLost'),
    }),
  },
  // SHAPE UNVERIFIED. Written from ESPN's documented soccer/tennis summary
  // shape, never checked against a real response — exactly the position the
  // basketball map was in before a live probe corrected it. Run
  // ?mode=probe&league=epl (or =tennis) and fix whatever it reports; an entry
  // referencing a key ESPN does not send simply refuses, so a wrong guess here
  // costs a missing grade, never a false one.
  soccer: {
    goals: (r) => readStat(r, 'goals'),
    assists: (r) => readStat(r, 'assists'),
    goalsassists: (r) => sum(r, ['goals', 'assists']),
    shots: (r) => readStat(r, 'totalShots'),
    shotsontarget: (r) => readStat(r, 'shotsOnTarget'),
    shotsontgt: (r) => readStat(r, 'shotsOnTarget'),
    goaliesaves: (r) => readStat(r, 'saves'),
    saves: (r) => readStat(r, 'saves'),
    foulscommitted: (r) => readStat(r, 'foulsCommitted'),
    foulsdrawn: (r) => readStat(r, 'foulsSuffered'),
    tackles: (r) => readStat(r, 'totalTackles'),
    passesattempted: (r) => readStat(r, 'totalPasses'),
    offsides: (r) => readStat(r, 'offsides'),
  },
  // Tennis does NOT go through readStat/dayIndex's usual summary+boxscore path —
  // see the tennis branch inside dayIndex(). ESPN's tennis "event" is a whole
  // tournament, not a single match (matches live under event.groupings[].
  // competitions[]), and the summary?event= call the rest of this file relies on
  // 400s for tennis no matter which id is passed — confirmed live, not guessed;
  // ESPN builds that request as events/{id}/competitions/{id} internally, and a
  // tournament id and a match id are never the same value. So there is no
  // reachable per-match box score here, which means aces/double faults/break
  // points won have no source and are deliberately left OUT of this table —
  // leaving them mapped would make statResolves() report true and let item M's
  // filter wave them onto the board for something that can never grade, the
  // exact failure that filter exists to catch.
  //
  // Total games won IS reachable, with no extra call: the scoreboard response
  // already carries each competitor's set-by-set linescores. dayIndex derives
  // totalGamesWon by summing them and puts it straight on the row, so the
  // mapper here just reads that field — no readStat, no statistics array.
  tennis: {
    gameswon: (r) => (r.totalGamesWon != null ? r.totalGamesWon : null),
    totalgameswon: (r) => (r.totalGamesWon != null ? r.totalGamesWon : null),
  },
  hockey: {
    goals: (r) => readStat(r, 'goals'),
    assists: (r) => readStat(r, 'assists'),
    points: (r) => sum(r, ['goals', 'assists']),
    shotsongoal: (r) => readStat(r, 'shotsTotal'),
    shots: (r) => readStat(r, 'shotsTotal'),
    goaliesaves: (r) => readStat(r, 'saves'),
    saves: (r) => readStat(r, 'saves'),
    blockedshots: (r) => readStat(r, 'blockedShots'),
    hits: (r) => readStat(r, 'hits'),
    penaltyminutes: (r) => readStat(r, 'penaltyMinutes'),
    pim: (r) => readStat(r, 'penaltyMinutes'),
    powerplaypoints: (r) => readStat(r, 'powerPlayPoints'),
    faceoffswon: (r) => readStat(r, 'faceoffsWon'),
    timeonice: (r) => readStat(r, 'timeOnIce'),
    goalsagainst: (r) => readStat(r, 'goalsAgainst'),
    shotsagainst: (r) => readStat(r, 'shotsAgainst'),
    goalsassists: (r) => sum(r, ['goals', 'assists']),
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
  // Tennis: an "event" here is a whole tournament, and matches live under
  // event.groupings[].competitions[] — not event.competitions[] like every
  // team sport this function otherwise handles. There is also no working
  // summary?event= call to make (see the comment on MAPS.tennis), so this
  // reads player+linescores straight off the scoreboard response instead of
  // fetching a per-match box score at all.
  if (slug.startsWith('tennis/')) {
    return cached(`box-${league}-${date}`, ttl, async () => {
      const sb = await api(`${SITE}/${slug}/scoreboard?dates=${ymd}`);
      const players = {};
      let matches = 0, unfinished = 0;
      for (const ev of sb?.events || []) {
        for (const g of ev?.groupings || []) {
          for (const comp of g?.competitions || []) {
            const done = comp?.status?.type?.completed === true;
            if (!done) { unfinished++; continue; }
            matches++;
            for (const c of comp?.competitors || []) {
              const name = c?.athlete?.displayName || c?.athlete?.fullName;
              if (!name) continue;
              const total = (c.linescores || []).reduce((sum, s) => sum + N(s?.value), 0);
              players[normKey(name)] = { name, totalGamesWon: total };
            }
          }
        }
      }
      return { players, games: matches, unfinished };
    });
  }
  const idx = await cached(`box-${league}-${date}`, ttl, async () => {
    const sb = await api(`${SITE}/${slug}/scoreboard?dates=${ymd}`);
    const all = (sb?.events || []).filter((e) => e?.id);
    // Only completed games. An in-progress game would otherwise be indexed with
    // its partial line and graded as final. Unfinished ones are simply left out,
    // so the pick stays pending and gets graded on a later pass.
    const events = all.filter(isFinished).map((e) => e.id);
    const unfinished = all.length - events.length;
    if (!events.length) return { players: {}, games: 0, unfinished };

    const players = {};
    const allKeys = new Set();
    await mapLimit(events, 4, async (id) => {
      const sum = await api(`${SITE}/${slug}/summary?event=${id}`);
      for (const team of sum?.boxscore?.players || []) {
        for (const group of team?.statistics || []) {
          const names = group.keys || group.labels || [];
          const index = {};
          names.forEach((k, i) => { index[k] = i; });
          for (const k of names) allKeys.add(k);
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
    // Blobs serialise, so the schema is stored as an array and rehydrated below.
    return { players, games: events.length, unfinished, schema: [...allKeys] };
  });
  if (idx?.players && idx.schema) {
    const schema = new Set(idx.schema);
    for (const row of Object.values(idx.players)) row.schema = schema;
  }
  return idx;
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
    if (!idx?.players) continue;
    // Exact name first, then the safe widening steps — ESPN and PrizePicks
    // disagree about suffixes and short first names often enough that an
    // exact-only match drops a real share of otherwise gradeable picks.
    const m = matchPlayer(buildIndex(Object.values(idx.players).map((r) => [r.name, r])), player);
    if (!m) continue;
    const value = read(m.value);
    if (value == null || !isFinite(Number(value))) continue;
    return { ...settle(value, line), source: 'espn', matchedVia: m.how };
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

/**
 * The last N days this league actually played, before `before`.
 *
 * NFL plays three days a week, so walking back day by day would be ~35
 * scoreboard calls to reach five game days. One range query finds them instead.
 */
async function gameDaysBefore(slug, before, n, windowDays) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date(Date.parse(`${before}T00:00:00Z`) - 86400000);   // strictly BEFORE
  const start = new Date(end.getTime() - windowDays * 86400000);
  const sb = await api(`${SITE}/${slug}/scoreboard?dates=${ymd(start)}-${ymd(end)}`);
  const days = new Set();
  for (const ev of sb?.events || []) {
    if (!isFinished(ev)) continue;
    const d = String(ev.date || '').slice(0, 10);
    if (d) days.add(d);
  }
  return [...days].sort().reverse().slice(0, n);
}

/**
 * Recent form for ESPN leagues — the last N results for THIS exact stat.
 *
 * This closes the largest hole in the engine outside MLB. `recent5` is the
 * signal the judge weights most heavily, and the ONLY thing that ever supplied
 * it was attachHistory(), which reads api.prizepicks.com — the host behind
 * DataDome that answers 403 to everything. So every NFL, NBA, NHL and college
 * candidate has been judged with no recent form at all, silently, for as long as
 * that block has been up. It is very likely why probabilities cluster low.
 *
 * The fix needs no new data source. Grading already fetches a day's box scores
 * and already knows how to read any mapped stat out of them; form is the same
 * two operations pointed at earlier dates. That also means form is exactly as
 * correct as grading is — one mapping, one shape, verified once.
 *
 * `before` must be the slate date, so a re-run after kickoff cannot feed the
 * game's own result back in as "form".
 */
export async function attachEspnForm(candidates, league, { before, limit = 5, windowDays = 45 } = {}) {
  const slug = SLUGS[String(league || '').toLowerCase()];
  if (!slug || !candidates?.length || !before) return null;

  const days = await gameDaysBefore(slug, before, limit + 2, windowDays);
  if (!days.length) return null;

  // Oldest first, so each player's series reads chronologically.
  const indices = [];
  for (const d of [...days].reverse()) {
    const idx = await dayIndex(league, d);
    if (idx?.players && Object.keys(idx.players).length) indices.push(idx);
  }
  if (!indices.length) return null;

  let attached = 0;
  for (const c of candidates) {
    const read = resolveStat(league, c.stat);
    if (!read) continue;
    const values = [];
    for (const idx of indices) {
      const m = matchPlayer(buildIndex(Object.values(idx.players).map((r) => [r.name, r])), c.player);
      if (!m) continue;                       // did not play that day — not a zero
      const v = read(m.value);
      if (v == null || !isFinite(Number(v))) continue;
      values.push(Number(v));
    }
    if (!values.length) continue;
    const last = values.slice(-limit);
    c.last5 = last;
    c.avg = Math.round((last.reduce((a, b) => a + b, 0) / last.length) * 100) / 100;
    c.histGames = last.length;
    attached++;
  }
  return attached ? candidates : null;
}

// ---- who is not playing -----------------------------------------------------
// PrizePicks VOIDS a prop on a player who does not appear — it does not settle
// it at 0 — so a "win" on one pays nothing. MLB gets this from confirmed
// lineups; every ESPN league had no equivalent at all.
//
// It matters most in NFL. Inactives are declared 90 minutes before kickoff, a
// meaningful share of any week's board is on players who end up down, and the
// engine would happily rate one at 85% with nothing to say otherwise. This is
// the same failure that showed up in MLB as Kyle Tucker at 85% with "not in
// confirmed lineup" printed underneath.
//
// OUT and INJURY_STATUS_OUT are the only statuses treated as a void.
// QUESTIONABLE and DOUBTFUL are NOT: those players frequently play, and voiding
// them would silently delete half a Sunday board on a maybe.
const OUT_STATUS = /^(out|injury_status_out|ir|injured_reserve|suspension|pup|nfi|did_not_play)$/i;
const INJURY_TTL = 30 * 60 * 1000;   // inactives move on game day; keep it fresh

export async function espnInjuries(league) {
  const slug = SLUGS[String(league || '').toLowerCase()];
  if (!slug) return null;
  return cached(`injuries-${league}`, INJURY_TTL, async () => {
    const d = await api(`${SITE}/${slug}/injuries`);
    const out = {};   // normalised name -> { status, detail }
    for (const team of d?.injuries || []) {
      for (const it of team?.injuries || []) {
        const name = it?.athlete?.displayName || it?.athlete?.fullName;
        if (!name) continue;
        const status = String(it.status || it?.type?.name || '').replace(/\s+/g, '_');
        out[normKey(name)] = {
          name,
          status,
          out: OUT_STATUS.test(status),
          detail: it?.details?.type || it?.shortComment || null,
        };
      }
    }
    return out;
  });
}

/**
 * Mark candidates whose player ESPN lists as OUT. Returns how many.
 * Additive and defensive: if the endpoint gives nothing, nothing is voided —
 * an empty injury report must never read as "everyone is out".
 */
export async function markEspnVoids(candidates, league) {
  if (!candidates?.length) return { checked: 0, out: 0 };
  const inj = await espnInjuries(league);
  if (!inj || !Object.keys(inj).length) return { checked: 0, out: 0 };

  // Match names the same way grading does. A plain exact lookup missed
  // "Marvin Harrison" against ESPN's "Marvin Harrison Jr." — and in the NFL the
  // Jr./II/III suffix is everywhere, so an exact-only check would let a
  // meaningful share of ruled-out players straight through.
  //
  // The asymmetry favours matching loosely here. Voiding a player who turns out
  // to play only costs a pick; MISSING one who is out recommends a prop that
  // cannot win.
  const index = buildIndex(Object.values(inj).map((v) => [v.name, v]));

  let out = 0;
  for (const c of candidates) {
    if (/ \+ /.test(c.player || '')) continue;          // combo: no single player
    const hit = matchPlayer(index, c.player)?.value;
    if (!hit || !hit.out) continue;
    c.injured = hit.detail ? `${hit.status} (${hit.detail})` : hit.status;
    c.voidReason = `listed ${hit.status} — PrizePicks voids this, it does not settle at 0`;
    out++;
  }
  return { checked: Object.keys(inj).length, out };
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

      // Tennis doesn't take the summary?event= path this probe checks (see
      // dayIndex/MAPS.tennis), so a key diff against that endpoint would either
      // 400 or, since the tennis mappers need zero readStat keys, falsely report
      // "verified" without ever touching the real code path. Check dayIndex's
      // output directly instead.
      if (slug.startsWith('tennis/')) {
        const from = q.date || new Date().toISOString().slice(0, 10);
        const idx = await dayIndex(league, from);
        const sample = Object.values(idx?.players || {})[0] || null;
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          league, date: from, matchesFound: idx?.games ?? 0, unfinishedMatches: idx?.unfinished ?? 0,
          playersIndexed: Object.keys(idx?.players || {}).length,
          sampleRow: sample,
          verdict: sample ? 'dayIndex is reading players + totalGamesWon straight off the scoreboard — this is the actual grading path, not a summary/box-score key diff.'
            : 'no finished tennis matches indexed for this date — try ?date=YYYY-MM-DD for a day tennis definitely played',
          note: 'aces/doubleFaults/breakPointsWon have no reachable source and are not in MAPS.tennis on purpose — see the comment above it.',
        }, null, 2) };
      }

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

// netlify/functions/game-logs.js
//
// Ingest and cache ESPN per-game logs, in the shape projection.js consumes.
//
// One row per player per game: the stats, the opponent, home/away, rest days,
// and — the part that matters most — THE EXPOSURE TERM. Innings for a pitcher,
// plate appearances for a hitter, minutes for a footballer. Without it the
// projection is a per-game average with extra steps, because a per-game average
// cannot tell a striker who takes two shots in ninety minutes from one who
// takes two in twenty.
//
// ===========================================================================
// WHAT ESPN ACTUALLY RETURNS
//
// GET /apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog
//
//   names       ['innings','hits','runs','earnedRuns',...]   column keys
//   labels      ['IP','H','R','ER',...]                      column headers
//   seasonTypes[].categories[].events[]  { eventId, stats: ['6.0','3',...] }
//   events      { '401816843': { gameDate, atVs, opponent, team, ... } }
//
// The stats are a POSITIONAL ARRAY aligned to `names`, and the game metadata
// lives in a separate map keyed by event id. Neither half is usable alone, so
// zipping them is the first thing this module does.
//
// ---------------------------------------------------------------------------
// THE SOCCER PROBLEM, STATED UP FRONT
//
// ESPN'S SOCCER GAME LOG HAS NO MINUTES COLUMN. The labels are exactly
// G, A, SHOT, SOG, FC, FA, OF, YC, RC and nothing else — verified live against
// eng.1 on 2026-09-10. The match summary endpoint adds `starter`, `subbedIn`
// and `subbedOut` as BOOLEANS, with no minute attached (`subbedInFor` names the
// other player, not the clock).
//
// So soccer minutes are IMPUTED from appearance type. That is the single
// largest approximation in the projection stack, and it is deliberately
// confined to one table in projection-config.json
// (exposure.soccer_minutes_from_appearance) with a per-type standard deviation
// beside every figure, so the uncertainty travels with the number instead of
// being dropped at the door. Every row it touches is stamped
// `exposure_source: 'imputed:<type>'`, so a caller can always tell a measured
// exposure from a guessed one.
//
// Baseball needs no such fudge: innings and batters faced are in the log.
// ===========================================================================

import { getStore } from '@netlify/blobs';
import { SLUGS } from './espn-grade.js';

const COMMON = 'https://site.web.api.espn.com/apis/common/v3/sports';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

// A game log for a season in progress changes after every game; a finished
// match summary never changes again. Two different TTLs for two different
// facts, rather than one compromise that either serves stale logs or refetches
// settled history forever.
const LOG_TTL = Number(process.env.GAMELOG_TTL_MS) || 6 * 60 * 60 * 1000;
const SUMMARY_TTL = 30 * 24 * 60 * 60 * 1000;

const store = () => {
  try {
    return getStore({ name: 'game-logs', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  } catch { return null; }
};

async function api(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
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

// ESPN's GRADING map (SLUGS in espn-grade.js) deliberately has NO mlb entry:
// MLB is graded from MLB's own Stats API, so espn-grade never needed one, and
// adding it there would silently reroute every MLB grade through ESPN. Game
// logs carry no such constraint — ESPN serves baseball/mlb gamelogs perfectly
// well — so the missing slug is LAYERED OVER the shared map rather than copied
// from it. SLUGS still wins wherever it has an opinion, which is what keeps a
// league added there working here for free, and what stops this from becoming
// the second copy of a table (see one-source-of-truth.test.mjs).
const EXTRA_SLUGS = {
  mlb: 'baseball/mlb',
  baseball: 'baseball/mlb',
};

/** The ESPN sport/league path for one of this app's league tags. */
export function slugFor(league) {
  const k = String(league || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return SLUGS[k] || EXTRA_SLUGS[k] || null;
}
export const isSoccer = (slug) => String(slug || '').startsWith('soccer/');
export const isBaseball = (slug) => String(slug || '').startsWith('baseball/');

// ---------------------------------------------------------------------------
// Parsing

/**
 * Baseball innings are NOT decimal. "6.1" is six and one THIRD, "6.2" is six
 * and two thirds; there is no such thing as 6.5. Reading them as decimals
 * understates a pitcher's exposure by up to a third of an inning per start and
 * — worse — does it systematically, since the fractional endings are common.
 * That is a rate error of a couple of percent applied in one direction, which
 * is exactly the kind of bias a strikeout projection cannot absorb.
 */
export function parseInnings(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  const whole = Math.trunc(n);
  const frac = Math.round((n - whole) * 10);
  if (frac === 0) return whole;
  if (frac === 1) return whole + 1 / 3;
  if (frac === 2) return whole + 2 / 3;
  // Anything else is not baseball notation — take it at face value rather than
  // silently reinterpreting a number this function does not understand.
  return n;
}

const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '--') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
};

const dayOf = (iso) => String(iso || '').slice(0, 10);

/**
 * The exposure term for one row, chosen by what the log actually contains.
 *
 * Returns every candidate it can compute, plus `value` — the primary one for
 * this kind of log — because different markets on the same player scale by
 * different things. A strikeout rate is per inning; a hits-allowed rate is per
 * batter faced. Picking one and discarding the rest would force every market
 * through whichever guess this function made.
 */
export function exposureFrom(stats, slug) {
  const out = {};
  if (isBaseball(slug)) {
    const ip = parseInnings(stats.innings);
    if (ip != null) out.innings = ip;
    if (num(stats.battersFaced) != null) out.battersFaced = num(stats.battersFaced);
    if (num(stats.pitches) != null) out.pitches = num(stats.pitches);
    if (num(stats.atBats) != null) out.atBats = num(stats.atBats);
    // PA, not AB, is the honest denominator for a hitter: a walk is an
    // opportunity that produced no at-bat, and treating it as no opportunity
    // inflates the per-AB rate of a patient hitter.
    if (out.atBats != null) {
      const extras = (num(stats.walks) || 0) + (num(stats.hitByPitch) || 0)
        + (num(stats.sacFlies) || 0) + (num(stats.sacBunts) || 0);
      out.plateAppearances = out.atBats + extras;
    }
    out.value = out.innings ?? out.plateAppearances ?? out.atBats ?? null;
    return out;
  }
  // Basketball / hockey / anything else that ships a minutes column.
  const mins = num(stats.minutes);
  if (mins != null) { out.minutes = mins; out.value = mins; }
  return out;
}

/**
 * Turn one ESPN gamelog payload into rows.
 *
 * PURE — no network, no clock, no store. Everything network-shaped is one layer
 * up, which is what makes this testable against a captured payload.
 */
export function parseGameLog(json, { slug, seasonTypes = null } = {}) {
  const names = json?.names || [];
  const meta = json?.events || {};
  if (!names.length) return [];

  const rows = [];
  for (const st of json?.seasonTypes || []) {
    if (seasonTypes && !seasonTypes.some((s) => String(st.displayName || '').includes(s))) continue;
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const m = meta[ev.eventId] || {};
        const stats = {};
        (ev.stats || []).forEach((v, i) => { if (names[i]) stats[names[i]] = v; });

        const numeric = {};
        for (const [k, v] of Object.entries(stats)) {
          const n = k === 'innings' ? parseInnings(v) : num(v);
          if (n != null) numeric[k] = n;
        }

        rows.push({
          eventId: ev.eventId,
          date: dayOf(m.gameDate),
          gameDate: m.gameDate || null,
          slug,
          // ESPN marks the AWAY game with '@' and the home game with 'vs'.
          home: m.atVs ? m.atVs !== '@' : null,
          opponent: m.opponent
            ? { id: m.opponent.id, abbreviation: m.opponent.abbreviation, name: m.opponent.displayName }
            : null,
          team: m.team ? { id: m.team.id, abbreviation: m.team.abbreviation } : null,
          // The COMBINED score of the game, kept because it is the single best
          // observable proxy for pace and game script — the common factor that
          // makes two players in the same game move together at all. Without it
          // there is nothing to estimate a same-game-total effect against, and
          // the correlation model would have to assert one. See correlation.js.
          gameTotal: (num(m.homeTeamScore) != null && num(m.awayTeamScore) != null)
            ? num(m.homeTeamScore) + num(m.awayTeamScore) : null,
          teamScore: m.team && m.homeTeamId === m.team.id ? num(m.homeTeamScore) : num(m.awayTeamScore),
          raw: stats,
          stats: numeric,
          exposure: exposureFrom(numeric, slug),
          exposure_source: isSoccer(slug) ? 'unresolved' : 'espn',
          restDays: null,   // filled by withRestDays once the rows are ordered
        });
      }
    }
  }
  return withRestDays(rows);
}

/**
 * Rest days, from consecutive game dates.
 *
 * Sorted ascending first, because ESPN returns most-recent-first and a rest-day
 * computed off an unsorted list is negative half the time. The first row has no
 * predecessor and so has no rest days — null, not zero: "unknown" and "played
 * yesterday" are different facts and only one of them is true.
 */
export function withRestDays(rows) {
  const sorted = [...rows].filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let prev = null;
  for (const r of sorted) {
    r.restDays = prev ? Math.round((Date.parse(r.date) - Date.parse(prev)) / 86400000) : null;
    prev = r.date;
  }
  // Returned most-recent-first, which is how every other reader in this repo
  // expects a game log.
  return sorted.reverse();
}

// ---------------------------------------------------------------------------
// Soccer minutes

/** starter/subbedOut/subbedIn -> the appearance type the config prices. */
export function appearanceType({ starter, subbedIn, subbedOut, didNotPlay } = {}) {
  if (didNotPlay) return 'unused';
  if (starter) return subbedOut ? 'started_subbed' : 'started_finished';
  if (subbedIn) return 'came_on';
  return null;
}

/**
 * Impute minutes for one appearance type from the config table.
 *
 * Returns the sd alongside the mean, deliberately. The whole reason the
 * imputation is tolerable is that the uncertainty travels with it: a player who
 * started and finished has near-certain minutes, one who came off the bench has
 * very uncertain ones, and a downstream model that saw only the means would
 * treat those two as equally known.
 */
export function imputeMinutes(type, config = {}) {
  const table = config?.exposure?.soccer_minutes_from_appearance || {};
  if (!type || table[type] == null) {
    return { minutes: null, sd: null, type: type || 'unknown', reason: 'appearance type could not be determined from the match summary' };
  }
  return { minutes: table[type], sd: table.sd?.[type] ?? null, type };
}

/** One finished match's roster entry for a player. Cached forever-ish: it never changes. */
async function rosterEntry(slug, eventId, athleteId) {
  const data = await cached(`summary/${slug}/${eventId}`, SUMMARY_TTL, async () => {
    const json = await api(`${SITE}/${slug}/summary?event=${encodeURIComponent(eventId)}`);
    if (!json?.rosters) return null;
    // Store only what is needed. A full summary is ~1MB and this cache would
    // otherwise grow by that much per match for three booleans.
    const trimmed = [];
    for (const team of json.rosters) {
      for (const p of team.roster || []) {
        trimmed.push({
          id: String(p.athlete?.id ?? p.playerId ?? ''),
          starter: !!p.starter,
          subbedIn: !!p.subbedIn,
          subbedOut: !!p.subbedOut,
          didNotPlay: !!p.didNotPlay,
        });
      }
    }
    return trimmed;
  });
  return (data || []).find((p) => p.id === String(athleteId)) || null;
}

/**
 * Fill in soccer exposure, one match summary at a time.
 *
 * `limit` bounds the fan-out: the projection is recency-weighted with a 30-day
 * half-life, so a match from last season contributes almost nothing and is not
 * worth an HTTP request. Rows past the limit keep `exposure_source:
 * 'unresolved'` and are skipped by weightedRate rather than being filled with a
 * default — an invented ninety minutes on an unfetched match is precisely the
 * silently-wrong number the rest of this stack refuses.
 */
export async function attachSoccerMinutes(rows, { slug, athleteId, config = {}, limit = 12 } = {}) {
  let fetched = 0;
  for (const r of rows) {
    if (fetched >= limit) break;
    if (r.exposure?.minutes != null) continue;
    fetched++;
    const entry = await rosterEntry(slug, r.eventId, athleteId);
    if (!entry) { r.exposure_note = 'no roster entry in the match summary'; continue; }
    const type = appearanceType(entry);
    const { minutes, sd, reason } = imputeMinutes(type, config);
    if (minutes == null) { r.exposure_note = reason; continue; }
    r.exposure = { ...r.exposure, minutes, value: minutes };
    r.exposure_sd = sd;
    r.exposure_source = `imputed:${type}`;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The ingest entry point

/** The athlete's listed position, for choosing a positional prior. */
export async function fetchPosition(slug, athleteId) {
  const json = await cached(`athlete/${slug}/${athleteId}`, LOG_TTL, () => api(`${COMMON}/${slug}/athletes/${encodeURIComponent(athleteId)}`));
  const a = json?.athlete || json || {};
  return a?.position?.abbreviation || null;
}

/**
 * Fetch, cache and parse one player's game log.
 *
 * Returns `{ ok, rows, position, ... }` and never throws — a projection that
 * cannot be built is a missing projection, not a failed request, and this is
 * called from paths that are already handling half a board.
 */
export async function fetchGameLog({ league, athleteId, config = {}, soccerLimit = 12, includePosition = true }) {
  const slug = slugFor(league);
  if (!slug) return { ok: false, reason: `no ESPN league slug for "${league}"`, rows: [] };
  if (!athleteId) return { ok: false, reason: 'no ESPN athlete id', rows: [] };

  const json = await cached(`gamelog/${slug}/${athleteId}`, LOG_TTL,
    () => api(`${COMMON}/${slug}/athletes/${encodeURIComponent(athleteId)}/gamelog`));
  if (!json) return { ok: false, reason: 'ESPN returned no game log', rows: [] };

  const rows = parseGameLog(json, { slug });
  if (!rows.length) return { ok: false, reason: 'the game log parsed to zero rows', rows: [], columns: json?.names || [] };

  if (isSoccer(slug)) await attachSoccerMinutes(rows, { slug, athleteId, config, limit: soccerLimit });

  const position = includePosition ? await fetchPosition(slug, athleteId) : null;
  const resolved = rows.filter((r) => r.exposure?.value != null).length;

  return {
    ok: true,
    slug,
    league,
    athleteId: String(athleteId),
    position,
    rows,
    columns: json?.names || [],
    exposure_resolved: resolved,
    // Surfaced rather than buried: on soccer this is the fraction of the log
    // that carries an imputed exposure at all, and a low number means the
    // projection is running on far less history than the row count suggests.
    exposure_coverage: rows.length ? resolved / rows.length : 0,
  };
}

// netlify/functions/grade-audit.js
//
// READ-ONLY. Answers "what is stopping the rest from grading?" using only the
// pick log and the mappings — no network calls at all.
//
// grade-debug asks PrizePicks about each pick, which now just reports 403 for
// everything and tells you nothing you can act on. This asks a different and
// more useful question: for every ungraded pick, would the graders even TRY, and
// if not, exactly which name string is missing from which table?
//
// The output is meant to be actionable rather than diagnostic: every entry in
// `unmappedStats` is a stat name that can be added to a MAPS table verbatim, and
// every entry in `unroutedLeagues` is a league with no box-score source wired.
//
// Usage: /api/grade-audit                    last 14 days
//        /api/grade-audit?days=60            wider window
//        /api/grade-audit?date=2026-08-15    one day

import { getStore } from '@netlify/blobs';
import { resolveStat as espnStat, SLUGS as ESPN_LEAGUES } from './espn-grade.js';
import { resolveStat as mlbStat } from './mlb-grade.js';
import { gradersFor, isCombo } from './grade-picks.js';
import { fantasyKind } from './fantasy-score.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

/** Would any wired grader be able to resolve this pick's stat? */
export function statResolves(league, stat) {
  const lg = String(league || '').toLowerCase();
  // Fantasy Score never lived in the column tables — it routes through its own
  // weighted formula inside the graders. This audit only asked the column
  // tables, so it kept reporting Fantasy Score picks as "stat name not in the
  // mapping table" long after they were grading fine, and sent me looking for a
  // mapping that was never the problem.
  if (fantasyKind(lg, stat)) return true;
  if (lg === 'mlb') return !!mlbStat(stat);
  if (ESPN_LEAGUES[lg]) return !!espnStat(lg, stat);
  return false;
}

/**
 * Period and half boards ("NBA1H", "MLB 5 Innings") post props on a SEGMENT of a
 * game. A full-game box score cannot settle them at any point, so they are a
 * permanent refusal rather than a mapping gap — worth separating so they don't
 * look like something a new stat entry would fix.
 */
// The league tag arrives as "nba1h" — one token, no separator — so a \b before
// the marker never fires there. The tag is matched on its ending instead, and
// the stat text on whole words.
const PERIOD_TAG = /(1h|2h|1q|2q|3q|4q|1p|2p|3p|\d+innings?|firsthalf|secondhalf|sznlong)$/i;
const PERIOD_STAT = /\b(1h|2h|1q|2q|3q|4q|first half|second half|halftime|innings?)\b/i;

export const isPeriodProp = (p) =>
  PERIOD_TAG.test(String(p.league || '').replace(/[^a-z0-9]/gi, ''))
  || PERIOD_STAT.test(String(p.stat || ''));

export function auditPicks(picks) {
  const out = {
    total: picks.length,
    graded: 0, ungraded: 0,
    reasons: {},
    unmappedStats: {},      // "league :: stat" -> count
    unroutedLeagues: {},    // league -> count
    gradedBySource: {},
    matchedVia: {},
  };
  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

  for (const p of picks) {
    if (p.hit === true || p.hit === false) {
      out.graded++;
      bump(out.gradedBySource, p.gradedVia || 'prizepicks');
      bump(out.matchedVia, p.matchedVia || 'exact');
      continue;
    }
    out.ungraded++;

    const lg = String(p.league || 'unknown').toLowerCase();
    if (isCombo(p)) { bump(out.reasons, 'combo (expected — two players in one prop)'); continue; }
    if (isPeriodProp(p)) { bump(out.reasons, 'period/half prop (no full-game box score can settle it)'); continue; }

    const chain = gradersFor(lg);
    if (chain.every((s) => s === 'prizepicks')) {
      bump(out.reasons, 'league has no box-score source wired');
      bump(out.unroutedLeagues, lg);
      continue;
    }
    if (!statResolves(lg, p.stat)) {
      bump(out.reasons, 'stat name not in the mapping table');
      bump(out.unmappedStats, `${lg} :: ${p.stat}`);
      continue;
    }
    if (p.ungradeable) { bump(out.reasons, `marked ungradeable: ${p.ungradeable}`); continue; }
    if ((p.gradeAttempts || 0) >= 3) { bump(out.reasons, 'gave up after repeated attempts'); continue; }
    // Everything the audit can check offline is fine. What's left is a live
    // lookup that hasn't succeeded: the player wasn't found in the box score,
    // the game hasn't finished, or the grader simply hasn't run yet.
    bump(out.reasons, 'mapping is fine — player lookup or game not yet resolved');
  }

  const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  out.reasons = sortDesc(out.reasons);
  out.unmappedStats = sortDesc(out.unmappedStats);
  out.unroutedLeagues = sortDesc(out.unroutedLeagues);
  out.coverage = out.total ? out.graded / out.total : 0;
  return out;
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const days = Math.min(Number(q.days) || 14, 120);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

    let dates;
    if (q.date) dates = [q.date];
    else {
      try { dates = (await store.list()).blobs.map((b) => b.key).sort().slice(-days); }
      catch { dates = []; }
    }

    const all = [];
    const perDay = {};
    for (const d of dates) {
      let arr = [];
      try { arr = (await store.get(d, { type: 'json' })) || []; } catch { arr = []; }
      if (!arr.length) continue;
      all.push(...arr);
      const a = auditPicks(arr);
      perDay[d] = { total: a.total, graded: a.graded, coverage: Math.round(a.coverage * 1000) / 1000 };
    }

    const audit = auditPicks(all);

    // The headline: what would actually raise coverage, ranked by how many picks
    // each fix would unlock.
    const actions = [];
    const unmappedN = Object.values(audit.unmappedStats).reduce((a, b) => a + b, 0);
    const unroutedN = Object.values(audit.unroutedLeagues).reduce((a, b) => a + b, 0);
    if (unmappedN) actions.push({ picks: unmappedN, fix: 'add these stat names to the MAPS table in espn-grade.js / mlb-grade.js', detail: Object.keys(audit.unmappedStats).slice(0, 40) });
    if (unroutedN) actions.push({ picks: unroutedN, fix: 'no free box-score source is wired for these leagues', detail: Object.keys(audit.unroutedLeagues) });
    actions.sort((a, b) => b.picks - a.picks);

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      window: dates.length ? `${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)` : 'no data',
      coverage: `${(audit.coverage * 100).toFixed(1)}%`,
      ...audit,
      actions,
      perDay,
      note: 'Offline audit — no network calls. `unmappedStats` entries can be added to the mapping tables verbatim.',
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

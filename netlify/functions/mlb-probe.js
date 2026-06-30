// netlify/functions/mlb-probe.js
//
// THROWAWAY DIAGNOSTIC. Confirms exactly what ESPN's free MLB API gives us before
// we build the platoon / starting-pitcher layer, and how PrizePicks labels MLB
// players so we can map PP games -> ESPN games. Walks ESPN's nesting recursively
// so it reports the REAL field paths instead of assuming them.
//
// It answers four questions:
//   1) Are probable starting pitchers available per game? (team-keyed = no name match)
//   2) Can we get a pitcher's throwing hand + quality stats (ERA / WHIP / K)?
//   3) Is batter handedness (bats) exposed, and where?
//   4) How does PrizePicks label MLB players/teams/matchups?
//
// Usage:  https://atombets.netlify.app/api/mlb-probe   then delete this file.

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};
const PP_H = { ...H, Referer: 'https://app.prizepicks.com/' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { __error: `HTTP ${res.status}`, __url: url };
    return await res.json();
  } catch (e) {
    return { __error: String(e.message || e), __url: url };
  }
}

// First value whose key === name, searched recursively (circular-safe).
function firstByKey(obj, name, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  for (const v of Object.values(obj)) {
    const r = firstByKey(v, name, seen);
    if (r != null) return r;
  }
  return null;
}

const trim = (v, n = 600) => (v == null ? null : JSON.stringify(v).slice(0, n));

// Walk any stats payload and pull ERA / WHIP / strikeouts wherever they live.
function pluckPitcherStats(obj, found = {}, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return found;
  seen.add(obj);
  const label = String(obj.abbreviation || obj.name || obj.shortDisplayName || '').toLowerCase();
  const val = obj.displayValue ?? obj.value;
  if (label && val !== undefined) {
    if (label === 'era' && found.era === undefined) found.era = val;
    if (label === 'whip' && found.whip === undefined) found.whip = val;
    if ((label === 'k' || label === 'so' || label.includes('strikeout')) && found.strikeouts === undefined) found.strikeouts = val;
  }
  for (const v of Object.values(obj)) pluckPitcherStats(v, found, seen);
  return found;
}

export const handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const report = {};

  try {
    // ---- 1) ESPN scoreboard: today's games + probables ----
    const sb = await getJSON('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', H);
    const events = sb?.events || [];
    report.espnScoreboardError = sb?.__error || null;
    report.espnGamesToday = events.length;
    report.games = events.slice(0, 8).map((e) => {
      const comp = e.competitions?.[0] || {};
      const teams = (comp.competitors || []).map((c) => {
        const prob = (c.probables && c.probables[0]) || null;
        return {
          homeAway: c.homeAway,
          team: c.team?.displayName,
          abbr: c.team?.abbreviation,
          teamId: c.team?.id,
          probablePitcher: prob?.athlete
            ? { name: prob.athlete.displayName, id: prob.athlete.id }
            : (firstByKey(c, 'probables') ? 'present-but-nested-differently' : null),
        };
      });
      return { id: e.id, name: e.shortName || e.name, state: comp.status?.type?.state, teams };
    });

    // ---- summary for game[0]: dump the raw probables node so we see its shape ----
    if (events[0]) {
      const sum = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${events[0].id}`, H);
      const prob = firstByKey(sum, 'probables');
      report.summaryProbablesRaw = sum?.__error ? `summary ${sum.__error}` : (prob ? trim(prob, 900) : 'NO "probables" key found in summary');
    }

    // ---- find a pitcher id (from probables; else first roster pitcher) ----
    let pitcherId = null, pitcherName = null, handednessFromRoster = null;
    for (const g of report.games || []) {
      for (const t of g.teams || []) {
        if (t.probablePitcher && t.probablePitcher.id) { pitcherId = t.probablePitcher.id; pitcherName = t.probablePitcher.name; break; }
      }
      if (pitcherId) break;
    }
    if (!pitcherId && events[0]) {
      const tid = events[0].competitions?.[0]?.competitors?.[0]?.team?.id;
      const roster = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${tid}/roster`, H);
      report.rosterGroups = (roster?.athletes || []).map((a) => ({ group: a.position || a.displayName, count: (a.items || []).length }));
      const firstAth = roster?.athletes?.[0]?.items?.[0] || null;
      if (firstAth) {
        pitcherId = firstAth.id; pitcherName = firstAth.displayName;
        handednessFromRoster = { name: firstAth.displayName, position: firstAth.position?.abbreviation, bats: firstAth.bats, throws: firstAth.throws };
      }
    }
    report.rosterAthleteSample = handednessFromRoster;

    await sleep(200);

    // ---- 2 & 3) athlete detail (hand) + stats (ERA/WHIP/K) ----
    if (pitcherId) {
      const det = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${pitcherId}`, H);
      const ath = det?.athlete || det;
      report.athleteDetailSample = det?.__error ? `detail ${det.__error}` : {
        name: pitcherName,
        bats: trim(firstByKey(ath, 'bats'), 200),
        throws: trim(firstByKey(ath, 'throws'), 200),
        topLevelKeys: ath && typeof ath === 'object' ? Object.keys(ath).slice(0, 30) : null,
      };
      await sleep(200);
      const stats = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${pitcherId}/stats`, H);
      report.pitcherStats = stats?.__error ? `stats ${stats.__error}` : pluckPitcherStats(stats);
    }

    // ---- 4) PrizePicks MLB feed: player/team/matchup labeling ----
    const pp = await getJSON('https://partner-api.prizepicks.com/projections?per_page=30&single_stat=true&league_id=2&page=1', PP_H);
    report.ppFeedError = pp?.__error || null;
    const players = {};
    for (const i of pp?.included || []) if (i.type === 'new_player') players[i.id] = i.attributes || {};
    report.ppSample = (pp?.data || []).slice(0, 6).map((d) => {
      const a = d.attributes || {};
      const pa = players[d.relationships?.new_player?.data?.id] || {};
      return {
        player: pa.display_name || pa.name,
        position: pa.position,
        team: pa.team_name || pa.team,
        stat: a.stat_type,
        matchup: a.description || a.matchup || null,
      };
    });

    // ---- bottom-line verdict ----
    const probablesOK = (report.games || []).some((g) => (g.teams || []).some((t) => t.probablePitcher && t.probablePitcher.id))
      || (typeof report.summaryProbablesRaw === 'string' && report.summaryProbablesRaw.includes('athlete'));
    const handOK = !!((report.rosterAthleteSample && report.rosterAthleteSample.throws)
      || (report.athleteDetailSample && report.athleteDetailSample.throws && report.athleteDetailSample.throws !== 'null'));
    const statsOK = report.pitcherStats && typeof report.pitcherStats === 'object' && Object.keys(report.pitcherStats).length > 0;
    const ppOK = (report.ppSample || []).length > 0 && report.ppSample.every((p) => p.team && p.matchup);

    report.VERDICT = {
      probablePitchersAvailable: probablesOK,            // -> SP context with NO name matching
      handednessAvailable: handOK,                       // -> optional batter-hand polish
      pitcherStatsAvailable: statsOK,                    // -> pitcher quality (ERA/WHIP/K)
      ppGamesMappable: ppOK,                             // -> can map PP matchup -> ESPN game
      note: 'If probablePitchersAvailable + pitcherStatsAvailable are true, the clean build is the team-keyed SP package (no batter name matching needed).',
    };

    return { statusCode: 200, headers, body: JSON.stringify(report, null, 2) };
  } catch (err) {
    report.fatal = String(err.message || err);
    return { statusCode: 500, headers, body: JSON.stringify(report, null, 2) };
  }
};

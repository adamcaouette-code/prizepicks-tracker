// dk-lines-probe.js — one-time diagnostic. Deploy, hit the URL, paste me the JSON.
//
// Goal: verify the WHOLE chain attachBookLines() in judge-slip.js depends on, before
// trusting it against real slips:
//   1. team mapping  — does a PrizePicks team abbreviation ("LAD") resolve to an ESPN
//      full name ("Los Angeles Dodgers"), and does THAT name actually match what the
//      Odds API calls that team in home_team/away_team? This is free (no Odds credits)
//      and checked for every team in the league at once, not just one.
//   2. DK response shape — for one real event, does DraftKings actually carry the
//      markets we guessed, and do outcomes really key the player name under
//      "description" (assumed) rather than "name" or something else? Costs 1 Odds
//      API credit per market probed, same as the real code would pay.
//
// Usage after deploy:
//   /api/dk-lines-probe?league=mlb
//   /api/dk-lines-probe?league=nba&markets=player_points,player_rebounds
//   /api/dk-lines-probe?league=mlb&event=<eventId>&markets=batter_hits   (skip team mapping, force a specific event)
//
// Safe: read-only except for the Odds API credits noted above. Same ODDS_API_KEY
// as everything else in this repo; no other keys needed.

const PP_LEAGUE_IDS = { world_cup: '241', mlb: '2', wnba: '3', nba: '7', nfl: '9' };
const ODDS_SPORT_KEYS = {
  world_cup: 'soccer_fifa_world_cup', mlb: 'baseball_mlb', nba: 'basketball_nba',
  wnba: 'basketball_wnba', nfl: 'americanfootball_nfl',
};
const ESPN_SLUGS = {
  mlb: { sport: 'baseball', league: 'mlb' }, nba: { sport: 'basketball', league: 'nba' },
  wnba: { sport: 'basketball', league: 'wnba' }, nfl: { sport: 'football', league: 'nfl' },
};
const PP_TO_ESPN_ABBR = { CWS: 'CHW', AZ: 'ARI', WAS: 'WSH', SDP: 'SD', SFG: 'SF', TBR: 'TB', KCR: 'KC', WSN: 'WSH' };

const DEFAULT_MARKETS = {
  mlb: 'batter_hits,batter_total_bases,pitcher_strikeouts',
  nba: 'player_points,player_rebounds,player_points_rebounds_assists',
  wnba: 'player_points,player_rebounds,player_points_rebounds_assists',
  nfl: 'player_pass_yards,player_receptions,player_rush_yards',
};

async function getJSON(url, opts) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...(opts?.headers || {}) } });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* leave null, report raw below */ }
    return { ok: r.ok, status: r.status, remaining: r.headers.get('x-requests-remaining'), used: r.headers.get('x-requests-used'), data, raw: data ? undefined : text.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Trim a big JSON node down to its shape: keys, and for arrays a sample element.
function shape(node, depth = 0) {
  if (depth > 5 || node == null) return typeof node;
  if (Array.isArray(node)) return node.length ? [`(${node.length} items) sample:`, shape(node[0], depth + 1)] : [];
  if (typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node).slice(0, 40)) out[k] = shape(node[k], depth + 1);
    return out;
  }
  return node; // primitive: show the actual value
}

// same tree-walk as fetchTeamFullNames in bet-finder-background.js (duplicated here
// so this probe stays self-contained and safely deletable)
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

function findGameForName(fullName, games) {
  if (!fullName) return null;
  const fk = fullName.toLowerCase();
  return games.find((g) => {
    const h = (g.home || '').toLowerCase(), a = (g.away || '').toLowerCase();
    return h === fk || a === fk || h.includes(fk) || fk.includes(h) || a.includes(fk) || fk.includes(a);
  }) || null;
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  const q = event.queryStringParameters || {};
  const league = (q.league || 'mlb').toLowerCase();
  const sport = ODDS_SPORT_KEYS[league];
  if (!sport) return { statusCode: 400, headers, body: JSON.stringify({ error: `unknown league '${league}', try mlb|nba|wnba|nfl` }) };

  const key = process.env.ODDS_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ODDS_API_KEY not set' }) };

  const marketsCsv = q.markets || DEFAULT_MARKETS[league] || 'player_points';

  // ---- step 1: h2h game list — cheapest possible real data, 1 credit total regardless of team count ----
  const h2hUrl = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${key}`;
  const h2h = await getJSON(h2hUrl);
  const games = Array.isArray(h2h.data) ? h2h.data.map((g) => ({ id: g.id, home: g.home_team, away: g.away_team, commenceTime: g.commence_time })) : [];
  const gamesProbe = { ok: h2h.ok, status: h2h.status, remaining: h2h.remaining, used: h2h.used, gameCount: games.length, games: games.slice(0, 8), error: h2h.ok ? undefined : (h2h.raw || h2h.error) };

  // ---- step 2: team mapping — PP abbreviation -> ESPN full name -> Odds API game (all free) ----
  let teamMapping = null;
  let bestPick = null; // { abbr, game } for a team that resolved end-to-end, used to pick the event for step 3
  if (PP_LEAGUE_IDS[league] && ESPN_SLUGS[league]) {
    const ppUrl = `https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&league_id=${PP_LEAGUE_IDS[league]}&page=1`;
    const pp = await getJSON(ppUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://app.prizepicks.com/' } });
    const ppTeams = new Set();
    if (pp.data?.included) for (const i of pp.data.included) if (i.type === 'new_player' && i.attributes?.team) ppTeams.add(String(i.attributes.team).toUpperCase());

    const espnUrl = `https://site.api.espn.com/apis/v2/sports/${ESPN_SLUGS[league].sport}/${ESPN_SLUGS[league].league}/standings`;
    const espn = await getJSON(espnUrl);
    const fullNames = espn.ok && espn.data ? collectTeamNames(espn.data) : {};

    const rows = [];
    for (const abbr of ppTeams) {
      let full = fullNames[abbr.toLowerCase()];
      let viaAlias = false;
      if (!full && PP_TO_ESPN_ABBR[abbr]) { full = fullNames[PP_TO_ESPN_ABBR[abbr].toLowerCase()]; viaAlias = true; }
      const game = full ? findGameForName(full, games) : null;
      if (game && !bestPick) bestPick = { abbr, game };
      rows.push({ ppAbbr: abbr, resolvedEspnName: full || null, viaAlias, matchedGame: game ? `${game.away} @ ${game.home}` : null });
    }
    teamMapping = {
      ppTeamCount: ppTeams.size, espnTeamCount: Object.keys(fullNames).length,
      unresolvedAbbrs: rows.filter((r) => !r.resolvedEspnName).map((r) => r.ppAbbr),
      resolvedButNoGameToday: rows.filter((r) => r.resolvedEspnName && !r.matchedGame).map((r) => r.ppAbbr),
      fullyMatched: rows.filter((r) => r.matchedGame).length,
      rows,
    };
  }

  // ---- step 3: pick an event and probe DK's real player-prop shape ----
  let eventId = q.event || bestPick?.game?.id || games[0]?.id || null;
  if (!eventId) {
    return { statusCode: 200, headers, body: JSON.stringify({ probe: { league, sport, marketsCsv }, gamesProbe, teamMapping, playerPropsProbe: 'skipped — no event id available (no games on the board right now?)' }, null, 2) };
  }

  const propsUrl = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?regions=us&markets=${encodeURIComponent(marketsCsv)}&oddsFormat=american&bookmakers=draftkings&apiKey=${key}`;
  const props = await getJSON(propsUrl);

  let dkBook = null, firstMarket = null, firstOutcomes = null;
  if (props.ok && props.data) {
    dkBook = (props.data.bookmakers || []).find((b) => b.key === 'draftkings') || null;
    firstMarket = dkBook ? (dkBook.markets || [])[0] || null : null;
    firstOutcomes = firstMarket ? (firstMarket.outcomes || []).slice(0, 6) : null;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      probe: { league, sport, eventId, marketsCsv, eventChosenVia: q.event ? 'explicit ?event=' : bestPick ? `PP team ${bestPick.abbr} (fully resolved)` : 'fallback: first h2h game (no PP team resolved end-to-end — see teamMapping)' },
      gamesProbe,
      teamMapping,
      playerPropsProbe: {
        ok: props.ok, status: props.status, remaining: props.remaining, used: props.used,
        error: props.ok ? undefined : (props.raw || props.error),
        bookmakersReturned: props.data ? (props.data.bookmakers || []).map((b) => b.key) : [],
        draftKingsFound: !!dkBook,
        // this is the part that actually answers the question: does DK have this market
        // today, and what do its outcome objects really look like (name vs description,
        // point vs something else)?
        firstMarketKey: firstMarket ? firstMarket.key : '(none — DK may not offer any of the requested markets for this game right now)',
        sampleOutcomes: firstOutcomes,
        fullShape: props.data ? shape(props.data) : null,
      },
    }, null, 2),
  };
};

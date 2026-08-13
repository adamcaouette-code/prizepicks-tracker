// netlify/functions/pp-probe.js
//
// Diagnostic dump of what PrizePicks ACTUALLY returns, meant to be copied out of
// the dev console and pasted somewhere useful. The app derives a lot from PP's
// strings — stat names for the prop filter, league names for tags, odds_type for
// tiers, position for the trap gate — and every one of those is guesswork unless
// you can see the real values.
//
//   GET /api/pp-probe                     -> league catalog only (small)
//   GET /api/pp-probe?league=mlb          -> catalog + full breakdown of that league
//   GET /api/pp-probe?league=mlb&raw=5    -> also include 5 untouched projections
//
// Deliberately NOT cached: the point is to see the board as it is right now.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
  Referer: 'https://app.prizepicks.com/',
};

const MAX_PAGES = 12;

// This is a synchronous function, so Netlify kills it around 10s. Every retry and
// every extra page spends that budget — better to come back early with a partial
// histogram and say so than to be killed and return nothing at all.
const TIME_BUDGET_MS = 7000;

const tagOf = (name) =>
  String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// count occurrences -> sorted [value, n] pairs, so a histogram stays readable
const histogram = (values) => {
  const m = {};
  for (const v of values) {
    const k = v === '' || v == null ? '(empty)' : String(v);
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};

async function getJSON(url, stopAt = Infinity) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status !== 429) {
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      return res.json();
    }
    const ra = Number(res.headers?.get?.('retry-after'));
    const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(15000, ra * 1000)
      : Math.min(9000, 600 * 2 ** attempt) + Math.floor(Math.random() * 400);
    // Only sleep if the retry can still finish inside the budget.
    if (attempt >= 5 || Date.now() + waitMs > stopAt) throw new Error(`${url} -> 429 (rate limited)`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  const out = { fetchedAt: new Date().toISOString() };
  const stopAt = Date.now() + TIME_BUDGET_MS;

  try {
    // ---- 1. every league PrizePicks lists, with the tag this app derives from it ----
    const lg = await getJSON('https://partner-api.prizepicks.com/leagues?per_page=250', stopAt);
    out.leagues = (lg.data || []).map((d) => {
      const a = d.attributes || {};
      const name = a.name || a.display_name || '';
      return {
        id: String(d.id), name, appTag: tagOf(name),
        displayName: a.display_name ?? null,
        projections: a.projections_count ?? a.props_count ?? null,
        active: a.active ?? null,
        // These decide whether a league is a real per-game board or a derivative
        // (season futures, live, a half/quarter split) — they grade very differently.
        parentId: a.parent_id ?? null,
        parentName: a.parent_name ?? null,
        rank: a.rank ?? null,
        hasLive: a.has_live_projections ?? null,
        lastFiveGames: a.last_five_games_enabled ?? null,
        gameLines: a.game_lines ?? null,
      };
    }).sort((x, y) => (y.projections ?? -1) - (x.projections ?? -1));
    out.leagueAttributeKeys = Object.keys((lg.data || [])[0]?.attributes || {});

    const wanted = q.league ? tagOf(q.league) : null;
    if (!wanted) {
      out.note = 'Leagues only. Add ?league=mlb for that league\'s stat types, tiers, positions and sample rows.';
      return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
    }

    const match = out.leagues.find((l) => l.appTag === wanted);
    if (!match) {
      out.error = `No live league whose derived tag is '${wanted}'. See leagues[] above for what PrizePicks is posting.`;
      return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
    }

    // ---- 2. page the slate for that league, keeping the raw payload ----
    // A few pages is plenty to see the stat vocabulary, and PrizePicks throttles a
    // long page walk hard. Whatever a failed page costs us, we keep what we have —
    // reporting a partial histogram beats losing the whole run to one 429.
    const wantPages = Math.max(1, Math.min(MAX_PAGES, parseInt(q.pages, 10) || 3));
    const data = [], players = {};
    let pages = 0, pageError = null;
    for (let page = 1; page <= wantPages; page++) {
      if (Date.now() > stopAt) { pageError = `stopped at page ${page}: out of time budget`; break; }
      try {
        const full = await getJSON(`https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&league_id=${match.id}&page=${page}`, stopAt);
        pages = page;
        for (const i of full.included || []) if (i.type === 'new_player') players[i.id] = i.attributes || {};
        const d = full.data || [];
        data.push(...d);
        if (d.length < 250) break;
      } catch (e) {
        pageError = `stopped at page ${page}: ${String(e.message || e)}`;
        break;
      }
    }
    if (pageError) out.pagingWarning = `${pageError} — everything below is from the ${data.length} projections that did load.`;
    if (!data.length) {
      out.error = 'No projections loaded for this league. Wait a minute (PrizePicks throttles) and run it again.';
      return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
    }

    const attrs = data.map((d) => d.attributes || {});
    const playerOf = (d) => players[d.relationships?.new_player?.data?.id] || {};

    out.league = {
      requested: q.league, appTag: wanted, id: match.id, name: match.name,
      projectionsOnBoard: match.projections, projectionsSampled: data.length, pagesFetched: pages,
      parentName: match.parentName, hasLive: match.hasLive, lastFiveGames: match.lastFiveGames,
    };

    // ---- 3. the strings the app keys off, exactly as PrizePicks writes them ----
    out.statTypes = histogram(attrs.map((a) => a.stat_type)).map(([stat, count]) => ({ stat, count }));
    out.statDisplayNames_ifDifferent = histogram(
      attrs.filter((a) => a.stat_display_name && a.stat_display_name !== a.stat_type).map((a) => `${a.stat_type}  ->  ${a.stat_display_name}`)
    ).map(([pair, count]) => ({ pair, count }));
    out.oddsTypes = histogram(attrs.map((a) => a.odds_type)).map(([oddsType, count]) => ({ oddsType, count }));
    out.positions = histogram(data.map((d) => playerOf(d).position)).map(([position, count]) => ({ position, count }));

    // Which positions carry which stat — this is what the MLB pitcher/hitter trap
    // gate reasons about, and it's pure guesswork without real pairings.
    out.positionByStat = histogram(data.map((d) => `${playerOf(d).position || '(none)'} | ${d.attributes?.stat_type || ''}`))
      .slice(0, 40).map(([pair, count]) => ({ pair, count }));

    out.startTimeSamples = [...new Set(attrs.map((a) => a.start_time).filter(Boolean))].slice(0, 3);

    // ---- 4. untouched rows, so field names/shapes are visible rather than inferred ----
    const rawN = Math.max(0, Math.min(10, parseInt(q.raw, 10) || 0));
    out.projectionAttributeKeys = Object.keys(attrs[0] || {});
    out.playerAttributeKeys = Object.keys(players[Object.keys(players)[0]] || {});
    if (rawN) {
      out.rawSamples = data.slice(0, rawN).map((d) => ({
        id: d.id,
        type: d.type,
        attributes: d.attributes,
        player: playerOf(d),
      }));
    }

    return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
  } catch (err) {
    out.error = String(err.message || err);
    return { statusCode: 502, headers, body: JSON.stringify(out, null, 2) };
  }
};

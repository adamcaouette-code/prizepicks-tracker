// netlify/functions/bet-finder-background.js
//
// BACKGROUND FUNCTION (filename MUST end in -background.js -> up to 15 min runtime).
// It returns 202 instantly; the browser polls bet-finder-status.js for the result.
// Engine = JS port of bet_finder.py: pull props -> screen -> Claude judges -> size.
//
// Requires: npm install @netlify/blobs
// Env var:  ANTHROPIC_API_KEY  (set in Netlify, same place as ODDS_API_KEY)

import { getStore } from '@netlify/blobs';

const MODEL = 'claude-sonnet-4-6';
const PP_LEAGUE_IDS = { world_cup: '241', mlb: '2', wnba: '3', nba: '7', nfl: '9' };
const ODDS_PRIOR = { goblin: 0.62, standard: 0.55, demon: 0.45 };

// PrizePicks payout tables (typical — adjust if your region differs)
const POWER = { 2: 3.0, 3: 5.0, 4: 10.0, 5: 20.0, 6: 25.0 };
const FLEX = {
  3: { 3: 2.25, 2: 1.25 },
  4: { 4: 5.0, 3: 1.5 },
  5: { 5: 10.0, 4: 2.0, 3: 0.4 },
  6: { 6: 25.0, 5: 2.0, 4: 0.4 },
};

// ---------- data: pull + trim PrizePicks props (all pages) ----------
async function fetchProps(leagueTag) {
  const lid = PP_LEAGUE_IDS[leagueTag];
  if (!lid) throw new Error(`Unknown league '${leagueTag}'`);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
    Referer: 'https://app.prizepicks.com/',
  };

  // Page through the whole slate. One page (250) is often just the next game or
  // two; we want every game today, so we follow pagination to the end.
  const players = {};
  const allData = [];
  const MAX_PAGES = 12; // safety cap (~3000 props)
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&league_id=${lid}&page=${page}`;
    let res, tries = 0;
    while (true) {
      res = await fetch(url, { headers });
      if (res.status === 429 && tries < 4) {        // throttled — wait and retry
        tries++;
        await new Promise((r) => setTimeout(r, 1000 * tries));
        continue;
      }
      break;
    }
    if (!res.ok) {
      if (page === 1) throw new Error(`PrizePicks returned ${res.status}${res.status === 429 ? ' (rate limited — try again in a minute)' : ''}`);
      break; // a later page failing just ends pagination
    }
    const full = await res.json();
    for (const i of full.included || []) {
      if (i.type === 'new_player') players[i.id] = i.attributes || {};
    }
    const data = full.data || [];
    allData.push(...data);
    if (data.length < 250) break; // last page reached
  }

  return allData.map((d) => {
    const a = d.attributes || {};
    const pa = players[d.relationships?.new_player?.data?.id] || {};
    const team = pa.team || '';
    const opp = a.description || '';
    return {
      id: d.id,
      player: pa.display_name || pa.name || 'Unknown',
      stat: a.stat_type || a.stat_display_name || '',
      line: a.line_score,
      position: pa.position || '',
      image: pa.image_url || '',
      oddsType: (a.odds_type || 'standard').toLowerCase(),
      team: team || '(unknown)',
      opp: opp || '',
      matchup: team && opp ? [team, opp].sort().join(' vs ') : opp || team || '(unknown game)',
      game: team && opp ? `${team} vs ${opp}` : opp || team || '(unknown game)',
      start: a.start_time || '',
      league: leagueTag,
    };
  });
}

function filterToday(rows, todayOnly) {
  if (!todayOnly) return rows;
  const td = new Date().toISOString().slice(0, 10);
  return rows.filter((r) => String(r.start).startsWith(td));
}

// ---------- PrizePicks last-5 history (their own data, perfect name match) ----------
// One call per candidate: /projections/{id}/history -> last 5 stat_values for THAT prop.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(projectionId, attempt = 0) {
  const url = `https://api.prizepicks.com/projections/${projectionId}/history`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://app.prizepicks.com/',
      },
    });
    if (res.status === 429) {                       // throttled — back off and retry
      if (attempt >= 3) return null;
      await sleep(800 * (attempt + 1));
      return fetchHistory(projectionId, attempt + 1);
    }
    if (!res.ok) return null;
    const data = await res.json();
    const games = (data.games || []).map((g) => ({
      v: g.stat_value, opp: g.opponent_abbreviation, away: g.is_away,
    }));
    if (!games.length) return null;
    const values = games.map((g) => Number(g.v)).filter((v) => isFinite(v));
    if (!values.length) return null;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    return { last5: values, avg: Math.round(avg * 100) / 100, games };
  } catch {
    return null; // history is a bonus; never break the run
  }
}

// Attach history gently: small batches with a pause between, so we don't trip
// PrizePicks' rate limit (which can sink the whole run).
async function attachHistory(candidates, batchSize = 4, pauseMs = 400) {
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((c) => (c.id ? fetchHistory(c.id) : null)));
    results.forEach((h, j) => { if (h) { batch[j].last5 = h.last5; batch[j].avg = h.avg; batch[j].histGames = h.games; } });
    if (i + batchSize < candidates.length) await sleep(pauseMs);
  }
  return candidates;
}

// ---------- ESPN team records (free, no key). Stored now, not yet judged. ----------
const ESPN_SLUGS = {
  world_cup: { sport: 'soccer', league: 'fifa.world' },
  mlb: { sport: 'baseball', league: 'mlb' },
  nba: { sport: 'basketball', league: 'nba' },
  wnba: { sport: 'basketball', league: 'wnba' },
  nfl: { sport: 'football', league: 'nfl' },
};

function recordFromStats(stats, team) {
  let summary = null, w = null, l = null, d = null;
  for (const s of stats || []) {
    const nm = (s.name || s.type || '').toLowerCase();
    if ((s.type === 'total' || nm === 'overall' || nm === 'record') && s.summary) summary = s.summary;
    if (nm === 'wins') w = s.value;
    if (nm === 'losses') l = s.value;
    if (nm === 'ties' || nm === 'draws' || nm === 'draw') d = s.value;
  }
  if (summary) return summary;
  if (w != null && l != null) {
    const base = `${Math.round(w)}-${Math.round(l)}`;
    return d != null ? `${base}-${Math.round(d)}` : base;
  }
  if (team?.record?.items?.[0]?.summary) return team.record.items[0].summary;
  return null;
}

function parseStandings(data) {
  const map = {};
  const add = (names, rec) => { for (const n of names) if (n) map[String(n).toLowerCase()] = rec; };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.team && node.stats) {
      const t = node.team;
      const rec = recordFromStats(node.stats, t);
      if (rec) add([t.displayName, t.shortDisplayName, t.name, t.location, t.abbreviation, t.nickname], rec);
    }
    for (const k in node) visit(node[k]);
  };
  visit(data);
  return map;
}

async function fetchTeamRecords(leagueTag) {
  const slug = ESPN_SLUGS[leagueTag];
  if (!slug) return {};
  const url = `https://site.api.espn.com/apis/v2/sports/${slug.sport}/${slug.league}/standings`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    return parseStandings(await res.json());
  } catch {
    return {}; // records are a nice-to-have; never break the run
  }
}

// Map ESPN records onto the exact team strings PrizePicks uses.
function resolveRecords(rows, espnMap) {
  const out = {};
  const teams = [...new Set(rows.map((r) => r.team).filter((t) => t && t !== '(unknown)'))];
  for (const team of teams) {
    const key = team.toLowerCase();
    let rec = espnMap[key];
    if (!rec) {
      const hit = Object.keys(espnMap).find((k) => k.includes(key) || key.includes(k));
      if (hit) rec = espnMap[hit];
    }
    if (rec) out[team] = rec;
  }
  return out;
}

// ---------- win% via The Odds API. Degrades gracefully; reports WHY it failed. ----------
const ODDS_SPORT_KEYS = {
  world_cup: 'soccer_fifa_world_cup',
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  nfl: 'americanfootball_nfl',
};

function americanToProb(price) {
  const n = Number(price);
  if (!isFinite(n) || n === 0) return 0;
  return n > 0 ? 100 / (n + 100) : (-n) / ((-n) + 100);
}

// Returns { status, message, remaining, used, teamWinProbs }.
// status is one of: ok | capped | error | skipped. NEVER throws — the run goes on.
async function fetchWinProbs(leagueTag, rows) {
  const sport = ODDS_SPORT_KEYS[leagueTag];
  if (!sport) return { status: 'skipped', message: `No odds mapping for ${leagueTag}.`, teamWinProbs: {} };
  const key = process.env.ODDS_API_KEY;
  if (!key) return { status: 'error', message: 'ODDS_API_KEY is not set in Netlify — that\'s a config error, not the cap.', teamWinProbs: {} };

  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${key}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    return { status: 'error', message: `Couldn't reach the Odds API (network or code issue): ${e.message}`, teamWinProbs: {} };
  }

  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');

  // 429 = rate limit, 401 = bad key OR out of monthly credits — distinguish by body text
  if (res.status === 429) {
    return { status: 'capped', message: 'Odds API rate limit hit — wait a moment and try again.', remaining, used, teamWinProbs: {} };
  }
  if (res.status === 401) {
    let body = '';
    try { body = await res.text(); } catch {}
    const capLike = /quota|usage|credit|limit|exceed/i.test(body);
    return capLike
      ? { status: 'capped', message: 'Odds API monthly cap reached — win% is paused until your quota resets. (Not a bug.)', remaining, used, teamWinProbs: {} }
      : { status: 'error', message: 'Odds API rejected the key — check ODDS_API_KEY. (Config error, not the cap.)', remaining, used, teamWinProbs: {} };
  }
  if (!res.ok) {
    return { status: 'error', message: `Odds API returned an unexpected error (HTTP ${res.status}).`, remaining, used, teamWinProbs: {} };
  }

  let games;
  try { games = await res.json(); } catch {
    return { status: 'error', message: 'Odds API returned data we couldn\'t read.', remaining, used, teamWinProbs: {} };
  }

  // de-vig each game's moneyline into win probabilities, keyed by odds team name
  const oddsMap = {};
  for (const g of games || []) {
    const book = (g.bookmakers || [])[0];
    const h2h = book && (book.markets || []).find((m) => m.key === 'h2h');
    if (!h2h) continue;
    const implied = (h2h.outcomes || []).map((o) => ({ name: o.name, p: americanToProb(o.price) }));
    const sum = implied.reduce((s, o) => s + o.p, 0) || 1;
    for (const o of implied) {
      if (o.name && o.name.toLowerCase() !== 'draw') oddsMap[o.name.toLowerCase()] = o.p / sum;
    }
  }

  // resolve to the exact PP team strings
  const teamWinProbs = {};
  const teams = [...new Set((rows || []).map((r) => r.team).filter((t) => t && t !== '(unknown)'))];
  for (const team of teams) {
    const k = team.toLowerCase();
    let p = oddsMap[k];
    if (p == null) {
      const hit = Object.keys(oddsMap).find((n) => n.includes(k) || k.includes(n));
      if (hit) p = oddsMap[hit];
    }
    if (p != null) teamWinProbs[team] = Math.round(p * 100) / 100;
  }

  const found = Object.keys(teamWinProbs).length;
  return {
    status: 'ok',
    message: `Win% loaded for ${found} team(s).${remaining != null ? ` ${remaining} Odds API requests left this month.` : ''}`,
    remaining, used, teamWinProbs,
  };
}

// ---------- hard position gate: kill physically-wrong props pre-Claude ----------
// League-aware. Each sport has its own role/stat vocabulary; a league with no gate
// defined fails OPEN (everything passes) so we never invent traps for a sport we
// don't understand yet.

// ===== soccer =====
function roleOf(pos) {
  const p = (pos || '').toUpperCase();
  if (!p.replace(/[^A-Z]/g, '')) return 'UNK';
  if (p.includes('GOAL') || p.includes('KEEPER') || /\bGK?\b/.test(p)) return 'GK';
  if (p.includes('DEF') || /\b(CB|LB|RB|FB|WB|RWB|LWB|D)\b/.test(p)) return 'DEF';
  if (p.includes('MID') || /\b(CM|CDM|CAM|DM|AM|LM|RM|MF|M)\b/.test(p)) return 'MID';
  if (p.includes('FORWARD') || p.includes('STRIK') || p.includes('WING') ||
      /\b(ST|CF|LW|RW|FW|SS|W|F)\b/.test(p)) return 'FWD';
  return 'UNK';
}

function statKind(stat) {
  const s = (stat || '').toLowerCase();
  if (s.includes('save') || s.includes('goalie') || s.includes('goals allowed') ||
      s.includes('goals against')) return 'GK';
  if (s.includes('clearance') || s.includes('block') || s.includes('tackle') ||
      s.includes('interception')) return 'DEF';
  if (s.includes('shot') || s.includes('goal') || s.includes('assist') ||
      s.includes('cross') || s.includes('dribble') || s.includes('offside')) return 'ATK';
  return 'NEUTRAL';
}

// Conservative: only block UNAMBIGUOUS impossibilities. Unknown position or
// neutral stat (passes, fouls, fantasy score) always passes through.
function soccerAllows(pos, stat) {
  const role = roleOf(pos), kind = statKind(stat);
  if (role === 'UNK' || kind === 'NEUTRAL') return true;
  if (kind === 'GK') return role === 'GK';            // only keepers get saves
  if (role === 'GK' && kind === 'ATK') return false;  // keepers don't shoot/cross
  if (role === 'GK' && kind === 'DEF') return false;  // keeper clearance line = trap
  if (kind === 'DEF' && role === 'FWD') return false; // the attacker-clearances trap
  return true;
}

// ===== baseball (MLB) =====
// The one axis that creates impossible props is pitcher vs position-player.
function mlbRole(pos) {
  const p = (pos || '').toUpperCase();
  if (!p.replace(/[^A-Z0-9]/g, '')) return 'UNK';
  if (/\b(SP|RP|P)\b/.test(p) || p.includes('PITCH')) return 'PIT';
  if (/\b(C|1B|2B|3B|SS|LF|CF|RF|DH|OF|IF|UT|UTIL)\b/.test(p) ||
      p.includes('CATCH') || p.includes('INFIELD') || p.includes('OUTFIELD') ||
      p.includes('DESIGNATED') || p.includes('BASE') || p.includes('SHORT')) return 'BAT';
  return 'UNK';
}

function mlbStatKind(stat) {
  const s = (stat || '').toLowerCase();
  // explicit role-prefixed stats win (PP often labels "Hitter ..." / "Pitcher ...")
  if (s.includes('hitter') || s.includes('batter')) return 'HIT';
  if (s.includes('pitcher') || s.includes('pitching')) return 'PIT';
  // unambiguous pitching stats
  if (s.includes('earned run') || s.includes('hits allowed') || s.includes('walks allowed') ||
      s.includes('outs recorded') || s.includes('pitching out')) return 'PIT';
  // unambiguous hitting stats
  if (s.includes('total bases') || s.includes('rbi') || s.includes('stolen base') ||
      s.includes('home run') || s.includes('double') || s.includes('triple') ||
      s.includes('single') || s.includes('at bat') || s.includes('hits+runs') ||
      s.includes('hits + runs')) return 'HIT';
  // deliberately AMBIGUOUS -> NEUTRAL -> pass: bare "strikeouts", "hits", "runs",
  // "walks", "fantasy score" can belong to either side; never block on those.
  return 'NEUTRAL';
}

// Block ONLY the unambiguous trap: a pitching stat on a position player. A hitting
// stat on a pitcher PASSES on purpose — two-way players (Ohtani) are real, and PP
// almost never posts a truly impossible hitting line for a pitcher.
function mlbAllows(pos, stat) {
  const role = mlbRole(pos), kind = mlbStatKind(stat);
  if (role === 'UNK' || kind === 'NEUTRAL') return true;
  if (kind === 'PIT') return role === 'PIT';          // only pitchers record pitching stats
  return true;
}

// ===== dispatch =====
function positionAllows(pos, stat, league) {
  if (league === 'mlb') return mlbAllows(pos, stat);
  if (league === 'world_cup') return soccerAllows(pos, stat);
  return true; // no gate defined for this league yet -> fail open, never invent traps
}

// ---------- screen: keep selected tiers, spread across ALL games ----------
function findCandidates(rows, tiers, perGame = 4, maxTotal = 44) {
  const allow = new Set(tiers && tiers.length ? tiers : ['goblin', 'standard']);
  const byMatchup = {};
  for (const r of rows) {
    if (!allow.has(r.oddsType)) continue;
    if (!positionAllows(r.position, r.stat, r.league)) continue;  // hard trap gate
    (byMatchup[r.matchup] ||= []).push({ ...r, fairProb: ODDS_PRIOR[r.oddsType] ?? 0.55 });
  }
  const out = [];
  for (const m in byMatchup) {
    const top = byMatchup[m].sort((a, b) => b.fairProb - a.fairProb).slice(0, perGame);
    out.push(...top);                              // every matchup gets represented
  }
  return out.sort((a, b) => b.fairProb - a.fairProb).slice(0, maxTotal);
}

function groupByGame(items) {
  const g = {};
  for (const it of items) (g[it.matchup || it.game] ||= []).push(it);
  return g;
}

// ---------- judgment: Claude with web search ----------
const SYSTEM = `You are a sports-betting research assistant. You receive a SHORTLIST of
player props GROUPED BY GAME that already cleared a statistical filter. Each prop
includes the player's POSITION. Work game by game: for EACH game run ONE web search
for that matchup's confirmed lineup and team news, then apply it to every player in
that game. Do NOT search per player.

Judge every prop against the player's ROLE. A stat must fit the position, or the line
is a trap no matter how low it looks:
- Clearances, blocks, interceptions, tackles = DEFENDER / defensive-mid stats. An
  attacker or winger will rarely clear the threshold. Mark these PASS for attackers.
- Shots, shots on target, goals, goal+assist = forwards and attacking mids.
- Crosses, assists = wide players and creators.
- If a stat does not match the player's role, that alone is reason to PASS.

Also weight rotation/minutes risk heavily (dead rubbers, already-qualified teams
resting starters, blowout substitutions).

Judge every prop in the context of the OPPONENT, not the player alone. In your
per-game web search, assess how strong each side is, then adjust:
- A defender/defensive-mid facing a STRONG attacking team will be under heavy
  pressure all game, so defensive stats (clearances, blocks, tackles, interceptions)
  trend UP. A clearances line for a weak team's defender vs an elite side is often
  LIVE for this reason.
- An attacker facing a STRONG defense gets smothered, so shots/goals/assists trend
  DOWN. Be skeptical of attacking props against elite defenses.
- An attacker facing a WEAK defense gets more chances, so attacking stats trend UP.
- The same line can be a play or a pass depending purely on the opponent. State the
  opponent's strength in your reasoning when it drives the verdict.

When a prop includes "recent5" (the player's last 5 results for THIS exact stat) and
"recentAvg", anchor your probability on it — it's real production, not a guess. Compare
the line to the recent values: a line well below the player's typical output is more
likely to hit; a line above what they usually produce is a pass unless the matchup
strongly favors it. Note how many of the last 5 cleared the line. Recent form is your
strongest signal — weight it heavily, then adjust for opponent and rotation. If recent5
is absent, fall back to your own knowledge and search.

Some props are COMBO props — two players bundled into one line (names joined by "+",
stat ends in "(Combo)", flagged combo:true). Treat these with extra caution:
- There is NO recent5 for a combo — you cannot see either player's recent form, and you
  must NOT invent one. A combined line is inherently noisier than a single-player line.
- The total can be carried unevenly: one player may do most of the work while the other
  contributes little. You cannot see that split, so never assume both pull their weight.
- Both players must be CONFIRMED starters. If either is doubtful, rested, or benched,
  that alone is a PASS.
- Judge combos on confirmed lineups, role fit, and opponent only, and be conservative.
  Do not rate a combo "play" unless both are confirmed starting AND the line sits well
  within reach; when unsure, lean or pass.
- If the two players are in DIFFERENT games, you are stacking two independent
  uncertainties — default to PASS unless both halves are clearly strong on their own.

When a prop includes "teamWinPct" (the player's team's win probability) and/or
"teamRecord", use them to gauge the matchup:
- High teamWinPct (favored, e.g. 65%+) → that team likely controls the game. Their
  attackers get more chances (attacking stats up); the opponent's attackers get
  fewer (attacking stats down), while the underdog's defenders rack up defensive stats.
- Low teamWinPct (underdog) → flip it: their attackers are smothered, their defenders
  are under siege (clearances/blocks up).
- Treat these as confirmation/adjustment on top of recent form, not as overriding it.

Be strict with verdicts — "play" must mean you are GENUINELY CONFIDENT:
- play  = 62%+ and the stat clearly fits the player's role and matchup
- lean  = 54-61%, fits the role but with some real doubt
- pass  = below 54%, OR the stat does not fit the player's position, OR real
          rotation/minutes risk. When unsure, PASS. Do not inflate probabilities.

Give each prop a CALIBRATED probability (0-1) of going over. Respond with ONLY valid
JSON, no prose, no fences. key_risk = short flag (8 words max) or "none". reasoning =
1-2 sentences.
{"picks":[{"player":"","stat":"","line":0,"verdict":"play|lean|pass","prob":0.0,"key_risk":"","reasoning":""}]}`;

function extractBalanced(text) {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          const chunk = text.slice(start, i + 1);
          if (chunk.includes('"picks"')) return chunk;
          break;
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

function parsePicks(text) {
  if (!text) return [];
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  for (const c of [cleaned, extractBalanced(cleaned)]) {
    if (!c) continue;
    try {
      const data = JSON.parse(c);
      if (Array.isArray(data?.picks)) return data.picks;
      if (Array.isArray(data)) return data;
    } catch {}
  }
  return [];
}

async function judge(candidates, teamRecords = {}, winProbs = {}) {
  // Only send what Claude reasons with — not image, timestamps, league tags, ids.
  // Saves input tokens on every run; the full objects stay in our code.
  const slim = {};
  for (const c of candidates) {
    const key = c.matchup || c.game;
    const isCombo = / \+ /.test(c.player) || /combo/i.test(c.stat); // "A + B" or "... (Combo)"
    const entry = {
      player: c.player, stat: c.stat, line: c.line,
      position: c.position, team: c.team, opponent: c.opp,
    };
    if (isCombo) entry.combo = true;                                    // no per-player form exists
    if (c.last5) { entry.recent5 = c.last5; entry.recentAvg = c.avg; }  // last 5 for THIS stat
    if (teamRecords[c.team]) entry.teamRecord = teamRecords[c.team];     // e.g. "55-30"
    if (winProbs[c.team] != null) entry.teamWinPct = Math.round(winProbs[c.team] * 100); // favored?
    (slim[key] ||= []).push(entry);
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Shortlist grouped by game:\n' + JSON.stringify(slim, null, 2) }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const picks = parsePicks(text);
  // re-attach game by player+stat
  const lookup = {};
  for (const c of candidates) lookup[`${c.player}|${c.stat}`] = c;
  for (const p of picks) {
    const src = lookup[`${p.player}|${p.stat}`] || {};
    p.game ??= src.game || '(unknown game)';
    p.oddsType ??= src.oddsType || 'standard';     // so the board can show the tier
    p.team ??= src.team || '';                      // for team dropdowns
    p.matchup ??= src.matchup || src.game || '(unknown game)';
    p.position ??= src.position || '';
    p.image ??= src.image || '';                    // player headshot
    if (src.last5) { p.recent5 ??= src.last5; p.recentAvg ??= src.avg; } // last-5 for the UI
  }
  return picks;
}

// ---------- selection + sizing ----------
const clamp = (p) => Math.min(0.99, Math.max(0.01, Number(p)));

// Nest props under each player so the UI can show one player with a prop dropdown
function groupByPlayer(board) {
  const map = new Map();
  for (const p of board) {
    const key = `${p.matchup}|${p.team}|${p.player}`;
    if (!map.has(key)) {
      map.set(key, {
        player: p.player, team: p.team, matchup: p.matchup,
        image: p.image || '', position: p.position || '',
        inParlay: false, bestProb: 0, props: [],
      });
    }
    const g = map.get(key);
    g.props.push({
      stat: p.stat, line: p.line, verdict: p.verdict, prob: p.prob,
      oddsType: p.oddsType, key_risk: p.key_risk, reasoning: p.reasoning,
      recent5: p.recent5 || null, recentAvg: p.recentAvg ?? null,
      inParlay: !!p.inParlay,
    });
    if (p.inParlay) g.inParlay = true;
    if ((p.prob || 0) > g.bestProb) g.bestProb = p.prob || 0;
  }
  const arr = [...map.values()];
  for (const g of arr) g.props.sort((a, b) => (b.prob || 0) - (a.prob || 0));
  arr.sort((a, b) => (b.inParlay - a.inParlay) || (b.bestProb - a.bestProb));
  return arr;
}

function selectLegs(picks, n) {
  const ord = { play: 0, lean: 1 };
  const pool = picks
    .filter((p) => p.verdict === 'play' || p.verdict === 'lean')
    .sort((a, b) => clamp(b.prob) - clamp(a.prob) || (ord[a.verdict] ?? 9) - (ord[b.verdict] ?? 9));
  const seen = new Set();
  const chosen = [];
  for (const p of pool) {
    const who = (p.player || '').toLowerCase();
    if (seen.has(who)) continue;
    seen.add(who);
    chosen.push(p);
    if (chosen.length >= Math.max(2, Math.min(n, 6))) break;
  }
  return chosen;
}

function hitDistribution(probs) {
  let dist = [1.0];
  for (const p of probs) {
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}

function evPerDollar(probs, table) {
  const dist = hitDistribution(probs);
  let ev = 0;
  for (let k = 0; k < dist.length; k++) ev += dist[k] * (table[k] || 0);
  return ev;
}

function expectedLogGrowth(probs, table, f) {
  const dist = hitDistribution(probs);
  let g = 0;
  for (let k = 0; k < dist.length; k++) {
    const ret = 1 - f + f * (table[k] || 0);
    if (ret <= 0) return -Infinity;
    g += dist[k] * Math.log(ret);
  }
  return g;
}

function kellyFraction(probs, table, mult = 0.25) {
  let bestF = 0, bestG = 0;
  for (let f = 0; f <= 1.0001; f += 0.005) {
    const g = expectedLogGrowth(probs, table, f);
    if (g > bestG) { bestG = g; bestF = f; }
  }
  return bestF * mult;
}

function priceEntry(probs, table, bankroll, floor, maxStake, label) {
  const edge = evPerDollar(probs, table) - 1;
  if (edge <= 0) return { label, evPerDollar: edge, stake: 0, note: 'NO BET — non-positive EV' };
  const f = kellyFraction(probs, table);
  const spendable = Math.max(bankroll - floor, 0);
  let stake = f * bankroll;
  if (maxStake) stake = Math.min(stake, maxStake);
  stake = Math.min(stake, spendable);
  stake = Math.round(stake * 100) / 100;
  return { label, evPerDollar: Math.round(edge * 1000) / 1000, fraction: f, stake };
}

function sizeParlay(legs, { bankroll, floor, maxStake }) {
  const probs = legs.map((p) => clamp(p.prob));
  const n = probs.length;
  if (n < 2) return { error: `Only ${n} playable leg(s) — need 2+.` };
  if (n > 6) return { error: `${n} legs exceeds PrizePicks max of 6.` };
  const dist = hitDistribution(probs);
  const out = { legs, hitDistribution: dist, entries: {} };
  let best = null, bestG = -Infinity;
  for (const entry of ['power', 'flex']) {
    if (entry === 'flex' && n < 3) continue;
    const table = entry === 'power' ? { [n]: POWER[n] } : FLEX[n];
    const rec = priceEntry(probs, table, bankroll, floor, maxStake, entry.toUpperCase());
    rec.payouts = Object.entries(table)
      .map(([hits, m]) => ({ hits: Number(hits), pays: Math.round(rec.stake * m * 100) / 100 }))
      .sort((a, b) => b.hits - a.hits);
    out.entries[entry] = rec;
    if (rec.stake > 0) {
      const g = expectedLogGrowth(probs, table, rec.stake / bankroll);
      if (g > bestG) { bestG = g; best = entry.toUpperCase(); }
    }
  }
  out.recommended = best;
  return out;
}

// ---------- orchestration ----------
export const handler = async (event) => {
  let jobId;
  const store = getStore({
    name: 'bet-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

    const params = {
      league: body.league || 'world_cup',
      bankroll: Number(body.bankroll) || 0,
      floor: Number(body.floor) || 0,
      legs: Number(body.legs) || 3,
      today: body.today !== false,
      maxStake: body.maxStake ? Number(body.maxStake) : null,
      tiers: Array.isArray(body.tiers) && body.tiers.length ? body.tiers : ['goblin', 'standard'],
    };
    await store.setJSON(jobId, { status: 'running', step: 'pulling props' });

    let rows = await fetchProps(params.league);
    rows = filterToday(rows, params.today);
    const teamRecords = resolveRecords(rows, await fetchTeamRecords(params.league));
    const odds = await fetchWinProbs(params.league, rows);
    const candidates = findCandidates(rows, params.tiers);
    const traps = rows
      .filter((r) => !positionAllows(r.position, r.stat, r.league))
      .slice(0, 15)
      .map((r) => ({ player: r.player, stat: r.stat, line: r.line, position: r.position, matchup: r.matchup }));
    if (!candidates.length) {
      await store.setJSON(jobId, { status: 'done', result: { board: [], parlay: { error: 'No candidates — props not posted yet.' }, params } });
      return { statusCode: 202 };
    }

    await store.setJSON(jobId, { status: 'running', step: 'pulling recent form' });
    await attachHistory(candidates);

    await store.setJSON(jobId, { status: 'running', step: 'Claude researching lineups' });
    const picks = await judge(candidates, teamRecords, odds.teamWinProbs);
    if (!picks.length) throw new Error('Claude returned no parseable picks.');

    const chosen = selectLegs(picks, params.legs);
    const parlay = sizeParlay(chosen, params);     // bankroll defaults 0 -> $0 stakes
    const parlayLegs = chosen.map((p) => ({
      player: p.player, stat: p.stat, line: p.line, prob: p.prob,
      oddsType: p.oddsType, team: p.team, matchup: p.matchup,
    }));
    const board = picks.filter((p) => p.verdict === 'play' || p.verdict === 'lean');
    const chosenKeys = new Set(chosen.map((p) => `${p.player}|${p.stat}|${p.line}`));
    for (const p of board) p.inParlay = chosenKeys.has(`${p.player}|${p.stat}|${p.line}`);
    const players = groupByPlayer(board);

    // Log every pick for later auto-grading + calibration. Keyed by date so each
    // day is one record. Stores what we need to grade: projection id, line, the
    // probability Claude gave, verdict, tier — plus graded:null to fill in later.
    try {
      const logStore = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
      const day = new Date().toISOString().slice(0, 10);
      const stamp = new Date().toISOString();
      const idByKey = {};
      for (const c of candidates) idByKey[`${c.player}|${c.stat}`] = c.id;
      const logged = picks.map((p) => ({
        date: day, loggedAt: stamp, league: params.league,
        projectionId: idByKey[`${p.player}|${p.stat}`] || null,
        player: p.player, stat: p.stat, line: p.line,
        prob: p.prob, verdict: p.verdict, oddsType: p.oddsType,
        recentAvg: p.recentAvg ?? null,
        result: null, hit: null, gradedAt: null,   // filled by the grader later
      }));
      let existing = [];
      try { existing = (await logStore.get(day, { type: 'json' })) || []; } catch {}
      await logStore.setJSON(day, existing.concat(logged));
    } catch {
      // logging is best-effort — never let it break a run
    }

    await store.setJSON(jobId, { status: 'done', result: { board, players, parlay, parlayLegs, traps, teamRecords, winProbs: odds.teamWinProbs, oddsStatus: { status: odds.status, message: odds.message, remaining: odds.remaining, used: odds.used }, allPicks: picks, params } });
    return { statusCode: 202 };
  } catch (err) {
    if (jobId) await store.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    return { statusCode: 202 };
  }
};

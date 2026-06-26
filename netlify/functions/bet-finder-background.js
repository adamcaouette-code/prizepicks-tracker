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
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (page === 1) throw new Error(`PrizePicks returned ${res.status}`);
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
      player: pa.display_name || pa.name || 'Unknown',
      stat: a.stat_type || a.stat_display_name || '',
      line: a.line_score,
      position: pa.position || '',
      image: pa.image_url || '',
      oddsType: (a.odds_type || 'standard').toLowerCase(),
      team: team || '(unknown)',
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

// ---------- hard position gate: kill physically-wrong props pre-Claude ----------
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
function positionAllows(pos, stat) {
  const role = roleOf(pos), kind = statKind(stat);
  if (role === 'UNK' || kind === 'NEUTRAL') return true;
  if (kind === 'GK') return role === 'GK';            // only keepers get saves
  if (role === 'GK' && kind === 'ATK') return false;  // keepers don't shoot/cross
  if (role === 'GK' && kind === 'DEF') return false;  // keeper clearance line = trap
  if (kind === 'DEF' && role === 'FWD') return false; // the attacker-clearances trap
  return true;
}

// ---------- screen: keep selected tiers, spread across ALL games ----------
function findCandidates(rows, tiers, perGame = 4, maxTotal = 44) {
  const allow = new Set(tiers && tiers.length ? tiers : ['goblin', 'standard']);
  const byMatchup = {};
  for (const r of rows) {
    if (!allow.has(r.oddsType)) continue;
    if (!positionAllows(r.position, r.stat)) continue;  // hard trap gate
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

async function judge(candidates) {
  const payload = groupByGame(candidates);
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
      messages: [{ role: 'user', content: 'Shortlist grouped by game:\n' + JSON.stringify(payload, null, 2) }],
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
    const candidates = findCandidates(rows, params.tiers);
    const traps = rows
      .filter((r) => !positionAllows(r.position, r.stat))
      .slice(0, 15)
      .map((r) => ({ player: r.player, stat: r.stat, line: r.line, position: r.position, matchup: r.matchup }));
    if (!candidates.length) {
      await store.setJSON(jobId, { status: 'done', result: { board: [], parlay: { error: 'No candidates — props not posted yet.' }, params } });
      return { statusCode: 202 };
    }

    await store.setJSON(jobId, { status: 'running', step: 'Claude researching lineups' });
    const picks = await judge(candidates);
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

    await store.setJSON(jobId, { status: 'done', result: { board, players, parlay, parlayLegs, traps, allPicks: picks, params } });
    return { statusCode: 202 };
  } catch (err) {
    if (jobId) await store.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    return { statusCode: 202 };
  }
};

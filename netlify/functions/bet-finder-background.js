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

// ---------- data: pull + trim PrizePicks props ----------
async function fetchProps(leagueTag) {
  const lid = PP_LEAGUE_IDS[leagueTag];
  if (!lid) throw new Error(`Unknown league '${leagueTag}'`);
  const url = `https://partner-api.prizepicks.com/projections?per_page=250&single_stat=true&league_id=${lid}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
      Referer: 'https://app.prizepicks.com/',
    },
  });
  if (!res.ok) throw new Error(`PrizePicks returned ${res.status}`);
  const full = await res.json();
  const players = {};
  for (const i of full.included || []) {
    if (i.type === 'new_player') players[i.id] = i.attributes || {};
  }
  return (full.data || []).map((d) => {
    const a = d.attributes || {};
    const pa = players[d.relationships?.new_player?.data?.id] || {};
    const team = pa.team || '';
    const opp = a.description || '';
    return {
      player: pa.display_name || pa.name || 'Unknown',
      stat: a.stat_type || a.stat_display_name || '',
      line: a.line_score,
      oddsType: (a.odds_type || 'standard').toLowerCase(),
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

// ---------- screen: keep only the odds tiers the user asked for ----------
function findCandidates(rows, tiers, topN = 16) {
  const allow = new Set(tiers && tiers.length ? tiers : ['goblin', 'standard']);
  const out = [];
  for (const r of rows) {
    if (!allow.has(r.oddsType)) continue;          // tier picker controls the pool
    out.push({ ...r, fairProb: ODDS_PRIOR[r.oddsType] ?? 0.55 });
  }
  return out.sort((a, b) => b.fairProb - a.fairProb).slice(0, topN);
}

function groupByGame(items) {
  const g = {};
  for (const it of items) (g[it.game] ||= []).push(it);
  return g;
}

// ---------- judgment: Claude with web search ----------
const SYSTEM = `You are a sports-betting research assistant. You receive a SHORTLIST of
player props GROUPED BY GAME that already cleared a statistical filter. Work game by
game: for EACH game run ONE web search for that matchup's confirmed lineup and team
news, then apply it to every player in that game. Do NOT search per player. Weight
rotation/minutes risk heaviest (dead rubbers, already-qualified teams resting starters).
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
      max_tokens: 8000,
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
  }
  return picks;
}

// ---------- selection + sizing ----------
const clamp = (p) => Math.min(0.99, Math.max(0.01, Number(p)));

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
      bankroll: Number(body.bankroll) || 400,
      floor: Number(body.floor) || 100,
      legs: Number(body.legs) || 3,
      today: body.today !== false,
      maxStake: body.maxStake ? Number(body.maxStake) : null,
      tiers: Array.isArray(body.tiers) && body.tiers.length ? body.tiers : ['goblin', 'standard'],
    };
    await store.setJSON(jobId, { status: 'running', step: 'pulling props' });

    let rows = await fetchProps(params.league);
    rows = filterToday(rows, params.today);
    const candidates = findCandidates(rows, params.tiers);
    if (!candidates.length) {
      await store.setJSON(jobId, { status: 'done', result: { board: [], parlay: { error: 'No candidates — props not posted yet.' }, params } });
      return { statusCode: 202 };
    }

    await store.setJSON(jobId, { status: 'running', step: 'Claude researching lineups' });
    const picks = await judge(candidates);
    if (!picks.length) throw new Error('Claude returned no parseable picks.');

    const chosen = selectLegs(picks, params.legs);
    const parlay = sizeParlay(chosen, params);
    const board = picks.filter((p) => p.verdict === 'play' || p.verdict === 'lean');
    const chosenKeys = new Set(chosen.map((p) => `${p.player}|${p.stat}|${p.line}`));
    for (const p of board) p.inParlay = chosenKeys.has(`${p.player}|${p.stat}|${p.line}`);

    await store.setJSON(jobId, { status: 'done', result: { board, parlay, allPicks: picks, params } });
    return { statusCode: 202 };
  } catch (err) {
    if (jobId) await store.setJSON(jobId, { status: 'error', message: String(err.message || err) });
    return { statusCode: 202 };
  }
};

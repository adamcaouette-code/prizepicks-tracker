// netlify/functions/snapshot-background.js
//
// One capture of the board: every prop PrizePicks is posting, with the matching
// DraftKings and FanDuel line and price alongside it, archived as an immutable
// row. Driven by snapshot-cron.js (see netlify.toml for the schedule).
//
// POST /api/snapshot-background
//   { league?: "mlb", closing?: true, eventId?: "...", budget?: 120 }
//
// ---------------------------------------------------------------------------
// THE ODDS API BILL, WHICH IS THE REAL CONSTRAINT ON THIS FEATURE
//
// The PrizePicks half is free and unmetered, so capturing the board every ten
// minutes costs nothing. The book half is metered per market per event, and at
// the brief's cadence the arithmetic is brutal:
//
//   ~15 MLB events x ~6 distinct markets     =  ~90 credits per capture
//   x 144 captures a day                     =  ~13,000 a day
//   x 30                                     = ~390,000 a month
//
// That is not a free-tier number and it is not a cheap-tier number. So the
// capture is BUDGETED rather than uncapped, and the budget degrades in the one
// direction that keeps the archive honest:
//
//   - the PrizePicks side is always captured in full, every time. A row with a
//     PP line and null book fields is a true record of what was on the board.
//   - book lookups stop when the budget for the capture is spent. The rows
//     still get written; they carry `books: []` and `book_status` saying why.
//
// A closing capture (is_closing) gets its own, larger budget, because it is the
// one snapshot every CLV number in the ledger is measured against. Missing an
// intraday capture costs resolution; missing the close costs the metric.
//
// Set SNAPSHOT_ODDS_BUDGET=0 to archive PrizePicks only and spend nothing.

import {
  fetchProps, ODDS_SPORT_KEYS, PP_TO_ESPN_ABBR, fetchTeamFullNames, normKey, mlbRole,
} from './bet-finder-background.js';
import { marketFor } from './odds-markets.js';
import { appendCapture, hasClosing, AppendOnlyViolation } from './ledger-store.js';
import { fairForRows } from './fair-odds.js';
import BOOK_WEIGHTS from './book-weights.json' with { type: 'json' };

// Per-capture credit ceiling: markets x events actually requested.
const DEFAULT_BUDGET = Number(process.env.SNAPSHOT_ODDS_BUDGET ?? 60);
const CLOSING_BUDGET = Number(process.env.SNAPSHOT_CLOSING_BUDGET ?? 240);
const BOOKS = 'draftkings,fanduel';

// PrizePicks' payout for a tier, as a multiplier on a 3-pick Power play. Same
// table the rest of the app prices against — imported rather than retyped would
// be better still, but bet-finder-size.js keys by slip shape rather than by
// tier, so the per-tier multiplier is stated here with its derivation.
//   goblin 2.0x, standard 4.75x, demon 12.0x on a 3-pick Power.
export const TIER_MULTIPLIER = { goblin: 2.0, standard: 4.75, demon: 12.0 };

/**
 * Both books' line and two-way price for one prop.
 *
 * Returns an ARRAY, one entry per book that priced it, rather than a
 * dk/fd-shaped object: a third book is then a data change and not a schema
 * change, and the CLV consensus already treats books as a list.
 */
export function readBooks(bookmakers, marketKey, playerName) {
  const pk = normKey(playerName);
  const out = [];
  for (const b of bookmakers || []) {
    for (const m of b.markets || []) {
      if (m.key !== marketKey) continue;
      const sides = (m.outcomes || []).filter((o) => normKey(o.description || o.name) === pk);
      if (!sides.length) continue;
      const over = sides.find((o) => /over/i.test(o.name));
      const under = sides.find((o) => /under/i.test(o.name));
      out.push({
        book: b.key,
        line: over?.point ?? under?.point ?? null,
        over_price: over?.price ?? null,
        under_price: under?.price ?? null,
        last_update: m.last_update || b.last_update || null,
      });
    }
  }
  return out;
}

async function fetchEventOdds(sport, eventId, marketsCsv) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: 'no ODDS_API_KEY' };
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds`
    + `?regions=us&markets=${encodeURIComponent(marketsCsv)}&oddsFormat=american`
    + `&bookmakers=${BOOKS}&apiKey=${key}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      bookmakers: data.bookmakers || [],
      remaining: res.headers.get('x-requests-remaining'),
      used: res.headers.get('x-requests-used'),
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function fetchEvents(sport) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${key}`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/**
 * Shape one PrizePicks row into a snapshot row. Pure — no network, no clock —
 * so the schema can be tested without either.
 */
export function toSnapshotRow(prop, league) {
  const tier = String(prop.oddsType || 'standard').toLowerCase();
  return {
    league,
    player: prop.player,
    team: prop.team ?? null,
    opponent: prop.opp ?? null,
    market: prop.stat,
    // The market key the books use for this stat, resolved once here so the
    // archive records WHICH book market a row was compared against — not just
    // that a comparison happened. Null means no book publishes this prop.
    book_market: marketFor(league, prop.stat, league === 'mlb' ? mlbRole(prop.position) : null),
    position: prop.position ?? null,
    pp_line: Number(prop.line),
    pp_tier: tier,
    // The brief's "goblin/demon flag": kept as an explicit boolean beside the
    // tier so a consumer never has to know that "standard" is the absence of
    // both, and the payout it implies, since a tier without its multiplier is
    // not enough to price anything.
    is_goblin: tier === 'goblin',
    is_demon: tier === 'demon',
    pp_multiplier: TIER_MULTIPLIER[tier] ?? null,
    projection_id: prop.id ?? null,
    start_time: prop.start ?? null,
    books: [],
    book_status: 'not-attempted',
  };
}

export async function capture({
  league = 'mlb', closing = false, eventId = null, budget = null, onlyProps = null,
} = {}) {
  const capturedAt = new Date().toISOString();
  // A closing capture is handed the props for its own event, already filtered.
  // Re-fetching and re-filtering here would archive a close taken a few seconds
  // later than the one that decided the event was due.
  const props = onlyProps || await fetchProps(league);
  const rows = props.map((p) => toSnapshotRow(p, league));

  const spendCap = budget != null ? Number(budget) : (closing ? CLOSING_BUDGET : DEFAULT_BUDGET);
  const sport = ODDS_SPORT_KEYS[league];
  let spent = 0;
  let quota = { remaining: null, used: null };

  if (sport && spendCap > 0 && process.env.ODDS_API_KEY) {
    const events = await fetchEvents(sport);
    const fullNames = await fetchTeamFullNames(league).catch(() => ({}));
    const resolve = (abbr) => {
      if (!abbr) return null;
      let full = fullNames[String(abbr).toLowerCase()];
      if (!full) {
        const alias = PP_TO_ESPN_ABBR[String(abbr).toUpperCase()];
        if (alias) full = fullNames[alias.toLowerCase()];
      }
      if (!full) return null;
      const fk = full.toLowerCase();
      return events.find((g) => [g.home_team, g.away_team].some((t) => {
        const s = String(t || '').toLowerCase();
        return s === fk || s.includes(fk) || fk.includes(s);
      })) || null;
    };

    // Group by event so one request covers every prop in that game.
    const byEvent = new Map();
    for (const row of rows) {
      if (!row.book_market) { row.book_status = 'no-book-market-for-this-stat'; continue; }
      // Resolved from the team, ALWAYS — never from `eventId`. Those are two
      // different id spaces: `eventId` is the ledger's key for a close, built
      // from what PrizePicks tells us about the game, while the odds endpoint
      // wants The Odds API's own event id. Using one as the other would send a
      // PrizePicks matchup string to a URL that expects a uuid and 404 every
      // closing capture — the one capture that matters most.
      const ev = resolve(row.team);
      if (!ev) { row.book_status = 'no-matching-event'; continue; }
      if (!byEvent.has(ev.id)) byEvent.set(ev.id, { markets: new Set(), rows: [] });
      byEvent.get(ev.id).markets.add(row.book_market);
      byEvent.get(ev.id).rows.push(row);
    }

    for (const [evId, entry] of byEvent) {
      const cost = entry.markets.size;                 // billed per market per event
      if (spent + cost > spendCap) {
        for (const r of entry.rows) r.book_status = 'odds-budget-exhausted';
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const got = await fetchEventOdds(sport, evId, [...entry.markets].join(','));
      spent += cost;
      if (got.error) {
        for (const r of entry.rows) r.book_status = `odds-error: ${got.error}`;
        continue;
      }
      if (got.remaining != null) quota = { remaining: got.remaining, used: got.used };
      for (const r of entry.rows) {
        r.books = readBooks(got.bookmakers, r.book_market, r.player);
        r.book_status = r.books.length ? 'ok' : 'no-quote-for-this-player';
      }
    }
  } else {
    const why = !sport ? 'no odds sport key for this league'
      : !process.env.ODDS_API_KEY ? 'no ODDS_API_KEY'
        : 'odds budget is 0';
    for (const r of rows) r.book_status = why;
  }

  // FAIR PROBABILITY, COMPUTED AT CAPTURE TIME.
  //
  // It goes in the row rather than into a derived store beside it, because the
  // archive is append-only: a capture written now can never be amended later,
  // so anything that belongs to this instant has to be here when it is written.
  //
  // This is a CACHE of a pure function, not the source of truth. The raw book
  // prices are archived on the same row, so any other de-vig method — or a
  // corrected book-weight table — can be re-run against this exact instant
  // afterwards and will get an answer that is just as real. That is what makes
  // the computation reconstructible; the stored number only makes it fast.
  const priced = fairForRows(rows, { config: BOOK_WEIGHTS, side: 'over' });

  const meta = {
    league,
    fair_method: BOOK_WEIGHTS.default_method,
    fair_config_id: BOOK_WEIGHTS.id,
    fair_priced: priced.filter((r) => r.fair.prob != null).length,
    fair_disagreements: priced.filter((r) => r.fair.disagrees).length,
    odds_credits_spent: spent,
    odds_budget: spendCap,
    odds_quota_remaining: quota.remaining,
    priced: rows.filter((r) => r.books.length).length,
  };
  return appendCapture({ capturedAt, isClosing: closing, eventId, rows: priced, meta });
}

/**
 * The closing capture for every event whose scheduled start has just passed.
 *
 * WHY "JUST PASSED" AND NOT "IS ABOUT TO". The close is the last price before
 * the market goes off, so it has to be taken as late as possible. Firing early
 * would archive a line that still had minutes of movement left in it, and every
 * CLV number in the ledger is measured against this row — an early close does
 * not add noise, it adds a bias, and it points the same way every time.
 *
 * The window looks BACK from now by `windowMin`, so a start at 19:05 is caught
 * by the 19:10 cron. An event already closed is skipped by key: the store
 * refuses a second write to closing/<eventId>, and the first one — taken at
 * kickoff — is the one that survives.
 */
export async function captureDueClosings({ league = 'mlb', windowMin = 15, budget = null } = {}) {
  const now = Date.now();
  const props = await fetchProps(league);
  const byEvent = new Map();
  for (const p of props) {
    const start = Date.parse(p.start || '');
    if (!isFinite(start)) continue;
    if (start > now) continue;                       // hasn't started
    if (now - start > windowMin * 60000) continue;   // too old: a past close, or none was taken
    // Grouped by matchup+start, which is the identity PrizePicks gives us. The
    // Odds API event id is not on a projection row, so the close is keyed by
    // the game as PrizePicks describes it.
    const id = `${league}:${p.matchup || `${p.team}-${p.opp}`}:${String(p.start).slice(0, 16)}`;
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEvent.get(id).push(p);
  }

  const done = [];
  for (const [eventId, evProps] of byEvent) {
    // eslint-disable-next-line no-await-in-loop
    if (await hasClosing(eventId)) { done.push({ eventId, skipped: 'already closed' }); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await capture({
        league, closing: true, eventId, budget,
        onlyProps: evProps,
      });
      done.push({ eventId, rows: out.count, priced: out.meta.priced });
    } catch (err) {
      done.push({ eventId, error: String(err.message || err), duplicate: err instanceof AppendOnlyViolation });
    }
  }
  return { checked: byEvent.size, closed: done };
}

export const handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event?.body || '{}'); } catch { /* no body */ }
  try {
    if (body.mode === 'closing') {
      const out = await captureDueClosings(body);
      return { statusCode: 200, body: JSON.stringify(out) };
    }
    const out = await capture(body);
    return {
      statusCode: 200,
      body: JSON.stringify({
        captured_at: out.captured_at, is_closing: out.is_closing,
        rows: out.count, meta: out.meta,
      }),
    };
  } catch (err) {
    // A duplicate capture is not a crash — two cron firings in the same second,
    // or a hand-run retry. Reported distinctly so it can be told apart from a
    // real failure in the heartbeat.
    const dup = err instanceof AppendOnlyViolation;
    return {
      statusCode: dup ? 200 : 500,
      body: JSON.stringify({ error: String(err.message || err), duplicate: dup }),
    };
  }
};

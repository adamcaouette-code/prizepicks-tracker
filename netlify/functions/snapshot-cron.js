// netlify/functions/snapshot-cron.js
//
// The scheduled half of the line archive. Fires every 10 minutes; the schedule
// itself lives in netlify.toml, which is the only thing that registers one on a
// v1 (`export const handler`) function. An in-code `export const config` is
// inert here — see grade-cron.js for the two months that cost us.
//
// This shim exists for the same reason grade-cron.js does: a capture of the
// whole board plus two books can run past the ~10-26s sync timeout, and a
// function killed at that limit never reaches its own bookkeeping. So the work
// happens in `-background` (15 minutes) and this only pokes it.
//
// Each firing does two things:
//   1. the routine capture of the board
//   2. any CLOSING captures now due — events whose scheduled start has just
//      passed. At a 10-minute cadence with a 15-minute look-back, every event
//      gets exactly one close, and the store's key refuses a second.

import { heartbeat } from './snapshot-heartbeat.js';

const LEAGUES = () => String(process.env.SNAPSHOT_LEAGUES || 'mlb')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 4);

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://atombets.netlify.app';
  const post = async (body) => {
    try {
      const res = await fetch(`${base}/api/snapshot-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: res.status === 202 || res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  };

  const fired = [];
  for (const league of LEAGUES()) {
    fired.push({ league, kind: 'routine', ...(await post({ league })) });
    fired.push({ league, kind: 'closing', ...(await post({ league, mode: 'closing' })) });
  }

  // Written BEFORE anything can go wrong downstream, for the reason grade-cron
  // learned the hard way: without a record of the dispatch, "the schedule never
  // fired" and "the schedule fired and the work died" are the same observation.
  await heartbeat({ trigger: 'schedule', fired });
  return { statusCode: 200, body: JSON.stringify({ fired }) };
};

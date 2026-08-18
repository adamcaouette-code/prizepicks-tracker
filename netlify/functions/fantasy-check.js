// netlify/functions/fantasy-check.js
//
// Reads the last completed Fantasy Score weight check.
//
// The work itself runs in fantasy-check-background.js. It used to run here,
// synchronously, and it failed three times in a row against the ~10s a
// synchronous Netlify function gets — first as a blank page, then finishing
// 15 of 40, then 6 of 40. Each MLB pick needs a season game log for a distinct
// player, and there is no amount of concurrency tuning that makes a hundred of
// those fit in ten seconds. So it stops trying.
//
// WHAT THE CHECK IS FOR
// Fantasy Score is a weighted formula, not a box-score column, and 335 logged
// picks depend on getting the weights right. There is no external truth to check
// against, so the lines are used as evidence — with two corrections that the
// first live runs proved necessary:
//
//   TIER      Only standard-tier picks count. A goblin line is set BELOW the
//             median outcome by design and a demon above it, so mixing tiers
//             makes the median line meaningless.
//   BIAS      The log holds props the engine CHOSE, mostly overs it liked, so
//             outcomes beat lines even with perfect weights. Basketball, whose
//             weights are the standard DFS ones, is the control: its ratio is
//             that bias floor, and MLB is judged relative to it.
//
// Usage: /api/fantasy-check                    read the last result
//        /api/fantasy-check-background         run a fresh one

import { getStore } from '@netlify/blobs';
import { BASKETBALL_WEIGHTS, MLB_HITTER_WEIGHTS, MLB_PITCHER_WEIGHTS, MLB_VERIFIED } from './fantasy-score.js';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

export const RESULT_KEY = 'fantasy-check';

export const handler = async () => {
  try {
    const store = getStore({ name: 'run-stats', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let result = null;
    try { result = await store.get(RESULT_KEY, { type: 'json' }); } catch {}

    if (!result) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
        state: 'never run',
        next: 'Start one at /api/fantasy-check-background, wait about a minute, then reload this.',
        mlbCurrentlyEnabled: MLB_VERIFIED,
        weightsInUse: { basketball: BASKETBALL_WEIGHTS, mlbHitter: MLB_HITTER_WEIGHTS, mlbPitcher: MLB_PITCHER_WEIGHTS },
      }, null, 2) };
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      ...result,
      mlbCurrentlyEnabled: MLB_VERIFIED,
      weightsInUse: { basketball: BASKETBALL_WEIGHTS, mlbHitter: MLB_HITTER_WEIGHTS, mlbPitcher: MLB_PITCHER_WEIGHTS },
      howToEnable: 'If the MLB verdicts read near the control, set FANTASY_MLB_VERIFIED=1 in the Netlify environment and redeploy. If one reads TOO HIGH or TOO LOW, send this back and the weights get corrected before anything grades.',
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

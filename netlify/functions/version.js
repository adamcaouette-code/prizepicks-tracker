// netlify/functions/version.js
//
// The canonical version number, and the deploy-check endpoint.
//
// WHY THIS EXISTS
// "Did it deploy?" was costing real time. A new endpoint returning 404 has two
// very different causes that look identical from outside:
//   - the deploy never happened (or is still building)
//   - the deploy happened but the build FAILED, so Netlify kept the previous
//     deploy live — old endpoints keep working, new ones 404
// This endpoint answers it in one request. If /api/version reports the version
// you expect, functions deployed. If it reports an older one, the build did not
// land. If it 404s, functions are not deploying at all.
//
// VERSIONING — v MAJOR . MINOR . PATCH
//   MAJOR  major overhauls: a new subsystem, or a change in how the app works
//   MINOR  fine-tuning: refinements to existing behaviour, new mappings, tuning
//   PATCH  bug fixes
//
// This constant is the single source of truth. public/index.html shows the same
// string in its footer, and tests/unit/version.test.mjs fails if the two drift —
// otherwise the page and the functions can report different versions and the
// whole point of having a version is lost.
export const VERSION = '4.0.0';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  // Never cache this. A cached version string is worse than none: it would
  // report the old deploy as live and send you hunting for a problem that has
  // already been fixed.
  'Cache-Control': 'no-store, must-revalidate',
};

export const handler = async () => ({
  statusCode: 200,
  headers: HEADERS,
  body: JSON.stringify({
    version: VERSION,
    // Netlify injects these at build time. COMMIT_REF is the exact commit that
    // is live, which settles any "is my push deployed" question outright.
    commit: (process.env.COMMIT_REF || '').slice(0, 7) || null,
    branch: process.env.BRANCH || null,
    deployId: process.env.DEPLOY_ID || null,
    builtAt: process.env.DEPLOY_PRIME_URL ? undefined : null,
    // A quick inventory so a partial deploy is visible too: if a function you
    // expect is missing from a fresh deploy, the bundle did not include it.
    endpoints: [
      'version', 'grade-audit', 'fantasy-check', 'grade-picks', 'grade-slips',
      'grade-backfill-background', 'grade-backfill-status', 'fantasy-check-background', 'espn-grade',
      'mlb-grade', 'pp-403-probe', 'calibration', 'slips', 'grade-cleanup',
      'judge-prompts',
    ],
  }, null, 2),
});

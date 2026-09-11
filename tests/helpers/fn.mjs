// Loads a real Netlify function for testing.
//
// The functions import '@netlify/blobs' and reach for a Netlify runtime context
// that doesn't exist locally, so we rewrite that one import to the in-memory
// store before importing. Relative imports are rewritten to absolute paths
// because the rewritten copy lives in a temp dir, not in netlify/functions/.
//
// Nothing else is touched: the handler under test is the code that ships.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Forward slashes throughout. path.resolve/join hand back backslashes on Windows,
// and the sibling-import rewrite below matches FN_DIR with a literal "/" — so on
// Windows the redirect silently missed and every rewritten module pulled the
// REAL @netlify/blobs. Normalising here keeps the whole harness on one separator.
const FN_DIR = path.resolve(HERE, '../../netlify/functions').replace(/\\/g, '/');
const BLOBS = path.join(HERE, 'blobs.mjs').replace(/\\/g, '/');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atombets-fn-'));

// A path a rewritten module's `from '...'` / `import('...')` can actually load.
// Node's ESM loader rejects a bare `C:\...` specifier — it must be a file:// URL.
const asImportUrl = (p) => (/^[a-z]+:\/\//i.test(p) ? p : pathToFileURL(p).href);

let seq = 0;

/**
 * @param {string} name    file name inside netlify/functions, e.g. 'pp-stats.js'
 * @param {object} [opts]
 * @param {Array<[string|RegExp, string]>} [opts.replace]  extra source rewrites,
 *        for stubbing a sibling module the function imports.
 */
export async function loadFn(name, opts = {}) {
  // Unique prefix per load so repeated loads in one process aren't served from
  // Node's module cache — suites often load the same function under different stubs.
  const gen = String(seq++).padStart(3, '0');
  const written = new Map();

  // Rewrite the WHOLE import graph, not just the entry module.
  //
  // Only the entry used to be rewritten, so a sibling it imported was loaded
  // straight from netlify/functions with the REAL @netlify/blobs. Anything that
  // sibling wrote went to a store the test could not see, and the write silently
  // did nothing — invisible when the sibling is best-effort and swallows its own
  // failures, as judge-context is by design.
  //
  // ORDER MATTERS. Relative imports are resolved to their absolute FN_DIR paths
  // FIRST and `opts.replace` is applied to that, because suites write their stub
  // patterns against the absolute form (see fnPath). Only afterwards are the
  // imports still pointing at FN_DIR redirected to rewritten copies — so an
  // import a suite deliberately redirected to a stub is left exactly where the
  // suite put it.
  const rewrite = (fnName) => {
    if (written.has(fnName)) return written.get(fnName);
    const file = `${TMP.replace(/\\/g, '/')}/${gen}-${fnName.replace(/[^\w.]/g, '_')}.mjs`;
    const url = asImportUrl(file);
    written.set(fnName, url);                        // set before recursing: cycles

    let src = fs.readFileSync(path.join(FN_DIR, fnName), 'utf8');
    src = src.replace(/from ['"]@netlify\/blobs['"]/g, `from '${asImportUrl(BLOBS)}'`);
    src = src.replace(/from ['"]\.\/([^'"]+)['"]/g, (_m, rel) => `from '${FN_DIR}/${rel}'`);
    for (const [from, to] of opts.replace || []) src = src.replace(from, to);

    src = src.replace(new RegExp(`from '${FN_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^']+)'`, 'g'),
      (m, rel) => {
        const target = /\.(m?js)$/.test(rel) ? rel : `${rel}.js`;
        if (!fs.existsSync(path.join(FN_DIR, target))) return m;
        return `from '${rewrite(target)}'`;          // a file:// URL — see asImportUrl
      });

    // Anything still left as a bare absolute path — a suite's own stub file
    // passed through opts.replace, or a sibling `./x.json` import attribute that
    // was resolved to FN_DIR but not to a rewritten copy. Node's loader needs a
    // file:// URL for all of them on Windows.
    src = src.replace(
      /(\bfrom\s*['"]|\bimport\(\s*['"])((?:[A-Za-z]:[\\/]|\/)[^'"]+\.(?:[mc]?js|json))(['"])/g,
      (_m, a, p, b) => `${a}${asImportUrl(p.replace(/\\/g, '/'))}${b}`,
    );

    fs.writeFileSync(file, src);
    return url;
  };
  return import(rewrite(name));
}

/** Absolute path to a function file, for building `replace` rules. Forward
 *  slashes, matching how the sibling-import rewrite writes them into source. */
export const fnPath = (name) => `${FN_DIR}/${name}`;

/**
 * Swaps globalThis.fetch for a router keyed by URL substring. Each route is
 * `[matcher, handler]`; the handler returns the JSON body, or a full Response-ish
 * object if it needs to control status. Unmatched URLs 404 loudly so a test never
 * silently passes because a call went nowhere.
 * Returns a restore function and a live log of the calls made.
 */
export function mockFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, handler] of routes) {
      const hit = typeof match === 'string' ? u.includes(match) : match.test(u);
      if (!hit) continue;
      const out = await handler(u, init);
      if (out && typeof out === 'object' && 'status' in out && !('data' in out)) {
        return {
          ok: out.status < 400, status: out.status,
          headers: { get: (k) => (out.headers || {})[k] ?? null },
          json: async () => out.body, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
        };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => out, text: async () => JSON.stringify(out),
      };
    }
    return {
      ok: false, status: 404, headers: { get: () => null },
      json: async () => ({}), text: async () => `unmocked: ${u}`,
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

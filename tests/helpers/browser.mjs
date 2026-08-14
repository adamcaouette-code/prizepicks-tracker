// Browser plumbing for the UI suites.
//
// The app is one self-contained HTML file that talks to /api/* — so a UI test is
// "serve public/, stub every endpoint, drive the real page." Nothing here knows
// what any given test asserts; it just gets a page with the network under control.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

/** Serves public/ on an OS-assigned port. Returns { url, close }. */
export async function serveApp() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(PUBLIC, rel);
    // Never serve outside public/, even if a test asks for it by accident.
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

/**
 * Resolves Playwright's chromium however it happens to be installed here, and
 * the browser binary the environment ships. Returns null when Playwright isn't
 * available so the runner can SKIP the UI suites instead of reporting failures
 * that say nothing about the app.
 */
export async function getChromium() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  for (const spec of candidates) {
    try {
      const pw = require(spec);
      if (pw?.chromium) return pw.chromium;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Browser launch options, including the pre-installed binary when there is one. */
export function launchOptions() {
  const bundled = '/opt/pw-browsers/chromium';
  return fs.existsSync(bundled) ? { executablePath: bundled } : {};
}

/**
 * A page with every /api/* route stubbed, JS errors collected, and a phone-sized
 * viewport (this app is used on a phone).
 *
 * `routes` maps a URL glob to either a plain object (fulfilled as 200 JSON) or a
 * function receiving the Playwright route + request for full control.
 *
 * Any /api/* call the test did NOT stub is failed with a 599 and recorded, so an
 * endpoint rename shows up as an explicit unstubbed-call report rather than a
 * mysterious timeout.
 */
export async function openApp(browser, { url, routes = {}, viewport, timezoneId, locale, init } = {}) {
  const page = await browser.newPage({
    viewport: viewport || { width: 430, height: 930 },
    ...(timezoneId ? { timezoneId } : {}),
    ...(locale ? { locale } : {}),
  });
  const errors = [];
  const unstubbed = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // "Failed to load resource" is the browser's own report of a non-2xx response —
  // suites that deliberately stub an endpoint as dead would fail on it. The app's
  // handling of that failure is what the suites assert; real console.error calls
  // from app code still count.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text());
  });

  if (init) await page.addInitScript(init);

  // Playwright checks routes in REVERSE registration order, so the catch-all is
  // registered FIRST — every specific stub added after it takes precedence, and
  // only genuinely unstubbed calls fall through to the 599.
  await page.route('**/api/**', (route, request) => {
    unstubbed.push(new URL(request.url()).pathname);
    route.fulfill({ status: 599, contentType: 'application/json', body: '{"error":"unstubbed in test"}' });
  });
  for (const [glob, handler] of Object.entries(routes)) {
    await page.route(glob, async (route, request) => {
      if (typeof handler === 'function') return handler(route, request);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(handler) });
    });
  }

  await page.goto(url + '/index.html', { waitUntil: 'networkidle' });
  return { page, errors, unstubbed };
}

/** Freezes the page clock so date-dependent rendering is deterministic. */
export const freezeClock = (iso) => `{
  const RealDate = Date;
  const FIXED = new RealDate(${JSON.stringify(iso)}).getTime();
  class D extends RealDate {
    constructor(...a){ super(...(a.length ? a : [FIXED])); }
    static now(){ return FIXED; }
  }
  globalThis.Date = D;
}`;

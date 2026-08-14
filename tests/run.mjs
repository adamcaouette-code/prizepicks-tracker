#!/usr/bin/env node
// Test runner.  `npm test`
//
//   node tests/run.mjs             every suite
//   node tests/run.mjs gametime    only suites whose name contains "gametime"
//
// Boots one static server for the whole run and one browser shared across the UI
// suites (launching Chromium per suite dominated the runtime). Exits non-zero if
// anything failed, so it works as a pre-deploy gate.
//
// UI suites SKIP rather than fail when Playwright isn't installed — a missing
// test dependency is not a broken app, and pretending otherwise trains you to
// ignore red.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAsserter } from './helpers/assert.mjs';
import { serveApp, getChromium, launchOptions } from './helpers/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';

const suitesIn = (dir) => (fs.existsSync(path.join(HERE, dir))
  ? fs.readdirSync(path.join(HERE, dir)).filter((f) => f.endsWith('.test.mjs')).sort()
      .map((f) => ({ kind: dir, name: f.replace('.test.mjs', ''), file: path.join(HERE, dir, f) }))
  : []);

const all = [...suitesIn('unit'), ...suitesIn('ui')];
const suites = all.filter((s) => !filter || s.name.includes(filter));

if (!suites.length) {
  console.error(filter ? `No suite matches "${filter}". Have: ${all.map((s) => s.name).join(', ')}` : 'No suites found.');
  process.exit(1);
}

const results = [];
const skipped = [];
const crashed = [];
const startedAt = Date.now();

const needsBrowser = suites.some((s) => s.kind === 'ui');
const server = await serveApp();
let browser = null;
let chromium = null;

if (needsBrowser) {
  chromium = await getChromium();
  if (chromium) browser = await chromium.launch(launchOptions());
}

for (const suite of suites) {
  if (suite.kind === 'ui' && !browser) {
    skipped.push(`${suite.name} (Playwright not installed — run: npm i -D playwright)`);
    continue;
  }
  console.log(`\n[1m${suite.kind}/${suite.name}[0m`);
  const t = makeAsserter(suite.name, results);
  try {
    const mod = await import(suite.file);
    await mod.default({ t, url: server.url, browser, chromium });
  } catch (err) {
    crashed.push({ suite: suite.name, err });
    // A crash is a failure, not a silent gap — count it so the exit code is right.
    results.push({ suite: suite.name, label: 'suite threw', pass: false });
    console.log(`  [31mFAIL  suite threw: ${err && err.message ? err.message.split('\n')[0] : err}[0m`);
  }
}

if (browser) await browser.close();
await server.close();

const failed = results.filter((r) => !r.pass);
const secs = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${results.length - failed.length}/${results.length} assertions passed across ${suites.length - skipped.length} suites in ${secs}s`);
for (const s of skipped) console.log(`[33mSKIP[0m  ${s}`);
if (failed.length) {
  console.log(`\n[31m${failed.length} failing:[0m`);
  for (const f of failed) console.log(`  ${f.suite} — ${f.label}`);
}
for (const c of crashed) {
  console.log(`\n[31m${c.suite} stack:[0m\n${c.err && c.err.stack ? c.err.stack : c.err}`);
}
process.exit(failed.length ? 1 : 0);

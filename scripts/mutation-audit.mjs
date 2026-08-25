#!/usr/bin/env node
// Mutation audit.  `node scripts/mutation-audit.mjs [id-substring]`
//
// WHY THIS EXISTS
// A passing suite proves the code ran. It does not prove the suite would have
// noticed if the code were wrong. The two came apart badly once already: loadFn
// rewrote only the entry module's imports, so a sibling loaded the real
// @netlify/blobs and everything it wrote went to a store the test could not
// read. The write silently did nothing, the sibling swallowed its own failure by
// design, and the suite passed while verifying nothing at all.
//
// The only way to tell a load-bearing assertion from a decorative one is to
// break the code on purpose and check that the suite goes red. A mutation the
// suite SURVIVES is a hole: that behaviour is not covered, whatever the labels
// say.
//
// Each entry names the file, an exact source substring, its replacement, and the
// suite that claims to cover it. The harness applies one mutation at a time,
// runs that suite alone, restores the file, and reports killed/survived.
//
// The `from` strings are exact and will rot as the code changes. That is the
// intended failure mode — a mutation that no longer applies is reported as
// STALE rather than silently counted as killed, because a mutation that cannot
// be applied proves nothing.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './mutations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const list = MUTATIONS.filter((m) => !filter || m.id.includes(filter) || m.suite.includes(filter));

const results = [];
for (const m of list) {
  const file = path.join(ROOT, m.file);
  const original = fs.readFileSync(file, 'utf8');
  const occurrences = original.split(m.from).length - 1;
  if (occurrences !== 1) {
    results.push({ ...m, verdict: 'STALE', note: `${occurrences} matches, need exactly 1` });
    console.log(`STALE     ${m.id}`);
    continue;
  }
  fs.writeFileSync(file, original.replace(m.from, m.to));
  let killed = false, detail = '', caught = [];
  try {
    execFileSync('node', ['tests/run.mjs', m.suite], { cwd: ROOT, stdio: 'pipe', timeout: 300000 });
  } catch (err) {
    killed = true;
    // Strip the runner's colour codes before parsing, and collect EVERY
    // assertion that went red — not just the first. The union of these across
    // all mutations is the set of assertions this audit proved load-bearing.
    const out = (String(err.stdout || '') + String(err.stderr || '')).replace(/\u001b\[[0-9;]*m/g, '');
    let suite = m.suite;
    for (const line of out.split('\n')) {
      const head = line.match(/^(unit|ui)\/(\S+)$/);
      if (head) { suite = head[2]; continue; }
      const fail = line.match(/^\s*FAIL\s\s(.*)$/);
      if (fail) caught.push(`${suite} :: ${fail[1].split(' — ')[0].trim()}`);
    }
    detail = (out.match(/^\s*FAIL.*$/m) || [''])[0].trim().slice(0, 90);
  } finally {
    fs.writeFileSync(file, original);
  }
  // An EQUIVALENT mutant changes the source without changing behaviour, so no
  // suite can kill it and its survival says nothing about coverage. Declaring
  // one is a claim that has to be argued in the manifest, not a way to retire an
  // inconvenient survivor — and it is checked both ways: an equivalent mutant
  // that DOES get killed means the equivalence argument is wrong.
  const verdict = m.equivalent
    ? (killed ? 'NOT-EQUIVALENT' : 'equivalent')
    : (killed ? 'killed' : 'SURVIVED');
  results.push({ ...m, verdict, note: detail, caught });
  console.log(`${verdict.padEnd(9)} ${m.id}${detail ? `\n            ${detail}` : ''}`);
}

const survived = results.filter((r) => r.verdict === 'SURVIVED');
const stale = results.filter((r) => r.verdict === 'STALE');
const equiv = results.filter((r) => r.verdict === 'equivalent');
const misdeclared = results.filter((r) => r.verdict === 'NOT-EQUIVALENT');
console.log(`\n${'─'.repeat(60)}`);
console.log(`${results.filter((r) => r.verdict === 'killed').length}/${results.length - equiv.length} killable mutations killed`
  + (equiv.length ? `, ${equiv.length} equivalent (unkillable by construction)` : ''));
if (stale.length) {
  console.log(`\n${stale.length} STALE (mutation no longer applies — fix the pattern):`);
  for (const s of stale) console.log(`  ${s.id} — ${s.note}`);
}
if (survived.length) {
  console.log(`\n${survived.length} SURVIVED (the suite did not notice):`);
  for (const s of survived) console.log(`  ${s.id} [${s.suite}] — ${s.what}`);
}
if (misdeclared.length) {
  console.log(`\n${misdeclared.length} declared equivalent but KILLED (the equivalence argument is wrong):`);
  for (const s of misdeclared) console.log(`  ${s.id} — ${s.what}`);
}
// The audit's own output: which assertions this proved load-bearing. It is a
// LOWER BOUND — an assertion only appears here if one of the mutations above
// happened to break the thing it checks, and the manifest is not exhaustive.
const loadBearing = new Set();
for (const r of results) for (const c of r.caught || []) loadBearing.add(c);
fs.writeFileSync(path.join(ROOT, 'scripts/.mutation-report.json'),
  JSON.stringify({ at: new Date().toISOString(),
    mutations: results.map(({ id, suite, verdict, caught }) => ({ id, suite, verdict, caught })),
    loadBearing: [...loadBearing].sort() }, null, 2));
console.log(`\n${loadBearing.size} distinct assertions went red under at least one mutation`);
console.log('(a lower bound — see scripts/.mutation-report.json)');
process.exit(survived.length || stale.length || misdeclared.length ? 1 : 0);

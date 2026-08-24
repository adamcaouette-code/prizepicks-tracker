// Guards against the class of bug that produced the worst error in this app.
//
// The recommended-slip box reported +70% EV per dollar on a pure goblin 3-pick
// that really returns -32%, and +231% on a goblin 5-pick that returns -57%. No
// logic was wrong. There were simply TWO payout tables — the real one in
// bet-finder-size.js and an untiered copy in bet-finder-background.js — and the
// board read the copy. 1073 assertions passed the whole time, because every one
// of them tested a table against itself.
//
// Duplicated constants do not fail loudly. They drift, and the flattering
// version is the one nobody questions. So the numbers that exist in more than
// one place are checked against each other here.

import fs from 'node:fs';
import path from 'node:path';
import { sizeParlay } from '../../netlify/functions/bet-finder-background.js';
import { tablesForSlip } from '../../netlify/functions/bet-finder-size.js';

const leg = (tier, prob = 0.6) => ({ player: 'P', stat: 'Hits', line: 0.5, prob, oddsType: tier });

/** The client mirrors the server's break-even table; pull it out of the page. */
function clientBreakEven() {
  const raw = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const src = JSON.parse(raw.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/)[1]);
  const m = src.match(/const BREAK_EVEN = \{([^}]*)\}/);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) out[k] = Number(v);
  return out;
}

export default async function ({ t }) {
  // ---- payouts: exactly one table --------------------------------------
  // Priced through the board's own path and through the sizing endpoint's,
  // which is the comparison that would have caught the original bug.
  for (const tier of ['goblin', 'standard', 'demon']) {
    for (const n of [3, 4, 5, 6]) {
      const legs = Array.from({ length: n }, () => leg(tier));
      const authoritative = tablesForSlip(legs).power[n];
      const priced = sizeParlay(legs, { bankroll: 1000, floor: 0, maxStake: null });
      // Compared on MULTIPLIERS, not payouts. Kelly stakes a negative-EV slip at
      // zero, so payouts collapse to $0.00 and would compare equal by accident —
      // a test that passes because both sides are nothing.
      const viaBoard = priced.entries.power.multipliers[0].mult;
      t.ok(`${tier} ${n}-pick prices the same on the board as in sizing`,
        Math.abs(viaBoard - authoritative) < 0.01, `${viaBoard} vs ${authoritative}`);
    }
  }

  // The specific numbers the old copy got wrong, pinned so they cannot come back.
  t.eq('a pure goblin 3-pick pays 2.0x, not the 5.0x the stale copy claimed',
    tablesForSlip([leg('goblin'), leg('goblin'), leg('goblin')]).power[3], 2.0);
  t.eq('a pure goblin 5-pick pays 2.6x, not 20x',
    tablesForSlip(Array.from({ length: 5 }, () => leg('goblin'))).power[5], 2.6);

  // ---- break-even: server and client must agree ------------------------
  // The board sorts by edge = probability - break-even. If the page and the
  // functions disagree the board ranks one way and the log scores another, and
  // nothing anywhere reports a problem.
  const client = clientBreakEven();
  const server = { goblin: 2.0 ** (-1 / 3), standard: 4.75 ** (-1 / 3), demon: 12.0 ** (-1 / 3) };
  for (const tier of Object.keys(server)) {
    t.ok(`break-even for ${tier} matches between page and functions`,
      Math.abs(client[tier] - server[tier]) < 0.001,
      `page ${client[tier]} vs functions ${server[tier].toFixed(4)}`);
  }

  // ...and that the client's numbers are derived from the real multipliers
  // rather than being plausible-looking constants of their own.
  t.ok('the page\'s break-evens are the real payout table, not round numbers',
    Math.abs(client.goblin - 0.7937) < 0.001 && Math.abs(client.standard - 0.5946) < 0.001);

  // ---- no second copy has crept back ------------------------------------
  const bg = fs.readFileSync(path.resolve('netlify/functions/bet-finder-background.js'), 'utf8');
  t.ok('bet-finder-background declares no payout table of its own',
    !/^const (POWER|FLEX)\s*=/m.test(bg));
  t.ok('...it imports the real one instead', /import \{ tablesForSlip \}/.test(bg));
}

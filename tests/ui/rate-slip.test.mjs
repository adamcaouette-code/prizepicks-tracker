// The Rate a Slip flow: upload -> parse -> review -> judge -> verdict.
//
// Replaces the pre-redesign suite that opened a `#slipModal`. The modal is gone;
// rating is now a tab with five sections revealed in sequence, so what's worth
// guarding changed:
//
//   - the file input must NOT carry capture="environment" (it forced iOS straight
//     into the camera and hid Photo Library — a PrizePicks slip is a screenshot,
//     there is nothing to point a camera at);
//   - the image is canvas re-encoded to JPEG before upload, because iPhone HEIC is
//     rejected by the vision API;
//   - every section starts hidden and only the current one shows — a CSS rule that
//     beat [hidden] once made all three banners visible permanently;
//   - the judge's honesty surface (warnings, unsure legs, data-status) has to
//     survive the round trip, since that's the point of the feature.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, PARSE, JUDGE, LEDGER, PNG_1PX, jobRoutes } from '../fixtures/api.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function ({ t, url, browser }) {
  const slip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slip-')), 'slip.png');
  fs.writeFileSync(slip, PNG_1PX);

  let parsePost = null;
  const job = jobRoutes('judge-slip', JUDGE);
  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES,
    '**/api/pp-stats*': STATS,
    '**/api/top-picks*': LEDGER,
    '**/api/parse-slip': (route, request) => {
      parsePost = JSON.parse(request.postData() || '{}');
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PARSE) });
    },
    // The verdict screen runs the deterministic parlay math against real payout
    // tables. Shape matches bet-finder-size.js: entries + hitDistribution.
    '**/api/bet-finder-size': {
      legs: [{ prob: 0.68 }, { prob: 0.34 }],
      hitDistribution: [0.2112, 0.5576, 0.2312],
      entries: { power: { label: 'POWER', evPerDollar: -0.306, stake: 0, note: 'NO BET — non-positive EV', payouts: [{ hits: 2, pays: 0 }] } },
      recommended: null, mixed: true,
    },
    ...job,
  }});

  await page.click('#tabBtnRate');
  await page.waitForSelector('#rateUpload');

  // ---- the picker itself -------------------------------------------------
  const input = await page.$eval('#rateFile', el => ({
    accept: el.accept,
    capture: el.getAttribute('capture'),
    inLabel: !!el.closest('label'),
  }));
  t.eq('accepts any image, so HEIC screenshots can be chosen', input.accept, 'image/*');
  t.eq('no capture attribute — the library stays reachable, camera included', input.capture, null);
  t.ok('the whole upload box is the label, so the tap target is the box', input.inLabel);

  const hiddenAtStart = await page.$$eval('#tabRate > section',
    els => els.map(e => ({ id: e.id, hidden: e.hidden || getComputedStyle(e).display === 'none' })));
  t.eq('only the upload step shows at rest',
    hiddenAtStart.filter(s => !s.hidden).map(s => s.id), ['rateUpload']);

  // ---- upload -> parse ---------------------------------------------------
  await page.setInputFiles('#rateFile', slip);
  await page.waitForFunction(() => !document.getElementById('rateReview').hidden, null, { timeout: 20000 });

  t.ok('an image was posted to parse-slip', /^data:image\//.test(parsePost?.image || ''), (parsePost?.image || '').slice(0, 24));
  t.ok('re-encoded to JPEG, not forwarded as HEIC/PNG', /^data:image\/jpeg/.test(parsePost.image), parsePost.image.slice(0, 24));

  // ---- review: the honesty surface --------------------------------------
  t.ok('parse warnings are shown, not swallowed', await page.isVisible('#warningsBanner'));
  t.ok('the settled banner stays hidden for a live slip', !(await page.isVisible('#settledBanner')));
  const unsure = await page.$$eval('#reviewLegs .eleg', els => els.map(e => e.classList.contains('unsure')));
  t.eq('the leg with an unreadable line is flagged, the clean one is not', unsure, [false, true]);
  const legCount = await page.$$eval('#reviewLegs .eleg', els => els.length);
  t.eq('every parsed leg is listed for review', legCount, PARSE.slip.legs.length);

  // ---- judge -------------------------------------------------------------
  await page.click('#rateThisBtn');
  await page.waitForFunction(() => !document.getElementById('rateResult').hidden, null, { timeout: 40000 });

  t.eq('the whole slip goes to the judge, not just the legs', job.sent.slip?.league, 'mlb');
  t.eq('the UI-only "unsure" flag is stripped before sending', 'unsure' in job.sent.slip.legs[0], false);

  const verdict = await page.textContent('#verdictLegs');
  t.ok('decimal probability renders as a percentage', /68%/.test(verdict));
  t.ok('web-search <cite> markup is stripped', !/<cite|cite index/.test(verdict));
  t.ok('...but the reasoning text itself survives', /31\.3 percent K rate/.test(verdict));
  t.ok('the named risk is shown', /quiet 0-K game/.test(verdict));

  const head = await page.textContent('#verdictHead');
  t.ok('the whole-slip read is rendered', /cannot carry a demon/.test(head));

  // the raw-numbers panel on a verdict leg: the facts the judge saw, on demand
  const statsBtns = await page.$$('#verdictLegs .whybtn[data-panel="stats"]');
  t.eq('a stats button only on the leg that matched a live projection', statsBtns.length, 1);
  await statsBtns[0].click();
  await page.waitForFunction(() => !document.querySelector('#verdictLegs .why[data-panel="stats"]').hidden);
  const sp = await page.$eval('#verdictLegs .why[data-panel="stats"]', e => e.innerText.replace(/\s+/g, ' '));
  t.ok('last-5 with the over count vs this line', /4\/5 over 0\.5/.test(sp), sp.slice(0, 80));
  t.ok('opposing starter line rides along', /Crochet.*ERA 3\.02/.test(sp));
  t.ok('sources named', /PRIZEPICKS/.test(sp) && /ESPN/.test(sp));

  const status = await page.textContent('#dataStatusBanner');
  t.ok('data-provenance banner is shown', await page.isVisible('#dataStatusBanner'));
  t.ok('it admits only some legs matched a live projection', /1[^0-9].*2|1 of 2/.test(status), status.trim().slice(0, 80));
  // A corrected goblin/demon changes the payout table, so it must be stated, and
  // stated specifically enough to check.
  t.ok('a corrected tier is reported, not silently applied', /Corrected 1 tier/.test(status), status.trim().slice(0, 120));
  t.ok('...naming the leg and the direction of the fix', /Elly De La Cruz demon→goblin/.test(status));

  // ---- reset -------------------------------------------------------------
  await page.click('#rateResetBtn');
  await page.waitForFunction(() => !document.getElementById('rateUpload').hidden
    && document.getElementById('rateResult').hidden);
  const afterReset = await page.$$eval('#tabRate > section',
    els => els.filter(e => !e.hidden && getComputedStyle(e).display !== 'none').map(e => e.id));
  t.eq('start over returns to a clean upload step', afterReset, ['rateUpload']);

  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();
}

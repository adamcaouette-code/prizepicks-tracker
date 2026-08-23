// The brand assets actually reaching the browser.
//
// Icons are the easiest thing in a codebase to get silently wrong: a favicon
// that 404s, an apple-touch-icon still pointing at a file that was deleted, a
// manifest naming sizes the images do not have. None of it throws, none of it
// fails a build, and you only find out when the icon on your home screen is a
// grey page rather than your logo.

import { openApp } from '../helpers/browser.mjs';
import { LEAGUES, STATS, jobRoutes } from '../fixtures/api.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PUB = path.resolve('public');
const read = (f) => fs.readFileSync(path.join(PUB, f));

// PNG header: width and height are big-endian 32-bit ints at byte 16 and 20.
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

export default async function ({ t, url, browser }) {
  // ---- the files exist, and are the size they claim ----------------------
  for (const [file, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
    const { w, h } = pngSize(read(file));
    t.eq(`${file} is ${size}x${size} as declared`, [w, h], [size, size]);
  }
  t.ok('a favicon.ico is shipped for browsers that still ask for one',
    read('favicon.ico').length > 0);
  t.ok('the in-page lockup is shipped', read('logo.png').length > 0);

  // The page is one big HTML file already; a logo that doubled it would cost
  // every cold load. Kept as a separate cached file rather than inlined.
  const kb = read('logo.png').length / 1024;
  t.ok('...and is small enough not to weigh down a cold load', kb < 120, `${kb.toFixed(0)} KB`);

  // ---- the manifest and the files agree ----------------------------------
  const man = JSON.parse(read('manifest.webmanifest').toString());
  for (const icon of man.icons) {
    const f = icon.src.replace(/^\//, '');
    t.ok(`manifest icon ${icon.src} exists`, fs.existsSync(path.join(PUB, f)), f);
    const { w } = pngSize(read(f));
    t.eq(`...and really is ${icon.sizes}`, `${w}x${w}`, icon.sizes);
  }

  // ---- nothing points at a deleted asset ---------------------------------
  // favicon.svg was removed when the hand-drawn mark was replaced by the real
  // artwork. A stale <link> to it would 404 on every single page load.
  const html = read('index.html').toString();
  t.ok('no reference survives to the removed SVG mark', !/favicon\.svg/.test(html));
  t.ok('...and the file really is gone', !fs.existsSync(path.join(PUB, 'favicon.svg')));

  // ---- and it renders --------------------------------------------------
  const { page, errors, unstubbed } = await openApp(browser, { url, routes: {
    '**/api/pp-leagues*': LEAGUES, '**/api/pp-stats*': STATS, ...jobRoutes('bet-finder', { board: [], params: {} }),
  }});
  const logo = await page.$('.brandband img');
  t.ok('the lockup renders in the app', !!logo);
  const box = await logo.boundingBox();
  t.ok('...at a size where the wordmark can actually be read', box.width >= 180, `${Math.round(box.width)}px`);
  // A 460px frame that a logo pushes wider would make the whole app pan sideways.
  t.ok('...without widening the frame', box.width <= 460, `${Math.round(box.width)}px`);
  const loaded = await page.evaluate(() => {
    const i = document.querySelector('.brandband img');
    return i && i.complete && i.naturalWidth > 0;
  });
  t.ok('...and the image actually loaded, not a broken-image box', loaded);

  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  t.ok('no sideways scroll with the lockup in place', w <= 430, `scrollWidth ${w}`);
  t.eq('no unstubbed API calls', unstubbed, []);
  t.eq('no JS errors', errors, []);
  await page.close();
}

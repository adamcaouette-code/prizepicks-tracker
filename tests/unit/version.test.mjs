// The version number, and the deploy check built on it.
//
// The point of this file is narrow: the version is only useful if it is the SAME
// everywhere. The page carries one copy baked into its HTML and the functions
// carry another in version.js, and they deploy through the same build — so if
// they ever disagree in the repo, the footer's whole purpose (telling you at a
// glance whether a deploy landed) is destroyed, because a mismatch would mean
// "someone edited one of them" rather than "the deploy half landed".

import { readFile } from 'node:fs/promises';
import { loadFn } from '../helpers/fn.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;

export default async function ({ t }) {
  const mod = await loadFn('version.js');

  t.ok('the version is MAJOR.MINOR.PATCH', SEMVER.test(mod.VERSION), mod.VERSION);

  const res = await mod.handler({});
  t.eq('the endpoint answers 200', res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.eq('...reporting the version', body.version, mod.VERSION);
  t.ok('...and never caches, so it can never report a stale deploy as live',
    /no-store/.test(res.headers['Cache-Control']));
  t.ok('...listing the endpoints a deploy should contain, so a partial one shows',
    Array.isArray(body.endpoints) && body.endpoints.includes('fantasy-check'));

  // ---- the page and the functions must agree ------------------------------
  const raw = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const block = raw.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  t.ok('the app template is still intact', !!block);
  const page = JSON.parse(block[1]);   // throws if the escaping was broken

  const shown = page.match(/id="appVer">v([\d.]+)</);
  t.ok('the footer shows a version', !!shown, shown && shown[1]);
  t.eq('the PAGE version matches the FUNCTION version — otherwise the footer lies',
    shown[1], mod.VERSION);

  // ---- the deploy check itself --------------------------------------------
  t.ok('the footer has a slot for the API version beside the page version',
    /id="apiVer"/.test(page));
  t.ok('...filled from /api/version', /fetch\("\/api\/version"/.test(page));
  t.ok('...bypassing cache, or it would report the previous deploy',
    /cache: "no-store"/.test(page));
  t.ok('...and flags a mismatch rather than showing two numbers silently',
    /half landed|different versions/.test(page));
  t.ok('...and says "offline" when the functions do not answer at all',
    /offline/.test(page));

  // The escaping rule this file has broken before: a raw </script> inside the
  // template ends the block early and takes the whole app down.
  const inner = raw.slice(raw.indexOf('<script type="__bundler/template">'));
  const upToClose = inner.slice(0, inner.indexOf('</script>'));
  t.eq('no unescaped </script> inside the template', (upToClose.match(/<\/script>/g) || []).length, 0);
}

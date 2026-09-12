// The model picker was removed from the normal board so a run can't be
// silently judged by something other than the standing default (Vilifiant).
// That capability must still be REACHABLE, deliberately, from the dev
// console — this pins that it actually is, rather than just deleted.

import { loadFn } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

export default async function ({ t }) {
  reset();
  const dev = await loadFn('dev.js');
  const html = (await dev.handler()).body;

  t.ok('the dev console offers a deliberate model override',
    /Judge model override/.test(html));
  t.ok('...labelled as an experiment, not the normal flow',
    /experiments only/.test(html));
  t.ok('...naming that the normal board removed this control on purpose',
    /model picker\s+was removed from that page on purpose/.test(html.replace(/\s+/g, ' ')));

  // The allowlist is the price table, reused rather than re-listed — a model
  // with no price would meter as Opus and misreport spend.
  t.ok('the standing default is one of the offered options',
    /value="claude-haiku-4-5-20251001"/.test(html));
  t.ok('a retired model is offered too, since this is exactly where it belongs now',
    /value="claude-opus-4-8"/.test(html));
  t.ok('options are named in the user\'s language, not just the raw id',
    /Vilifiant \(claude-haiku-4-5-20251001\)/.test(html));

  t.ok('firing it hits bet-finder-background, the same endpoint the board uses',
    /runExpFinder/.test(html) && /\/api\/bet-finder-background/.test(html));
  t.ok('...and says where the results will actually surface',
    /Legacy engines/.test(html) && /calibration/.test(html));
}

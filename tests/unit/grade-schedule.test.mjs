// The grading cron: that it is scheduled AT ALL, and at the right time.
//
// Worth a test because a wrong cron fails SILENTLY — nothing errors, results
// just never appear, and you'd notice days later. The intent is "3am Pacific",
// but Netlify cron is UTC with no daylight-saving awareness, so that is 10:00 UTC
// for most of the year and 11:00 UTC in winter. This asserts the schedule
// actually lands on 3am Pacific in BOTH halves of the year rather than checking
// a hardcoded string against itself.
//
// AND — added after this file's own blind spot cost five days of grading —
// that the schedule sits on a file Netlify will actually register it on.
//
// On 2026-08-29 grade-cron.js was renamed to grade-cron-background.js for the
// 15-minute execution budget, carrying `export const config = { schedule }`
// with it. Netlify treats `-background` and scheduled as two different kinds of
// function; a `-background` file's schedule is never registered. Grading
// stopped dead, 1,159 picks went ungraded, and THIS TEST STAYED GREEN the whole
// time: it read the schedule string out of the background file and checked the
// cron expression was well-formed, which it was. It asserted the schedule was
// CORRECT and never that it was REGISTERED. The guard below is the missing half.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFn } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const FN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../netlify/functions');
const SCHEDULED = path.join(FN_DIR, 'grade-cron.js');
const BACKGROUND = path.join(FN_DIR, 'grade-cron-background.js');

// Returns the Pacific hour as a NUMBER — hour12:false formats midnight-to-9am
// with a leading zero ("03"), so comparing strings silently never matches.
const hourInLA = (utcHour, isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Number(new Date(Date.UTC(y, m - 1, d, utcHour)).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
  }));
};

export default async function ({ t }) {
  const scheduled = fs.readFileSync(SCHEDULED, 'utf8');
  const background = fs.readFileSync(BACKGROUND, 'utf8');

  // ---- the schedule is on a file Netlify will register it on ---------------
  const m = scheduled.match(/schedule:\s*'([^']+)'/);
  t.ok('a NON-background function carries the schedule', !!m, m && m[1]);
  t.ok('...and it is not named -background', !/-background\.js$/.test(SCHEDULED));

  // THE GUARD. No function file ending in -background may declare a schedule:
  // Netlify silently ignores it, which is indistinguishable from working.
  // Comments are stripped first — the files above deliberately DISCUSS the
  // mistake at length, and a warning about a trap must not trip the trap.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const offenders = fs.readdirSync(FN_DIR)
    .filter((f) => /-background\.(m?js|ts)$/.test(f))
    .filter((f) => /config\s*=\s*\{[^}]*schedule/s.test(stripComments(fs.readFileSync(path.join(FN_DIR, f), 'utf8'))));
  t.eq('no -background function declares a schedule — Netlify never registers those',
    offenders, []);

  // ---- the schedule itself still lands on 3am Pacific year-round -----------
  const [minute, hours, dom, month, dow] = m[1].split(/\s+/);
  t.eq('fires on the hour', minute, '0');
  t.eq('every day', [dom, month, dow], ['*', '*', '*']);

  const utcHours = hours.split(',').map(Number);
  t.note(`UTC hours ${utcHours.join(', ')} -> PDT ${utcHours.map((h) => hourInLA(h, '2026-07-15')).join(', ')}` +
    ` | PST ${utcHours.map((h) => hourInLA(h, '2026-01-15')).join(', ')}`);

  t.ok('one run lands at 3am Pacific during daylight time',
    utcHours.some((h) => hourInLA(h, '2026-07-15') === 3),
    utcHours.map((h) => `${h}z=${hourInLA(h, '2026-07-15')}`).join(' '));
  t.ok('one run lands at 3am Pacific during standard time',
    utcHours.some((h) => hourInLA(h, '2026-01-15') === 3),
    utcHours.map((h) => `${h}z=${hourInLA(h, '2026-01-15')}`).join(' '));
  t.ok('a later pass exists as a backstop',
    utcHours.some((h) => hourInLA(h, '2026-07-15') >= 6),
    utcHours.map((h) => `${h}z=${hourInLA(h, '2026-07-15')}`).join(' '));

  // ---- the work still lives in the background half ------------------------
  t.ok('the draining loop drains the pick log', /grade-picks/.test(background));
  t.ok('...and settles saved slips in the same run', /grade-slips/.test(background));
  t.ok('the cron itself calls no model', !/anthropic|ANTHROPIC/i.test(background + scheduled));

  // ---- the scheduled half actually pokes the background half --------------
  // A scheduled function that fires and does nothing is the same outage wearing
  // a different hat, so this drives the real handler.
  reset();
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  };
  let out;
  try {
    const { handler } = await loadFn('grade-cron.js');
    out = await handler({ httpMethod: 'POST', body: '' });
  } finally { globalThis.fetch = origFetch; }

  t.eq('the scheduled run dispatches exactly once', calls.length, 1);
  t.ok('...to the background function', /grade-cron-background/.test(calls[0].url), calls[0].url);
  t.eq('...over POST, which is what invokes a background function', calls[0].init.method, 'POST');
  t.eq('...and reports the dispatch succeeded', JSON.parse(out.body).dispatched, true);

  // The dispatch is recorded on its own. Without this, "the scheduler never
  // fired" and "the scheduler fired and the work died" produce an identical
  // absence of heartbeat — which is exactly why the outage took five days and
  // a calibration audit to notice.
  const beats = read('run-stats', 'cron-heartbeat') || [];
  t.eq('the fire is recorded even before any grading happens', beats.length, 1);
  t.eq('...labelled as a scheduler dispatch, distinctly from a completed drain',
    beats[0].trigger, 'schedule-dispatch');
  t.eq('...and says the poke landed', beats[0].dispatched, true);

  // ---- a failed dispatch is recorded, not swallowed -----------------------
  reset();
  const origFetch2 = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const { handler } = await loadFn('grade-cron.js');
    await handler({ httpMethod: 'POST', body: '' });
  } finally { globalThis.fetch = origFetch2; }
  const failBeats = read('run-stats', 'cron-heartbeat') || [];
  t.eq('a dispatch that throws still writes a heartbeat', failBeats.length, 1);
  t.eq('...marked as not dispatched', failBeats[0].dispatched, false);
  t.ok('...carrying the reason', /network down/.test(failBeats[0].error || ''), failBeats[0].error);

  // ---- the background function reports its trigger instead of asserting it -
  // The old code stamped every deployed invocation 'schedule', so a hand-fired
  // run was indistinguishable from a cron one in the only record kept. That is
  // what let a dead schedule pass verification.
  t.ok('the background function no longer hardcodes the schedule label',
    !/trigger:\s*process\.env\.NETLIFY_DEV\s*\?\s*'local'\s*:\s*'schedule'/.test(background));
  t.ok('...it reads the trigger it was actually given', /body\.trigger/.test(background));
}

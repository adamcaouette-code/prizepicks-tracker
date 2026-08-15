// The grading cron's schedule.
//
// Worth a test because a wrong cron fails SILENTLY — nothing errors, results
// just never appear, and you'd notice days later. The intent is "3am Pacific",
// but Netlify cron is UTC with no daylight-saving awareness, so that is 10:00 UTC
// for most of the year and 11:00 UTC in winter. This asserts the schedule
// actually lands on 3am Pacific in BOTH halves of the year rather than checking
// a hardcoded string against itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../netlify/functions/grade-cron.js');

// Returns the Pacific hour as a NUMBER — hour12:false formats midnight-to-9am
// with a leading zero ("03"), so comparing strings silently never matches.
const hourInLA = (utcHour, isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Number(new Date(Date.UTC(y, m - 1, d, utcHour)).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
  }));
};

export default async function ({ t }) {
  const src = fs.readFileSync(FN, 'utf8');
  const m = src.match(/schedule:\s*'([^']+)'/);
  t.ok('grade-cron exports a schedule', !!m, m && m[1]);

  const [minute, hours, dom, month, dow] = m[1].split(/\s+/);
  t.eq('fires on the hour', minute, '0');
  t.eq('every day', [dom, month, dow], ['*', '*', '*']);

  const utcHours = hours.split(',').map(Number);
  t.note(`UTC hours ${utcHours.join(', ')} -> PDT ${utcHours.map((h) => hourInLA(h, '2026-07-15')).join(', ')}` +
    ` | PST ${utcHours.map((h) => hourInLA(h, '2026-01-15')).join(', ')}`);

  // Summer (PDT, UTC-7) and winter (PST, UTC-8) must each get a 3am run.
  t.ok('one run lands at 3am Pacific during daylight time',
    utcHours.some((h) => hourInLA(h, '2026-07-15') === 3),
    utcHours.map((h) => `${h}z=${hourInLA(h, '2026-07-15')}`).join(' '));
  t.ok('one run lands at 3am Pacific during standard time',
    utcHours.some((h) => hourInLA(h, '2026-01-15') === 3),
    utcHours.map((h) => `${h}z=${hourInLA(h, '2026-01-15')}`).join(' '));

  // A later backstop matters: a west-coast game that ran long may not have a
  // final box score at 3am, and the 3am pass would find nothing to settle.
  t.ok('a later pass exists as a backstop',
    utcHours.some((h) => hourInLA(h, '2026-07-15') >= 6),
    utcHours.map((h) => `${h}z=${hourInLA(h, '2026-07-15')}`).join(' '));

  // Every fire re-runs both graders, so they must be safe to repeat.
  t.ok('the cron drains the pick log', /grade-picks/.test(src));
  t.ok('...and settles saved slips in the same run', /grade-slips/.test(src));
  t.ok('the cron itself calls no model', !/anthropic|ANTHROPIC/i.test(src));
}

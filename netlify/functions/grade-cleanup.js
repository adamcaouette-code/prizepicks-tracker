// netlify/functions/grade-cleanup.js
//
// Marks the picks that CANNOT be graded, so the grader stops trying them.
//
// Every ungraded pick costs something on each pass: an attempt counter, a slot
// in the day's todo list, and a share of the run's budget. Most of the residue
// is not waiting on anything — a combo has two players in one prop and no box
// score settles it, and an esports pick has no free data source in existence.
// Retrying those forever is pure waste, and it also hides the picks that ARE
// still resolvable behind a wall of ones that never will be.
//
// MARKS, DOES NOT DELETE. The picks stay in the log with a reason attached.
// They are still a record of what was picked, they still count in coverage as
// "logged", and the marking is reversible. Deleting would throw away the only
// evidence of what the engine chose on those days.
//
// PERMANENT vs CONDITIONAL is the important distinction:
//
//   permanent    a combo, or a period/half prop. No full-game box score can
//                ever settle these. Nothing will change that, so they are never
//                revived.
//   conditional  a stat with no mapping, or a league with no source wired.
//                These are only ungradeable because of what this app supports
//                TODAY — adding a mapping or a data source makes them
//                gradeable again, so they carry the grader era and come back
//                when it moves.
//
// That distinction is the whole reason this is not just a delete button. Every
// unmapped stat in the current audit became gradeable at some point in the last
// few days; wiping them permanently would have thrown away picks that a later
// mapping recovered.
//
// Usage: /api/grade-cleanup?dry=1    preview — counts only, writes nothing
//        /api/grade-cleanup          mark them
//        /api/grade-cleanup?undo=1   clear every CONDITIONAL mark and retry

import { getStore } from '@netlify/blobs';
import { isCombo, GRADER_ERA } from './grade-picks.js';
import { statResolves, isPeriodProp } from './grade-audit.js';
import { gradersFor } from './grade-picks.js';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const ungraded = (p) => p.hit === null || p.hit === undefined;

/**
 * Why this pick can't be graded, or null if it still can.
 * `permanent` marks the ones no future change can rescue.
 */
export function ungradeableReason(p) {
  if (isCombo(p)) {
    return { reason: 'combo — two players in one prop, no box score settles it', permanent: true };
  }
  if (isPeriodProp(p)) {
    return { reason: 'period/half prop — a full-game box score cannot settle a segment', permanent: true };
  }
  const lg = String(p.league || '').toLowerCase();
  if (gradersFor(lg).every((s) => s === 'prizepicks')) {
    return { reason: `no box-score source wired for ${lg}`, permanent: false };
  }
  if (!statResolves(lg, p.stat)) {
    return { reason: `stat "${p.stat}" has no mapping`, permanent: false };
  }
  return null;
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const dry = q.dry === '1';
  const undo = q.undo === '1';
  const days = Math.min(Number(q.days) || 120, 400);

  try {
    const store = getStore({ name: 'pick-log', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let dates = [];
    try { dates = (await store.list()).blobs.map((b) => b.key).sort().slice(-days); } catch {}

    let marked = 0, revived = 0, alreadyMarked = 0, stillGradeable = 0;
    const byReason = {};
    const examples = [];

    for (const date of dates) {
      let picks = [];
      try { picks = (await store.get(date, { type: 'json' })) || []; } catch { continue; }
      let touched = false;

      for (const p of picks) {
        if (!ungraded(p)) continue;

        if (undo) {
          // Only conditional marks come back. A combo is still a combo.
          if (p.ungradeable && p.ungradeablePermanent !== true) {
            delete p.ungradeable;
            delete p.ungradeableReason;
            delete p.ungradeablePermanent;
            p.gradeAttempts = 0;
            revived++; touched = true;
          }
          continue;
        }

        if (p.ungradeable) { alreadyMarked++; continue; }
        const verdict = ungradeableReason(p);
        if (!verdict) { stillGradeable++; continue; }

        byReason[verdict.reason] = (byReason[verdict.reason] || 0) + 1;
        if (examples.length < 12) {
          examples.push({ date, player: p.player, stat: p.stat, league: p.league, reason: verdict.reason });
        }
        if (!dry) {
          p.ungradeable = 'cannot grade';
          p.ungradeableReason = verdict.reason;
          p.ungradeablePermanent = verdict.permanent;
          // A conditional mark carries the era it was made in, so adding a
          // mapping or a source later brings it back automatically.
          if (!verdict.permanent) p.graderEra = GRADER_ERA;
          touched = true;
        }
        marked++;
      }

      if (touched && !dry) await store.setJSON(date, picks);
    }

    const permanent = Object.entries(byReason).filter(([r]) => /combo|period/.test(r)).reduce((a, [, n]) => a + n, 0);

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      mode: undo ? 'undo' : dry ? 'preview (nothing written)' : 'marked',
      days: dates.length,
      ...(undo ? { revived } : { marked, alreadyMarked, stillGradeable, byReason, examples }),
      ...(undo ? {} : {
        permanent,
        conditional: marked - permanent,
        note: 'Marked, not deleted — the picks stay in the log and still count as logged. PERMANENT ones (combos, period props) never come back. CONDITIONAL ones (no mapping, no source) return automatically when a mapping or data source is added, so nothing is lost by marking them now.',
        ...(dry ? { next: 'Re-run without ?dry=1 to apply.' } : { undo: 'Reverse the conditional ones any time with ?undo=1' }),
      }),
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

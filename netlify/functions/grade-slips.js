// netlify/functions/grade-slips.js
//
// Settles saved slips. Uses grade-picks.js's own fetchHistory/gradeOne so a slip
// leg and a logged pick are decided by identical rules.
//
// THE INVERSION, because it is the easiest thing in this codebase to get wrong:
// gradeOne returns `hit = actual > line`, i.e. "did the OVER hit". A saved leg
// carries the side YOU took. So a leg you took UNDER hits when the over did not.
// Getting this backwards would mark your winners as losses.
//
//   /api/grade-slips            grade every pending slip
//   /api/grade-slips?id=...     just one
//   /api/grade-slips?dry=1      report, don't save

import { getStore } from '@netlify/blobs';
import { fetchHistory, gradeOne, isCombo, MAX_ATTEMPTS } from './grade-picks.js';

const BUDGET_MS = 8000;
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// Flex pays on partial hits; Power is all-or-nothing. Slip status is the honest
// summary of the legs, computed here rather than trusted from the client.
//
// An ungradeable leg (no projection id, a combo, or a lookup we gave up on) is
// never fatal and never guessed. It just means the slip can't be fully settled —
// EXCEPT when the gradeable legs already decide it, which is common: one
// confirmed miss loses a Power card no matter what the unknown leg did.
function summarize(slip) {
  const legs = slip.legs || [];
  const settled = legs.filter((l) => l.hit === true || l.hit === false);
  const ungradeable = legs.filter((l) => l.ungradeable);
  const hits = legs.filter((l) => l.hit === true).length;
  const misses = legs.filter((l) => l.hit === false).length;

  // A confirmed miss decides a Power card immediately — no reason to wait on the
  // rest, gradeable or not.
  if (slip.entry === 'power' && misses > 0) return { status: 'lost', hits, misses };

  const undecided = legs.length - settled.length - ungradeable.length;
  if (undecided > 0) return { status: 'pending', hits, misses };

  // Everything that CAN be graded has been.
  if (ungradeable.length) {
    // Flex can still be decided if the unknown legs can't change the outcome:
    // enough legs already missed to bust it regardless.
    if (slip.entry === 'flex' && misses > 2) return { status: 'lost', hits, misses };
    return { status: 'ungradeable', hits, misses, ungradeableLegs: ungradeable.length };
  }
  if (slip.entry === 'power') return { status: misses === 0 ? 'won' : 'lost', hits, misses };
  // Flex: a full card is a win, a partial card still pays at some tiers — the
  // page shows the exact payout from the sizing table saved with the slip.
  if (misses === 0) return { status: 'won', hits, misses };
  return { status: hits >= 2 && hits >= legs.length - 2 ? 'partial' : 'lost', hits, misses };
}

// Slips are kept for a few days and then dropped, so the list stays readable
// instead of becoming an archive nobody scrolls. Measured from the SLATE date
// (when the legs played), not when you saved it.
const RETENTION_DAYS = Number(process.env.SLIP_RETENTION_DAYS) || 3;
function isExpired(slip, now = Date.now()) {
  const basis = slip.slateDate || String(slip.createdAt || '').slice(0, 10);
  const t = Date.parse(`${basis}T00:00:00Z`);
  if (!isFinite(t)) return false;            // unparseable date: keep it, don't delete blind
  // +1 day of grace so a slip that played last night is never swept before its
  // own results have had a chance to land.
  return now - t > (RETENTION_DAYS + 1) * 86400000;
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const dry = q.dry === '1';
  const start = Date.now();

  try {
    const store = getStore({ name: 'saved-slips', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
    let keys = [];
    try { keys = (await store.list()).blobs.map((b) => b.key); } catch { keys = []; }
    if (q.id) keys = keys.filter((k) => k === q.id);

    const report = [];
    let legsGraded = 0, slipsSettled = 0, timedOut = false, pruned = 0;

    for (const key of keys) {
      if (Date.now() - start > BUDGET_MS) { timedOut = true; break; }
      let slip = null;
      try { slip = await store.get(key, { type: 'json' }); } catch { slip = null; }
      if (!slip || !Array.isArray(slip.legs)) continue;

      // Retention sweep. Runs before grading so an expired slip isn't graded and
      // then immediately deleted.
      if (isExpired(slip)) {
        if (!dry) { try { await store.delete(key); } catch {} }
        pruned++;
        continue;
      }
      if (slip.status && !['pending', 'ungradeable'].includes(slip.status)) continue;   // already final

      let touched = false;
      for (const leg of slip.legs) {
        if (leg.hit === true || leg.hit === false || leg.ungradeable) continue;
        if (!leg.projectionId) { leg.ungradeable = 'no projection id'; touched = true; continue; }
        if (isCombo(leg)) { leg.ungradeable = 'combo'; touched = true; continue; }
        if ((leg.gradeAttempts || 0) >= MAX_ATTEMPTS) { leg.ungradeable = 'gave up'; touched = true; continue; }
        if (Date.now() - start > BUDGET_MS) { timedOut = true; break; }

        const history = await fetchHistory(leg.projectionId);
        // gradeOne keys the game off `date` + `loggedAt`; give it the slate date
        // the slip recorded, not today.
        const graded = gradeOne({ date: slip.slateDate, line: leg.line, loggedAt: slip.createdAt }, history);
        if (!graded) { leg.gradeAttempts = (leg.gradeAttempts || 0) + 1; touched = true; continue; }

        leg.result = graded.result;
        // graded.hit is "did the OVER hit" — flip it for a leg taken under.
        leg.hit = leg.pick === 'under' ? !graded.hit : graded.hit;
        leg.gradedAt = new Date().toISOString();
        legsGraded++; touched = true;
      }

      const sum = summarize(slip);
      if (sum.status !== slip.status) touched = true;
      slip.status = sum.status;
      slip.hits = sum.hits;
      slip.misses = sum.misses;
      slip.ungradeableLegs = sum.ungradeableLegs || 0;
      if (['won', 'lost', 'partial'].includes(sum.status) && !slip.gradedAt) {
        slip.gradedAt = new Date().toISOString();
        slipsSettled++;
      }
      // Payout straight from the multiplier table saved with the slip, so the
      // number shown later is the one that was quoted at save time.
      if (slip.sizing && ['won', 'partial'].includes(sum.status)) {
        const row = (slip.sizing.payouts || []).find((r) => Number(r.hits) === sum.hits);
        if (row && Number(row.pays) > 0) {
          slip.payout = row.pays;
        } else {
          // Older slips were saved with payouts scaled by the Kelly stake, which
          // is 0 on negative EV — those rows are all zero and would report a win
          // as paying nothing. Recompute from the multiplier table when it's there.
          const mult = (slip.sizing.multipliers || []).find((r) => Number(r.hits) === sum.hits);
          slip.payout = mult ? Math.round(Number(slip.stake || 0) * mult.mult * 100) / 100 : (row ? row.pays : null);
        }
      } else if (sum.status === 'lost') {
        slip.payout = 0;
      }

      if (touched && !dry) await store.setJSON(key, slip);
      report.push({ id: slip.id, name: slip.name, status: slip.status, hits: sum.hits, misses: sum.misses, payout: slip.payout });
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ dry, timedOut, slips: keys.length, legsGraded, slipsSettled, pruned, retentionDays: RETENTION_DAYS, report }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};

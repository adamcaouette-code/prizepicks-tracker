// The mutation manifest for scripts/mutation-audit.mjs.
//
// One entry per behaviour a suite claims to cover. `from` must appear EXACTLY
// once in the file — the harness reports anything else as STALE rather than
// pretending the mutation ran.
//
// `what` is written as the lie the mutation tells. If the suite survives it,
// that lie is one the app could ship.

export const MUTATIONS = [
  // ======================================================================
  // PRIORITY 1 — AUC and the selection curve (item D).
  // These shipped in the same window as the loadFn gap, and Task 3's whole
  // objective function is "within-tier AUC and realized top-N hit rate". If
  // these are not covered, Task 3 is optimizing against an unverified ruler.
  // ======================================================================
  { id: 'auc-noop', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'AUC is never computed at all',
    from: 'function aucOf(rows) {\n  const pos = [], neg = [];',
    to: 'function aucOf(rows) {\n  if (rows) return null;\n  const pos = [], neg = [];' },

  { id: 'auc-inverted', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'AUC is reported the wrong way round — a perfect ranker reads as 0',
    from: '  return { auc: A, se, pos: pos.length, neg: neg.length };',
    to: '  return { auc: 1 - A, se, pos: pos.length, neg: neg.length };' },

  { id: 'auc-midrank', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'ties get insertion-order ranks instead of midranks, so a flat judge scores by luck of the sort',
    from: '    const mid = (i + j) / 2 + 1;                      // 1-based midrank',
    to: '    const mid = i + 1;' },

  { id: 'auc-se-zero', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'every AUC is reported with a zero interval, so noise reads as skill',
    from: `  const se = Math.sqrt(Math.max(0,
    (A * (1 - A) + (pos.length - 1) * (q1 - A * A) + (neg.length - 1) * (q2 - A * A))
    / (pos.length * neg.length)));`,
    to: '  const se = 0;' },

  { id: 'lift-se-zero', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'every lift is reported with a zero interval',
    from: '    const liftSE = Math.sqrt((pt * (1 - pt)) / half + (pb * (1 - pb)) / half);',
    to: '    const liftSE = 0;' },

  { id: 'slices-noop', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the percentile selection curve is empty',
    from: '      topSlices: [50, 25, 10, 5].map((pctile) => {',
    to: '      topSlices: [].map((pctile) => {' },

  { id: 'slices-bottom', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the "top" slice is taken from the BOTTOM of the ranking',
    from: '        const r = rate(rows.slice(0, k));',
    to: '        const r = rate(rows.slice(-k));' },

  { id: 'slices-thin-shown', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'a hit rate on a handful of picks is printed as if it were evidence',
    from: '        if (k < MIN_SLICE_N) return { pctile, n: k, rate: null, clears: null };',
    to: '        if (k < 0) return { pctile, n: k, rate: null, clears: null };' },

  { id: 'topn-noop', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'top-N by run is never computed',
    from: '      topN: [3, 5, 10].map((N) => {',
    to: '      topN: [].map((N) => {' },

  { id: 'topn-pooled', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'top-N is taken from the whole log once instead of per run — the top 3 of a season is not a bet',
    from: "        for (const p of rows) (byRun[p.loggedAt || p.date || '?'] ||= []).push(p);",
    to: "        for (const p of rows) (byRun['all'] ||= []).push(p);" },

  { id: 'topn-always-clears', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'every top-N cell claims to clear break-even',
    from: '        return { N, runs: Object.keys(byRun).length, n: picked.length, rate: r, clears: be == null ? null : r >= be };',
    to: '        return { N, runs: Object.keys(byRun).length, n: picked.length, rate: r, clears: true };' },

  // EQUIVALENT by construction: `rows` is already sorted descending by prob
  // before the runs are grouped, and byRun pushes in that order, so each run's
  // array arrives sorted and the inner sort is a re-sort of sorted input. No
  // suite can kill this and none should be written to. The ranking IS
  // load-bearing — see topn-no-ranking, which removes the sort that does the
  // work and dies immediately.
  { id: 'topn-unsorted', suite: 'calibration', file: 'netlify/functions/calibration.js', equivalent: true,
    what: 'top-N re-sorts an already-sorted run',
    from: '          picked.push(...run.sort((x, y) => (Number(y.prob) || 0) - (Number(x.prob) || 0)).slice(0, N));',
    to: '          picked.push(...run.slice(0, N));' },

  { id: 'topn-no-ranking', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'top-N is the first N logged in each run rather than the N the judge ranked highest',
    from: `    const rows = graded.filter((p) => (p.oddsType || 'unknown') === tier)
      .sort((x, y) => (Number(y.prob) || 0) - (Number(x.prob) || 0));`,
    to: `    const rows = graded.filter((p) => (p.oddsType || 'unknown') === tier);` },

  // ======================================================================
  // PRIORITY 2 — item 6's has-form / no-form bucket split.
  // This is the finding that redirected the whole effort from prompt work to
  // form coverage. If the split is not covered, that redirection rests on an
  // unverified number.
  // ======================================================================
  { id: 'form-buckets-swapped', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the has-form and no-form buckets are the wrong way round',
    from: '  const hasForm = graded.filter((p) => p.recentAvg != null);\n  const noForm = graded.filter((p) => p.recentAvg == null);',
    to: '  const hasForm = graded.filter((p) => p.recentAvg == null);\n  const noForm = graded.filter((p) => p.recentAvg != null);' },

  { id: 'form-split-collapsed', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'every pick counts as having had form, so the split reports nothing',
    from: '  const hasForm = graded.filter((p) => p.recentAvg != null);',
    to: '  const hasForm = graded.filter(() => true);' },

  { id: 'coverage-wrong-way-round', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'coverage reports the share that had NO form as if it were the share that had it',
    from: '  out.byFormCoverage.formCoverage = graded.length ? hasForm.length / graded.length : null;',
    to: '  out.byFormCoverage.formCoverage = graded.length ? noForm.length / graded.length : null;' },

  { id: 'bucket-baseline-pooled', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'each bucket is scored against the POOLED baseline instead of one built from its own rows',
    from: '    scoreAgainstBaseline(o, rows);\n    o.skill = computeSkill(rows);',
    to: '    scoreAgainstBaseline(o, graded);\n    o.skill = computeSkill(rows);' },

  { id: 'pooled-diff-sign', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the no-form-minus-has-form difference is reported with its sign flipped',
    from: '      const diff = nf[metric] - h[metric];',
    to: '      const diff = h[metric] - nf[metric];' },

  { id: 'pooled-diff-se-halved', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the difference carries only one bucket\'s error, so its interval is too narrow and its z too big',
    from: '      const se = Math.sqrt(h[seKey] ** 2 + nf[seKey] ** 2);',
    to: '      const se = h[seKey];' },

  { id: 'pooled-equal-weight', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'tiers are pooled with equal weight rather than by inverse variance',
    from: '      const w = 1 / (se * se);',
    to: '      const w = 1;' },

  { id: 'gs-pooling-is-a-copy', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the goblin+standard pooling is silently the all-tier one, so publishing both proves nothing',
    from: "    liftGoblinStandard: pooledDiff('lift', 'liftSE', GS),",
    to: "    liftGoblinStandard: pooledDiff('lift', 'liftSE')," },

  { id: 'mean-lift-unweighted', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the headline lift is a flat mean of tiers, so a 20-pick tier weighs as much as a 400-pick one',
    from: '      ? lifts.reduce((a, v) => a + v.lift * v.n, 0) / lifts.reduce((a, v) => a + v.n, 0) : null;',
    to: '      ? lifts.reduce((a, v) => a + v.lift, 0) / lifts.length : null;' },

  { id: 'noform-by-stat-noop', suite: 'calibration', file: 'netlify/functions/calibration.js',
    what: 'the uncovered rows are never attributed to a league and stat, so nothing is actionable',
    from: '    out.noFormBy.stat[sk] = (out.noFormBy.stat[sk] || 0) + 1;',
    to: '    out.noFormBy.stat[sk] = 0;' },

  // ======================================================================
  // PRIORITY 3 — everything else whose import graph reaches @netlify/blobs.
  //
  // Weighted toward the failure mode that started this: a write that silently
  // goes nowhere. A suite that reads a store back is proof against it; a suite
  // that only checks the handler's return value is not, and the difference is
  // invisible until you break the write on purpose.
  // ======================================================================

  // ---- bet-finder-background: the pick log ------------------------------
  { id: 'bf-picklog-vanishes', suite: 'judge-version-run', file: 'netlify/functions/bet-finder-background.js',
    what: 'nothing is ever written to the calibration log',
    from: '      await logStore.setJSON(day, [...byKey.values()]);',
    to: '      await Promise.resolve();' },

  { id: 'bf-log-identity-loses-judge', suite: 'judge-version-run', file: 'netlify/functions/bet-finder-background.js',
    what: 'two judges on one slate share a log row, so the second overwrites the first',
    from: "        p.source || 'board', p.promptVersion || '', p.judgeModel || '',",
    to: "        p.source || 'board', '', ''," },

  { id: 'bf-costlog-vanishes', suite: 'judge-version-run', file: 'netlify/functions/bet-finder-background.js',
    what: 'the cost of a run is metered and then thrown away',
    from: '    await store.setJSON(day, arr);\n  } catch { /* metering must never break anything */ }',
    to: '    await Promise.resolve(arr);\n  } catch { /* metering must never break anything */ }' },

  { id: 'bf-runstats-vanishes', suite: 'find-bets-pipeline', file: 'netlify/functions/bet-finder-background.js',
    what: 'run timings are collected and never stored, so the ETA never learns',
    from: '        await statsStore.setJSON(params.league, hist.slice(-20));   // keep last 20 runs',
    to: '        await Promise.resolve(hist);' },

  // ---- sides ------------------------------------------------------------
  { id: 'sides-under-always-available', suite: 'sides', file: 'netlify/functions/bet-finder-background.js',
    what: 'every line is treated as accepting an under, including the over-only ones',
    from: "    const underAvailable = p.wagerTypes\n      ? p.wagerTypes === 'under_or_over'\n      : tierKnown && tier === 'standard';",
    to: '    const underAvailable = true;' },

  { id: 'sides-legacy-fallback-open', suite: 'sides', file: 'netlify/functions/bet-finder-background.js',
    what: 'a prop with no wagerTypes field falls back to allowing an under on any tier',
    from: "      : tierKnown && tier === 'standard';",
    to: '      : true;' },

  { id: 'sides-prob-not-inverted', suite: 'sides', file: 'netlify/functions/bet-finder-background.js',
    what: 'an under is quoted at P(over) — the Brier score inverted',
    from: "    p.sideProb = side === 'under' ? 1 - over : over;",
    to: '    p.sideProb = over;' },

  { id: 'sides-unpriced-not-flagged', suite: 'sides', file: 'netlify/functions/bet-finder-background.js',
    what: 'an under on an alt line is priced as if its multiplier were known',
    from: "    p.sidePriceUnverified = side === 'under' && tier !== 'standard';",
    to: '    p.sidePriceUnverified = false;' },

  // ---- candidate selection ----------------------------------------------
  { id: 'balanced-not-round-robin', suite: 'balanced-run', file: 'netlify/functions/bet-finder-background.js',
    what: 'a balanced run takes the top of each game like any other, so it is goblins',
    from: '    out.push(...(balance ? roundRobinByTier(ordered, pg) : ordered.slice(0, pg)));',
    to: '    out.push(...ordered.slice(0, pg));' },

  { id: 'balanced-single-tier', suite: 'balanced-run', file: 'netlify/functions/bet-finder-background.js',
    what: 'the round robin only ever visits goblins',
    from: "  const order = ['goblin', 'standard', 'demon'].filter((t) => byTier[t]?.length);",
    to: "  const order = ['goblin'].filter((t) => byTier[t]?.length);" },

  { id: 'prop-filter-substring-only', suite: 'prop-filter', file: 'netlify/functions/bet-finder-background.js',
    what: 'an exact stat name is matched by substring, so "Hits" drags in Hits Allowed',
    from: '  const hasExact = wantStat ? rows.some((r) => namesOf(r).includes(wantStat)) : false;',
    to: '  const hasExact = false;' },

  { id: 'today-flag-ignored', suite: 'prop-filter', file: 'netlify/functions/bet-finder-background.js',
    what: "PrizePicks' own today flag is ignored, so late games drop after UTC rolls over",
    from: "  return rows.filter((r) => (typeof r.today === 'boolean' ? r.today : String(r.start).startsWith(td)));",
    to: '  return rows.filter((r) => String(r.start).startsWith(td));' },

  { id: 'ledger-filter-off', suite: 'ledger-rejudge', file: 'netlify/functions/bet-finder-background.js',
    what: 'a ledger re-judge scans the whole board at full price',
    from: '      rows = rows.filter((r) => want.has(`${r.player}|${r.stat}|${Number(r.line)}`));',
    to: '      rows = rows.filter(() => true);' },

  { id: 'ledger-source-untagged', suite: 'ledger-rejudge', file: 'netlify/functions/bet-finder-background.js',
    what: 'a re-judge overwrites the morning forecast instead of landing beside it',
    from: "        ...(params.fromLedger ? { source: 'ledger' } : {}),",
    to: '        ...({}),' },

  { id: 'voids-not-applied', suite: 'dnp-void', file: 'netlify/functions/bet-finder-background.js',
    what: 'confirmed DNPs stay on the board and get judged',
    from: '    const voided = candidates.filter((c) => c.voidReason);\n    const live = candidates.filter((c) => !c.voidReason);',
    to: '    const voided = candidates.filter((c) => c.voidReason);\n    const live = candidates;' },

  // ---- grading ----------------------------------------------------------
  { id: 'settle-push-as-loss', suite: 'push', file: 'netlify/functions/grade-picks.js',
    what: 'a prop landing exactly on its line is graded a loss instead of a refund',
    from: '  if (a === l) return { result: a, hit: null, push: true };',
    to: '  if (a === l && false) return { result: a, hit: null, push: true };' },

  { id: 'settle-absent-as-zero', suite: 'push', file: 'netlify/functions/grade-picks.js',
    what: 'an absent stat settles as a genuine zero — the DNP-scored-as-a-loss bug',
    from: "  if (actual == null || actual === '' || line == null || line === '') return null;",
    to: "  if (line == null || line === '') return null;" },

  { id: 'grade-write-vanishes', suite: 'grade-cleanup', file: 'netlify/functions/grade-picks.js',
    what: 'grading runs and never persists a result',
    from: '    if (!dry && (processed > 0 || combosMarked > 0 || reset > 0 || repaired > 0 || revived > 0)) await store.setJSON(date, picks);',
    to: '    if (false) await store.setJSON(date, picks);' },

  { id: 'cleanup-write-vanishes', suite: 'grade-cleanup', file: 'netlify/functions/grade-cleanup.js',
    what: 'cleanup reports what it marked and writes none of it',
    from: '      if (touched && !dry) await store.setJSON(date, picks);',
    to: '      if (false) await store.setJSON(date, picks);' },

  // ---- form ---------------------------------------------------------------
  { id: 'form-avg-padded-to-five', suite: 'espn-form', file: 'netlify/functions/espn-grade.js',
    what: 'a three-game average is divided by five, so form reads low for anyone who missed games',
    from: '    c.avg = Math.round((last.reduce((a, b) => a + b, 0) / last.length) * 100) / 100;',
    to: '    c.avg = Math.round((last.reduce((a, b) => a + b, 0) / limit) * 100) / 100;' },

  { id: 'form-dnp-as-zero', suite: 'espn-form', file: 'netlify/functions/espn-grade.js',
    what: 'a day the player did not appear is recorded as a zero rather than absent',
    from: '      if (!m) continue;                       // did not play that day — not a zero',
    to: '      if (!m) { values.push(0); continue; }' },

  { id: 'injuries-questionable-voided', suite: 'espn-injuries', file: 'netlify/functions/espn-grade.js',
    what: 'QUESTIONABLE and DOUBTFUL players are voided, though they usually play',
    from: 'const OUT_STATUS = /^(out|injury_status_out|ir|injured_reserve|suspension|pup|nfi|did_not_play)$/i;',
    to: 'const OUT_STATUS = /^(out|injury_status_out|ir|injured_reserve|suspension|pup|nfi|did_not_play|questionable|doubtful)$/i;' },

  { id: 'injuries-exact-name-only', suite: 'espn-injuries', file: 'netlify/functions/espn-grade.js',
    what: 'a suffix mismatch lets a player ruled OUT straight through',
    from: '    const hit = matchPlayer(index, c.player)?.value;',
    to: '    const hit = inj[c.player];' },

  { id: 'espn-cache-vanishes', suite: 'espn-form', file: 'netlify/functions/espn-grade.js',
    what: 'the ESPN day cache is written nowhere, so every run re-fetches',
    from: '  if (s && data && ttlOf(data) > 0) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }',
    to: '  if (false) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }' },

  // ---- judge context (Task 2) --------------------------------------------
  { id: 'jc-snapshot-vanishes', suite: 'judge-context', file: 'netlify/functions/judge-context.js',
    what: 'the snapshot is built and never stored — the exact shape of the loadFn gap',
    from: "    await STORE().setJSON(keyFor(day, snap.runId), { v: 1, gz });",
    to: '    await Promise.resolve(gz);' },

  { id: 'jc-not-compressed', suite: 'judge-context', file: 'netlify/functions/judge-context.js',
    what: 'snapshots are stored uncompressed, where search text dominates the size',
    from: "    const gz = gzipSync(Buffer.from(JSON.stringify(record), 'utf8')).toString('base64');",
    to: "    const gz = Buffer.from(JSON.stringify(record), 'utf8').toString('base64');" },

  { id: 'jc-prune-noop', suite: 'judge-context', file: 'netlify/functions/judge-context.js',
    what: 'pruning counts what it would delete and deletes nothing',
    from: '    try { await store.delete(b.key); removed++; } catch { /* ignore */ }',
    to: '    try { removed++; } catch { /* ignore */ }' },

  // ---- the calibration cron ----------------------------------------------
  { id: 'cron-day-not-claimed', suite: 'calibration-cron', file: 'netlify/functions/calibration-cron.js',
    what: 'the day is never claimed, so the second firing pays for a second run',
    from: "  try { await STORE().setJSON('calibration-cron-day', { day, at: new Date().toISOString() }); } catch {}",
    to: '  try { await Promise.resolve(day); } catch {}' },

  { id: 'cron-heartbeat-vanishes', suite: 'calibration-cron', file: 'netlify/functions/calibration-cron.js',
    what: 'the cron heartbeat is written nowhere, so a silent cron is invisible',
    from: "    await store.setJSON('calibration-cron', log.slice(-30));",
    to: '    await Promise.resolve(log);' },

  { id: 'cron-not-balanced', suite: 'calibration-cron', file: 'netlify/functions/calibration-cron.js',
    what: 'the daily run is an ordinary board scan, so it is a sample of goblins',
    from: '          balance: true,',
    to: '          balance: false,' },

  { id: 'cron-league-cap-removed', suite: 'calibration-cron', file: 'netlify/functions/calibration-cron.js',
    what: 'a typo in the env var can launch twenty paid runs',
    from: '  .split(\',\').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 4);',
    to: "  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);" },

  // ---- slips --------------------------------------------------------------
  { id: 'slips-save-vanishes', suite: 'saved-slips', file: 'netlify/functions/slips.js',
    what: 'a saved slip is acknowledged and never stored',
    from: '    await s.setJSON(id, slip);',
    to: '    await Promise.resolve(slip);' },

  { id: 'slips-delete-noop', suite: 'saved-slips', file: 'netlify/functions/slips.js',
    what: 'deleting a slip reports success and leaves it there',
    from: '      await s.delete(String(body.id));',
    to: '      await Promise.resolve(body.id);' },

  { id: 'slip-grade-write-vanishes', suite: 'saved-slips', file: 'netlify/functions/grade-slips.js',
    what: 'a settled slip is graded in memory and never written back',
    from: '      if (touched && !dry) await store.setJSON(key, slip);',
    to: '      if (false) await store.setJSON(key, slip);' },

  { id: 'slip-picklog-vanishes', suite: 'slip-tier', file: 'netlify/functions/judge-slip-background.js',
    what: 'a judged slip never reaches the calibration log',
    from: '        await logStore.setJSON(day, [...byKey.values()]);',
    to: '        await Promise.resolve();' },

  // ---- mlb ---------------------------------------------------------------
  { id: 'mlb-cache-vanishes', suite: 'mlb-stats', file: 'netlify/functions/mlb-stats.js',
    what: 'the MLB cache is written nowhere',
    from: '  if (s) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }',
    to: '  if (false) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }' },

  { id: 'mlb-form-cache-vanishes', suite: 'mlb-grade', file: 'netlify/functions/mlb-grade.js',
    what: 'the MLB box-score cache is written nowhere',
    from: '  if (s && data) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }',
    to: '  if (false) { try { await s.setJSON(key, { at: Date.now(), data }); } catch {} }' },

  // ---- fantasy ------------------------------------------------------------
  { id: 'fantasy-result-vanishes', suite: 'fantasy-check', file: 'netlify/functions/fantasy-check-background.js',
    what: 'the fantasy check computes a result and stores nothing',
    from: "      await s.setJSON(RESULT_KEY, { ...state, at: new Date().toISOString() });",
    to: '      await Promise.resolve(state);' },

  // ======================================================================
  // The replay harness itself (Task 3). Its A/A verdict is the gate every
  // variant result will pass through, so an assertion that cannot catch it
  // being wrong is worse than no gate at all.
  // ======================================================================
  { id: 'replay-truncated-allowed', suite: 'replay', file: 'netlify/functions/judge-context.js',
    what: 'a snapshot that hit the search cap is replayed anyway, with less context than the original',
    from: '  && !snap.searchTruncated',
    to: '  && true' },

  { id: 'replay-searches-live', suite: 'replay', file: 'netlify/functions/replay-lib.js',
    what: 'the replay re-runs the searches live instead of replaying the stored ones',
    from: "  if (snap.search?.length) messages.push({ role: 'assistant', content: snap.search });",
    to: '  if (false) messages.push({});' },

  { id: 'replay-floor-vs-original', suite: 'replay', file: 'netlify/functions/replay-lib.js',
    what: 'the noise floor is measured against the original, so harness error is counted as noise',
    from: '  const floor = vsEachOther.length ? mean(vsEachOther.map((c) => c.meanAbsDiff)) : null;',
    to: '  const floor = vsOriginal.length ? mean(vsOriginal.map((c) => c.meanAbsDiff)) : null;' },

  { id: 'replay-fidelity-always-ok', suite: 'replay', file: 'netlify/functions/replay-lib.js',
    what: 'the fidelity gate passes everything',
    from: "    verdict: floor > 0 && toOriginal / floor > 2",
    to: '    verdict: false' },

  { id: 'replay-k-formula', suite: 'replay', file: 'netlify/functions/replay-lib.js',
    what: 'the runs-per-arm formula is off by the factor that accounts for two arms',
    from: '  return Math.max(1, Math.ceil(8 * (sdOfDiff / target) ** 2));',
    to: '  return Math.max(1, Math.ceil(4 * (sdOfDiff / target) ** 2));' },

  { id: 'replay-live-search-unreported', suite: 'replay', file: 'netlify/functions/replay-lib.js',
    what: 'a replay that went and searched again is averaged in silently',
    from: '    if (issued) warnings.push(`replay-${i + 1} issued ${issued} live search(es) — not an offline replay`);',
    to: '    if (false) warnings.push(String(issued));' },

  { id: 'replay-missing-props-folded', suite: 'replay', file: 'netlify/functions/replay-lib.js',
    what: 'a prop one run never answered is compared anyway, as a difference from undefined',
    from: '  const shared = [...A.keys()].filter((k) => B.has(k));',
    to: '  const shared = [...A.keys()];' },

  // ======================================================================
  // judge-replay-background.js / judge-replay-status.js — the server-side
  // transport around replay-lib.js. Thin, but the two failure modes that
  // matter (silently replaying a truncated snapshot, an unbounded k) are
  // exactly the ones a thin wrapper is most likely to drop while wiring it up.
  // ======================================================================
  { id: 'jrb-k-unbounded', suite: 'judge-replay-endpoint', file: 'netlify/functions/judge-replay-background.js',
    what: 'a caller-supplied k is trusted verbatim, so one bad request can fire hundreds of paid calls',
    from: '  const k = Math.max(1, Math.min(10, Number(body.k) || 5));   // 10 is a sanity cap, not a design choice',
    to: '  const k = Number(body.k) || 5;' },

  { id: 'jrb-missing-runid-not-checked', suite: 'judge-replay-endpoint', file: 'netlify/functions/judge-replay-background.js',
    what: 'a request with no runId starts a job anyway instead of failing fast',
    from: "    if (!runId) throw new Error('runId is required');",
    to: '    if (false) throw new Error(\'unreachable\');' },

  { id: 'jrb-error-not-stored', suite: 'judge-replay-endpoint', file: 'netlify/functions/judge-replay-background.js',
    what: 'a failed run answers the caller\'s empty 202 and writes nothing, so a poller waits forever — the platform discards the return value, so the store IS the answer',
    from: "    if (jobId) await jobs.setJSON(jobId, { status: 'error', message: String(err.message || err) });",
    to: '    if (false) await jobs.setJSON(jobId, {});' },
];

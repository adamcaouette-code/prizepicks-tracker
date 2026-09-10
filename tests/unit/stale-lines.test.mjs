// The stale-line monitor.
//
// ===========================================================================
// THE ASSERTION THAT MATTERS MOST IS `oddsRequests === 0`
//
// The brief says to assume The Odds API quota is the binding constraint. A
// 5-minute monitor that re-fetched book prices would cost ~26,000 credits a
// day on its own, on top of the ~13,000 the archive already spends. So the book
// side comes from the archive and the PrizePicks side — which is free, and is
// the side that goes stale — is fetched live.
//
// That is a design decision a later change could silently undo, so it is
// pinned: every mocked fetch in this suite is counted, and any call to an
// odds-api host fails the test.
// ===========================================================================

import fs from 'node:fs';
import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, seed, read } from '../helpers/blobs.mjs';

const CONFIG = JSON.parse(fs.readFileSync('netlify/functions/stale-lines-config.json', 'utf8'));
const WEIGHTS = JSON.parse(fs.readFileSync('netlify/functions/book-weights.json', 'utf8'));
const MODELS = JSON.parse(fs.readFileSync('netlify/functions/market-models.json', 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const snapRow = (over, line = 3.5) => ({
  league: 'mlb', player: 'Nick Martinez', market: 'Pitcher Strikeouts',
  book_market: 'pitcher_strikeouts', pp_line: line, pp_tier: 'standard',
  books: [
    { book: 'draftkings', line, over_price: over, under_price: -110 },
    { book: 'fanduel', line, over_price: over + 2, under_price: -112 },
  ],
  book_status: 'ok',
});

const capture = (at, rows) => ({
  key: `capture/${at}`, captured_at: at, is_closing: false, event_id: null,
  count: rows.length, rows,
});

export default async function ({ t }) {
  reset();
  const S = await loadFn('stale-lines.js');

  // =========================================================================
  // 1. The gap
  //
  //   A standard tier needs 4.75^(-1/3) = 59.49% to break even on the over.
  //   DK -116 / -110 de-vigs (additive == Shin on two-way) to 50.66%, so the
  //   market says this over is a LOSER by about 8.8 points. A gap is only a
  //   signal when it points the other way.
  // =========================================================================
  t.ok('the standard break-even is 4.75^(-1/3) = 59.49%',
    near(S.TIER_BREAK_EVEN.standard, Math.pow(4.75, -1 / 3), 1e-12),
    S.TIER_BREAK_EVEN.standard.toFixed(6));
  t.ok('...goblin needs far more', S.TIER_BREAK_EVEN.goblin > 0.79, String(S.TIER_BREAK_EVEN.goblin));
  t.ok('...and a demon far less', S.TIER_BREAK_EVEN.demon < 0.44, String(S.TIER_BREAK_EVEN.demon));

  const flat = S.gapFor({ pp_line: 3.5, pp_tier: 'standard' }, snapRow(-116), { weights: WEIGHTS, models: MODELS });
  t.ok('a fairly-priced prop shows a negative gap against the standard bar',
    flat.gap < 0 && flat.gap > -0.12, `${(flat.gap * 100).toFixed(2)}pp`);
  t.ok('...reporting both sides so the number can be checked',
    flat.bookProb != null && flat.breakEven != null && flat.bookLine === 3.5, '');

  //   A book that loves the over: -260 / -110 de-vigs to 59.92%, just past the
  //   59.49% bar, so the gap turns positive.
  const juicy = S.gapFor({ pp_line: 3.5, pp_tier: 'standard' }, snapRow(-260), { weights: WEIGHTS, models: MODELS });
  t.ok('a book pricing the over well above the tier bar shows a POSITIVE gap',
    juicy.gap > 0, `${(juicy.gap * 100).toFixed(2)}pp`);

  //   A demon only needs 43.68%, so the same fair price is a big positive gap.
  const demon = S.gapFor({ pp_line: 3.5, pp_tier: 'demon' }, snapRow(-116), { weights: WEIGHTS, models: MODELS });
  t.ok('the SAME book price is a large edge on a demon, because the bar is lower',
    demon.gap > 0.06, `${(demon.gap * 100).toFixed(2)}pp`);
  t.ok('...which is the tier doing the work, not the market', near(demon.bookProb, flat.bookProb), '');

  //   Refusals carry reasons, never numbers.
  t.ok('a prop with no archived capture refuses by name',
    S.gapFor({ pp_line: 3.5, pp_tier: 'standard' }, null).gap === null, '');
  t.ok('...saying so', /no archived book price/.test(S.gapFor({ pp_line: 3.5, pp_tier: 'standard' }, null).reason), '');
  t.ok('an unknown tier refuses rather than assuming standard',
    /unknown tier/.test(S.gapFor({ pp_line: 3.5, pp_tier: 'mystery' }, snapRow(-116)).reason), '');
  const far = S.gapFor({ pp_line: 12.5, pp_tier: 'standard' }, snapRow(-116), { weights: WEIGHTS, models: MODELS });
  t.ok('a PP line too far from the book to translate refuses', far.gap === null, '');
  t.ok('...naming the distance', /sd from the book line/.test(far.reason), far.reason);

  // =========================================================================
  // 2. PERSISTENCE — requirement 2
  //
  // A run continues only while the SIGN holds and both observations clear the
  // minimum. A gap flipping +4pp / -2pp / +4pp has been noise for three cycles,
  // not a three-cycle edge, and counting raw consecutive observations would let
  // a market oscillating around zero accumulate a "twenty minute" gap.
  // =========================================================================
  const t0 = '2026-09-10T12:00:00.000Z';
  const t5 = '2026-09-10T12:05:00.000Z';
  const t10 = '2026-09-10T12:10:00.000Z';
  const t20 = '2026-09-10T12:20:00.000Z';

  let h = S.updateHistory(null, { gap: 0.05, at: t0, minGap: 0.02 });
  t.eq('a first sighting is one observation', h.observations, 1);
  t.eq('...having held for no time at all', h.heldMs, 0);
  h = S.updateHistory(h, { gap: 0.055, at: t5, minGap: 0.02 });
  h = S.updateHistory(h, { gap: 0.048, at: t10, minGap: 0.02 });
  t.eq('a gap holding its sign accumulates observations', h.observations, 3);
  t.eq('...and ten minutes of history', h.heldMs, 10 * 60000);

  const flipped = S.updateHistory(h, { gap: -0.03, at: t20, minGap: 0.02 });
  t.eq('A SIGN FLIP RESETS THE RUN', flipped.observations, 1);
  t.eq('...back to zero elapsed', flipped.heldMs, 0);

  const faded = S.updateHistory(h, { gap: 0.005, at: t20, minGap: 0.02 });
  t.eq('...and so does fading under the minimum gap', faded.observations, 1);

  //   The smallest gap during the run is kept, so a run that dipped is not
  //   reported as if it had held its current size throughout.
  const dipped = S.updateHistory(
    S.updateHistory(S.updateHistory(null, { gap: 0.08, at: t0, minGap: 0.02 }),
      { gap: 0.021, at: t5, minGap: 0.02 }),
    { gap: 0.075, at: t10, minGap: 0.02 },
  );
  t.eq('a run that dipped records how far it dipped', Number(dipped.minGapInRun.toFixed(3)), 0.021);
  t.eq('...while still counting as one run', dipped.observations, 3);

  // =========================================================================
  // 3. VELOCITY — requirement 3
  //
  //   Four archived observations 15 minutes apart, the book rising 1pp each:
  //   0.50, 0.51, 0.52, 0.53 over 45 minutes = 0.03 in 0.75h = 0.04/hour.
  // =========================================================================
  const rising = [
    { at: '2026-09-10T11:15:00.000Z', bookProb: 0.50 },
    { at: '2026-09-10T11:30:00.000Z', bookProb: 0.51 },
    { at: '2026-09-10T11:45:00.000Z', bookProb: 0.52 },
    { at: '2026-09-10T12:00:00.000Z', bookProb: 0.53 },
  ].map((s) => ({ ...s, at: new Date(Date.now() - (Date.parse('2026-09-10T12:00:00.000Z') - Date.parse(s.at))).toISOString() }));
  const v = S.velocity(rising, { windowMin: 60 });
  t.ok('a book rising 1pp per 15 minutes measures as 4pp/hour',
    near(v.perHour, 0.04, 1e-6), `${(v.perHour * 100).toFixed(6)}pp/h`);
  t.eq('...from all four observations', v.n, 4);

  t.ok('two observations are not a trend',
    S.velocity(rising.slice(0, 2)).perHour === null, '');
  t.ok('...and it says why', /fewer than three/.test(S.velocity(rising.slice(0, 2)).reason), '');
  const flatV = S.velocity(rising.map((s) => ({ ...s, bookProb: 0.5 })));
  t.ok('a book going nowhere measures as zero, not null', near(flatV.perHour, 0, 1e-12), String(flatV.perHour));

  // =========================================================================
  // 4. SCORING — magnitude x persistence x velocity
  // =========================================================================
  const base = { gap: 0.05, heldMs: 20 * 60000, velocityPerHour: null };
  const s20 = S.score(base, CONFIG);
  t.ok('at the 20-minute half-saturation point persistence is exactly 0.5',
    near(s20.persistence, 0.5, 1e-12), String(s20.persistence));
  const s0 = S.score({ ...base, heldMs: 0 }, CONFIG);
  t.ok('a brand-new gap scores below one that has held', s0.score < s20.score,
    `${s0.score.toFixed(4)} vs ${s20.score.toFixed(4)}`);

  //   PERSISTENCE SATURATES. Six hours is not eighteen times twenty minutes.
  const s6h = S.score({ ...base, heldMs: 6 * 3600000 }, CONFIG);
  t.ok('six hours is worth less than double twenty minutes, not eighteen times',
    s6h.score < s20.score * 2, `${s20.score.toFixed(4)} -> ${s6h.score.toFixed(4)}`);

  //   VELOCITY ONLY COUNTS TOWARD THE GAP — requirement 3's ranking rule.
  const moving = S.score({ ...base, velocityPerHour: 0.10 }, CONFIG);
  const against = S.score({ ...base, velocityPerHour: -0.10 }, CONFIG);
  t.ok('a book sprinting toward the gap scores far above a still one',
    moving.score > s20.score * 1.9, `${s20.score.toFixed(4)} -> ${moving.score.toFixed(4)}`);
  t.ok('...and that is the strongest single lever in the score', moving.velocityBonus === 1, String(moving.velocityBonus));
  t.ok('a book moving AGAINST the gap earns no bonus', against.velocityBonus === 0, String(against.velocityBonus));
  t.ok('...but is never penalised twice — the closing gap is already smaller',
    near(against.score, s20.score), '');

  // =========================================================================
  // 5. ALERT GATING — requirements 4 and 5
  // =========================================================================
  const good = { gap: 0.06, heldMs: 15 * 60000, bookCount: 3 };
  t.ok('a big, held, well-priced gap fires', S.alertDecision(good, { config: CONFIG }).fire === true, '');

  const small = S.alertDecision({ ...good, gap: 0.02 }, { config: CONFIG });
  t.ok('a gap under the threshold does not', small.fire === false, '');
  t.eq('...gated on the edge', small.gate, 'edge');
  t.ok('...naming the number that failed', /2\.0pp is under the 4pp threshold/.test(small.why), small.why);

  const brief = S.alertDecision({ ...good, heldMs: 3 * 60000 }, { config: CONFIG });
  t.eq('a gap that has only just appeared is gated on confidence, not edge', brief.gate, 'confidence');
  t.ok('...naming how long it has held', /held for 3m/.test(brief.why), brief.why);

  const oneBook = S.alertDecision({ ...good, bookCount: 1 }, { config: CONFIG });
  t.eq('a single book quoting it is not a market', oneBook.gate, 'confidence');
  t.ok('...and says so', /only 1 book/.test(oneBook.why), oneBook.why);

  //   THE COOLDOWN — requirement 5's 10 minutes, per prop.
  const now = Date.parse('2026-09-10T12:00:00.000Z');
  const cooled = S.alertDecision(good, {
    config: CONFIG, now, lastAlertAt: new Date(now - 4 * 60000).toISOString(),
  });
  t.eq('an alert 4 minutes ago suppresses this one', cooled.gate, 'cooldown');
  t.ok('...saying how long ago', /alerted 4m ago, inside the 10m cooldown/.test(cooled.why), cooled.why);
  t.ok('an alert 11 minutes ago does not', S.alertDecision(good, {
    config: CONFIG, now, lastAlertAt: new Date(now - 11 * 60000).toISOString(),
  }).fire === true, '');

  //   THE SECOND RATE LIMIT, which is the one that matters on a volatile slate.
  //   A per-prop cooldown does nothing when forty different props qualify at
  //   once — that is forty alerts, none of them repeats.
  const flood = S.alertDecision(good, { config: CONFIG, firedThisRun: 5 });
  t.eq('a run that has already sent five stops', flood.gate, 'rate-limit');
  t.ok('...which is what stops a whole slate spamming, not the per-prop cooldown',
    S.alertDecision(good, { config: CONFIG, firedThisRun: 4 }).fire === true, '');

  //   The alert text — requirement 4's contents.
  const text = S.alertText({
    player: 'Nick Martinez', market: 'Pitcher Strikeouts', ppLine: 3.5, tier: 'standard',
    gap: 0.062, bookProb: 0.657, breakEven: 0.595, heldMs: 25 * 60000, observations: 5,
    bookLine: 2.5, translated: true, velocityPerHour: 0.08, bookCount: 3,
  });
  t.ok('the alert names the player and market', /Nick Martinez Pitcher Strikeouts/.test(text), text);
  t.ok('...the side and the PP line', /OVER 3\.5/.test(text), '');
  t.ok('...both probabilities', /65\.7% vs 59\.5% needed/.test(text), '');
  t.ok('...the gap in probability points', /gap \+6\.2pp/.test(text), '');
  t.ok('...how long it has held', /held 25m across 5 checks/.test(text), '');
  t.ok('...the book line, flagged when translated', /book line 2\.5 \(translated\)/.test(text), '');
  t.ok('...and how fast the book is moving', /moving \+8\.0pp\/h/.test(text), '');

  // =========================================================================
  // 6. THE RUN — and the zero-quota promise
  // =========================================================================
  reset();
  const at = new Date().toISOString();
  const older = new Date(Date.now() - 20 * 60000).toISOString();
  seed('line-snapshots', `capture/${older}`, capture(older, [snapRow(-140)]));
  seed('line-snapshots', `capture/${at}`, capture(at, [snapRow(-260)]));

  const props = [{ player: 'Nick Martinez', stat: 'Pitcher Strikeouts', line: 3.5, oddsType: 'demon' }];
  const m = mockFetch([]);
  let out;
  try {
    out = await S.run({ league: 'mlb', config: CONFIG, weights: WEIGHTS, models: MODELS, props });
    t.eq('THE RUN SPENDS NO ODDS API QUOTA', out.oddsRequests, 0);
    t.eq('...and makes no HTTP calls at all when the board is supplied', m.calls.length, 0);
    t.ok('...never touching an odds-api host',
      !m.calls.some((c) => /odds-?api/i.test(c.url)), m.calls.map((c) => c.url).join(' '));
  } finally { m.restore(); }

  t.eq('the prop is compared against the archive', out.compared, 1);
  t.ok('...and the book price used is the LATEST capture, not the older one',
    out.top[0].gapPP > 15, `${out.top[0].gapPP.toFixed(1)}pp`);
  t.ok('the archive age is reported, because the book side is up to 10 minutes old',
    out.archive.ageMs != null && out.archive.ageMs < 60000, String(out.archive.ageMs));
  t.eq('two captures were read', out.archive.captures, 2);

  //   First sighting: a real edge, but it has not held, so nothing fires.
  t.eq('a brand-new gap does not alert, however large', out.alertCount, 0);
  t.eq('...gated on confidence', Object.keys(out.gatedBy)[0], 'confidence');
  t.ok('...and the state was written for next time', read('stale-line-state', 'state/mlb') != null, '');

  //   Second run, 15 minutes later: the same gap, now held.
  const later = Date.now() + 15 * 60000;
  const out2 = await S.run({ league: 'mlb', config: CONFIG, weights: WEIGHTS, models: MODELS, props, now: later });
  t.eq('the same gap 15 minutes later DOES alert', out2.alertCount, 1);
  t.ok('...with the full alert text', /Nick Martinez/.test(out2.alerts[0]), out2.alerts[0]);
  t.ok('...and it was logged even with no webhook configured',
    (read('stale-line-alerts', `log/${new Date(later).toISOString().slice(0, 10)}`) || []).length === 1, '');
  t.ok('...saying delivery was not configured rather than claiming success',
    out2.delivery.delivered === false && /STALE_LINE_WEBHOOK/.test(out2.delivery.reason), out2.delivery.reason);

  //   Third run, one minute after that: suppressed by the cooldown.
  const out3 = await S.run({ league: 'mlb', config: CONFIG, weights: WEIGHTS, models: MODELS, props, now: later + 60000 });
  t.eq('a minute later the same prop is suppressed', out3.alertCount, 0);
  t.eq('...by the cooldown, not by the edge gate', Object.keys(out3.gatedBy)[0], 'cooldown');

  //   A prop the archive has never seen is skipped by name, not alerted on.
  const unknown = await S.run({
    league: 'mlb', config: CONFIG, weights: WEIGHTS, models: MODELS,
    props: [{ player: 'Nobody At All', stat: 'Pitcher Strikeouts', line: 3.5, oddsType: 'standard' }],
    now: later + 120000,
  });
  t.eq('a prop with no archived price is not compared', unknown.compared, 0);
  t.ok('...and the reason is counted', unknown.skipped['no archived book price for this prop'] === 1,
    JSON.stringify(unknown.skipped));
  t.eq('...with no alert', unknown.alertCount, 0);

  // =========================================================================
  // 7. DELIVERY — requirement 4, "wherever is simplest"
  // =========================================================================
  const m2 = mockFetch([[/hooks\.example/, () => ({ ok: true })]]);
  try {
    const d = await S.deliver([{ text: 'a stale line' }], { webhook: 'https://hooks.example/abc' });
    t.ok('an alert POSTs to a webhook', d.delivered === true, JSON.stringify(d));
    t.eq('...one request', m2.calls.length, 1);
    const body = JSON.parse(m2.calls[0].init.body);
    t.ok('...carrying a human-readable text field, which is all Slack/Discord/ntfy need',
      /a stale line/.test(body.text), body.text);
    t.ok('...and the structured alerts beside it', Array.isArray(body.alerts), '');
  } finally { m2.restore(); }
  t.ok('with no webhook set, delivery reports the gap rather than failing silently',
    (await S.deliver([{ text: 'x' }], { webhook: null })).delivered === false, '');

  // =========================================================================
  // 8. DID IT CONVERGE — requirement 6, the evidence
  //
  // Scored on the BOOK's subsequent movement rather than on whether the prop
  // won. One prop's result is a coin flip; market movement is a measurement
  // with a sample size, available in an hour instead of after grading.
  // =========================================================================
  reset();
  const alertAt = new Date(Date.now() - 30 * 60000).toISOString();
  const afterAt = new Date(Date.now() - 5 * 60000).toISOString();
  const key = `mlb|nick martinez|pitcher strikeouts|3.5`;
  seed('stale-line-alerts', `log/${alertAt.slice(0, 10)}`, [
    { alertedAt: alertAt, key, league: 'mlb', player: 'Nick Martinez', market: 'Pitcher Strikeouts',
      tier: 'demon', ppLine: 3.5, bookLine: 3.5, bookProbAtAlert: 0.55, breakEven: 0.4368,
      gap: 0.11, heldMs: 900000, observations: 3, bookCount: 2, score: 1, text: 'x', outcome: null },
  ]);
  // The book kept going up, which is the direction the positive gap pointed.
  seed('line-snapshots', `capture/${afterAt}`, capture(afterAt, [snapRow(-300)]));

  const fu = await S.followUp({ day: alertAt.slice(0, 10), weights: WEIGHTS, config: CONFIG });
  t.eq('the alert resolves', fu.alerts, 1);
  t.eq('...as converged, because the book moved the way the gap pointed', fu.converged, 1);
  t.eq('...and the log now carries the outcome',
    (read('stale-line-alerts', `log/${alertAt.slice(0, 10)}`) || [])[0].outcome, 'converged');
  t.ok('ONE alert is not evidence, and the verdict says so',
    /too few to conclude/.test(fu.verdict), fu.verdict);

  //   The opposite case must be counted as a loss, not rounded away.
  reset();
  seed('stale-line-alerts', `log/${alertAt.slice(0, 10)}`, [
    { alertedAt: alertAt, key, bookProbAtAlert: 0.65, gap: 0.11, outcome: null },
  ]);
  seed('line-snapshots', `capture/${afterAt}`, capture(afterAt, [snapRow(-116)]));
  const fu2 = await S.followUp({ day: alertAt.slice(0, 10), weights: WEIGHTS, config: CONFIG });
  t.eq('a book that came back the other way is counted as reverted', fu2.reverted, 1);
  t.eq('...not as converged', fu2.converged, 0);
  t.eq('...and the convergence rate reflects it', fu2.convergenceRate, 0);
}

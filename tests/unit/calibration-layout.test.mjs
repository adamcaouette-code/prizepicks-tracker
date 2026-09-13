// The v4.53.0 redesign: three questions instead of seventeen flat sections,
// each a <details> that answers itself before it is opened. This file pins
// the layout contract specifically — the data these sections show is already
// covered by calibration.test.mjs and guardrail-measure.test.mjs.

import { loadFn } from '../helpers/fn.mjs';
import { reset, seed } from '../helpers/blobs.mjs';

const DAY = '2026-08-14';
const mk = (o) => ({
  date: DAY, loggedAt: `${DAY}T18:00:00Z`, league: 'mlb', source: 'board',
  verdict: 'play', gradedAt: `${DAY}T23:00:00Z`, judgeModel: 'claude-haiku-4-5-20251001', ...o,
});

export default async function ({ t }) {
  reset();
  // A believable slate: all three tiers, enough per tier to clear every
  // sample-size gate the page applies (BASELINE_MIN_TIER_N, MIN_SLICE_N, the
  // guardrail's own n>=50 "dim" floor).
  const rows = [
    ...Array.from({ length: 60 }, (_, i) => mk({
      projectionId: `g${i}`, player: `G${i}`, stat: 'Hits', line: 0.5, oddsType: 'goblin',
      prob: 0.70, hit: i < 42, result: i < 42 ? 1 : 0,
    })),
    ...Array.from({ length: 60 }, (_, i) => mk({
      projectionId: `s${i}`, player: `S${i}`, stat: 'Hits', line: 0.5, oddsType: 'standard',
      prob: 0.50, hit: i < 24, result: i < 24 ? 1 : 0,
    })),
    ...Array.from({ length: 60 }, (_, i) => mk({
      projectionId: `d${i}`, player: `D${i}`, stat: 'Hits', line: 0.5, oddsType: 'demon',
      prob: 0.30, hit: i < 15, result: i < 15 ? 1 : 0,
    })),
  ];
  seed('pick-log', DAY, rows);

  const cal = await loadFn('calibration.js');
  const html = (await cal.handler({ queryStringParameters: {} })).body;

  // ---- 1. each of the three sections renders its answer while collapsed ---
  const sections = [...html.matchAll(/<details class="qsection">([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
  t.eq('three question sections plus Housekeeping render', sections.length, 4);
  t.ok('none of them carry the "open" attribute — collapsed by default',
    !/<details class="qsection"\s+open/.test(html), '');

  const titles = ['Are its numbers honest?', 'Does it make money?', 'Is it getting better?', 'Housekeeping'];
  titles.forEach((title, i) => {
    const s = sections[i];
    t.ok(`"${title}" is present in its own <summary>`, s.includes(title), s.slice(0, 200));
    // The answer line lives inside <summary>, which native <details> always
    // renders regardless of the open/closed state — no JS toggle required.
    t.ok(`...and carries a real qanswer/qsub, not a placeholder`,
      /class="qanswer[^"]*">\S/.test(s) || /class="qsub">\S/.test(s), s.slice(0, 300));
  });

  // The three real questions each answer something specific, not "TBD".
  t.ok('honesty answers with a real word (close/a bit off/overstated)',
    /class="qanswer (good|mid|bad)">(close|a bit off|overstated)</.test(sections[0]), sections[0].slice(0, 200));
  t.ok('money answers yes/no/partially given three losing tiers',
    /class="qanswer bad">no</.test(sections[1]), sections[1].slice(0, 200));
  t.ok('...naming the widest gap by tier', /widest gap is (goblin|standard|demon)/.test(sections[1]));

  // ---- 2. a tier meter draws its own tier's break-even ---------------------
  const BE = { goblin: 2 ** (-1 / 3), standard: 4.75 ** (-1 / 3), demon: 12 ** (-1 / 3) };
  for (const tier of ['goblin', 'standard', 'demon']) {
    const label = tier[0].toUpperCase() + tier.slice(1);
    const idx = html.indexOf(`<span>${label}</span>`);
    t.ok(`${tier}'s meter block is present`, idx !== -1, tier);
    const block = html.slice(idx, idx + 1200);
    const tick = block.match(/etick" style="left:([\d.]+)%/);
    t.ok(`...and it draws an etick`, !!tick, block.slice(0, 300));
    t.ok(`...at ITS OWN break-even (${(BE[tier] * 100).toFixed(1)}%), not another tier's`,
      tick && Math.abs(Number(tick[1]) - BE[tier] * 100) < 0.15,
      `${tier}: drew ${tick && tick[1]}, expected ${(BE[tier] * 100).toFixed(1)}`);
  }
  // Two different tiers must not draw the same tick position.
  const goblinTick = html.slice(html.indexOf('<span>Goblin</span>')).match(/etick" style="left:([\d.]+)%/)[1];
  const demonTick = html.slice(html.indexOf('<span>Demon</span>')).match(/etick" style="left:([\d.]+)%/)[1];
  t.ok('goblin and demon meters draw DIFFERENT ticks — each is its own tier, not a shared constant',
    goblinTick !== demonTick, `${goblinTick} vs ${demonTick}`);

  // ---- 3. the Brier comparison is a two-marker axis, never a fill meter ---
  const verdictIdx = html.indexOf('class="verdict');
  t.ok('the verdict block renders', verdictIdx !== -1, '');
  // Bounded by the first collapsible section (Honesty) rather than a guessed
  // closing tag — the verdict box and the state-note callout beside it both
  // sit before it, and neither should ever contain a fill meter.
  const verdictBlock = html.slice(verdictIdx, html.indexOf('<details class="qsection">'));
  t.ok('...using the two-marker axis (baxis/bmark/bgap), not the edge meter',
    /class="baxis"/.test(verdictBlock) && /class="bmark/.test(verdictBlock), verdictBlock.slice(0, 200));
  t.ok('...and it never uses .emeter or .efill — those read backwards for a lower-is-better score',
    !/class="emeter"/.test(verdictBlock) && !/class="efill/.test(verdictBlock), verdictBlock);
  t.ok('...carrying both the baseline number and the judge number as separate marks',
    /class="bmark base"/.test(verdictBlock) && /class="bmark judge/.test(verdictBlock), '');

  // No fixture anywhere on the page should render a fill-style meter for a
  // Brier number — .emeter is reserved for rate-vs-break-even (tier/guardrail).
  t.ok('the tier-only baseline card is worded, not meter-bar-shaped, in the verdict',
    /tier-only baseline/.test(verdictBlock), '');

  // ---- a thin tier is dimmed, and can't swing the headline verdict --------
  // Found in review: the tier meters and the "Does it make money?" answer had
  // no small-sample floor at all, unlike every other bucket on the page (the
  // guardrail/edge-verdict/deep-dive meters all dim below n=50). A tier with a
  // handful of picks could otherwise flip the headline on noise.
  reset();
  const thinRows = [
    // demon: only 6 picks, hitting well above its own break-even (0.437) —
    // exactly the kind of lucky-looking thin sample that must not decide
    // the page's headline by itself.
    ...Array.from({ length: 6 }, (_, i) => mk({
      projectionId: `td${i}`, player: `TD${i}`, stat: 'Hits', line: 0.5, oddsType: 'demon',
      prob: 0.80, hit: i < 5, result: i < 5 ? 1 : 0,
    })),
    // goblin: a real, decisive sample that clearly falls short.
    ...Array.from({ length: 60 }, (_, i) => mk({
      projectionId: `tg${i}`, player: `TG${i}`, stat: 'Hits', line: 0.5, oddsType: 'goblin',
      prob: 0.70, hit: i < 42, result: i < 42 ? 1 : 0,
    })),
  ];
  seed('pick-log', DAY, thinRows);
  const calThin = await loadFn('calibration.js');
  const htmlThin = (await calThin.handler({ queryStringParameters: {} })).body;
  const demonBlock = htmlThin.slice(htmlThin.indexOf('<span>Demon</span>'), htmlThin.indexOf('<span>Demon</span>') + 700);
  t.ok('a thin tier (n=6) draws its meter dimmed, not a confident green',
    /efill dim/.test(demonBlock), demonBlock);
  t.ok('...and the mrow-gap number beside it is dimmed too, not colour-coded',
    /mrow-gap dim/.test(demonBlock), demonBlock);
  const moneySection = htmlThin.slice(htmlThin.indexOf('Does it make money?'), htmlThin.indexOf('Does it make money?') + 400);
  t.ok('the headline verdict is decided by the real (n=60) tier, not the thin (n=6) one',
    /class="qanswer bad">no</.test(moneySection), moneySection);

  // ---- the over/close/short split is symmetric around break-even ----------
  // Found in review: any positive gap was unconditionally "over" (green) with
  // no significance check, while only a negative gap could be downgraded to
  // "close" (amber). A tier landing a fraction of a point above its own bar,
  // on too few picks to tell from noise, must read the same as one a fraction
  // below it — not a confirmed win.
  reset();
  const closeRows = Array.from({ length: 20 }, (_, i) => mk({
    projectionId: `cg${i}`, player: `CG${i}`, stat: 'Hits', line: 0.5, oddsType: 'goblin',
    // 16 of 20 hit = 80%, just above the 79.4% break-even — a lead far too
    // small on n=20 to be anything but noise (this whole bucket is also
    // dimmed by the n<50 floor above, so check the classification logic
    // directly against a bucket sized to be "decisive" by n but not by sigma).
    prob: 0.70, hit: i < 16, result: i < 16 ? 1 : 0,
  }));
  // A second goblin bucket, sized past the dim floor, whose rate sits barely
  // above break-even (0.795 vs 0.794) — decisive by n, not by sigma.
  const barelyOver = Array.from({ length: 60 }, (_, i) => mk({
    projectionId: `bg${i}`, player: `BG${i}`, stat: 'Hits', line: 0.5, oddsType: 'goblin',
    prob: 0.70, hit: i < 48, result: i < 48 ? 1 : 0, // 48/60 = 80.0%, ~0.15σ above 79.4%
  }));
  seed('pick-log', DAY, barelyOver);
  const calBarely = await loadFn('calibration.js');
  const htmlBarely = (await calBarely.handler({ queryStringParameters: {} })).body;
  const barelyBlock = htmlBarely.slice(htmlBarely.indexOf('<span>Goblin</span>'), htmlBarely.indexOf('<span>Goblin</span>') + 700);
  t.ok('a gap barely above break-even, not significant, reads as inconclusive (amber) — not a confirmed clear',
    /efill close/.test(barelyBlock) && !/efill over/.test(barelyBlock), barelyBlock);

  // ---- the unpriced guardrail note never leaves a dangling separator ------
  // Found in review: the unpriced bucket's note always concatenated a
  // trailing " — " because its sigma/EV are always null (no break-even
  // exists for a side with no known payout).
  reset();
  const unpricedRows = Array.from({ length: 10 }, (_, i) => mk({
    projectionId: `up${i}`, player: `UP${i}`, stat: 'Hits', line: 0.5, oddsType: 'demon',
    side: 'under', prob: 0.30, verdict: 'lean', hit: i < 3, result: i < 3 ? 1 : 0,
  }));
  seed('pick-log', DAY, unpricedRows);
  const calUnpriced = await loadFn('calibration.js');
  const htmlUnpriced = (await calUnpriced.handler({ queryStringParameters: {} })).body;
  t.ok('the unpriced bucket note reads plainly, with no dangling " — "',
    /payout unknown<\/div>/.test(htmlUnpriced) && !/payout unknown — </.test(htmlUnpriced), '');

  // ---- an unrecognized oddsType still gets a row, not silent disappearance
  // Found in review: tierMeters only ever walked the three known tiers, so a
  // pick logged under an unmapped oddsType (bucketed as its own key in
  // a.byTier, same as everywhere else on this page) had no visible row at all
  // in the redesigned "By tier" section.
  reset();
  const weirdRows = Array.from({ length: 12 }, (_, i) => mk({
    projectionId: `wx${i}`, player: `WX${i}`, stat: 'Hits', line: 0.5, oddsType: 'exotic',
    prob: 0.55, hit: i < 6, result: i < 6 ? 1 : 0,
  }));
  seed('pick-log', DAY, weirdRows);
  const calWeird = await loadFn('calibration.js');
  const jsonWeird = JSON.parse((await calWeird.handler({ queryStringParameters: { format: 'json' } })).body);
  t.eq('the unrecognized tier is really there in byTier, same as any other', jsonWeird.byTier.exotic?.n, 12);
  const htmlWeird = (await calWeird.handler({ queryStringParameters: {} })).body;
  t.ok('...and it renders its own row in "By tier", not just the three known tiers',
    /<span>exotic<\/span>/.test(htmlWeird), htmlWeird.slice(htmlWeird.indexOf('By tier'), htmlWeird.indexOf('By tier') + 50));
  t.ok('...priced as "unknown" rather than a fabricated break-even',
    /class="needs">price unknown<\/span>/.test(htmlWeird.slice(htmlWeird.indexOf('<span>exotic</span>'))), '');
}

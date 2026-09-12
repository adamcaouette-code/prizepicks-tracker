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
}

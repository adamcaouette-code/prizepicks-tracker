// Unders, and how the recommended slip is actually built.
//
// THE CONTRACT THAT MUST NOT BREAK: every judged probability is P(OVER), and the
// calibration log stores it that way — grade-picks decides `hit = actual > line`.
// Surfacing unders must therefore change only the DISPLAY (side / sideProb), never
// p.prob. If an under's 0.70 were written back as the logged probability, every
// under on the board would poison the Brier score in the opposite direction.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset, read } from '../helpers/blobs.mjs';

const props = (rows) => ({
  data: rows.map((r, i) => ({
    id: `pp-${i}`, type: 'projection',
    attributes: { stat_type: r.stat || 'Hits', stat_display_name: r.stat || 'Hits', line_score: r.line,
      odds_type: r.tier || 'standard', description: r.opp || 'OPP',
      start_time: new Date().toISOString(), today: true },
    relationships: { new_player: { data: { id: `n${i}` } } },
  })),
  included: rows.map((r, i) => ({ id: `n${i}`, type: 'new_player',
    attributes: { display_name: r.player, team: r.team, position: 'OF', market: r.team } })),
  meta: { total_pages: 1 },
});

// Four props spanning the range: two strong overs, two strong UNDERS (weak overs).
const ROWS = [
  { player: 'Strong Over',  team: 'CIN', line: 0.5, opp: 'PIT' },
  { player: 'Decent Over',  team: 'PIT', line: 1.5, opp: 'CIN' },
  { player: 'Strong Under', team: 'CHC', line: 2.5, opp: 'MIL' },
  { player: 'Lean Under',   team: 'MIL', line: 3.5, opp: 'CHC' },
];
const PICKS = [
  { player: 'Strong Over',  stat: 'Hits', line: 0.5, verdict: 'play', prob: 0.70, key_risk: 'k', reasoning: 'r' },
  { player: 'Decent Over',  stat: 'Hits', line: 1.5, verdict: 'lean', prob: 0.58, key_risk: 'k', reasoning: 'r' },
  { player: 'Strong Under', stat: 'Hits', line: 2.5, verdict: 'pass', prob: 0.28, key_risk: 'k', reasoning: 'r' },
  { player: 'Lean Under',   stat: 'Hits', line: 3.5, verdict: 'pass', prob: 0.44, key_risk: 'k', reasoning: 'r' },
];

async function run(sides, extra = {}) {
  reset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const mock = mockFetch([
    ['partner-api.prizepicks.com/projections', async () => props(ROWS)],
    [/statsapi|espn|the-odds-api|\/history/, async () => ({})],
    ['api.anthropic.com', async () => ({ content: [{ type: 'text', text: JSON.stringify({ picks: PICKS }) }], usage: {} })],
  ]);
  try {
    const { handler } = await loadFn('bet-finder-background.js');
    await handler({ httpMethod: 'POST', body: JSON.stringify({ jobId: 'sides1', league: 'mlb', legs: 3, sides, ...extra }) });
  } finally { mock.restore(); }
  return read('bet-jobs', 'sides1')?.result || {};
}

export default async function ({ t }) {
  // ---- both: each prop shown as whichever side is the bet ------------------
  const both = await run('both');
  const by = (n) => (both.allPicks || []).find((p) => p.player === n);

  t.eq('a strong over is an over', [by('Strong Over').side, by('Strong Over').sideProb], ['over', 0.7]);
  t.eq('a WEAK over is surfaced as a strong UNDER', by('Strong Under').side, 'under');
  t.ok('...at 1 minus the over probability', Math.abs(by('Strong Under').sideProb - 0.72) < 1e-9,
    String(by('Strong Under').sideProb));
  t.eq('...and is graded on that side, not the discarded one', by('Strong Under').sideVerdict, 'play');
  t.eq('a 0.44 over becomes a 0.56 under, which is only a lean',
    by('Lean Under').sideVerdict, 'lean');

  // THE contract.
  t.eq('p.prob is still P(over) for every pick, untouched',
    (both.allPicks || []).map((p) => p.prob).sort(), [0.28, 0.44, 0.58, 0.7]);

  const logged = read('pick-log', new Date().toISOString().slice(0, 10)) || [];
  const loggedFor = (n) => logged.find((l) => l.player === n);
  t.eq('the calibration log records P(OVER) for an under-recommended prop',
    loggedFor('Strong Under').prob, 0.28);
  t.ok('...NOT the under probability, which would invert the Brier score',
    loggedFor('Strong Under').prob !== 0.72);

  const boardNames = (both.board || []).map((p) => p.player).sort();
  t.eq('the board now carries both sides', boardNames,
    ['Decent Over', 'Lean Under', 'Strong Over', 'Strong Under']);

  // ---- overs only: the old behaviour, on request ---------------------------
  const overs = await run('over');
  t.ok('every card is an over', (overs.board || []).every((p) => p.side === 'over'));
  t.eq('the weak overs drop off the board rather than flipping',
    (overs.board || []).map((p) => p.player).sort(), ['Decent Over', 'Strong Over']);

  // ---- unders only --------------------------------------------------------
  const unders = await run('under');
  t.ok('every card is an under', (unders.board || []).every((p) => p.side === 'under'));
  t.eq('only props that are genuinely good unders survive',
    (unders.board || []).map((p) => p.player).sort(), ['Lean Under', 'Strong Under']);
  t.eq('the recommended slip is unders too', (unders.parlayLegs || []).map((l) => l.pick), ['under', 'under']);
  t.eq('...and reports which side it was built for', unders.parlayNote.sides, 'under');

  // ---- the recommended slip is not just "top N" ---------------------------
  t.eq('the slip is sized on the SIDE probability, not P(over)',
    (both.parlayLegs || []).map((l) => l.prob).every((v, i, a) => v >= (a[i + 1] ?? 0)), true);
  t.ok('each leg carries the side it was recommended on',
    (both.parlayLegs || []).every((l) => l.pick === 'over' || l.pick === 'under'));
  t.ok('...and its projection id, so a saved slip can be graded',
    (both.parlayLegs || []).every((l) => !!l.projectionId));

  // A short slate must yield a SHORT slip, not a padded one.
  t.eq('asking for more legs than clear the bar reports a shortfall',
    both.parlayNote.requested >= both.parlayNote.built, true);
  t.eq('...and the shortfall is stated, not hidden',
    both.parlayNote.shortfall, both.parlayNote.requested - both.parlayNote.built);

  // ---- an inactive player is never recommended ----------------------------
  // Same slate, but the strongest leg is on the injured list.
  reset();
  const mod = await loadFn('bet-finder-background.js');
  const injured = [
    { player: 'Strong Over', stat: 'Hits', line: 0.5, prob: 0.70, verdict: 'play', matchup: 'A vs B', injured: '10-Day Injured List' },
    { player: 'Decent Over', stat: 'Hits', line: 1.5, prob: 0.58, verdict: 'lean', matchup: 'C vs D' },
    { player: 'Third Guy',   stat: 'Hits', line: 1.5, prob: 0.57, verdict: 'lean', matchup: 'E vs F' },
  ];
  mod.attachSides(injured, 'both');
  const picked = mod.selectLegs(injured, 3);
  t.ok('the injured player is excluded even though he is the best number',
    !picked.some((p) => p.player === 'Strong Over'), picked.map((p) => p.player).join(', '));
  t.eq('...and the healthy legs are still returned', picked.map((p) => p.player).sort(), ['Decent Over', 'Third Guy']);

  // ---- tier-vs-side is flagged, not silently mispriced --------------------
  const tiers = [
    { player: 'Goblin Under', stat: 'Hits', line: 0.5, prob: 0.30, verdict: 'pass', oddsType: 'goblin' },
    { player: 'Demon Under',  stat: 'Hits', line: 4.5, prob: 0.30, verdict: 'pass', oddsType: 'demon' },
    { player: 'Goblin Over',  stat: 'Hits', line: 0.5, prob: 0.70, verdict: 'play', oddsType: 'goblin' },
  ];
  mod.attachSides(tiers, 'both');
  const byTier = (n) => tiers.find((p) => p.player === n);

  // PrizePicks offers Over AND Under on the STANDARD line only. Every other line
  // on a prop — the goblin below it, the demons above — shows a single "More"
  // button and no "Less". The engine did not know that: it took whichever side
  // its probability favoured, so a demon with a low P(over) was recommended as an
  // UNDER at 80% — a bet that cannot be placed at all.
  t.eq('an alt line has no under available', byTier('Goblin Under').underAvailable, false);
  t.eq('...so the only real bet on it is the over', byTier('Goblin Under').side, 'over');
  t.eq('...priced as the over it actually is, not the under it was showing',
    byTier('Goblin Under').sideProb, 0.30);
  t.eq('a demon is the same — over only', byTier('Demon Under').side, 'over');
  t.eq('...at its true over probability, so a weak one drops out on merit',
    byTier('Demon Under').sideProb, 0.30);
  t.eq('an over on an alt line is unaffected', byTier('Goblin Over').side, 'over');
  t.eq('...and keeps its probability', byTier('Goblin Over').sideProb, 0.70);

  // The standard line is the only place an under exists.
  const std = [{ player: 'Std Under', stat: 'Hits', line: 1.5, prob: 0.30, verdict: 'pass', oddsType: 'standard' }];
  mod.attachSides(std, 'both');
  t.eq('a standard line DOES offer the under', std[0].underAvailable, true);
  t.eq('...and takes it when the probability favours it', std[0].side, 'under');
  t.eq('...at the flipped probability', Math.round(std[0].sideProb * 100), 70);

  // Unders-only mode must not quietly serve an over instead.
  const onlyUnders = [
    { player: 'Alt', stat: 'Hits', line: 4.5, prob: 0.30, verdict: 'pass', oddsType: 'demon' },
    { player: 'Std', stat: 'Hits', line: 1.5, prob: 0.30, verdict: 'pass', oddsType: 'standard' },
  ];
  mod.attachSides(onlyUnders, 'under');
  t.eq('in unders-only mode an alt line is marked unavailable', onlyUnders[0].sideUnavailable, true);
  t.eq('...while the standard line is fine', onlyUnders[1].sideUnavailable, false);
  const undersOnlyLegs = mod.selectLegs(onlyUnders.map((p) => ({ ...p, sideVerdict: 'play', matchup: 'A vs B' })), 2);
  t.ok('...and the unavailable one is never selected',
    !undersOnlyLegs.some((p) => p.player === 'Alt'), undersOnlyLegs.map((p) => p.player).join(','));

  // ---- one prop per player, whatever the line ----------------------------
  // The reported bug: the recommended slip carried "Altmaier Total Games Won
  // under 7.5" AND "under 6.5". PrizePicks won't take one prop twice, and the
  // two are NESTED — under 6.5 already means under 7.5 — so multiplying them as
  // independent produces a number that is simply wrong.
  const altLines = [
    { player: 'Daniel Altmaier', stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 7.5, prob: 0.20, verdict: 'pass', matchup: 'ALT vs MUS' },
    { player: 'Daniel Altmaier', stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 6.5, prob: 0.22, verdict: 'pass', matchup: 'ALT vs MUS' },
    { player: 'Zeynep Sonmez',   stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 4.5, prob: 0.70, verdict: 'play', matchup: 'SON vs X' },
    { player: 'Third Player',    stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 5.5, prob: 0.66, verdict: 'play', matchup: 'THI vs Y' },
  ];
  mod.attachSides(altLines, 'both');
  const noDupes = mod.selectLegs(altLines, 3);
  const altmaier = noDupes.filter((p) => p.player === 'Daniel Altmaier');
  t.eq('the same prop never appears twice, however good both lines look', altmaier.length, 1);
  t.eq('...and the slot goes to another player instead',
    noDupes.map((p) => p.player).sort(), ['Daniel Altmaier', 'Third Player', 'Zeynep Sonmez']);

  // A second leg on the same player is still allowed for a DIFFERENT stat —
  // that's legal on PrizePicks and merely correlated, not duplicated.
  const twoStats = [
    { player: 'Same Guy', stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 7.5, prob: 0.70, verdict: 'play', matchup: 'A vs B' },
    { player: 'Same Guy', stat: 'Aces', statDisplay: 'Aces', line: 4.5, prob: 0.68, verdict: 'play', matchup: 'A vs B' },
    { player: 'Other Guy', stat: 'Aces', statDisplay: 'Aces', line: 3.5, prob: 0.64, verdict: 'play', matchup: 'C vs D' },
  ];
  mod.attachSides(twoStats, 'both');
  const mixed = mod.selectLegs(twoStats, 3);
  t.eq('two DIFFERENT props on one player are still allowed',
    mixed.filter((p) => p.player === 'Same Guy').length, 2);
  t.eq('...and they are different stats, not two lines of one',
    new Set(mixed.filter((p) => p.player === 'Same Guy').map((p) => p.stat)).size, 2);
}

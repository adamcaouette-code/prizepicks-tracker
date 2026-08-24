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

  // ---- EDGE is not probability -------------------------------------------
  // The board sorted by raw probability and labelled it "EDGE %", which ranked
  // it almost exactly backwards. A goblin line is set LOW so the over is easy,
  // but it pays 2.0x on a 3-pick Power and needs 79.4% a leg to break even. A
  // standard pays 4.75x and needs 59.5%. So the tier changes what a percentage
  // is WORTH, and sorting on the percentage alone floats the worst-paying tier
  // to the top every time.
  const tiers2 = [
    { player: 'Fat Goblin', stat: 'Ks', line: 3.5, prob: 0.80, verdict: 'play', oddsType: 'goblin' },
    { player: 'Solid Standard', stat: 'Ks', line: 5.5, prob: 0.65, verdict: 'play', oddsType: 'standard' },
    { player: 'Live Demon', stat: 'Ks', line: 8.5, prob: 0.50, verdict: 'play', oddsType: 'demon' },
  ];
  mod.attachSides(tiers2, 'both');
  const t2 = (n) => tiers2.find((p) => p.player === n);

  t.ok('a goblin must clear ~79%, because 2.0x is all it pays',
    Math.abs(t2('Fat Goblin').breakEven - 0.7937) < 0.001, String(t2('Fat Goblin').breakEven));
  t.ok('a standard only has to clear ~59%',
    Math.abs(t2('Solid Standard').breakEven - 0.5946) < 0.001);
  t.ok('a demon only ~44%', Math.abs(t2('Live Demon').breakEven - 0.4368) < 0.001);

  t.ok('an 80% goblin is barely above water', Math.abs(t2('Fat Goblin').edge - 0.006) < 0.002,
    `${(t2('Fat Goblin').edge * 100).toFixed(1)}pp`);
  t.ok('...while a 65% standard is far better value',
    Math.abs(t2('Solid Standard').edge - 0.055) < 0.002, `${(t2('Solid Standard').edge * 100).toFixed(1)}pp`);
  t.ok('THE POINT: the lower percentage is the better bet',
    t2('Solid Standard').edge > t2('Fat Goblin').edge,
    `standard ${(t2('Solid Standard').edge * 100).toFixed(1)}pp vs goblin ${(t2('Fat Goblin').edge * 100).toFixed(1)}pp`);
  t.ok('...by roughly nine times',
    t2('Solid Standard').edge / t2('Fat Goblin').edge > 5);
  t.ok('a coin-flip demon still beats the 80% goblin on what it pays',
    t2('Live Demon').edge > t2('Fat Goblin').edge);

  // ---- one prop per player, whatever the line ----------------------------
  // The reported bug: the recommended slip carried "Altmaier Total Games Won
  // under 7.5" AND "under 6.5". PrizePicks won't take one prop twice, and the
  // two are NESTED — under 6.5 already means under 7.5 — so multiplying them as
  // independent produces a number that is simply wrong.
  // Tiers are stated because they now decide whether an under exists at all —
  // an unknown tier is treated as over-only, and both Altmaier lines are unders.
  const altLines = [
    { player: 'Daniel Altmaier', stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 7.5, prob: 0.20, verdict: 'pass', matchup: 'ALT vs MUS', oddsType: 'standard' },
    { player: 'Daniel Altmaier', stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 6.5, prob: 0.22, verdict: 'pass', matchup: 'ALT vs MUS', oddsType: 'standard' },
    { player: 'Zeynep Sonmez',   stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 4.5, prob: 0.70, verdict: 'play', matchup: 'SON vs X', oddsType: 'standard' },
    { player: 'Third Player',    stat: 'Total Games Won', statDisplay: 'Total Games Won', line: 5.5, prob: 0.66, verdict: 'play', matchup: 'THI vs Y', oddsType: 'standard' },
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

  // ---- the join: one prop posted at several lines ------------------------
  // THE REPORTED BUG. The board offered "Parker Messick Pitcher Strikeouts
  // UNDER 3.5" when the only under PrizePicks actually had was at 6.
  //
  // The judge is sent each line as its own entry and echoes back
  // player/stat/line/prob — no tier. Everything else is re-attached afterwards
  // from the candidate rows, and that join was keyed on player+stat ALONE. All
  // three of Messick's lines collapsed onto one key, last write won, and the 3.5
  // goblin inherited the 6 line's "standard" tier. attachSides then believed an
  // under existed on it, saw P(over 3.5) was low, and recommended the under —
  // a bet with no button on the card.
  //
  // The same collision handed it the wrong projectionId, which is worse and
  // quieter: the pick would have graded cleanly against a line nobody bet.
  const messickLines = [
    { id: 'pp-gob', player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 3.5, oddsType: 'goblin',   team: 'CLE', matchup: 'CLE vs DET', game: 'CLE vs DET' },
    { id: 'pp-std', player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 6,   oddsType: 'standard', team: 'CLE', matchup: 'CLE vs DET', game: 'CLE vs DET' },
    { id: 'pp-dem', player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 8.5, oddsType: 'demon',    team: 'CLE', matchup: 'CLE vs DET', game: 'CLE vs DET' },
  ];
  const judged = [
    { player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 3.5, prob: 0.20, verdict: 'pass' },
    { player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 6,   prob: 0.42, verdict: 'lean' },
    { player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 8.5, prob: 0.08, verdict: 'pass' },
  ];
  mod.attachSource(judged, messickLines);
  const atLine = (l) => judged.find((p) => p.line === l);

  t.eq('each line keeps its OWN tier, not the last one in the array',
    judged.map((p) => p.oddsType), ['goblin', 'standard', 'demon']);
  t.eq('...and its own projection id, so it grades against the line it was bet at',
    judged.map((p) => p.projectionId), ['pp-gob', 'pp-std', 'pp-dem']);
  t.eq('player-level fields still attach', atLine(3.5).team, 'CLE');

  mod.attachSides(judged, 'both');
  t.eq('the goblin 3.5 has no under to take', atLine(3.5).underAvailable, false);
  t.eq('...so it is offered as the over it really is, at its true 20%',
    [atLine(3.5).side, atLine(3.5).sideProb], ['over', 0.2]);
  t.eq('the demon 8.5 is over-only too', atLine(8.5).side, 'over');
  // THE POINT: exactly one line on this prop has an under, and it is the 6.
  t.eq('the standard 6 is the only line that can be taken under', atLine(6).side, 'under');
  t.ok('...priced at 1 minus P(over 6)', Math.abs(atLine(6).sideProb - 0.58) < 1e-9,
    String(atLine(6).sideProb));
  t.eq('one under on the whole prop, not three',
    judged.filter((p) => p.side === 'under').map((p) => p.line), [6]);

  // ---- a line no candidate carried ---------------------------------------
  // The judge occasionally echoes a line that was never on the board. There is
  // then no tier and no projection id to be had, and INVENTING them is exactly
  // what caused the bug above. Refuse both, keep the player-level context, and
  // treat the unknown tier as over-only — assuming no under costs at most one
  // real bet, while assuming one that does not exist puts an unplaceable pick
  // on the board.
  const orphan = [{ player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 5, prob: 0.30, verdict: 'pass' }];
  mod.attachSource(orphan, messickLines);
  t.eq('a line that is not on the board is marked as unmatched', orphan[0].lineMatched, false);
  t.eq('...and gets no projection id rather than a wrong one', orphan[0].projectionId, undefined);
  t.eq('...and no tier rather than a guessed one', orphan[0].oddsType, null);
  t.eq('...but player-level context still attaches', orphan[0].matchup, 'CLE vs DET');
  mod.attachSides(orphan, 'both');
  t.eq('an unconfirmed tier is treated as over-only', orphan[0].underAvailable, false);
  t.eq('...so a weak over stays a weak over instead of becoming a 70% under',
    [orphan[0].side, orphan[0].sideProb], ['over', 0.3]);

  // ---- PrizePicks now offers both sides on most alt lines -----------------
  // The board used to be one-sided outside the standard line, and the engine
  // encoded that as a rule: under exists only where tier === 'standard'. That
  // rule was true when written and is now wrong in BOTH directions.
  //
  // Measured on a live 6,203-prop MLB board: 676 goblins and 2,144 demons accept
  // an under, all of which the engine was refusing outright — and 85 STANDARD
  // lines are over-only, which it was happily recommending unders on. The second
  // half is the Messick bug again from the opposite direction: a bet with no
  // button on the card.
  //
  // PrizePicks states it directly per projection, so the feed is the authority
  // and the heuristic is gone.
  const wagers = [
    { player: 'Two-Sided Goblin', stat: 'TB', line: 0.5, prob: 0.25, oddsType: 'goblin', wagerTypes: 'under_or_over' },
    { player: 'Two-Sided Demon', stat: 'TB', line: 5.5, prob: 0.25, oddsType: 'demon', wagerTypes: 'under_or_over' },
    { player: 'Over Only Standard', stat: 'TB', line: 2.5, prob: 0.25, oddsType: 'standard', wagerTypes: 'over' },
    { player: 'Two-Sided Standard', stat: 'TB', line: 2.5, prob: 0.25, oddsType: 'standard', wagerTypes: 'under_or_over' },
  ];
  mod.attachSides(wagers, 'both');
  const byW = (n) => wagers.find((p) => p.player === n);

  t.eq('a goblin that accepts an under gets one', byW('Two-Sided Goblin').underAvailable, true);
  t.eq('...and is surfaced as the under it should be', byW('Two-Sided Goblin').side, 'under');
  t.eq('a demon that accepts an under gets one too', byW('Two-Sided Demon').side, 'under');
  // The dangerous direction, and the one a tier heuristic could never catch.
  t.eq('a STANDARD line that is over-only does not get an under',
    byW('Over Only Standard').underAvailable, false);
  t.eq('...and is offered as the over it really is', byW('Over Only Standard').side, 'over');
  t.eq('a standard that does accept both is unchanged', byW('Two-Sided Standard').side, 'under');

  // ---- but the payout for that under is not known yet --------------------
  // Each side carries its own tier in the PrizePicks UI, while the API sends one
  // odds_type for the whole projection. Pricing an under on a goblin line at the
  // goblin multiplier would quote 2.0x on what is really the expensive side —
  // and mispriced payouts have already cost this app once.
  t.eq('an under on an alt line is flagged as unpriced',
    byW('Two-Sided Goblin').sidePriceUnverified, true);
  t.eq('...as is an under on a demon', byW('Two-Sided Demon').sidePriceUnverified, true);
  t.eq('an under on a STANDARD line is priced normally',
    byW('Two-Sided Standard').sidePriceUnverified, false);

  // ---- and therefore has NO edge, rather than a borrowed one -------------
  // This is what put "Messick under 9.5" at the top of the board: 9.5 is a demon
  // ON THE OVER, so the under was scored against the demon break-even of 43.7%
  // for a +36pp edge, when the under there is the cheap side and needs far more
  // than 80% to be worth taking. Ranking a bet by the price of its opposite side
  // is worse than not ranking it.
  t.eq('an under on a demon line gets no edge at all', byW('Two-Sided Demon').edge, null);
  t.eq('...and no break-even either', byW('Two-Sided Demon').breakEven, null);
  t.eq('an under on a goblin line is the same', byW('Two-Sided Goblin').edge, null);
  t.ok('an under on a STANDARD line still gets a real edge',
    typeof byW('Two-Sided Standard').edge === 'number', String(byW('Two-Sided Standard').edge));
  t.ok('...and every over does', typeof byW('Over Only Standard').edge === 'number');

  // The specific shape of the bug: 80% on a demon line's under must NOT come out
  // ahead of a modest priced over.
  const rank = [
    { player: 'Fake Top', stat: 'K', line: 9.5, prob: 0.20, oddsType: 'demon', wagerTypes: 'under_or_over' },
    { player: 'Real Edge', stat: 'K', line: 4.5, prob: 0.65, oddsType: 'standard', wagerTypes: 'over' },
  ];
  mod.attachSides(rank, 'both');
  t.eq('the 80% under is surfaced as an under', [rank[0].side, rank[0].sideProb], ['under', 0.8]);
  t.eq('...but carries no edge to rank on', rank[0].edge, null);
  t.ok('...while the 65% over does', rank[1].edge > 0, String(rank[1].edge));
  t.eq('...and so is any over', byW('Over Only Standard').sidePriceUnverified, false);

  // Shown on the board, where the probability is honest and useful — but kept
  // out of a slip that quotes EV off a multiplier nobody has confirmed.
  const priced = mod.selectLegs([
    ...wagers.map((p) => ({ ...p, matchup: p.player })),
    { player: 'Clean A', stat: 'TB', line: 1.5, prob: 0.70, oddsType: 'standard', wagerTypes: 'over', matchup: 'A' },
    { player: 'Clean B', stat: 'TB', line: 1.5, prob: 0.68, oddsType: 'standard', wagerTypes: 'over', matchup: 'B' },
  ].map((p) => { mod.attachSides([p], 'both'); return p; }), 4);
  t.ok('an unpriced under never reaches the recommended slip',
    !priced.some((p) => p.sidePriceUnverified), priced.map((p) => p.player).join(', '));

  // ---- pre-rollout props fall back to the old rule ------------------------
  // The field is absent on ~15% of the board, all with older board_times. For
  // those the old heuristic is still the best evidence there is, because it
  // described the world they were posted into.
  const legacy = [
    { player: 'Old Goblin', stat: 'TB', line: 0.5, prob: 0.25, oddsType: 'goblin' },
    { player: 'Old Standard', stat: 'TB', line: 2.5, prob: 0.25, oddsType: 'standard' },
  ];
  mod.attachSides(legacy, 'both');
  t.eq('a pre-rollout goblin stays over-only', legacy[0].side, 'over');
  t.eq('...and a pre-rollout standard keeps its under', legacy[1].side, 'under');
}

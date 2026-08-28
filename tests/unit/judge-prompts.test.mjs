// The judge, versioned — Psyche (original) vs Aphrodite (refinement).
//
// What is actually being guarded here is the ability to TELL THEM APART. A
// prompt change with no way to measure it is a change of mood, not of quality:
// the versions must reach the model intact, the payload must carry what the
// prompt talks about, and every logged pick must say which one produced it.

import { PSYCHE, APHRODITE, THEMIS, PROMPTS, promptSet, verdictFor } from '../../netlify/functions/judge-prompts.js';

const CAND = {
  player: 'Parker Messick', stat: 'Pitcher Strikeouts', line: 3.5,
  position: 'P', team: 'CLE', opp: 'DET', oddsType: 'goblin',
};

export default async function ({ t }) {
  // ---- selection ----------------------------------------------------------
  const saved = process.env.JUDGE_PROMPT;
  delete process.env.JUDGE_PROMPT;
  t.eq('aphrodite is the default', promptSet().name, 'aphrodite');
  t.eq('an explicit name wins', promptSet('psyche').name, 'psyche');
  process.env.JUDGE_PROMPT = 'psyche';
  t.eq('the env var selects when no argument is given', promptSet().name, 'psyche');
  t.eq('...and an argument still overrides it', promptSet('aphrodite').name, 'aphrodite');
  // A typo in a query string must not take a run down.
  t.eq('an unknown name falls back rather than throwing', promptSet('athena').name, 'aphrodite');
  if (saved == null) delete process.env.JUDGE_PROMPT; else process.env.JUDGE_PROMPT = saved;

  t.eq('all three versions are registered', Object.keys(PROMPTS).sort(), ['aphrodite', 'psyche', 'themis']);

  // ---- the payload difference is the point --------------------------------
  // Aphrodite's central change is that the judge is told the payout tier, which
  // is PrizePicks' own price on the prop. A prompt that reasons about a field
  // the payload does not carry is worse than either version alone, so the two
  // travel together.
  t.eq('psyche never sees the tier', PSYCHE.entryFor(CAND).tier, undefined);
  t.eq('aphrodite is told the tier', APHRODITE.entryFor(CAND).tier, 'goblin');
  t.eq('...normalised, since the prompt names the three by name',
    APHRODITE.entryFor({ ...CAND, oddsType: 'DEMON' }).tier, 'demon');
  t.eq('...and defaults rather than sending undefined',
    APHRODITE.entryFor({ ...CAND, oddsType: null }).tier, 'standard');

  // Everything else must stay identical, or the comparison measures two changes
  // at once and attributes the result to the wrong one.
  const strip = (o) => { const { tier, ...rest } = o; return rest; };
  t.eq('the rest of the payload is unchanged between versions',
    JSON.stringify(strip(APHRODITE.entryFor(CAND))), JSON.stringify(PSYCHE.entryFor(CAND)));

  const combo = { ...CAND, player: 'A Guy + B Guy' };
  for (const V of [PSYCHE, APHRODITE]) {
    t.ok(`${V.name} still flags combos`, V.entryFor(combo).combo === true);
    t.ok(`${V.name} leaves single props unflagged`, V.entryFor(CAND).combo === undefined);
  }

  // ---- the prompts themselves --------------------------------------------
  const psy = PSYCHE.promptFor('mlb');
  const aph = APHRODITE.promptFor('mlb');

  // Sport rules are SHARED. If a role rule is fixed it must land in both, or the
  // A/B silently becomes "new prompt vs old baseball knowledge".
  const mlbRule = 'The single biggest driver of any HITTER prop is the OPPOSING STARTING';
  t.ok('both carry the same MLB role rules', psy.includes(mlbRule) && aph.includes(mlbRule));
  t.ok('and both switch to WNBA rules for the WNBA',
    PSYCHE.promptFor('wnba').includes('It is NOT the NBA') && APHRODITE.promptFor('wnba').includes('It is NOT the NBA'));
  t.ok('and both switch to NFL rules for the NFL',
    PSYCHE.promptFor('nfl').includes('This is the NFL') && APHRODITE.promptFor('nfl').includes('This is the NFL'));
  t.ok('NFL props never get soccer terminology — that was the bug being fixed',
    !APHRODITE.promptFor('nfl').includes('Clearances, blocks, interceptions, tackles'));
  t.ok('soccer is the fallback for anything else',
    APHRODITE.promptFor('epl').includes('Clearances, blocks, interceptions, tackles'));

  // Psyche asked for a verdict label alongside the probability, which let the
  // label be chosen first and the number written to justify it.
  t.ok('psyche asks the model for a verdict', /"verdict":"play\|lean\|pass"/.test(psy));
  t.ok('aphrodite does not', !/verdict/.test(aph.split('{"picks"')[1] || ''));
  t.ok('aphrodite asks for the count of last-5 that cleared, before the number',
    /"cleared"/.test(aph));
  t.ok('aphrodite explains the tier as the market price', /goblin/.test(aph) && /demon/.test(aph));
  // The tier ranges are MEASURED, not guessed. The first version of this prompt
  // carried ranges I derived from payout break-evens — goblin 0.72-0.85,
  // standard 0.50-0.62, demon 0.25-0.45 — and every one of them sat above what
  // 1,807 graded picks actually show (70% / 45% / 20%). A prior that biased high
  // would have pushed the new judge to overstate exactly where it hurts.
  t.ok('goblin is anchored at the measured rate, not the payout-implied one',
    /70% of the time \(811\/1162\)/.test(aph) && /0\.65-0\.75/.test(aph));
  t.ok('standard is anchored below a coin flip, which is what the data says',
    /45% of the time \(137\/302\)/.test(aph) && /0\.40-0\.52/.test(aph));
  t.ok('demon is anchored at one in five', /20% of the time \(67\/343\)/.test(aph) && /0\.15-0\.25/.test(aph));
  t.ok('...and none of the old payout-implied ranges survive',
    !/0\.72-0\.85/.test(aph) && !/0\.50-0\.62/.test(aph) && !/0\.25-0\.45/.test(aph));

  // The reported bug about rare props: a line that cannot go below 0.5 is not
  // "nearly a lock because the number is small".
  t.ok('aphrodite is warned about floor-pinned rare-event lines',
    /cannot go\s+below 0\.5/.test(aph) && /home runs, stolen bases/.test(aph));
  // The measured failure: the 0-10% band hit 43% of the time across 93 picks.
  t.ok('...and told not to reach for the extremes without evidence',
    /below 0\.10 hit 43% of the time/.test(aph));
  t.ok('...and says which way an error costs, since the top picks are the bet ones',
    /overstatement is the expensive error/.test(aph));
  t.ok('both still demand bare JSON', /ONLY valid\nJSON|ONLY valid JSON/.test(psy) && /ONLY valid JSON/.test(aph));

  // ---- verdict is derived, not taken -------------------------------------
  // The thresholds are exactly the ones Psyche stated in its own prompt, so a
  // Psyche run scores the same whether the label came from the model or from
  // here. That is what keeps the two versions comparable rather than merely
  // different.
  t.eq('0.62 and up is a play', verdictFor(0.62), 'play');
  t.eq('0.61 is a lean', verdictFor(0.61), 'lean');
  t.eq('0.54 is still a lean', verdictFor(0.54), 'lean');
  t.eq('0.53 is a pass', verdictFor(0.539), 'pass');
  t.ok('psyche stated these same thresholds',
    psy.includes('play  = 62%+') && psy.includes('lean  = 54-61%'));

  // ---- THEMIS: a TAIL-ONLY variant of Aphrodite ---------------------------
  // The whole point is that head, role blocks, search policy/budget, and
  // entryFor are IDENTICAL — only the tier-anchoring section and the output
  // schema differ. If anything else drifted, a THEMIS-vs-Aphrodite comparison
  // would be measuring more than one change at once.
  const them = THEMIS.promptFor('mlb');

  t.eq('THEMIS is registered and selectable', promptSet('themis').name, 'themis');

  // The HEAD — the search-policy paragraph, verbatim — is shared, not copied.
  const searchPolicyLine = 'Your search budget is set to the number of';
  t.ok('THEMIS carries the identical head', them.includes(searchPolicyLine) && aph.includes(searchPolicyLine));
  const headEnd = aph.indexOf('This is BASEBALL');   // start of the shared MLB role block
  t.eq('...byte-identical up to the role block', them.slice(0, headEnd), aph.slice(0, headEnd));

  // entryFor is identical in behaviour, not merely similar.
  t.eq('THEMIS payload is identical to Aphrodite\'s',
    JSON.stringify(THEMIS.entryFor(CAND)), JSON.stringify(APHRODITE.entryFor(CAND)));
  t.eq('...tier included', THEMIS.entryFor(CAND).tier, 'goblin');
  t.ok('...combos still flagged', THEMIS.entryFor(combo).combo === true);

  // The measured tier rates survive UNCHANGED — only the anchoring instruction
  // around them changes.
  t.ok('THEMIS keeps the measured goblin rate', /70% of the time \(811\/1162\)/.test(them));
  t.ok('...the measured standard rate', /45% of the time \(137\/302\)/.test(them));
  t.ok('...the measured demon rate', /20% of the time \(67\/343\)/.test(them));

  // But the old "start inside the range" anchoring, its numeric ranges, AND the
  // "use the whole range, do not cluster" instruction are all gone — leaving
  // one and not the other would tell the model to do both at once.
  t.ok('the old "start inside the range" instruction is gone', !/Start inside the tier's range/.test(them));
  t.ok('...and its numeric ranges do not survive',
    !/0\.65-0\.75/.test(them) && !/0\.40-0\.52/.test(them) && !/0\.15-0\.25/.test(them));
  t.ok('the contradicting "use the whole range" instruction is also gone',
    !/USE THE WHOLE RANGE/.test(them) && !/[Dd]o not cluster/.test(them));

  // The new instruction: most props at the tier rate, a few decisive standouts.
  t.ok('THEMIS tells the judge most props are unremarkable',
    /PUT THEM AT THEIR TIER'S RATE/.test(them));
  t.ok('...and a standout needs a decisive, named move',
    /at least 0\.10\s+off the tier rate/.test(them) && /name the fact/.test(them));
  t.ok('...expects few standouts, and says a flat slate is a legitimate answer',
    /two to five out of forty/.test(them) && /legitimate and useful answer/.test(them));

  // Output schema: standout added, everything else the same shape.
  t.ok('THEMIS asks for "standout" in the schema', /"standout"/.test(them));
  t.ok('...and the JSON template carries it', /"standout":false/.test(them));
  t.ok('...alongside "cleared", unchanged', /"cleared"/.test(them));

  // Everything NOT named as changing is identical, verbatim, to Aphrodite —
  // checked as substrings so a a stray edit anywhere else in the tail is caught.
  const sharedTailPassages = [
    'RARE-EVENT PROPS. Some stats cannot have a balanced line',
    'stop and check you\nhave read the line correctly',
    'DO NOT USE THE EXTREMES UNLESS YOU MEAN THEM',
    'ANCHOR ON A COUNT, NOT AN IMPRESSION',
    'BE HONEST ABOUT WHICH WAY AN ERROR COSTS',
    'Some props are COMBO props',
    'teamWinPct',
    'oppStatRank',
    'A stat that does not fit the player\'s role is not a low probability',
  ];
  for (const s of sharedTailPassages) {
    t.ok(`unrelated passage carried over unchanged: "${s.slice(0, 40)}..."`,
      aph.includes(s) && them.includes(s));
  }

  // Aphrodite itself must be untouched by THEMIS's existence.
  t.ok('Aphrodite still asks the model to spread out, unlike THEMIS',
    /USE THE WHOLE RANGE/.test(aph));
  t.ok('...and still anchors inside the old numeric ranges',
    /Start inside the tier's range/.test(aph) && /0\.65-0\.75/.test(aph));
}

// slip-judge-prompt.js
//
// Builds the Opus call for SLIP MODE — grading a slip the user already built,
// as opposed to board mode (discovering the best plays). Same judging brain,
// different question: the side is locked, so the judge evaluates P(chosen side
// hits) and its risk, per leg, then gives a whole-slip read.
//
// It does NOT compute the parlay probability — that's your deterministic
// hitDistribution / Flex-entries math, where the same-game correlation
// adjustment lives. This prompt returns per-leg probs + a qualitative synthesis.
//
// Usage:
//   const { system, userContent } = buildSlipJudge(slip, enrichedLegs);
//   // then your normal Opus call: model: JUDGE_MODEL, system, messages:[{role:"user",content:userContent}]
//
//   - `slip`         = the normalized object from parse-slip.js (slipType, matchup, legCount, ...)
//   - `enrichedLegs` = slip.legs AFTER your research fetch, each leg carrying
//                      whatever you gathered (season avg, recent hit rate,
//                      oppStatRank, book line, pace, minutes). Pass it all
//                      under leg.research — the judge uses what's present and
//                      is told to lower confidence when data is thin.

const SLIP_JUDGE_SYSTEM = `You are the judging engine for a PrizePicks slip-rating tool. The user has ALREADY built this slip; your job is not to pick plays but to grade the ones they chose, honestly and skeptically. Your default posture is doubt: you are more useful for talking someone out of a bad leg than for cheering a good one.

RULES

1. The side is locked. Each leg has "pick": "under" or "over". Estimate P(that exact side hits) — never flip to the side you'd prefer. An under on a player whose recent median already clears the line is a BAD under; say so loudly.

2. Every leg MUST have a stated failure mode. "key_risk" is required and must name the specific way this side loses (foul trouble, blowout benching, pace, role change, injury, line is inflated vs the book). "Looks good" is not a risk. If you cannot name a real risk, the leg is probably a coinflip, not a lock.

3. Use the sportsbook line if provided. The gap between the PrizePicks line and the book's number is your sharpest signal. If PrizePicks is offering a softer number than the book, that's edge; if it's harder, it's a trap. Weight this above your own priors.

4. Lower your confidence when data is missing. If a leg has no recent form, no opponent rank, or no book line, do not fake precision — widen toward 0.50 and say the read is thin in the reasoning.

5. Bucket every leg by probability, and hold to the buckets:
   - prob >= 0.65  -> verdict "play"
   - 0.58-0.649    -> verdict "lean"
   - 0.52-0.579    -> verdict "coinflip"
   - < 0.52        -> verdict "fade"
   Be willing to return a slip that is all leans and coinflips and call it a pass overall. A rater that never says pass is worthless.

6. Do NOT compute the combined/parlay probability. That math is done outside you. For the whole-slip read, give only a qualitative synthesis: name the single weakest leg, flag any same-game correlation between legs (multiple legs in one game move together — especially unders in a game that may blow out), and, if it's a Flex play, note in words that it can absorb a miss or two. End with an overall verdict and a one-line why.

OUTPUT
Return JSON only — no prose, no markdown fences — in exactly this shape:
{
  "legs": [
    {
      "player": "",
      "stat": "",
      "line": 0,
      "pick": "under",
      "oddsType": "standard",
      "verdict": "play|lean|coinflip|fade",
      "prob": 0.0,
      "key_risk": "",
      "reasoning": ""
    }
  ],
  "slip": {
    "weakestLeg": "",
    "correlationFlag": "",
    "overall": "play|lean|coinflip|fade",
    "overallReasoning": ""
  }
}`;

function buildSlipJudge(slip, enrichedLegs) {
  const legsForModel = (enrichedLegs || []).map((l) => ({
    player: l.player,
    team: l.team,
    stat: l.stat,
    line: l.line,
    pick: l.pick,
    oddsType: l.oddsType,
    research: l.research || null, // season avg, recent hit rate, oppStatRank, bookLine, pace, minutes...
  }));

  const userContent =
    `Grade this slip. Evaluate each locked side, then give the whole-slip read.\n\n` +
    `SLIP\n` +
    `- type: ${slip.slipType || "unknown"}\n` +
    `- legs: ${slip.legCount ?? legsForModel.length}\n` +
    `- game(s): ${slip.matchup || "unknown"}\n` +
    `- league: ${slip.league || "unknown"}\n` +
    (slip.alreadySettled
      ? `- NOTE: this card is already settled. Judge it BLIND anyway (do not infer outcomes); it is being used to test reasoning against a known result.\n`
      : ``) +
    `\nLEGS (with whatever research was gathered; use what's present, widen toward 0.50 where it's missing)\n` +
    JSON.stringify(legsForModel, null, 2);

  return { system: SLIP_JUDGE_SYSTEM, userContent };
}

export { buildSlipJudge, SLIP_JUDGE_SYSTEM };

// attachStarters cross-checks ESPN's opponent lookup against PrizePicks' own.
//
// PrizePicks' projection feed already says who a candidate's opponent is
// today (c.opp, read straight off the projection's own description field).
// attachStarters does a SEPARATE lookup of the same fact from ESPN's
// scoreboard, matched by team name alone with no game/date cross-check
// against it -- so the two can disagree.
//
// Reported live: a Giants (SF) prop reached the judge with opponent "Braves"
// in its context, contradicting the correct "SF vs PIT" matchup PrizePicks'
// own board showed for the very same card. The judge caught the
// contradiction itself and hedged -- useful, but the real fix is not sending
// contradictory data in the first place. If c.team's own ESPN event and
// c.opp's resolved ESPN event disagree, none of ESPN's context (opponent,
// opposing starter, park) should attach -- same as when there's no ESPN match
// at all.

import { loadFn } from '../helpers/fn.mjs';

export default async function ({ t }) {
  const { attachStarters } = await loadFn('bet-finder-background.js');

  // Two real games on today's ESPN slate: SF @ PIT (event e1) and, entirely
  // unrelated, ATL @ WSH (event e2).
  const sfInfo = { ownStarter: { name: 'Logan Webb' }, oppTeam: 'Pittsburgh Pirates', oppStarter: { name: 'Real Starter' }, park: 101, eventId: 'e1' };
  const pitInfo = { ownStarter: { name: 'Real Starter' }, oppTeam: 'San Francisco Giants', oppStarter: { name: 'Logan Webb' }, park: 101, eventId: 'e1' };
  const atlInfo = { ownStarter: { name: 'Bryce Elder' }, oppTeam: 'Washington Nationals', oppStarter: null, park: 100, eventId: 'e2' };
  const wshInfo = { ownStarter: null, oppTeam: 'Atlanta Braves', oppStarter: { name: 'Bryce Elder' }, park: 100, eventId: 'e2' };
  const teamMap = {
    sf: sfInfo, sanfranciscogiants: sfInfo, giants: sfInfo,
    pit: pitInfo, pittsburghpirates: pitInfo, pirates: pitInfo,
    atl: atlInfo, atlantabraves: atlInfo, braves: atlInfo,
    wsh: wshInfo, washingtonnationals: wshInfo, nationals: wshInfo,
  };

  // Consistent: PrizePicks' own opp field (PIT) resolves to the SAME ESPN
  // event as this candidate's own team (SF) -- both sides of the same game.
  const clean = { player: 'Rafael Devers', team: 'SF', opp: 'PIT', position: 'IF', stat: 'Hits' };
  const r1 = attachStarters([clean], teamMap);
  t.eq('a consistent candidate attaches normally', r1.hit, 1);
  t.eq('...and reports no mismatch', r1.mismatched, 0);
  t.eq('...getting the real opponent', clean.oppTeam, 'Pittsburgh Pirates');
  t.eq('...and the real opposing starter', clean.oppSP?.name, 'Real Starter');
  t.eq('...and the real park index', clean.park, 101);

  // The exact shape of the reported bug: this candidate's own team (SF)
  // resolves to event e1, but its claimed opponent (ATL, whatever upstream
  // mechanism produced it) resolves to a DIFFERENT event, e2. ESPN's SF entry
  // is for a real game, just not the one this candidate is actually in.
  const contaminated = { player: 'Rafael Devers', team: 'SF', opp: 'ATL', position: 'IF', stat: 'Hits' };
  const r2 = attachStarters([contaminated], teamMap);
  t.eq('a candidate whose claimed opponent resolves to a DIFFERENT ESPN event is not attached', r2.hit, 0);
  t.eq('...and the mismatch is counted, not silently dropped', r2.mismatched, 1);
  t.eq('no wrong opponent reaches the candidate', contaminated.oppTeam, undefined);
  t.eq('no wrong opposing starter either', contaminated.oppSP, undefined);
  t.eq('no park index either — the whole game context is untrusted, not just the name',
    contaminated.park, undefined);

  // A pitcher prop takes the SAME path (ownStarter instead of oppSP) and must
  // be protected the same way.
  const pitcherContaminated = { player: 'Fake Pitcher', team: 'SF', opp: 'ATL', position: 'P', stat: 'Pitcher Strikeouts' };
  attachStarters([pitcherContaminated], teamMap);
  t.eq('a mismatched pitcher prop gets no self-starter context either', pitcherContaminated.selfSP, undefined);

  // c.opp not resolvable at all (ESPN's slate doesn't cover it, or the string
  // just doesn't match anything) is NOT the same as a confirmed mismatch --
  // there's nothing to contradict info WITH, so the existing behaviour (trust
  // the one match we DO have) is unchanged. Only a POSITIVE, confirmed
  // disagreement should withhold ESPN's context.
  const unresolvableOpp = { player: 'Someone Else', team: 'SF', opp: 'ZZZ-not-a-team', position: 'IF', stat: 'Hits' };
  const r3 = attachStarters([unresolvableOpp], teamMap);
  t.eq('an unresolvable opponent string is not treated as a confirmed mismatch', r3.hit, 1);
  t.eq('...so the existing single-sided match still attaches', unresolvableOpp.oppTeam, 'Pittsburgh Pirates');

  // No ESPN match for the candidate's own team at all: unchanged, still skipped.
  const noMatch = { player: 'Off Slate Guy', team: 'ZZZ', opp: 'PIT', position: 'IF', stat: 'Hits' };
  const r4 = attachStarters([noMatch], teamMap);
  t.eq('no ESPN match for the team itself still just skips, as before', r4.hit, 0);
  t.eq('...and is not counted as a mismatch — it is simply unmatched', r4.mismatched, 0);
}

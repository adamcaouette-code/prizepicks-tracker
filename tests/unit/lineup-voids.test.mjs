// Players who are not playing must never be recommended.
//
// The reported bug: Kyle Tucker and Victor Mesa Jr. were served as 85% picks
// with the model's OWN reasoning saying "Not in confirmed lineup" underneath
// them. PrizePicks voids a prop on a player who does not appear — it does not
// settle at 0 — so a "win" there pays nothing, and the pick was never real.
//
// markVoids only ever checked PITCHERS against the probable starter. Position
// players were skipped outright, which is exactly how those two got through.

import { loadFn } from '../helpers/fn.mjs';

const slate = (lineup) => ({
  games: [{
    home: { abbr: 'LAD', probablePitcher: { name: 'Some Starter' }, lineup },
    away: { abbr: 'COL', probablePitcher: { name: 'Other Starter' }, lineup: null },
  }],
});

const hitter = (player, team = 'LAD') => ({
  player, team, stat: 'Hits+Runs+RBIs', statDisplay: 'H+R+RBIs', line: 6.5,
  position: 'RF', prob: 0.2, verdict: 'play',
});

export default async function ({ t }) {
  const mod = await loadFn('bet-finder-background.js');

  // ---- a posted lineup is authoritative -----------------------------------
  const posted = [{ id: 1, name: 'Mookie Betts' }, { id: 2, name: 'Freddie Freeman' }];
  const cands = [hitter('Mookie Betts'), hitter('Kyle Tucker'), hitter('Freddie Freeman')];
  const counts = mod.markVoids(cands, slate(posted));

  t.eq('a hitter IN the posted lineup is left alone', cands[0].voidReason, undefined);
  t.eq('...and so is the other one', cands[2].voidReason, undefined);
  t.ok('a hitter NOT in the posted lineup is voided', !!cands[1].voidReason, cands[1].voidReason);
  t.ok('...with the reason stated as a void, not a loss',
    /voids this, it does not settle at 0/.test(cands[1].voidReason));
  t.eq('...and counted separately from injuries and pitchers', counts.notInLineup, 1);

  // ---- an ABSENT lineup means "not posted yet", never "nobody is playing" --
  // Lineups drop a couple of hours before first pitch. Treating that gap as
  // evidence would wipe the entire early-afternoon board.
  const early = [hitter('Mookie Betts'), hitter('Kyle Tucker')];
  const earlyCounts = mod.markVoids(early, slate(null));
  t.eq('with no lineup posted, nothing is voided on lineup grounds', earlyCounts.notInLineup, 0);
  t.eq('...not even a player who will turn out to be benched', early[1].voidReason, undefined);

  // An empty array is the same as absent — it is not a confirmed empty lineup.
  const emptyCounts = mod.markVoids([hitter('Kyle Tucker')], slate([]));
  t.eq('an empty lineup array is treated as not posted', emptyCounts.notInLineup, 0);

  // ---- the pitcher rule still works ---------------------------------------
  const pitchers = [
    { player: 'Some Starter', team: 'LAD', stat: 'Pitcher Strikeouts', position: 'P', prob: 0.6, verdict: 'play' },
    { player: 'Bullpen Guy', team: 'LAD', stat: 'Pitcher Strikeouts', position: 'P', prob: 0.6, verdict: 'play' },
  ];
  const pc = mod.markVoids(pitchers, slate(posted));
  t.eq('the confirmed starter is left alone', pitchers[0].voidReason, undefined);
  t.ok('a pitcher who is not starting is still voided', !!pitchers[1].voidReason);
  t.eq('...and counted as such', pc.notStarting, 1);

  // ---- an injured player is voided regardless ------------------------------
  const hurt = [{ ...hitter('Mookie Betts'), injured: 'Day-To-Day' }];
  const hc = mod.markVoids(hurt, slate(posted));
  t.ok('an injured player is voided even if the lineup has not posted', !!hurt[0].voidReason);
  t.eq('...counted as inactive', hc.inactive, 1);

  // ---- and none of them can reach a recommendation -------------------------
  // The real failure was downstream: a voided candidate still got picked.
  const legs = mod.selectLegs([
    { ...hitter('Mookie Betts'), sideVerdict: 'play', sideProb: 0.62, matchup: 'A vs B' },
    { ...hitter('Kyle Tucker'), sideVerdict: 'play', sideProb: 0.85, matchup: 'C vs D',
      voidReason: 'not in the confirmed lineup — PrizePicks voids this' },
  ], 2);
  t.ok('a voided player is never selected, however good the number looks',
    !legs.some((l) => l.player === 'Kyle Tucker'), legs.map((l) => l.player).join(','));
  t.ok('...while the confirmed one still is', legs.some((l) => l.player === 'Mookie Betts'));
}

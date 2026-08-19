// Players ESPN lists as OUT must never reach a recommendation.
//
// PrizePicks VOIDS a prop on a player who does not appear — it does not settle
// it at 0 — so a "win" on one pays nothing. MLB got this from confirmed
// lineups. Every ESPN league had NO check at all, which means an NFL prop on a
// player ruled out would have been rated and recommended like any other.
//
// NFL is where it bites hardest: inactives drop 90 minutes before kickoff and a
// meaningful share of any Sunday board is on players who end up down.

import { loadFn, mockFetch } from '../helpers/fn.mjs';
import { reset } from '../helpers/blobs.mjs';

const report = (rows) => ({
  injuries: [{ injuries: rows.map(([name, status, detail]) => ({
    athlete: { displayName: name }, status, details: { type: detail || null },
  })) }],
});

export default async function ({ t }) {
  reset();
  const mod = await loadFn('espn-grade.js');

  const cands = [
    { player: 'Ruled Out', stat: 'Rush Yards' },
    { player: 'Questionable Guy', stat: 'Rush Yards' },
    { player: 'Doubtful Guy', stat: 'Rush Yards' },
    { player: 'On IR', stat: 'Rush Yards' },
    { player: 'Perfectly Fine', stat: 'Rush Yards' },
    { player: 'Ruled Out + Someone Else', stat: 'Rush Yards' },   // combo
  ];
  const mock = mockFetch([[/injuries/, async () => report([
    ['Ruled Out', 'Out', 'Hamstring'],
    ['Questionable Guy', 'Questionable', 'Ankle'],
    ['Doubtful Guy', 'Doubtful', 'Knee'],
    ['On IR', 'IR', 'Achilles'],
  ])]]);
  let res;
  try { res = await mod.markEspnVoids(cands, 'nfl'); } finally { mock.restore(); }

  const by = (n) => cands.find((c) => c.player === n);
  t.ok('a player ruled OUT is voided', !!by('Ruled Out').voidReason);
  t.ok('...saying it is a void, not a loss',
    /voids this, it does not settle at 0/.test(by('Ruled Out').voidReason));
  t.ok('...with the injury carried through for the UI', /Hamstring/.test(by('Ruled Out').injured));
  t.ok('a player on IR is voided too', !!by('On IR').voidReason);

  // The judgement call that matters: questionable players play all the time.
  // Voiding them would silently delete half a Sunday board on a maybe.
  t.eq('QUESTIONABLE is not voided — those players usually play',
    by('Questionable Guy').voidReason, undefined);
  t.eq('DOUBTFUL is not voided either', by('Doubtful Guy').voidReason, undefined);
  t.eq('a healthy player is untouched', by('Perfectly Fine').voidReason, undefined);
  t.eq('a combo is skipped — there is no single player to check',
    by('Ruled Out + Someone Else').voidReason, undefined);
  t.eq('the count reflects only real voids', res.out, 2);

  // ---- an empty report must never read as "everyone is out" --------------
  reset();
  const empty = [{ player: 'Ruled Out', stat: 'Rush Yards' }];
  const noData = mockFetch([[/injuries/, async () => ({ injuries: [] })]]);
  let none;
  try { none = await mod.markEspnVoids(empty, 'nfl'); } finally { noData.restore(); }
  t.eq('an empty injury report voids nothing', none.out, 0);
  t.eq('...leaving the candidate alone', empty[0].voidReason, undefined);

  reset();
  const broken = [{ player: 'Ruled Out', stat: 'Rush Yards' }];
  const dead = mockFetch([[/injuries/, async () => ({ status: 500, body: 'boom' })]]);
  let failed;
  try { failed = await mod.markEspnVoids(broken, 'nfl'); } finally { dead.restore(); }
  t.eq('a failed injury fetch voids nothing rather than everything', failed.out, 0);
  t.eq('...and the board survives', broken[0].voidReason, undefined);

  // ---- names still match loosely -----------------------------------------
  reset();
  const suffixed = [{ player: 'Marvin Harrison', stat: 'Receiving Yards' }];
  const jr = mockFetch([[/injuries/, async () => report([['Marvin Harrison Jr.', 'Out', 'Concussion']])]]);
  try { await mod.markEspnVoids(suffixed, 'nfl'); } finally { jr.restore(); }
  t.ok('a suffix mismatch does not let an OUT player through',
    !!suffixed[0].voidReason, suffixed[0].voidReason);

  // ---- and a voided candidate can never be selected ----------------------
  const bf = await loadFn('bet-finder-background.js');
  const legs = bf.selectLegs([
    { player: 'Fit', stat: 'Rush Yards', sideVerdict: 'play', sideProb: 0.6, matchup: 'A vs B' },
    { player: 'Ruled Out', stat: 'Rush Yards', sideVerdict: 'play', sideProb: 0.9, matchup: 'C vs D',
      voidReason: 'listed Out — PrizePicks voids this' },
  ], 2);
  t.ok('an OUT player is never recommended, however good the number',
    !legs.some((l) => l.player === 'Ruled Out'), legs.map((l) => l.player).join(','));
  t.ok('...while the fit one still is', legs.some((l) => l.player === 'Fit'));

  t.eq('a league with no ESPN slug is skipped cleanly',
    (await mod.markEspnVoids([{ player: 'X', stat: 'Kills' }], 'lol')).out, 0);
}

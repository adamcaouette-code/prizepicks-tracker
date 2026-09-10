# The slip optimizer

Searches the board for the highest-EV legal slips.

| file | what it is |
|---|---|
| `netlify/functions/slip-optimizer.js` | Pure. Prefilter, beam, constraints, staking, report. |
| `netlify/functions/optimizer-config.json` | Every constraint and knob. |
| `payout-engine.js` → `kellyFraction` / `kellyStake` | Correlation-aware staking. |

## Why not brute force

A board is 2,000–3,000 props; a few hundred carry a judged probability.
`C(300,6) = 1.2e12`. Each candidate needs a copula simulation. Exhaustive
search isn't slow here, it's impossible — and anything claiming to "search the
full board" is doing something else and should say what.

## What it does instead

```
1. PREFILTER    drop legs that cannot appear in any winning slip
2. BEAM SEARCH  build slips a leg at a time, keep the best `beam_width` per size
3. SCREEN       price every candidate at 5k paths
4. FINAL        re-price the diverse finalists at 100k paths and rank
```

**The tradeoff is in step 2 and it is real.** A beam can throw away a partial
that would have grown into the best slip — a pair of mediocre legs whose third
partner is superb gets cut before that partner is considered. Widening the beam
buys that back at linear cost. The result is labelled `heuristic`, always.

The alternatives, and why not:

| approach | why not |
|---|---|
| greedy (beam width 1) | commits to the best leg before knowing its partners, and slip EV is not separable across legs — the payout table is a step function of the whole set |
| branch and bound | the bound on `P(all hit)` is weakest exactly where the board is dense with similar legs, which is always. Degenerates to brute force |
| ILP / convex relaxation | the objective is a step function of a count. No honest relaxation exists |

**Search is guided by independent EV, decided by correlated EV.** The
independent EV is closed-form and exact, so it costs nothing per partial; a
short simulation would be strictly worse guidance at enormously higher cost. The
copula runs once per candidate. The gap between the two is reported per slip.

### Two-stage pricing, because one stage took 29 seconds

Pricing every beam candidate at 100k paths took **29 seconds** on a 40-prop
board — measured, not estimated. Candidates are now screened at 5k paths
(standard error ~0.007 on `P(all hit)`) and only the finalists are re-priced
exactly. Same board: **3.4 seconds**.

The risk is a candidate mis-ranked at the screen falling outside the finalist
set; a generous multiple of `top_n` is the margin bought against it.

## The prefilter is admissible only under independence

For each leg, the most favourable slip it could be in is itself plus the best
partners on the board. If even *that* is negative-EV under independence, no
independent slip containing it is positive — a real admissibility argument.

Under a copula it is weaker in the direction that matters: positive correlation
raises `P(all hit)` above the product, so a leg the bound rejects can be rescued.
`prefilter_slack` is the margin, and it's a knob rather than a claim.

**A naive per-leg threshold would be wrong.** It's tempting to require each leg
to clear the per-leg break-even — 59.5% for a 3-leg Power. Legs at 0.90, 0.90
and 0.40 have a product of 0.324 against a break-even of 0.2105. Any filter that
drops the 40% leg is discarding winners.

### The free rider

A 5% leg beside three 90% legs is worthless on a 4-Power (**−63.6%**) and worth
having on a 4-Flex (**+23.9%**) — Flex pays 1.5× for three of four, and three
90% legs deliver that almost every time. The bad leg rides free.

A prefilter that checked only Power shapes, or only the shape at the leg's own
size, would throw it away. It takes genuinely weak partners (three 60% legs) to
make a leg hopeless — which is itself the finding: **the prefilter earns its keep
on poor slates, not good ones.**

## Hard constraints

Not preferences, not penalties. A slip violating one is never generated, never
scored, never shown. A soft penalty would let a large enough EV buy its way past
a correlation limit, which is backwards: the limits exist because the EV
estimate is *least* trustworthy in the cases they rule out.

| constraint | default | why |
|---|---|---|
| `max_legs_per_game` | 2 | Three legs from one game is one bet with extra steps |
| `max_legs_per_team` | 2 | |
| `max_legs_per_player` | 1 | Two markets on one player is betting the same thing twice — `same_player` has the strongest measured correlations in the table |
| `min_leg_probability` | 0.35 | Below a third the model is saying "this rarely happens", not "this is mispriced" |
| `allow_low_confidence_legs` | false | A leg the model is unsure of doesn't belong in a slip that needs every leg |
| `allowed_sports` | null (all) | Narrow it once the scoreboard shows a sport isn't beating the book |

**Every constraint is prefix-closed** — a cap on a count, so adding a leg can
move a set from legal to illegal and never back. That's what lets the beam prune
a violating partial immediately. A constraint that *weren't* prefix-closed (a
minimum from one sport, say) couldn't be checked during search at all. There are
none on purpose.

## Staking

Quarter Kelly by default. Full Kelly is optimal only if the probabilities are
exactly right, and the scoreboard can't yet distinguish this model's calibration
from miscalibrated.

Kelly is **solved, not scanned**. `G(f) = Σ P_k ln(1 − f + f·m_k)` is strictly
concave, so `G'` has one root, found by bisection to machine precision. It takes
the payout engine's own `byOutcome` — probability beside multiplier — so the same
function sizes an independent slip, a correlated one, and a slip with push mass
that re-prices at a smaller size, with no branch.

Verified against the closed forms: even money at 60% gives exactly 0.2; a 3×
return at 50% gives exactly 0.25; a negative edge gives exactly zero.

> There is another Kelly in this repo — `kellyFraction()` in `bet-finder-size.js`,
> private to the live board path. It builds its own **independent** hit
> distribution, and scans `f` in steps of 0.005 so it can't resolve a stake below
> half a percent of bankroll. It's left alone rather than refactored because it
> serves the board today, and a test pins the two to agree on the independent
> case so they can't drift. **There is no "task 11" Kelly module** — this is it.

The **slate cap** is a portfolio constraint applied after selection. Kelly sizes
each bet as if it were the only one; slips off one slate share legs, games and
weather, so their stakes aren't additive in risk. Stakes are scaled down
proportionally and **floored, not rounded** — rounding each to the nearest cent
pushed the total a cent over, and a cap exceeded by a cent is a suggestion.

## The reported list is diversified

The raw top five off a real board are five permutations of one idea. That's a
correct ranking and a useless report: it teaches nothing about what else the
model likes, and hides that the whole list rests on one set of picks.

Each reported slip must differ from every earlier one by `min_distinct_legs`
(default 2). **The runner-up diff is exempt** — it compares against the *true*
second best, which is exactly where a one-leg swap is the informative thing to
see. Both are reported; they answer different questions.

Selection happens on the **screened pool**, not after taking the top 20 — taking
the top twenty and then filtering for diversity left two survivors, because the
top twenty are permutations of one idea.

## "No bet today", and meaning it

The floor is not a tie-breaker. A board that *almost* clears the bar refuses as
firmly as one that is hopeless.

Under `pp-classic` the loosest bar on the whole board is the 5-leg Flex, positive
from about 54.3% a leg. A flat board at 54.0% is −1.6% on its best shape —
genuinely close, and still not a bet.

The refusal is a first-class answer: a verdict, the reason in words, the board
accounting, and **the best slip it rejected with its number**, so the refusal can
be checked rather than taken on trust.

## Two bugs the tests caught

- **The currency EV went stale after the slate cap.** `ev.atRecommendedStake` was
  computed from the pre-cap Kelly stake, so on a capped slate it reported the EV
  of a bet several times larger than the one being recommended.
- **A one-prop board blamed the prop.** With one prop there are no partners to
  build the hopelessness bound against, so every leg fell through as "hopeless"
  and the refusal read as though the prop were bad rather than the board empty.
  Board size is now checked before the prefilter.

## A live consequence of the unresolved payout table

Which payout config is in force changes the answer completely. A flat board at
**58% a leg**:

- under `pp-classic` (6-Power pays 37.5×) → a **+42% 6-leg Power**
- under `repo-observed-2026-08` (6-Power pays 16.0×) → **no bet**

That is the table disagreement flagged when the payout engine was built, still
unresolved, and it is no longer academic — it is the difference between the
optimizer recommending a slip and refusing.

## Tests

```
node tests/run.mjs slip-optimizer   # 89 assertions
```

The optimum is checked against **brute force** on boards small enough to
enumerate. A beam that quietly returns the second-best slip is the failure this
module is most exposed to, and comparing it against another heuristic would prove
nothing.

## Not wired in

The optimizer takes a board and returns slips. Nothing calls it yet — the app's
board still runs the old path. It needs judged probabilities plus a correlation
table, and **no correlation table has been built in production**, so today every
pair returns `source: 'none'`, correlation contributes nothing, and the ranking
is the independent one with the machinery in place around it.

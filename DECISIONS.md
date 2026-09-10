# DECISIONS.md

Append-only. Newest at the bottom. Every modelling assumption goes here with a
date, so that when the model changes behaviour there is a record of what was
assumed and why.

**Do not edit an entry.** If a decision is reversed, append a new entry saying
so and referencing the old one. The point of this file is that it can be trusted
six months from now.

Format:

```
## YYYY-MM-DD — short title
**Decision.** What was chosen.
**Why.** The reasoning, including what the alternative was.
**Evidence.** What it rests on — measured, conventional, or assumed.
**How to overturn it.** What measurement would change the answer.
```

---

## 2026-09-10 — Shin de-vig as the default, and it equals additive on two-way markets

**Decision.** `fair-odds.js` defaults to Shin de-vigging. On a two-way market
Shin is provably identical to the additive method, so the default costs nothing
and is the right answer if a third outcome is ever priced.

**Why.** Multiplicative de-vig assumes the margin is proportional to the price,
which systematically overstates favourites.

**Evidence.** Derived, not assumed: Shin's condition rearranges to
`p² + z·p(1−p) = π²/Π`; substituting `p = π − d` with `d = (Π−1)/2` gives an
identity. Verified numerically to 2.5e-16.

**How to overturn it.** A three-way market where the two methods diverge, scored
against outcomes.

---

## 2026-09-10 — Book weights are assumptions, not measurements

**Decision.** `book-weights.json` weights Pinnacle > Circa > DK/FD, with
PrizePicks at 0.0.

**Why.** Sharper books' prices carry more information. PrizePicks is the thing
being priced, so including it would be circular.

**Evidence.** **Convention, not measurement.** The file says so in a
`PROVENANCE` field.

**How to overturn it.** Score each book's de-vigged price against outcomes in
the snapshot archive and fit the weights.

---

## 2026-09-10 — One probability identifies exactly one parameter

**Decision.** Every two-parameter distribution in `alt-line.js` has its shape
parameter fixed from config; only the mean is solved for.

**Why.** A single observed probability cannot identify two parameters. The
further PrizePicks' line sits from the book's, the more of the answer comes from
the assumed shape.

**Evidence.** Dispersion 1.25 for strikeouts, cv 0.32 for yardage, 0.12
zero-inflation — all conventional. `shape_sensitivity` on every result is the
honest error bar, and the module REFUSES past a threshold.

**How to overturn it.** Fit each market's shape to realised counts from the
results store.

---

## 2026-09-10 — Soccer minutes are imputed from appearance type

**Decision.** ESPN's soccer game log has no minutes column, so minutes come from
`starter` / `subbedIn` / `subbedOut`: 90 / 66 / 23, each with its own sd.

**Why.** The rate model needs an exposure term and there is no other source.

**Evidence.** The absence is verified live against `eng.1` — the labels are
exactly `G A SHOT SOG FC FA OF YC RC`. The minute figures are assumptions. This
is the largest single approximation in the projection stack and is confined to
one config table.

**How to overturn it.** A source with real minutes, or fitting the three numbers
against observed counts.

---

## 2026-09-10 — Correlation is shrunk toward independence by delta-method variance

**Decision.** Estimated correlations are inverted to the latent (copula) scale
exactly, then shrunk on Fisher's z with the sampling variance propagated through
the inversion.

**Why.** The observed correlation between two counts is not the copula
parameter — two Bernoulli(½) variables at latent 0.5 show an observed ⅓. And the
inversion has a slope: on sparse marginals a tiny observed correlation maps to a
huge latent one that is not identified at any sample size.

**Evidence.** The tetrachoric relation is exact and verified to 1e-12. The
delta-method variance was added after real ESPN logs produced six pairs above
|0.9| from observed correlations under 0.10.

**How to overturn it.** It is arithmetic, not an assumption. The prior sd (0.35)
is the assumption; fit it against realised joint outcomes.

---

## 2026-09-10 — Independence understates Power MORE than Flex (the reverse of what I first wrote)

**Decision.** The payout engine's original `TODO(correlation)` claimed
independence *overstates* Flex. It does not, for the tables PrizePicks posts.

**Why.** The premise holds — correlation drains the middle of the correct-count
distribution — but a 6-leg Flex pays 25× for six and 2× for five, so the perfect
tier dominates Flex's EV too.

**Evidence.** **Measured**, across both payout configs, leg counts 3–6 and leg
probabilities 0.3–0.7: positive correlation raises Flex EV in every cell, by
roughly half as much as it raises Power. What survives is that independence
under-ranks Power against Flex.

**How to overturn it.** A payout table with a flatter Flex curve would flip it.
The finding is a property of the table, not of the maths.

---

## 2026-09-10 — Book prices in the backtest and the monitor are taken contemporaneously

**Decision.** `scoreboard-join` and `stale-lines` price against the capture that
was *current* when the forecast was made, never the closing line.

**Why.** Scoring a morning forecast against a closing price uses information the
model never had, and makes the book baseline unbeatable by construction.

**Evidence.** Structural, same rule as `captureCurrentAt()` in `ledger-store`.
`--closing` exists and answers a different question.

**How to overturn it.** Nothing — but note the book side is up to 10 minutes
stale, which is reported on every alert.

---

## 2026-09-10 — The backtest counts unresolved outcomes as losses

**Decision.** A leg that never graded is scored as a loss, not excluded.

**Why.** Excluding assumes an ungraded prop would have gone like the graded
ones. Ungradeable props are not a random sample — they are DNPs, voids and name
mismatches, which skew toward the messy end of the board.

**Evidence.** Reasoning, not measurement. It is the pessimistic choice and is
listed in the `pessimism` block of every result with the flattering alternative
named beside it.

**How to overturn it.** Grade a sample of currently-ungradeable props by hand
and compare their rate to the graded population.

---

## 2026-09-10 — The Kelly haircut only ever reduces

**Decision.** `bankroll.js` scales the Kelly fraction by the calibration slope
when it is below 1, and does nothing when it is above 1.

**Why.** A slope above 1 says the model is underconfident and full Kelly is too
small — but acting on that means betting *more* because a fit on a few hundred
graded props came out above one. The downside of being wrong in that direction
is ruin; in the other direction it is slower growth.

**Evidence.** Simulated: on a real, correctly-estimated 60/40 edge, full Kelly
has a 44% chance of halving the bankroll and 2× Kelly turns a median of $84,021
into $11.

**How to overturn it.** A calibration slope measured above 1 with a tight
interval across several thousand graded props.

---

## 2026-09-10 — Unlabelled slips are counted as neither manual nor optimizer

**Decision.** `leak-report.js` reads the ledger's `source` field and treats
anything unrecognised as `unlabelled`, excluded from both sides of the
manual-vs-optimizer comparison.

**Why.** Assuming they are manual would invent data, and it would bias exactly
the comparison being asked about.

**Evidence.** Structural. The count of unlabelled slips is stated in the answer.

**How to overturn it.** Label them.

---

## 2026-09-10 — OPEN: the payout tables disagree and it is no longer academic

**Decision.** None yet. `payout-tables.json` holds two configs and
`configFor()` picks `repo-observed-2026-08` by effective date.

**Why it matters.** A flat board at 58% a leg is a **+42% 6-leg Power** under
`pp-classic` (37.5×) and **no bet** under `repo-observed-2026-08` (16.0×). Same
board, opposite answers. It also changes every backtest P&L and every leak-report
ROI.

**Evidence.** `pp-classic` was transcribed from break-evens supplied as the
spec; `repo-observed-2026-08` from the multipliers already in
`bet-finder-size.js`. They differ by 8.3 points on a 6-pick Power.

**How to resolve it.** Check a real 6-pick Power slip on the PrizePicks app and
record the multiplier it prints. Then append an entry here retiring the wrong
one.

---

## 2026-09-10 — JSON config is loaded by static import, never by path

**Decision.** Function modules load their config with
`import CONFIG from './x.json' with { type: 'json' }`, never with
`readFile(new URL('./x.json', import.meta.url))`.

**Why.** The path form does not resolve inside the Netlify function bundle — the
module is rewritten and the JSON is not beside it. `leak-report` shipped to
production returning `{"error":"Invalid URL"}`, and `stale-lines` had the same
bug in a **silent** form: its loader caught the failure and returned `{}`, so the
scheduled run would have used built-in defaults and ignored every threshold in
its own config file.

**Evidence.** Observed live on the 4.46.0 deploy. `snapshot-background.js` has
used the static form all along and works.

**How it was missed.** Every test exercised the pure functions; nothing invoked
the handler. Both suites now call `handler()` and assert a 200 — a handler that
500s is not a pure-function bug and cannot be caught by pure-function tests.

---

## 2026-09-10 — The stale-line monitor watches every captured league, and one dead league cannot kill the run

**Decision.** `stale-lines.js` reads its league list from
`STALE_LINE_LEAGUES || SNAPSHOT_LEAGUES` (comma-separated, capped at 4, default
`mlb`) and runs each league inside its own `try`. A league that throws is
reported in a `skipped` array; the others still run.

**Why.** The handler shipped with `q.league || 'mlb'` and the cron passes no
query string, so the scheduled run watched MLB and nothing else — however many
leagues `SNAPSHOT_LEAGUES` was capturing. With football in season that is two
thirds of the board unwatched, and the failure is silent in the worst way: an
empty alert list reads as "no edges today" rather than "not looking."

The per-league `try` exists because absence is normal, not exceptional.
PrizePicks returns a 500 for `?league=cfb` out of season, and one out-of-season
league 500-ing the whole scheduled run would take the in-season ones down with
it.

The per-league failure field is named `failed`, not `skipped`. `run()` already
returns a `skipped` field — a histogram of per-prop skip reasons — and `{}` is
truthy, so the first draft's `runs.filter((r) => r.skipped)` listed every
*healthy* league as absent with an empty reason. That is a refusal carrying no
sentence, which this repo bans.

**Evidence.** Observed live: `?league=cfb` returns
`{"error":"PrizePicks isn't posting a league called 'cfb' right now"}` while
`?league=mlb` returns a normal run. The test that matters pins the mixed case —
MLB up, CFB down, both attempted, MLB still reads the archive, only CFB in the
skip list with a real sentence, quota still zero. (It pins CFB and not NFL
because `nfl` is in the hardcoded `PP_LEAGUE_IDS` map and always resolves, so an
NFL fixture never actually failed.)

**How to overturn it.** Nothing to overturn; the cap of 4 is the only knob, and
it exists to bound the free-endpoint fan-out, not the paid one — this function
deliberately spends zero Odds API credits.

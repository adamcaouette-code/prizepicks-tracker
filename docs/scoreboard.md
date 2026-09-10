# The scoreboard

**`npm run scoreboard`**

This is the primary scoreboard for the project. It grades the model's
*probabilities*, not its results.

| file | what it is |
|---|---|
| `netlify/functions/scoreboard.js` | Pure. Every score, curve, fit and the renderer. |
| `netlify/functions/scoreboard-join.js` | The join: pick log + ledger + line archive. |
| `scripts/scoreboard.mjs` | The CLI. |

```
npm run scoreboard                      everything ever graded
npm run scoreboard -- --days=30         the last 30 days
npm run scoreboard -- --league=mlb      one sport
npm run scoreboard -- --json            the whole report as JSON
npm run scoreboard -- --closing         price against the CLOSING line
npm run scoreboard -- --half-width=10   a looser ±10pp target for "meaningful"
npm run scoreboard -- --no-book         skip the archive scan (fast)
```

Exits **2** when the model is losing to the book, so it can gate a cron or a
deploy without anyone reading the output.

## Why this and not a win rate

A win rate answers *did the picks land*. That number is dominated by which props
were selected, by tier mix, and by luck — three things that move it far more than
forecasting skill does. It can be excellent while every probability is wrong.

A probability score answers *when it says 65%, does it happen 65% of the time*.
That is what the rest of the app is built on: sizing, edge, verdicts, EV all take
the probability at face value. If the probabilities are miscalibrated, every
downstream number is wrong in a way no amount of good results would reveal.

## What the report contains

**Banner.** If the model is not beating the book, that is the first thing on the
page, in a box, before any number that might soften it. If there is *no* book
baseline, that is its own warning — silence would read as a pass.

**Headline.** Brier and log loss, against two baselines on the same rows.

**Calibration slope and intercept**, from a logistic regression of the outcome on
the predicted log-odds, with standard errors — stated in plain language:

> Slope 0.496 is BELOW 1, which means OVERCONFIDENT: the probabilities are spread
> further from 50% than the outcomes justify. When it says 75% the truth is
> nearer 65%… Pulling every number toward the base rate would improve it.
>
> 1.0 is OUTSIDE the 95% interval at n=640 — this is a real miscalibration, not
> sampling noise.

**Reliability curve.** Deciles, predicted vs observed, each with a Wilson
interval drawn on the line.

**Progress.** How many graded props each bucket still needs, with a bar.

**Breakdowns** by sport, market, line type (goblin/standard/demon) and days until
game.

**Data integrity.** Book coverage with the refusal reasons itemised, and the
ledger cross-check.

## The decisions that make the numbers mean something

### Everything is scored on P(over)

The pick log's `prob` is P(over) by a convention the whole log rests on, and
`hit` is "did the over hit" (`settle()` in `grade-picks.js`). An under
recommendation at P(under)=0.66 is logged as 0.34, so the pair is always
coherent. Scoring the *side's* probability would be the same forecast
relabelled, but it would fold every under onto the top half of the axis and let
a systematic over-bias cancel against itself.

### The book price is taken contemporaneously

**Default: the capture that was current when the forecast was made.** A closing
line is sharper, but scoring a morning forecast against a closing price uses
information the model never had and makes the book unbeatable by construction.
Same rule, same reason, as `captureCurrentAt()` in `ledger-store.js`.

`--closing` answers a different question — *how much did the market learn by
kickoff that I never found out* — and every row records which mode produced it.

### The book baseline is scored on the intersection only

The model is re-scored on exactly the rows where a book price exists. Comparing
the model over every prop against the book over the subset it happens to price
would compare two different questions — and that subset is not random. It is the
liquid, heavily-modelled markets, which are the hardest ones to beat.

Alongside the mean, a **paired sign test**: on how many individual props was the
model's squared error smaller. A mean can be carried by a handful of rows.

### The archive is indexed without the line

PrizePicks posts a **ladder** — the same player and market at 1.5 through 6.5 —
and every rung is archived as its own row. DraftKings posts one line. Keying the
lookup on the exact line returned "no archived capture" for a pick whose prices
were sitting in the same capture under a different rung, and made the whole
translation layer unreachable. So the lookup is by player and market, and
`alt-line.js` moves the probability onto the rung the pick was taken at.

### A refusal is null with a reason, never a number

De-vig refuses when no book posted both sides. Translation refuses when the two
lines are far enough apart that the answer would come from the assumed
distribution shape rather than from the market. Every refusal is counted by
reason in the report, because *"the archive is empty"* and *"the lines are two
steps apart"* are different problems with different fixes, and one coverage
percentage cannot tell them apart.

### The comparison is conditional on no push, on both sides

A graded row is by construction one where no push happened — `settle()` returns
`hit: null` on a tie. So the book probability it is compared to is
`prob_no_push`. Using unconditional P(over) would charge the book for the push
mass on every whole-number line while the model was never charged for it: a
systematic advantage to the model in the one comparison the report turns on.

### The ledger is a cross-check, not the outcome source

The brief asks for every prop the judge scored, *whether or not I bet it*. The
ledger only knows about bets, so scoring from it would restrict the report to the
props liked enough to back — the most selected, least representative slice.

Where the two overlap, the ledger is an **independent record of the same fact**,
and a disagreement means one of them is wrong. That matters more than any
calibration number on the page, because the report is scored on one of them.

The ledger's `won` is the outcome of the leg **as bet**: on an under, `won` means
the over did *not* hit. Comparing without flipping that would report a
disagreement on every under in the book.

## How much data before this means anything

The gate is a Wilson interval whose half-width is inside the target (default
±5pp), evaluated **at each bucket's own probability** — an 85% bucket needs 196
rows where a 50% bucket needs 385.

`meaningful` is the **achieved** interval, not the planned row count. The formula
is an estimate; the interval is the measurement.

The numbers are large on purpose. Separating 65% from 70% is a genuinely
expensive measurement, and a report that implied otherwise would be the most
damaging thing in the file.

## Two things the tests do that are worth knowing about

**Analytic recovery.** The calibration fit is checked against data constructed so
that `logit(true rate) = a + b·logit(predicted)` holds *exactly* at every distinct
prediction. A perfect fit then exists inside the model, so the maximum likelihood
estimate must be that fit — and the IRLS recovers slope `0.500000000`,
`1.000000000`, `2.000000000` and intercept `ln 2 = 0.693147181`. A slope is
exactly the kind of number that looks plausible while being wrong.

**Wilson, not Wald.** The normal interval on 12-for-12 is `[1.0, 1.0]` — certainty
from a dozen rows — which would mark the top bucket "meaningful" the moment a
lucky streak filled it.

## Bugs this work surfaced

- **`Number(null)` is 0 and `isFinite(0)` is true.** A row with no prediction
  scored as a confident 0%, and a row recorded as *no book price* became *the
  book said 0%* — which on a prop that hit contributes a full 1.0 to the book's
  Brier and hands the model a win it never earned.
- **`translate()` returns `{over, under, push}`, not a scalar.** Assigned
  straight through, every translated row became `NaN` and dropped out — the book
  baseline would have been silently empty on exactly the rows translation exists
  to cover.
- **Murphy's decomposition is only exact for forecasts taking finitely many
  values.** Binning continuous probabilities leaves a residual the textbook
  three-term version absorbs. It is computed and printed, so the terms actually
  sum to the Brier score beside them.

## Not done

- No UI. The CLI and `--json` are the interface.
- No HTTP endpoint. `/api/calibration` still serves the older results-oriented
  view; this is deliberately a separate, offline-first tool.
- **No book coverage yet in production.** The snapshot archive has to have
  captured lines for props that have since graded. Until then the banner says so,
  and the central question of the project is unanswered.

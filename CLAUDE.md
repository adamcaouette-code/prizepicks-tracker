# CLAUDE.md

## What this is

A PrizePicks prop judge whose goal is **measurable positive EV**, not features.
Every module exists to move one of two numbers: how accurate the probabilities
are, or how well the slips built from them are priced — and if a change cannot
be tied to one of those, it should not be built.

## Push back on me

**If I ask for a feature that does not improve EV or measurement, say so before
building it.** Not after, and not by building it with a caveat attached. The
right response is one or two sentences naming what the feature would and would
not move, then a question or a recommendation.

This is not a licence to refuse work. If I hear the objection and say do it
anyway, do it properly and completely. But the app already has more surface than
it has evidence, and the failure mode here is a beautiful feature resting on a
probability nobody has scored.

Say so too when I ask for something already built, or when a smaller change gets
most of the benefit.

---

## Architecture

### Data flow

```
PrizePicks board ─┐
                  ├─► bet-finder-background ──► judge (LLM) ──► pick-log
ESPN game logs ───┤        (context: form, injuries, lineups)      │
The Odds API ─────┘                                                │
      │                                                            ▼
      ├──► snapshot-background ──► line-snapshots ────────► grade-picks
      │      (every 10 min, metered)      │                        │
      │                                   ▼                        ▼
      │                          fair-odds ──► alt-line       bet-results
      │                          (de-vig)      (translate)          │
      │                                   │                        │
      ▼                                   ▼                        ▼
  stale-lines                      slip-pricing ◄── correlation ── scoreboard
  (5 min, free)                          │           (ESPN logs)   (calibration)
                                          ▼                        │
                                   slip-optimizer ──► bankroll ◄────┘
                                          │           (Kelly, ruin)
                                          ▼
                                    proposed slips
```

### What each module owns

| module | owns |
|---|---|
| `bet-finder-background.js` | The board pipeline: fetch props, attach context, call the judge, write the pick log. **The one place a probability is created.** |
| `judge-prompts.js` | The prompt, versioned. A prompt change is a new forecaster — bump the version or calibration mixes two models. |
| `grade-picks.js` / `espn-grade.js` / `mlb-grade.js` | Outcomes. `settle()` is the single push rule. |
| `snapshot-background.js` | The archive: PP board + DK/FD prices, every 10 min. **Metered — see the budget before raising cadence.** |
| `ledger-store.js` | Append-only bets, results, snapshots. `onlyIfNew` is the guarantee. |
| `payout-engine.js` | Payout tables (as data), exact EV, break-even, Kelly. **No payout constant lives in code.** |
| `fair-odds.js` | De-vig book prices to a fair probability. |
| `alt-line.js` | Move a book probability onto PrizePicks' line. |
| `projection.js` / `game-logs.js` | Model markets the books do not price. |
| `correlation.js` / `copula.js` | The dependence between legs. |
| `slip-pricing.js` | Naive vs correlated EV for a slip. |
| `slip-optimizer.js` | Search the board for the best legal slips. |
| `bankroll.js` | How much to stake, and whether to stake at all. |
| `scoreboard.js` | **The primary scoreboard.** Grades probabilities, not results. |
| `backtest.js` / `point-in-time.js` | Walk-forward simulation that cannot read the future. |
| `leak-report.js` | Where the money actually went. |
| `stale-lines.js` | 5-minute monitor for lines the market has left behind. |

### Pure modules (no imports beyond siblings, no I/O, no clock, no randomness)

`payout-engine` · `projection` · `copula` · `correlation` · `scoreboard` ·
`point-in-time` · `alt-line` · `fair-odds` · `slip-optimizer`

Keep them that way. Every clock or fetch added to one of these is a test that
has to be rewritten and a number that stops being reproducible. Time comes in as
an argument (`asOf`, `now`); randomness comes in as a seed.

---

## Hard rules

### 1. Never invent a statistic. Return `null` with a reason.

Missing data is not zero, and it is not the league average. `Number(null)` is
`0` and `isFinite(0)` is `true` — that exact trap has produced real bugs in this
repo three times (a prop with no line counting every result as a clear; a row
with no prediction scoring as a confident 0%; "no book price" becoming "the book
said 0%").

Every refusal carries a sentence saying what was missing. `{ prob: null, reason:
'no book posted a two-way price' }`, never `{ prob: 0 }`.

### 2. No payout table or model parameter in code.

`payout-tables.json`, `book-weights.json`, `market-models.json`,
`projection-config.json`, `correlation-config.json`, `optimizer-config.json`,
`stale-lines-config.json`. A table that changes is a **new entry with a later
`effective_date`**, never an edit — old slips have to keep pricing under the
table they were placed under.

Two copies of a constant is the bug that produced the worst error this app has
made (see `tests/unit/one-source-of-truth.test.mjs`). If a number must appear
twice, add a test pinning the copies to each other.

### 3. Every probability output carries a confidence flag.

A probability with no confidence is a probability that will be sized as though
it were firm. The flag is a **field, not a suppression** — a thin estimate is
still worth seeing next to a book price, so long as nothing downstream can
mistake it for a measured one.

`low_confidence` + `confidence_reasons` (projection), `disagrees` (fair-odds),
`shape_sensitivity` (alt-line), `confidence.level` (correlation).

### 4. Every module that touches money has tests.

Money means: a probability, a payout, a stake, an EV, or a slip. Not the probes,
not the status endpoints.

---

## Definition of done

1. **Tests written and passing** — `npm test` green, full suite, not just the
   new file.
2. **No untyped escape hatches.** This is plain JavaScript with no `tsconfig`,
   so "no `any`" cannot be enforced by a compiler. What it means here: no
   function that accepts an arbitrary shape and hopes; validate at the boundary
   and refuse with a reason. JSDoc the arguments of anything exported.
3. **Config documented** — every knob in a `*-config.json` has a `note` saying
   what it does, why that value, and what would change it.
4. **A note appended to `DECISIONS.md`** explaining any modelling assumption
   made, with the date.
5. **Version bumped** in `netlify/functions/version.js` AND `public/index.html`
   (a test pins them together).

---

## Testing standards

- **Hand-computed expected values, in comments.** A test whose expected value
  came from running the code proves only that the code is deterministic. Show
  the arithmetic:

  ```js
  //   p=0.8 y=1 -> (0.8-1)^2 = 0.04
  //   ...
  //                  sum      0.90  /4 = 0.225
  t.ok('Brier is the mean squared error', near(brier(rows), 0.225), '');
  ```

- **Better still, a closed form.** Where one exists, use it: `Φ₂(0,0;ρ) = ¼ +
  asin(ρ)/2π`, the tetrachoric relation, Poisson-mixed-over-Gamma being exactly
  negative binomial. Those catch errors no plausible-looking assertion would.

- **No network calls, ever.** `mockFetch` in `tests/helpers/fn.mjs`. Fixtures
  are real captured API responses, trimmed — a hand-written fixture gives itself
  the shape it expects and hides the thing that will actually break.

- **Tolerances tight enough to fail.** A 1e-6 tolerance on a check that can hit
  1e-12 hid a real bias in the copula quadrature for a whole session.

- **Test the refusals.** "No bet today", "not enough data to say", a `null` with
  a reason — those are the outputs that matter most and the ones nobody writes
  tests for.

---

## Commands

```
npm test                  the whole suite
node tests/run.mjs NAME   one suite
npm run scoreboard        the primary scoreboard — probabilities, not results
npm run leaks             where the money went
npm run correlations      rebuild the correlation table from ESPN logs
```

---

## Things to know before changing anything

- **Schedules only register from `netlify.toml`.** In-code `export const config
  = { schedule }` is inert on a v1 `export const handler` function. Two cron
  functions carried exactly that for months and neither ever fired.
- **`public/index.html` is a single-file bundler export.** The whole app is
  JSON-escaped inside `<script type="__bundler/template">`. Decode → edit →
  re-encode, and verify a byte-exact round trip.
- **The Odds API quota is the binding constraint.** The archive spends ~90
  credits per 10-minute capture. `stale-lines` deliberately spends zero.
- **Node's `fetch` is blocked by the agent proxy in this environment; `curl`
  works.**

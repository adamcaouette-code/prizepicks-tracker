# Per-market projection models

For props the books do not price. Two modules, one config file, no UI.

| file | what it is |
|---|---|
| `netlify/functions/game-logs.js` | ESPN ingestion + blob cache. Rows in, exposure attached. |
| `netlify/functions/projection.js` | Pure. Rate → exposure → compound distribution → blend. |
| `netlify/functions/projection-config.json` | Every knob. Nothing is hardcoded in the code. |

## The shape of the model

```
rate  = shrink( recency-weighted rate , positional prior )   per unit exposure
      × opponent factor
      × home/away factor

count | exposure ~ Family( rate × exposure )
exposure         ~ Gamma( its own mean, its own sd )
count            = the compound of those two
```

**The output is always a full distribution.** `pmf`, `cdf`, `mean`, `variance`,
`sd`, plus every intermediate that produced them. Never a projected number — a
point estimate cannot answer "what is P(over 1.5)", which is the only question
this app asks.

## Why the rate, not the per-game average

A per-game average conflates two different things: how often a player does
something while he is on the pitch, and how long he is on the pitch. Bryan
Mbeumo with 3 shots on target across 66 + 90 + 23 minutes averages 1.0 per game.
That is not his rate; his rate is 3/179 = 0.0168 per minute, which over a full
start is **1.5**. Price a confirmed start off the per-game average and you are
pricing him as the bench player he sometimes is.

So the rate is `sum(w·stat) / sum(w·exposure)` — **both halves weighted**, not a
weighted mean of per-game rates. Averaging per-game rates would give a
twelve-minute cameo in which he happened to shoot once the same standing as a
full ninety.

## Exposure has its own uncertainty, and it is compounded in

Exposure is projected **separately**, with its own (longer) half-life, because
role is stickier than form: a player who has started six straight will probably
start again, while his shooting rate genuinely moves week to week.

A **dispersion floor** applies even when the history looks stable. Six
consecutive six-inning starts have an observed sd of exactly zero, and reading
that as certainty would produce a confidently narrow distribution for entirely
the wrong reason — an early hook, a rain delay or a blowout are always live.

That uncertainty is then **compounded**, not collapsed to a mean:

```
P(X = k) = Σ_j  w_j · P(X = k | exposure = e_j)
```

A Poisson conditional on a random exposure is **not** Poisson — it is
overdispersed, and that extra variance is the realism. Collapsing exposure to
its mean understates the spread of every projection, and understates it most for
bench players and short-outing pitchers, which is exactly backwards.

### The check that makes this trustworthy

A Poisson mixed over a Gamma exposure is **exactly** negative binomial. So the
quadrature can be verified against an answer computed independently of the code:

```
X | E ~ Poisson(rate·E),  E ~ Gamma(k, θ)   ⇒   X ~ NegBin(r = k, p = 1/(1+rate·θ))
```

`tests/unit/projection.test.mjs` checks this to **2.7e-12** on the PMF and 1e-8
on the mean and the overdispersion. It is the only assertion in the suite whose
expected value does not come from the code under test.

**That check found a real bug.** The exposure grid originally truncated the
Gamma at +6sd. A Gamma is right-skewed and its upper tail is fatter than a
normal's, so ~3e-6 of mass fell outside the grid — and renormalising it away
biased **every** projection's mean 4e-6 low, always in the same direction.
Adding nodes did not move it, which is what identified the range rather than the
quadrature as the cause. Widening to ±10sd dropped the residual by five orders
of magnitude. At a 1e-6 tolerance the test would have passed throughout.

## Soccer minutes are imputed, and say so

**ESPN's soccer game log has no minutes column.** The labels are exactly
`G A SHOT SOG FC FA OF YC RC` — verified live against `eng.1`. The match summary
adds `starter` / `subbedIn` / `subbedOut` as **booleans**, with no minute
attached (`subbedInFor` names the other player, not the clock).

So minutes come from appearance type:

| appearance | minutes | sd |
|---|---|---|
| started, finished | 90 | 4 |
| started, subbed off | 66 | 14 |
| came on | 23 | 12 |
| unused | 0 | — |

This is the largest single approximation in the stack, and it is confined to one
table in the config on purpose. **The sd is not decoration** — a player who
started and finished has near-certain minutes, one who came off the bench has
very uncertain ones, and that difference propagates into the final distribution.

Every affected row is stamped `exposure_source: 'imputed:<type>'`, so a measured
exposure and a guessed one are never confusable. A match whose summary was not
fetched stays `'unresolved'` and is **skipped** by the rate rather than being
filled with a default ninety.

Baseball needs none of this: innings and batters faced are in the log. But
**baseball innings are not decimal** — `5.2` is five and two *thirds*. Read as a
decimal, a starter's exposure comes in low by up to a third of an inning per
outing, and low *systematically*, since both fractional endings err the same way.

## Blending with the book

Where a book prices the same market, the model is pooled linearly with the
book-derived probability from `fair-odds.js` / `alt-line.js`:

```
blended = 0.80 · book + 0.20 · model            (0.92 / 0.08 when low confidence)
```

**Defaulting heavily toward the book is right.** A market price aggregates injury
news, lineup leaks, weather and the opinions of everyone willing to stake money
on being correct; this model sees a game log and a dozen knobs set from
convention.

**Both components are returned unblended** — `model_prob`, `book_prob`,
`disagreement`. That is the entire reason for doing this rather than quoting the
book: with the two logged separately against the same outcome, 0.80 can
eventually be replaced by a measurement instead of a belief.

A market **no book prices at all** is the case this module exists for, and there
the model stands alone (`book_weight_used: 0`) rather than being suppressed.

## Confidence is a flag, not a filter

`low_confidence` plus `confidence_reasons` in plain words ("57% of the rate is
the positional prior rather than this player"). A thin projection is still worth
seeing next to a book price, as long as nothing downstream can mistake it for a
firm one.

`min_effective_games` is **per group**, because a fixed bar is not comparable
across sports. Effective games saturates at `1 / (1 − 0.5^(days_between/half_life))`:
a starting pitcher can never exceed 9.2, a weekly footballer 6.7, a daily hitter
44. A single threshold of 5 read as "a healthy sample" for a hitter and
"most of a season" for a footballer — and permanently flagged a pitcher with six
recent starts.

## Every number is a knob

`projection-config.json` holds half-lives, priors, shrinkage strength, opponent
weight and clamp, home factor, exposure assumptions, dispersion floors,
confidence thresholds, distribution families and the book weight. They are
**starting values chosen from convention, not fitted** — the same posture as
`book-weights.json` and `market-models.json`.

Shrinkage strength is expressed in **exposure units** (`18` innings ≈ three
starts) rather than as an abstract weight. That one choice makes the shrinkage
scale with sample size automatically, and a second knob would only let the two
disagree.

The snapshot archive plus the results store is what would replace all of these
with measurements.

## What is not modelled

- **Rest days** are ingested (`restDays` on every row) but not yet used as an
  adjustment. The field is there so the adjustment can be fitted rather than
  asserted.
- **Correlation** between legs — see the `TODO(correlation)` in
  `payout-engine.js`. Every distribution here is marginal.
- **Lineup / batting order** for hitters. Plate appearances are projected from
  history, which absorbs order changes only after they have happened.

## Tests

```
node tests/run.mjs projection     # 74 assertions
node tests/run.mjs game-logs      # 60 assertions, all fetches mocked
```

The game-log fixtures are **real payloads** captured on 2026-09-10 and trimmed —
because the two things most likely to be wrong are both properties of ESPN's
actual shape (a positional stats array that means nothing unzipped, and the
missing soccer minutes column), and a hand-written fixture would have quietly
given itself both.

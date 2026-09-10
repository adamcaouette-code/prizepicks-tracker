# Correlation-aware slip pricing

Replaces naive probability multiplication. This is the most important module in
the repo after the judge.

| file | what it is |
|---|---|
| `netlify/functions/copula.js` | Pure numerics: Φ, Φ₂, Cholesky, PSD repair, the simulation. |
| `netlify/functions/correlation.js` | Pure: estimation, the latent inversion, shrinkage. |
| `netlify/functions/correlation-store.js` | Versioned persistence of the table. |
| `netlify/functions/slip-pricing.js` | Naive vs correlated EV, the delta, the ranking. |
| `netlify/functions/correlation-config.json` | Every knob. |
| `scripts/build-correlations.mjs` | `npm run correlations` — estimate and store. |

## The number that justifies the module

Three coin-flip legs, pairwise correlation ½. The trivariate orthant
probability has a closed form:

```
P(all three) = 1/8 + 3·asin(ρ)/(4π)  =  1/8 + 1/8  =  1/4
```

**Exactly double** the independent ⅛. The full correct-count distribution is
uniform — ¼, ¼, ¼, ¼ — against the binomial's ⅛, ⅜, ⅜, ⅛.

On the `pp-classic` 3-leg Power table (5× for three correct, nothing else):

```
naive EV       = 1/8 · 5 − 1 = −0.375
correlated EV  = 1/4 · 5 − 1 = +0.250
delta                          0.625
```

A slip the old engine priced at **−37.5%** is really **+25%**. That is not a
refinement of a number; it is the difference between a bet you should not make
and one you should.

## The observed correlation is not the copula parameter

For two Bernoulli(½) variables driven by a Gaussian copula with parameter ρ, the
observed Pearson correlation is exactly

```
r = 2·asin(ρ)/π          ρ = ½  ⇒  r = 1/3
```

Feeding an observed ⅓ into the copula as if it were ρ **understates the
dependence by a third** — and on a Power play that understates the whole slip.

So the inversion is done exactly. Given the two marginals, the map
ρ → implied observed correlation is a finite sum of bivariate normal
probabilities:

```
E[XY] = Σ_{j≥1} Σ_{k≥1} P(X ≥ j, Y ≥ k)
      = Σ Σ  1 − Φ(a_j) − Φ(b_k) + Φ₂(a_j, b_k; ρ)
```

strictly increasing in ρ, inverted by bisection. No small-ρ expansion, no
assuming the counts are normal. `impliedPearson` reproduces the tetrachoric
relation to 1e-12 and the round trip is exact to 1e-8 on asymmetric discrete
marginals.

## Φ₂ is the anchor

```
∂Φ₂(h,k;ρ)/∂ρ = φ₂(h,k;ρ)   ⇒   Φ₂ = Φ(h)Φ(k) + ∫₀^ρ φ₂ dt
```

64-point Gauss–Legendre on an analytic integrand. Verified against every closed
form that exists — `Φ₂(0,0;ρ) = ¼ + asin(ρ)/2π` to **7e-16**, factorisation at
ρ=0, the Fréchet bounds at ρ=±1. The correct-count distribution is simulated,
but for two legs it has an exact answer, and the tests check the simulation
against *that* rather than against another simulation.

## Four relationships, estimated separately

| relationship | why it is its own estimate |
|---|---|
| `same_player` | A pitcher's strikeouts and outs recorded. Strongly positive — both are driven by how long he lasts. |
| `same_team` | Two forwards. Positive through team volume, negative through competing for the same chances. Which dominates is a question for the data. |
| `opposing_player` | Pace and game script. A blowout inflates one side and suppresses the other. |
| `same_game_total` | The common factor — how much baseball actually happened. |

Averaging them would cancel effects with genuinely opposite signs into a mush
near zero, which looks exactly like "no correlation" while hiding two strong
ones.

Where two legs in one game have no direct pair estimate, the correlation is
induced through the **game-total factor**: the product of each market's measured
loading, negated for opposing players. Every entry says which source it used
(`direct` / `factor` / `none`). The factor is deliberately **not** applied within
one player — two markets on one player share far more than the game total, and
understating is not the safe direction on a Power play.

## Shrinkage carries the sampling variance through the inversion

Requirement 5 is "shrink toward zero when the sample is thin", and the naive
version of that is wrong here in a way that matters.

The quantity being shrunk is the **latent** correlation, not the observed one,
and the inversion has a slope. So the variance is propagated by the delta method:

```
var(observed)  = (1 − r²)² / (n − 1)
var(z_latent)  = var(observed) / (slope² · (1 − ρ²)²)      slope = d(implied)/dρ
weight         = τ² / (τ² + var(z_latent))                 τ = 0.35
```

For ordinary marginals `slope ≈ 1` and this collapses to the familiar
`1/(n−1)`. For sparse ones it explodes and the weight goes to zero **on its
own** — no threshold, no special case.

That matters because it is the difference between a usable table and a dangerous
one. See below.

## What real ESPN logs broke

All three were found by running the estimator against three live MLB game logs.
None was hypothetical.

**Rate stats masquerading as counts.** ESPN's hitter log carries `avg`,
`onBasePct`, `slugAvg` and `OPS` in the same row as the counts. Rounding a
batting average of 0.271 to build a PMF collapses the column — which produced
**16 pairs with no latent estimate at all and 8 more pinned at exactly ±1.000**,
off observed correlations as small as 0.02. Non-count columns are now excluded
by name in the table's `skipped` list.

**Sparse marginals inverting to ±1.** Hit-by-pitch and stolen bases can reach
+0.6 together but only −0.05 apart — two things that are almost always zero are
almost always zero *together*. An observed −0.09 was landing at a latent −1.0.
The first guard took `max(|lo|, |hi|)` of the attainable range, which let the
healthy ceiling vouch for the unusable floor; it has to be the bound on the side
the estimate actually clipped on. The delta-method variance then handles the
near-misses that do not clip.

**A perfect observed correlation getting zero variance.** `(1−r²)²/(n−1)`
vanishes as `|r| → 1`, so six games where one stat is exactly twice another came
out with no sampling variance and therefore **no shrinkage at any n**. The
variance is now floored at the plain Fisher-z `1/(n−3)`: carrying an estimate
through the inversion can only make it *less* identified than a directly
observed correlation on the same sample, never more.

After all three fixes, the top of the real table reads as it should:

```
same_player|earnedruns|runs        n=28   obs=+0.989  rho=+0.949
same_player|homeruns|rbis          n=129  obs=+0.702  rho=+0.787
same_player|battersfaced|pitches   n=28   obs=+0.841  rho=+0.731
same_game_total|earnedruns|total   n=28   obs=+0.716  rho=+0.598
same_player|atbats|walks           n=129  obs=−0.513  rho=−0.583
```

## The correction I got wrong, and measured

The payout engine's `TODO(correlation)` predicted that independence
**understates Power and overstates Flex** — Flex is paid from the middle of the
distribution and correlation drains the middle into the ends.

The premise holds. **The conclusion does not**, for the tables PrizePicks
actually posts. A 6-leg Flex pays 25× for six and 2× for five: the perfect tier
dominates Flex's EV too, and the middle tiers are consolation rather than the
product. Measured across both configs, leg counts 3–6 and leg probabilities
0.3–0.7, positive correlation **raises Flex EV in every case** — by roughly half
as much as it raises Power.

What survives is the relative claim, and it is the one that matters: independence
understates Power *more* than Flex in every cell, so it systematically
**under-ranks Power against Flex**. The tests pin the corrected version rather
than the intuition.

## Pushes re-price the slip at a smaller size

A push is not a loss. PrizePicks voids the leg and a 6-pick Power becomes a
5-pick Power on the 5-pick table. The simulation returns a **joint
`[pushes][correct]` matrix**, and `evFromJoint` applies the right table per
reduced size. Where the reduced size has no table, the stake is returned.

Payout tables are **step functions**, so folding pushes into losses does not
average out — it moves a slip across a tier boundary or it does not.

Because `legFromPmf` inverts the *actual* marginal, the push band on a
whole-number line survives exactly. A normal approximation would smear it away.

## Matrix repair is not optional

The matrix is assembled from **pairwise** estimates, each fitted on whatever
games happened to have both players in them, so nothing makes it positive
semi-definite. Two legs at +0.9 to a third but −0.9 to each other is a perfectly
reachable estimate and has a negative eigenvalue (−0.80 for that example).

Negative eigenvalues are clipped, the matrix rebuilt and the diagonal rescaled to
1 — and `matrixAdjusted` says it happened, so a slip priced off a repaired matrix
never presents the repair as a measurement.

## Ranking

`rankByCorrelationBenefit` ranks by **how much correlation helps**, not by EV —
the payout engine already ranks by EV. This answers a different question: where
was the old number most wrong, and in which direction.

A delta inside the simulation's own Monte Carlo error is treated as exactly zero
for ordering. Sorting on the raw point estimate would let noise float to the top;
ranking every non-significant slip *below* every significant one would push a
slip correlation actively harms above one where nothing is known, and the bottom
of the list would stop meaning "most harmed".

## Reproducibility

Seeded PRNG, no `Math.random` anywhere. Two runs of the same slip give the
identical price — a price must not move in the third decimal for reasons that
have nothing to do with the slip. Every result carries the EV's own Monte Carlo
standard error.

## Tests

```
node tests/run.mjs copula         #  55 assertions
node tests/run.mjs correlation    # 100 assertions
node tests/run.mjs slip-pricing   #  63 assertions
```

The hand-computable constants — ⅓, ¼, ⅙, ⅜, 5/12, the uniform three-leg
distribution, the −0.375 → +0.250 EV swing — are all derived in the test headers
from closed forms. Nothing in those files was produced by running the code.

## Not done

- **No table has been built in production yet.** `npm run correlations
  --athletes=…` needs a roster; until it runs, `correlationFor` returns
  `source: 'none'` for everything and every slip prices exactly as it did
  before, with confidence marked `low` and the pair count stated.
- The estimator is fed athletes explicitly rather than discovering them from the
  board. Which players matter is a question about tonight's slate, and keeping it
  an input keeps "who did we measure" reviewable.
- Soccer has no Odds API sport key, so soccer legs have marginals from the
  projection model only.

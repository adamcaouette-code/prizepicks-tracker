# Judge measurement — objectives and standing decisions

Working notes for the measurement infrastructure. Recorded here because the
decisions below are easy to get wrong from a standing start, and each of them
was reached from data rather than from taste.

## The bar

`/api/calibration` reports a **tier-only baseline**: a three-row lookup that
outputs each tier's own base rate and uses nothing else. On the log as of
2026-08-25 it scores **0.2076** (leave-one-out) against the judge's **0.2402**.
The judge is behind a lookup table by 0.0325.

Leave-one-out, not in-sample: each pick is predicted by its tier's rate computed
excluding that pick, closed form `h(n-h)/(n-1)^2`. The in-sample figure is kept
beside it because the difference between them *is* the hindsight.

The gate is **per tier** (min 10), not per config — the baseline is fitted per
tier, so a config with 40 rows split 30/5/5 would otherwise fit two baselines on
five picks each where `h(n-h)` collapses to zero. Thin tiers are dropped from
both sides so the delta compares like with like.

## Task 3 replay harness — DO NOT OPTIMIZE POOLED BRIER

The replay harness must not treat Brier as the objective.

The tier baseline has **zero within-tier resolution by construction**, so a judge
that merely reproduces tier base rates beats it on Brier while adding no betting
value whatsoever. Selection takes the top N of ~44 props: that is purely a
**discrimination** problem, and `bestHalfClears` is currently false on every
tier.

**Primary objective: within-tier discrimination.**

- AUC per tier
- realized hit rate of the top-N picks a run would actually have selected

Brier and calibration are reported **alongside, as diagnostics** — never as the
thing being maximized.

> A prompt variant that improves Brier while lowering top-N hit rate is a
> regression and must be reported as one.

## Why AUC and not lift

`lift` is a median half-split, which keeps only which side of the middle each
pick fell on. At n=200 that discards most of the ranking signal and the standard
error balloons: a -2.0pt goblin lift on 402 picks carries ±4.6 and cannot be
distinguished from zero. Reading a single bucket's lift as "the ranking is
inverted" is reading noise.

AUC uses every pairwise comparison — same data, far more power. `lift` is kept
for continuity and because it is easier to explain.

Where a claim has to be made about two buckets, make the **paired** one: the
difference between buckets on the same tier, pooled across tiers by inverse
variance. On the current log, no-form minus has-form is **+11.2 ± 5.0 pts
(z ≈ 2.2, p ≈ 0.03)** — suggestive, not settled, and stated that way.

## Form coverage

`recentAvg` is non-null exactly when the payload carried `recent5`, so it is a
record of what the judge was fed rather than an inference. Coverage is **43.5%
has-form / 56.5% no-form** across 1,857 graded picks.

`clearedShare` on the behaviour card is a **coverage** metric, not an obedience
one. The log settled it: of props reaching the judge with `recent5`, 127 of 127
returned the count; of those without, zero did. Compliance is perfect in both
directions.

Notable: `Pitches Thrown`, `Hits+Runs+RBIs`, `Hitter/Pitcher Strikeouts` and
`Home Runs` account for ~458 graded uncovered picks. Those are ordinary counting
stats PrizePicks itself serves last-5 for, so that is a live gap in
`attachHistory` rather than an inherent limitation like Fantasy Score.

## Standing constraints

Prompt text, model, search budget, payload contents, selection logic and the
shrinkage default are all variables in experiments in flight. None of them may be
changed as a side effect of measurement work.

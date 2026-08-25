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

## The selection curve, not the median split

`bestHalfClears` asks about the top 50% of a tier. That is not a cut anyone
bets: selection takes the top few of ~44 props, so a median split on a genuinely
skilled ranker averages the tail that gets wagered together with the middle that
never does, and can return "does not clear break-even" as a **false negative**.

Reported instead, per tier and per form bucket:

- percentile slices at **50 / 25 / 10 / 5%** over the pooled tier
- fixed **top 3 / 5 / 10 per RUN**, pooled across runs — the top 3 of a whole
  season's log is not a bet either; the engine picks its best few from one slate

Each against that tier's break-even, each carrying the count behind it. Cells
under 20 picks show the count only. `bestHalfClears` is kept for continuity and
is no longer the verdict.

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
variance.

On the log as of 2026-08-25, no-form minus has-form:

| pooling | lift | AUC |
|---|---|---|
| all three tiers | +8.3 ± 4.3 (z 1.92) | +0.042 ± 0.031 (z 1.36) |
| goblin + standard | +11.2 ± 5.0 (z 2.23) | +0.060 ± 0.036 (z 1.67) |

**Both poolings are published and neither is "the" number.** Dropping demon
raises the estimate because demon shows almost no difference between buckets.
There is a reasonable case for the narrower set — goblin and standard are most
of the board — but that case was only available *after* seeing which tier
diluted the result, and choosing a subset on that basis is selecting on the
outcome.

**Where AUC and lift disagree, believe AUC.** It is the better powered of the
two, and it is consistently weaker here: no pooling reaches |z| = 2 on AUC. The
lift-based z ≈ 2.2 is the most favourable number available and should not be
quoted alone.

Per-tier AUC on the same log, with Hanley-McNeil intervals:

| bucket | tier | n | lift | AUC |
|---|---|---|---|---|
| has form | standard | 200 | −11.0 ± 7.0 | 0.481 ± 0.041 |
| has form | demon | 205 | +14.7 ± 5.7 | **0.644 ± 0.049** |
| has form | goblin | 402 | −2.0 ± 4.6 | 0.512 ± 0.031 |
| no form | goblin | 773 | +8.5 ± 3.3 | **0.550 ± 0.022** |
| no form | standard | 130 | +3.1 ± 8.7 | 0.530 ± 0.051 |
| no form | demon | 147 | +15.1 ± 5.9 | **0.689 ± 0.065** |

Bolded rows are the three where AUC clears 2σ from 0.5. The defensible reading
is not "the ranking inverts with form" — it is that the judge **ranks demons
well in both buckets, ranks no-form goblins slightly, and has no measurable
ranking on has-form goblins or standards.**

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

## `source: 'ledger'` — re-judged picks are a separate population

A ledger re-judge (v4.21.0) re-scores props already on the day's ledger against
posted lineups, and logs the result beside the morning forecast rather than over
it. Those rows carry `source: 'ledger'`; the originals carry no `source` at all,
which `calibration.js` reads as `board`.

They must not be pooled with board rows in any headline number. Two reasons, and
both bite:

1. **They are not a sample of the board.** They are a sample of what the board
   already called a play or a lean — conditioned on the first judgment being
   optimistic. Their base rate is not the board's base rate, and pooling them
   drags the pooled hit rate toward the selected end.
2. **The same game appears twice.** A prop with a morning row and an evening row
   contributes two predictions and one outcome. Every standard error in
   `calibration.js` assumes independent rows; pooled, they are not.

The interesting comparison is the *paired* one — same prop, morning forecast
versus evening forecast, one outcome — which measures what confirmed lineups are
actually worth. That is a Task 3 question and needs its own estimator; it is not
what the per-source Brier table on `/api/calibration` reports.

## Standing constraints

Prompt text, model, search budget, payload contents, selection logic and the
shrinkage default are all variables in experiments in flight. None of them may be
changed as a side effect of measurement work.

---

# PRE-REGISTERED HYPOTHESIS — do not test on data graded on or before 2026-08-25

**Registered 2026-08-25. Nothing below has been acted on, and none of it may be
until the prospective check has run.**

## The observation

Per-tier AUC on the log as of 2026-08-25 shows the judge's discrimination is
concentrated almost entirely in **demons**, in two disjoint buckets:

| bucket | tier | n | AUC | z from 0.5 |
|---|---|---|---|---|
| has form | demon | 205 | 0.644 ± 0.049 | 2.94 |
| no form | demon | 147 | 0.689 ± 0.065 | 2.91 |

Both survive a Bonferroni correction across the six tier×bucket cells
(α = 0.05/6 ≈ 0.0083, needing |z| ≳ 2.64). **Nothing else in the table does** —
has-form goblin sits at 0.512 ± 0.031, has-form standard at 0.481 ± 0.041.

## Why it cannot be confirmed here

This hypothesis was *generated by looking at these rows*. Confirming it on the
same rows proves nothing — it is the identical selecting-on-the-outcome error as
choosing the goblin+standard pooling after seeing which tier diluted the
estimate. Two supporting samples drawn from one inspection are one finding, not
two.

## The prediction

> On picks graded **after 2026-08-25**, demon AUC will remain **above 0.60**.

Scope: `byFormCoverage.*.skill.demon.auc` and `skill.demon.auc`, computed on
rows with `gradedAt > 2026-08-25` only. Check once the post-registration demon
sample reaches **n ≥ 150**, which at current volume is roughly two to three
weeks.

Read it as follows:

- **AUC > 0.60 with the interval excluding 0.5** — the effect replicates
  out-of-sample and becomes a finding worth building on.
- **AUC near 0.5** — the original reading was the multiple-comparisons artifact
  it might well be, and it dies here.
- **Between** — inconclusive; extend the window rather than reinterpreting it.

## Standing prohibition until then

Do **not** change selection, sizing, tier weighting, or any prompt in response to
this. It is a hypothesis with two supporting samples from a single look at the
data, not a strategy. Demons are also the tier the engine currently bets least,
so acting early would be both premature and expensive.

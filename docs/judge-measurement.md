# Judge measurement — objectives and standing decisions

Working notes for the measurement infrastructure. Recorded here because the
decisions below are easy to get wrong from a standing start, and each of them
was reached from data rather than from taste.

## The judge can't reliably count to 5 (2026-08-30)

Reported live: Trea Turner, Plate Appearances over 4.5, reasoning said "5/5
recent cleared" — PrizePicks' own last-5 chart for the same prop showed
[4, 4, 5, 5, 5], which clears a 4.5 line 3 times, not 5. Aphrodite's prompt
deliberately asks the model to COUNT how many of the last 5 cleared the line
itself and anchor its probability on that count, before reasoning about tier
or matchup ("ANCHOR ON A COUNT, NOT AN IMPRESSION" in judge-prompts.js) — a
real, deliberate grounding technique. The model (Vilifiant/Haiku, the default)
simply got the arithmetic wrong, and the probability it produced was built
starting from that wrong count.

This was never checked. `cleared` was logged as whatever the model said,
verbatim, no matter what the pick's own recent5 array actually contained —
the exact same class of mistake item M exists to catch for a different field
(trusting a claim the code could have verified instead).

Fixed two places:
- `bet-finder-background.js`: `cleared` is now recomputed from the pick's own
  `recent5` + `line` — ground truth, computed the same way the UI's stats
  panel already computes it independently — instead of trusted from the
  model. `judgeClearedClaim` keeps what the model actually said, kept
  separately so disagreement is measurable rather than silently overwritten
  (worth a look once enough volume accumulates: how often, and does it
  correlate with the tiers/models with worse Brier scores?).
- `public/index.html`: the "why" panel now compares the model's raw `cleared`
  claim against the same ground-truth count and shows an inline warning when
  they disagree — "⚠ reasoning says 5/5 cleared — the actual last-5 data says
  3/5" — rather than letting a wrong claim sit unflagged next to a correct
  number in the stats panel two taps away. The model's reasoning PROSE can't
  be rewritten after the fact (it's the model's own sentence), so this is a
  visible flag, not a correction of the text itself.

What this does NOT do: change the prompt, the probability, the tier logic, or
selection. The wrong `cleared` count already fed a wrong probability for this
specific historical pick — that can't be undone — but nothing about how
probabilities get computed changed here, only whether a verifiable factual
claim is trusted blindly or checked against data the app already has.

7 new tests (mocked against the exact real numbers), full suite unaffected
elsewhere.

## "No candidates" was one message for three different causes (2026-08-29)

Reported live: NFL's Find Bets returned "No bets cleared your filters on this
slate. Try widening tiers or props." every single time — not a filtering bug,
not the position gate or NFL_ROLES added the same day. Confirmed by pulling
PrizePicks' raw NFL feed directly: 2,261 real props posted, `today` boolean
null on every one of them (PP doesn't set it on a future slate), and every
`start_time` reading 2026-09-09 through 2026-09-14 — Week 1. Nothing was
dated "today" because there is no NFL slate today; preseason ended, the
regular season hasn't started. `filterToday` correctly returned zero rows.
The bug was the message, not the filter: "props not posted yet" is a real
claim about the whole board when the true state is "the board is real, just
not for today" — and that distinction matters most for exactly the leagues
that don't play daily (NFL, NHL, CFB, CBB), where it will be the common case,
not an edge case.

Fixed in `bet-finder-background.js`: the raw (pre-today-filter) fetch is kept
in scope so the zero-candidates branch can tell apart three real causes —
nothing posted at all, a real board with nothing dated today (names the
actual next slate date, sorted, not an arbitrary row), or today's board real
but nothing matching the selected tiers/filter — each with its own message,
carried in a new `emptyMessage` field. `public/index.html`'s
`renderBoardResults()` had never read `out.emptyMessage` at all (a gap open
since the item-M/demon-filtering fix, which built the field but never wired
the display) — fixed at the same time, so both empty-board causes now
actually surface instead of showing the same generic line regardless of why.
6 new tests, 2/2 targeted mutations killed.

While investigating: found `grade-cron`'s scheduled heartbeat had gone silent
for 3 days (last entry 2026-08-26, none since). Traced it to `grade-cron.js`
not being a background function despite looping up to 4 days × 15 passes
internally before writing its heartbeat — with a large backlog that loop
almost certainly exceeds Netlify's sync timeout and gets killed mid-run,
before the heartbeat write, which explains the gap without the schedule
itself being broken. Worked around it this once by draining the backlog
directly against `/api/grade-picks` (self-time-budgeted, returns cleanly).

**Fixed same day**: renamed to `grade-cron-background.js` — the exact
mechanism every other `*-background.js` file in this repo already relies on
(Netlify grants up to 15 minutes instead of the ~10–26s sync limit), just
never applied to this one because nothing user-facing was ever waiting on
its response. Nothing about the draining loop changed, only how much wall
time it's allowed to use. The dev console's manual "run grading now" button
updated to match: a background function returns an empty 202 immediately, so
it now polls `/api/grade-cron-heartbeat` until a new entry appears instead of
expecting a synchronous JSON body. Whether the schedule itself re-registers
cleanly on this rename is worth confirming against a real heartbeat entry a
day or two out — renaming a scheduled function is a fresh registration, and
that's exactly the kind of thing that silently doesn't take effect without a
live deploy to confirm it (see the 08-15 to 08-25 heartbeat gap above, a
different failure mode with the same symptom).

## Multi-league orchestration (foundation in place)

The `/api/multi-league-bet-finder-background` endpoint accepts a `leagues` array
and orchestrates parallel judge calls, merging results into one ranked board with
per-league tags. Each league is judged identically to single-league runs — only
the orchestration and merge are new, preserving the config freeze.

**League support status:**
- **Fully built:** MLB, WNBA — real rolesFor rules AND a position gate (hard block
  on unambiguous stat/position traps before the judge ever sees the row).
- **Fully built (2026-08-28):** NFL — added ahead of the regular season, since PP
  preseason boards are ending. `NFL_ROLES` replaces the soccer fallback (which had
  been silently feeding the judge "clearances/crosses/goals" language on every NFL
  run — an active wrong answer, not just a generic one) with real position-fit,
  injury-report, game-script, opponent, and weather guidance, plus a position gate
  (`nflAllows`) mirroring MLB's: blocks a passing stat on a non-QB, a defensive stat
  on an offensive player, and an offense/kicking stat on a defender or kicker;
  rushing/receiving stay open for any offensive role since mobile QBs and gadget
  plays are real. 3/3 targeted mutations killed (scripts/mutations.mjs).
  Not yet built for NFL: an opponent-defense-rank feed (`fetchOppDefense` is a
  repo-wide stub returning `{}` for every league, not NFL-specific) and a
  `lineupConfirmed` signal (MLB-only today, via the confirmed-starter check) — both
  left to the model's own web search, same as WNBA.
- **Ready but default to soccer rules:** NBA, NHL, CFB, CBB — untouched, no rolesFor
  block written yet, so the soccer fallback still applies. Do the same NFL treatment
  before relying on any of these for real money.
- **Fully built (2026-08-28):** Tennis. Two separate fixes, same day. First, the
  0% gradeable rate: a shape bug, not a naming one — ESPN's tennis "event" is a
  whole tournament, with matches nested under `event.groupings[].competitions[]`,
  so the same `event.competitions[0]` read every other sport in espn-grade.js
  uses always found nothing. Confirmed live against the real API (not guessed):
  the `summary?event=` call this file makes for every other league also 400s for
  tennis no matter which id is passed — ESPN builds it as
  `events/{id}/competitions/{id}` from a single id, and a tournament id and a
  match id are never the same value. Total Games Won — PrizePicks' most common
  tennis prop — is now graded by reading each competitor's set-by-set
  `linescores` straight off the scoreboard response instead, no summary call
  needed. Aces, double faults, and break points won have no reachable source
  through this API and were removed from the mapping on purpose, so item M's
  filter correctly keeps them off the board instead of logging picks that can
  never grade. Second, `TENNIS_ROLES`: tennis has no position/role concept the
  way team sports do, so the rules are about what actually drives Total Games
  Won for one player in one match — match format (best-of-3 vs Slam best-of-5),
  how CLOSE the match is (a lopsided match runs fewer total games for both
  players; an even one runs more, for winner and loser alike — games won is not
  the same question as who wins), and retirement/fatigue risk, which unlike a
  DNP is NOT refunded by PrizePicks. Deliberately does not assert a surface
  effect ("clay is longer", "grass is faster") since that direction genuinely
  depends on the two specific players and a wrong guess baked into the prompt
  is worse than no claim — told to check by search instead. 3/3 targeted
  mutations killed across both fixes. Tennis's board will stay thin relative to
  other leagues (only one gradeable stat type) — that's expected, not a bug, and
  it's now in `SUPPORTED` for multi-league orchestration alongside MLB/WNBA/NFL.
- **Other leagues:** Can be added by writing a rolesFor block in judge-prompts.js
  and, ideally, a position gate in bet-finder-background.js's dispatch section.

**Calibration caveat:** Merging leagues into one ranked board assumes tier rates
are stable across leagues. In practice they differ: MLB goblins hit ~70%, WNBA
basketball goblins ~48%. A combined board systematically favors miscalibrated
tiers. The UI shows this warning: "Cross-league ranking: tier rates differ by
league. Results are approximate."

The feature is backend-ready. UI changes (multi-select checkboxes, warnings) are
next; once deployed, Adam can select any combination of ready leagues.

## Heartbeat observability gap (08-15 to 08-25)

The cron heartbeat was added 2026-08-15 but was empty until 2026-08-25. Root
cause: **Netlify requires an active deploy to register scheduled functions.** The
heartbeat code existed in the commit, but the schedule was not registered until
the next production deploy on 08-25.

This means "did the cron fire?" was unanswerable between 08-15 and 08-25 even
though the code was there — a 10-day observability gap created by inactivity. A
deploy that touches any function re-registers all scheduled tasks, so the fix was
implicit: the next deploy (demon board work on 08-26) restored the schedule.

The heartbeat endpoint `/api/grade-cron-heartbeat` now exposes the full log with
wall-clock timestamps and trigger source (`trigger: "schedule"` vs `"local"`), so
future gaps are immediately visible. Every scheduled firing writes one entry; if
no entries appear within 48 hours, the schedule is not registered on the live
site and requires a new deploy to restore it.

**Note on multiple heartbeat entries per window:** The 10:00 UTC window on 08-26
produced three heartbeat entries (10:13, 10:55 cluster, 12:37-12:39 cluster);
the 14:00 UTC window should produce one. Multiple invocations within a window
(likely Netlify retries or cold-start restarts) are idempotent — the grader
skips previously graded picks and exits, so repeated runs cause no duplicate
work. Every entry in the heartbeat represents a completed (and idempotent)
invocation, not an indication of duplicate grading.

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

## Replay is faithful for the TAIL, not the HEAD

The replay harness (`scripts/replay.mjs`) holds the stored search results
fixed and replays them as a prefilled assistant turn rather than letting the
model search live. That is faithful only for variants that change how the
judge reasons over a fixed set of facts — the prompt tail. It is **not**
faithful for variants that change what the judge searches, because the stored
results came from queries a different variant would not have issued. Comparing
such a variant against the replayed original would be comparing a real answer
to a hobbled one and calling the gap a finding.

Psyche and Aphrodite differ in the HEAD, not only the tail: Aphrodite added the
`lineupConfirmed` skip and sets the search budget to the number of
*unconfirmed* games, so the two versions do not even issue the same number of
searches on the same slate. **The psyche-vs-aphrodite comparison cannot be
settled by replay** and still requires parallel live runs, exactly as it has
been measured so far.

Any future variant intended for replay testing must hold the head fixed —
same search policy, same budget — and vary only the tail.

## Item G/I/J results — fidelity passes, k needed is metric-specific

**Run:** MLB, Aphrodite/Vilifiant, snapshot `9391fb8e-8ac2-47a7-9ee2-e41e3b3f0a9a`
(60 props, 20/20/20 tier mix), k=5, 2026-08-25.

**Fidelity: PASS.** Replay-vs-original mean absolute diff (0.0443) is
indistinguishable from replay-vs-replay (0.0441) — ratio 1.005, threshold for
concern was 2.0. The harness reproduces the original call. The suspected
mechanism (search replayed as a prefilled turn instead of genuine
`tool_use`/`web_search_tool_result` blocks) is not adding detectable distortion
beyond ordinary sampling noise, at least at this k.

**Noise floor:** per-pick mean absolute diff between identical replays is
**0.044** (sd 0.069 of the paired difference; per-run sigma ≈ sd/√2 ≈ 0.049 —
this is the same scale as the has-form demon AUC SE of 0.049 at n=205, a
coincidence worth noting but not load-bearing).

**k is not one number — it depends what you're trying to detect:**

| target | what it's for | k needed |
|---|---|---|
| 0.02 per-pick (original ask) | — | 96 (this was sizing for the wrong thing, see below) |
| meanProb / tierGap / calibration Brier, target 0.02 | these average over ~60 picks; aggregate sd of diff = 0.069/√60 = 0.0089 | **2** |
| ...target 0.01 | | 7 |
| ...target 0.005 | | 26 |
| AUC | bounded by GRADED OUTCOME sampling (SE 0.049 at n=205), not by judge noise. Replaying the same slate produces no new outcomes — a settled game's result doesn't change. | **replay count does not help; more graded days does** |
| top-3 selection, resolving the 0.01 gap that actually separates rank 1 from rank 3 on this slate | | 191 |
| top-3, resolving a 0.02 gap | | 48 |

So: **don't replicate for aggregate metrics (k=2-7 is plenty), can't replicate
for AUC (replay the wrong axis entirely), and top-N needs 50-200+ replays if
the goal is resolving THIS slate's actual gaps** — which, per the diagnosis
below, may not be the achievable or even the right goal.

## Top-3 churn is separation failure, not (only) noise

Predicted top-3 churn under a Gaussian model at the measured noise (per-run sd
0.049, signal spread 0.190) was **32%**. Observed was **67%** — in every single
one of the 15 pairwise comparisons (5 original-vs-replay, 10 replay-vs-replay),
only 1 of the top 3 props matched.

Diagnostic, from the original snapshot alone, no new data:

```
top 10 probabilities (desc): 0.74 0.73 0.73 0.72 0.72 0.70 0.68 0.68 0.68 0.68
rank1 − rank3 gap:  0.01
rank1 − rank10 gap: 0.06
props within 0.02 of the 3rd-place value (0.73), across all 60: 5
```

The entire top 10 spans **0.06** — about 1.2 per-run sigma. The gap the model
actually has to resolve to pick a stable top 3 is **0.01**, a fifth of one
sigma. Five props sit within noise-scale of the 3rd-place cut. Several of the
top values are also exact multiples of 0.01 (0.74/0.73/0.72/0.70/0.68),
consistent with the round-number tendency already tracked elsewhere on the
behaviour card, which compresses the effective resolution further.

**Verdict: separation failure, not noise.** The judge's own top-of-board output
is a tight cluster with essentially no gap between the picks that would and
would not make a 3-leg slip. Averaging replays shrinks the ESTIMATE of each
prop's probability, but if the true gap between competing props really is
~0.01, no amount of averaging turns a genuine near-tie into a stable ranking —
191 replays gets you a precise measurement of a distinction that may not be
meaningful. This is a property of what the judge outputs at the top of a
slate, independent of the replay harness.

## THEMIS — a tail-only variant testing whether tier anchoring caused the churn

**Rationale.** Aphrodite tells the judge two things that pull against each
other: "start inside the tier's range" (goblin 0.65-0.75, standard 0.40-0.52,
demon 0.15-0.25) and, a few paragraphs later, "use the whole range, do not
cluster — a slate of forty props should produce a spread." Told to stay in a
10-point band AND spread out inside it, 20 goblins on a balanced slate get
smeared across roughly 0.5 points apiece — underneath the ~4.9-point per-run
noise floor measured in item G/J. That is the mechanism item J's diagnosis
pointed at directly: a rank1-rank3 gap of 0.01 and five props within 0.02 of
third place is exactly what "0.5 points of true separation, 4.9 points of
noise" produces. **Tier anchoring bought calibration and cost discrimination.**

**The change.** THEMIS is Aphrodite with ONE instruction instead of two: put
ordinary props at the tier's measured rate (± a couple of points), and
reserve movement for props with a specific, stated reason — moved decisively
(≥0.10), flagged `standout: true`. Removing only "start inside the range" and
leaving "use the whole range" in place would have told the model to spread
out the very props THEMIS just called unremarkable, contaminating the
standout signal Phase 1 exists to measure — so both were removed together.
Nothing else changed: same head, same role blocks, same search policy and
budget, same `entryFor`, same measured tier rates (70%/45%/20%), same
rare-event/extremes/count-anchoring/asymmetric-cost/combo paragraphs, carried
over verbatim rather than shared, so the two prompts can never silently drift
together. See `netlify/functions/judge-prompts.js`'s `THEMIS` block for the
exact text and the full accounting of what was and wasn't touched.

Selected the same way Aphrodite is — `JUDGE_PROMPT=themis` or `?prompt=themis`
— alongside Aphrodite, not in place of it.

**Phase 1 tooling.** `netlify/functions/variant-lib.js` runs k independent
calls of a variant's prompt against a snapshot's FIXED payload and search
context (`runVariant`), then analyses them symmetrically — no run is a
privileged "original" the way replay-lib.js's A/A design has one, because
THEMIS has never run live. `judge-variant-background.js` /
`judge-variant-status.js` expose this as the same POST-202-then-poll job
pattern as every other background job in this app. Reports: standout
replication (pairwise Jaccard overlap of standout sets, a flag-count histogram,
and a disclosed-as-approximate chance baseline), the distribution of how far
flagged standouts moved from their tier's rate, per-tier calibration survival,
top-N churn among the k runs, and rank correlation against the real live
Aphrodite response the snapshot actually recorded.

**Interpretation, written down before running it:**
- standouts replicate well above the chance baseline → real signal; proceed to
  Phase 2 (AUC and hit rate on the standout subset, once picks grade)
- standouts near the chance baseline → the judge is generating noise with
  confident wording — an answer, not a null result
- zero standouts across all runs → also informative: the judge has nothing to
  add over the tier on this slate, stated honestly, which THEMIS's own prompt
  explicitly allows as "a legitimate and useful answer"

Phase 2 needs settled games and cannot be replayed. Phase 1 accelerates the
BEHAVIOURAL loop to minutes; the OUTCOME loop is still two weeks, and Phase 1
results must not be read as standing in for it.

### Phase 1 result (2026-08-25, snapshot 9391fb8e, k=5): near-chance replication

**Verdict: standouts are near the chance baseline. Do not proceed to Phase 2
on this evidence, and do not touch the prompt in response — this is a
measurement, not a fix.**

| | |
|---|---|
| standout set sizes across the 5 runs | 31, 3, 8, 18, 2 (out of 60) |
| pairwise Jaccard overlap (10 pairs) | 0, 0.06, 0.06, 0.08, 0.18, 0.18, 0.22, 0.22, 0.25, **0.67** |
| mean pairwise Jaccard | 0.176 |
| expected under independent random flagging (same set sizes) | 0.115 |
| ratio | 1.52× chance (the reporting threshold for "real signal" was 2×) |
| flagged in exactly 1 of 5 runs / 2 / 3 / 4 / 5 | 27 props / 12 / 1 / 2 / **0** |
| standout move distribution (n=62 flagged instances) | mean 0.081, min **0**, max 0.48 |
| top-3 / top-5 / top-10 churn | 80% / 68% / 49% (Aphrodite: 67% / — / 41%) |
| tierGap across the 5 runs | 0.44-0.47 (Aphrodite original: 0.44) |
| per-tier mean vs measured rate | goblin ±0.01-0.02, standard +0.02-0.05, demon +0.01-0.06 |
| Spearman vs the real Aphrodite original | 0.85-0.93 |

**No prop was flagged standout in all 5 runs.** The set sizes alone contradict
THEMIS's own stated expectation ("two to five out of forty") — one run flagged
31 of 60, another flagged 2. **The move distribution is the sharpest finding:**
mean move for a FLAGGED standout is 0.081, below the prompt's own 0.10 floor,
and the minimum is 0 — some props were flagged `standout: true` with no
displacement from the tier rate at all. That is not "noise in a real signal",
it is the judge not reliably following the instruction it was just given,
structurally the same failure mode item 5 found in `cleared` fill: an
instruction that depends on the model checking its own work is not being
checked reliably.

**Calibration survived.** tierGap stayed in the same 0.44-0.48 band Aphrodite
itself showed on this snapshot, and per-tier means sit within a few points of
the measured rates across all 5 runs — THEMIS did not break the thing item 5
said would end the experiment regardless of what the standouts did.

**Top-3/top-5 churn got WORSE, not better** (80%/68% vs Aphrodite's 67%),
though this number carries a real confound: one of the five runs (`run-2`)
issued a live web search instead of staying on the replayed context — see
below. That run's disagreement with the other four is genuine new information,
not pure sampling noise, and it is folded into the churn/Jaccard numbers
above without being separated out. The qualitative conclusion (near-chance
replication) does not turn on this one run, but the exact churn percentages
should be read as having one contaminated leg among five.

**A live search leaked through the replay — since fixed.** `run-2` issued 1
live web search despite the prefilled-turn design meant to keep replays
offline. The cause: `buildRequest` declared the tool (required for the
prefilled blocks to validate structurally) but never forbade using it again —
a prefilled assistant turn is a CONTINUATION, and the model is free to decide
mid-continuation that it wants more, especially under a prompt like THEMIS's
that explicitly asks for a named fact before flagging a standout. Declaring a
tool makes it available; it does not make it optional.

Fixed by adding `tool_choice: { type: 'none' }` to the replay request — the
tool stays declared (so the historical blocks still validate) while a NEW
invocation is structurally impossible, not merely discouraged. As a backstop
in case the API ever behaves unexpectedly anyway, `replay()` and `runVariant()`
now EXCLUDE any run that still triggers `searchesIssued()` from every
aggregate number (behaviour, pairwise, standout replication, tier calibration)
rather than folding it in with only a warning — which is what let this
specific run silently widen the THEMIS churn/Jaccard figures above in the
first place. The report separates `k` (clean runs actually analysed) from
`kRequested`, and names each exclusion with its reason.

84/84 mutations, including two new ones for the exclusion behaviour itself
(`replay-contaminated-not-excluded`, `variant-contaminated-not-excluded`).
Item G's fidelity guarantee — replay conditions match the original, or the run
is refused/excluded rather than silently degraded — now holds at the request
level, not just as a documented intent.

**Per the pre-registered interpretation:** this is the "near chance overlap"
branch — "the judge is generating noise with confident wording, and that is
the answer to the original question." The original question was whether tier
anchoring, specifically, was the cause of Aphrodite's top-3 churn. This result
does not confirm that: replacing the anchoring instruction did not produce a
more consistent top-of-board ranking, and by the crudest measure (top-3 churn)
made it slightly worse. What it does show is a SEPARATE, real problem — the
judge cannot reliably execute a "flag decisively-moved props" instruction —
which is worth knowing regardless of what it says about the original tier-
anchoring hypothesis.

## Item K — within-tier residual reliability (2026-08-26, snapshot 9391fb8e)

The question Phase 1 could not answer: is there a stable per-prop judge
opinion *underneath* the tier, at all — on either prompt, and (had it run) on
a stronger model? Computed from `report.rawRuns` on the leak-proof harness
(the live-search leak closed this session; `tool_choice: 'none'` plus
exclusion). Residual = probability minus that tier's *measured* rate (goblin
0.698, standard 0.452, demon 0.193 — not the prompt's rounder 0.70/0.45/0.20).
ICC is the one-way random-effects ICC(1,1) (Shrout–Fleiss): reliability of a
single run's residual against the same prop's mean across runs. It measures
consistency, not correctness.

**Planned as three arms, one variable each: prompt (Aphrodite vs THEMIS) and
model (Haiku vs Opus 5), both on the leak-proof harness. Only two ran.** Opus
5 rejects the harness's prefilled-assistant-turn request outright — a live
400, "the conversation must end with a user message" — which is a documented
API change across the whole 4.6+ family, not a bug. A `shape` axis
(`buildUserTurnRequest`, folding the same stored search into the user turn as
text instead) was built to work around it and passed a k=2 smoke test, but the
k=5 runs for both the Opus arm and its same-prompt/same-model `userTurn`
control failed on an Anthropic account credit shortfall before producing data.
**The model question (arm 3/4) is open, not answered — this is a missing
measurement, not a null result.** What follows is the prompt question only,
on the two arms that did complete.

| | ARM 1 — Aphrodite / Haiku (production) | ARM 2 — THEMIS / Haiku |
|---|---|---|
| clean k | 5 | 4 (`run-5` returned 0 parseable picks — a distinct failure from the live-search exclusion; not caught by it, dropped here by hand) |
| RAW probability ICC | 0.909 | 0.954 |
| RESIDUAL ICC (overall) | **0.436** | **0.324** |
| gap (raw − residual) | 0.473 | 0.630 |
| residual ICC — goblin | 0.063 | −0.022 |
| residual ICC — standard | 0.095 | 0.210 |
| residual ICC — demon | 0.427 | 0.401 |
| residual sd — goblin / standard / demon | 0.048 / 0.046 / 0.108 | 0.041 / 0.031 / 0.074 |
| residual sd — overall | 0.080 | 0.053 |
| pairwise residual r (range across all pairs) | 0.165 – 0.741 | 0.281 – 0.521 |
| pairwise residual ρ (range) | 0.151 – 0.806 | 0.242 – 0.462 |
| derived k for residual ICC → 0.80 (Spearman–Brown) | 6 | 9 |
| cost | $0.4375 | $0.5094 |

The gap row is the headline: on raw pooled probability both arms look highly
reliable (ICC ≈ 0.91–0.95), but 47–63% of that is the tier doing the work —
goblins cluster near 0.70 and demons near 0.20 regardless of which run
answered, which both prompts trivially "agree" on. What is left after
removing that — the within-tier residual — is the judge's actual repeatable
opinion, and it is smaller on THEMIS (0.324) than on Aphrodite (0.436), not
larger. Per-tier, demon is the one tier with a residual ICC clearly off the
floor on both prompts (0.43 / 0.40); goblin and standard are near zero or
slightly negative on both, meaning within those two tiers a run's deviation
from the tier rate is close to indistinguishable from noise.

**Against the pre-committed interpretation:** neither the "all arms low"
branch nor the "THEMIS meaningfully higher" branch fits. Both arms sit in the
0.3–0.6 band (stable signal swamped by noise, not pure noise), and THEMIS is
*lower* than Aphrodite, the opposite of what removing the tier-anchoring
instruction was hoped to produce — consistent with Phase 1's finding that
THEMIS's standout mechanism did not add a more consistent ranking. Per the
"any arm high" branch: a residual ICC of 0.44 says Aphrodite's within-tier
judgments are more repeatable than chance on *this* slate, not that they are
right — that still needs graded outcomes. The model question this was
supposed to help decide (does a stronger model raise the ceiling, making
prompt work or averaging worth pursuing) is unanswered pending Anthropic
account credit and a k=5 rerun of arms 3/4 through the now-built `shape`
axis — no new instrument, the same harness, once credit is available.

**Caveat, as pre-committed:** one MLB slate, 60 props. Per-tier subsets are
~19–20 props each; an ICC estimated on n≈20 subjects has wide sampling error
of its own, so the goblin/standard near-zero readings are suggestive, not a
settled floor. A low result here is still fairly strong evidence given the
consistency across two prompts; a result this low generalizes weakly on its
own and should not be treated as final without repeating on another slate.

This is the last diagnostic in this line, per instruction. The two paths from
here are (a) build the fitted model, treating within-tier judge output as
largely noise on goblin/standard and worth keeping only on demon, or (b)
complete arms 3/4 once credit allows and let the model result decide between
prompt-refinement and averaging — not a third measurement.

## Item M — ungradeable stat types excluded at the candidate stage

Measured on 2026-08-25's slate: 42 of 69 ungraded picks that night failed on
stat-name mapping, not a transient lookup — systematic, not noise. Judged and
selectable but never scorable, they were invisible to calibration while still
able to reach a slip.

`findCandidates` (bet-finder-background.js) now drops any row whose
(league, stat) does not resolve through `statResolves` — the exact predicate
grade-audit.js already uses to explain a backlog, reused rather than
re-derived so the two can never drift apart. The check runs before the prop-
type filter and alongside the position trap gate, so it costs nothing extra
and saves a judge call on every prop it removes.

**Historical size of the hole**, read live from `grade-audit`'s new
`unmappedStatsAllTime` field (every logged pick of that stat type, graded or
not — `unmappedStats` alone would undercount if any had graded historically
via the now-dead PrizePicks-history fallback; checked, and for this exact set
of stat types none ever did, so the two fields happen to read identical here):

| league :: stat | all-time count |
|---|---|
| tennis :: Total Games | 89 |
| tennis :: Fantasy Score | 28 |
| mlb :: Strikes Thrown | 10 |
| mlb :: Balls Thrown | 8 |
| mlb :: Strikes Counted | 7 |
| mlb :: Balls Counted | 4 |
| mlb :: TB | 1 |
| mlb :: Pitches Thrown 95+ MPH | 1 |

148 picks total, out of 2,746 logged across the full 27-day retained history
(2026-06-29 → 2026-08-26, read after this fix deployed). No graders were
built for these — that was explicitly out of scope — so this count is the
size of what the candidate filter now removes going forward, on record
rather than measured around.

## Item L — tier-reliability shrinkage (instrumentation only, DEFAULT OFF)

`shrinkProb` (bet-finder-background.js): `shrunk = tier_rate + (judge_prob -
tier_rate) * ICC_tier`, the standard Kelley/empirical-Bayes shrinkage
estimator applied to item K's residual ICC. `TIER_MEASURED_RATE` (goblin
0.698, standard 0.452, demon 0.193) and `TIER_RELIABILITY_ICC` (goblin 0.063,
standard 0.095, demon 0.427) are both measured, refittable config — not
hardcoded constants — sourced from item K, snapshot 9391fb8e, 2026-08-26,
Aphrodite/Haiku arm, clean k=5. Negative ICC point estimates floor at 0; a
tier missing from the ICC table falls through to 0 (pure tier rate), never to
1 — an untested tier defaults to "assume no signal," not "assume the judge is
fully trustworthy."

Gated behind `JUDGE_SHRINKAGE=1`, **default off**. When off (every run
today), every logged pick carries `shrunkProb: null` and `prob` is untouched.
When on, both are logged on every pick so calibration can score them apart —
selection and sizing are unchanged either way; nothing downstream reads
`shrunkProb`.

**Consequence that has to be written down before this is ever turned on:**
with goblin ICC at 0.063, every goblin pick collapses to within about a point
of 0.698 regardless of what the judge said — that is correct, the within-
goblin ranking was MEASURED to be noise (item K), not a bug in the formula.
But it means a probability-ordered selection over shrunk values would face a
~20-way tie at the top of a goblin-heavy board. Selection has no other basis
today (it still ranks on `fairProb`/raw `prob`, unchanged by this item), so
`JUDGE_SHRINKAGE` must not be turned on for anything that feeds selection or
sizing until a different ranking basis exists. This flag exists so
`shrunkProb` can accumulate graded volume for calibration to evaluate, not to
be flipped on in production.

**Expected effect on Brier, vs. the existing leave-one-out tier baseline
(0.2076)**: goblin and standard should move toward that baseline, since their
residual is being shrunk almost entirely away; demon should retain most of
the judge's own contribution, since its ICC (0.427) says roughly 43% of its
residual is real. Not yet measured — the flag has never been turned on
against graded volume; this is the prediction the eventual calibration read
should be checked against.

**Isotonic layer (Task 4):** no record of this spec was found in this
repository — not in `docs/`, not in git history (`git log --all --grep`, both
"isotonic" and "Task 4" turned up nothing tracked here). Rather than guess at
a specification I cannot see, this is flagged rather than answered: point me
at wherever that spec actually lives (an earlier session's transcript, a doc
outside this repo) and the supersedes-or-complements question can be
answered directly. Provisionally, based on what shrinkage IS — a per-tier
linear pull toward a fixed anchor, not a fitted monotonic map from raw score
to outcome — the two look complementary rather than redundant (isotonic
regression would ordinarily fit ON TOP of whatever score reaches it, shrunk
or raw), but that is inference from the concept's name, not from a spec, and
should be treated as such until the real one is found.

## Distance to break-even by tier — a finding, not an action item

| tier | rate | break-even | gap | best half | gap |
|---|---|---|---|---|---|
| goblin | 0.698 | 0.794 | −9.6pp | 0.731 | −6.3pp |
| standard | 0.452 | 0.595 | −14.3pp | — | — |
| demon | 0.193 | 0.437 | −24.4pp | 0.261 | −17.6pp |

Break-even rates cross-checked against calibration.js's own `BREAK_EVEN`
constants (`2.0^(-1/3)`, `4.75^(-1/3)`, `12.0^(-1/3)`) — all three match to
three decimal places.

The tier where the judge HAS signal (demon: residual ICC 0.427, AUC
0.64–0.69) is the one furthest from profitable — a 17.6pp gap even at its
best half. The tier closest to profitable (goblin: 6.3pp at best half) is the
one where the judge was measured to have none (residual ICC 0.063, AUC
0.512). Recorded as a finding. Not acted on. No experiment proposed for it.

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
one. The log first suggested it was clean: of props reaching the judge with
`recent5`, 127 of 127 returned the count; of those without, zero did.

**That "perfect compliance in both directions" claim is falsified — item 5's
finding does not survive replication.** It was read off ONE run's log, where
recent5 coverage and fill behaviour are confounded: every covered prop happened
to get filled, so filling looked deterministic. The A/A replay (item G,
2026-08-25, snapshot `9391fb8e-8ac2-47a7-9ee2-e41e3b3f0a9a`, k=5) holds recent5
coverage fixed — same 60 props, same which-ones-have-form, on every single
replay — and lets everything else vary:

| run | eligible picks answered | `cleared` filled | fill rate |
|---|---|---|---|
| original | 60 | 21 | 35.0% |
| replay-1 | 56 | 25 | 44.6% |
| replay-2 | 57 | 26 | 45.6% |
| replay-3 | 56 | 16 | 28.6% |
| replay-4 | 60 | 26 | 43.3% |
| replay-5 | 57 | 21 | 36.8% |

Recent5 availability cannot explain a swing from 16 to 26 filled — it is
identical across all six runs by construction. The fill count is moving on its
own, on IDENTICAL input, with a 62% relative range (16 to 26) between the two
extremes. **This is a run-to-run reliability failure of Aphrodite's count-first
anchoring, not a data-coverage artifact.** The prompt asks the judge to derive
`cleared` from the anchor computation before writing a probability; that
derivation is not happening consistently even when every input it needs is
present every time.

This is recorded as a measurement finding. No prompt was changed in response —
see the standing constraints below. The corrected framing (coverage sets a
floor, but does not by itself explain fill rate above that floor) also now
appears on the live `/api/calibration` page.

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

## Structural finding: demons filtered to zero in "Demon-only Find Bets"

On 2026-08-26 at ~10:16 UTC, "Demon-only Find Bets" returned "No bets cleared
your filters on this slate" despite demons being present on the board.

**Cause identified: CAUSE B — Structural filtering downstream, not an empty board.**

Demons make it through `findCandidates` when the `tiers` filter is set to
`['demon']`. However, they are all filtered out by `selectLegs` in
bet-finder-background.js line 1498:

```javascript
const pool = picks
  .filter((p) => (p.sideVerdict || p.verdict) === 'play' || (p.sideVerdict || p.verdict) === 'lean')
```

This is the selection mechanism. Only picks with verdicts of "play" (prob ≥ 0.62)
or "lean" (prob ≥ 0.54) are eligible for slip construction. The verdict is
derived from probability via `verdictFor` (judge-prompts.js line 509):
`prob >= 0.62 ? 'play' : prob >= 0.54 ? 'lean' : 'pass'`.

**The structural interaction:**

1. Aphrodite anchors demons at `ODDS_PRIOR['demon'] = 0.20`, reflecting the tier's
   measured base rate (0.193). This is used only to order tiers against each other
   in the candidate ranking — not for probability generation itself.
2. The judge produces probabilities in the range 0.15–0.25 on most demons, because
   that range accurately reflects the tier's empirical success rate.
3. All probabilities in 0.15–0.25 range map to "pass" verdict (< 0.54).
4. `selectLegs` filters to only "play" (≥0.62) and "lean" (≥0.54) verdicts.
5. Result: Every demon pick is filtered out before construction.

**Demons in the pick log, but not in slips:**

Demons still enter the pick log normally (logged, graded, and scored for
measurement). The pick log contains 343 demons historically (out of 1,855 graded
picks as of 2026-08-25); these came largely from Psyche (the earlier judge
version), which was never told the tier and rated demons freely enough to clear
0.54. Aphrodite, tier-aware and measured to have ICC 0.427 on demons, produces
probabilities that no longer pass the verdict filter.

**Why the current gate is wrong (for this use case):**

The verdict thresholds (0.62 for "play", 0.54 for "lean") are tier-blind — they
predate Aphrodite's per-tier anchoring — and they do not align with any tier's
actual break-even cost. The correct gate for selection should be per-tier
break-even, not a constant:

| tier | break-even (3-pick power) | current "lean" threshold |
|---|---|---|
| goblin | 0.794 | 0.54 (pass) |
| standard | 0.595 | 0.54 (pass) |
| demon | 0.437 | 0.54 (play or lean) |

Demons need only 0.437 to break even but must clear 0.54 to pass the verdict gate.
Goblins need 0.794 but only need 0.54 to pass. **The current system accidentally
blocks demons while passing goblins — exactly the tier furthest from profitable
(demon, 17.6pp under break-even) is structurally prevented from surfacing, while
the tier closest to break-even (goblin, 6.3pp under) is allowed through, despite
having measured no signal (ICC 0.063).**

**Why this matters as a finding, not a bug to fix now:**

This is a structural architectural problem, not a malfunction. The selection filter
is working as designed — selecting high-conviction picks. The problem is the
architectural mismatch: **a tier-blind verdict gate and a tier-aware judge
produce a situation where high signal can result in zero surface probability**.

The real fix — replacing verdictFor thresholds with per-tier break-even gates —
is the right long-term answer. But it waits until the pre-registered test
resolves. Until demon AUC is confirmed above 0.60 prospectively (see PRE-REGISTERED
HYPOTHESIS below), the current accident is close to least-bad: excluding the worst
tier inadvertently excludes the tier furthest from money, even though that tier
is the one the judge actually measures signal on.

**UI copy change needed (config freeze otherwise):**

When the tier filter is demon-only (or demon-heavy) and everything is filtered out
at the verdict gate, the empty-state message should say plainly: "Demons are
judged and logged for measurement but do not currently reach slips, because
Aphrodite anchors them below the selection threshold (0.54)." This is truth. The
current message "try widening tiers or props" implies the user can solve this by
changing filters, when in fact it is unsolvable within the current configuration.
Copy change only — no changes to thresholds, verdictFor, selectLegs, or the
prompt.

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

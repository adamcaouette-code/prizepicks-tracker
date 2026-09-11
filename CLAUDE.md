# AtomBets / PrizePicks Tracker

Live prop lines from PrizePicks with ESPN season averages, DraftKings line
comparison, Kalshi odds, a judge that rates each prop, and a slip builder.
React + Vite front end, Netlify serverless functions, Netlify Blobs for storage.

Deployed at https://atombets.netlify.app

---

## Read this before changing anything that touches the judge

`docs/judge-measurement.md` is the standing record of what has been measured and
what has been decided. It is not background reading — it contains binding
constraints, and several of them forbid changes that would otherwise look
obviously correct.

**Two things in it are in force right now:**

1. **Standing constraints.** Prompt text, model, search budget, payload
   contents, selection logic and the shrinkage default are all variables in
   experiments in flight. None may be changed as a side effect of other work.

2. **A pre-registered hypothesis** on demon-tier AUC, registered 2026-08-25.
   Until it resolves, do not change selection, sizing, tier weighting or any
   prompt in response to demon-tier results. The first out-of-sample check ran
   2026-09-09 and came back inconclusive; the registered instruction on that
   branch is to extend the window, not to act.

If a request seems to require breaking one of these, say so and stop rather than
working around it.

---

## The thing this project is actually for

This is measurement infrastructure that happens to have a betting UI. Its value
is that it catches its own errors — it has found scheduled functions that never
fired for two months, unders being graded on the over's outcome, and a
recommendation stream losing 45 cents on the dollar. Changes that make the app
feel better while making the measurement weaker are regressions.

**Every tier is currently below break-even.** Break-even per leg on a 3-pick
Power is 79.4% goblin / 59.5% standard / 43.7% demon, set by the payout
multipliers. The judge is roughly level with a three-row tier lookup table.
Nothing here is a profitable system, and no prompt change will make it one.
Do not build features whose premise is that it is.

**The edge guardrail (`edgeVerdictFor`, bet-finder-background.js) refuses any
leg whose probability is below its tier's break-even.** It refuses about 90% of
volume, and the refused bucket measures at −43 cents per dollar at 14σ. Do not
weaken, bypass, or add an override to it. "Find a slip anyway" is not a feature
request that can be honoured.

---

## Conventions that other code depends on

- `prob` means **P(over)** and `hit` means **the over cleared**, everywhere in
  the pick log and calibration. This convention is load-bearing and must not
  change. Unders are scored by deriving from it, not by flipping it.
- Never score a bucket against a break-even it does not have. PrizePicks prices
  the over only; derive the bar from the edge (`needed = sideProb − edge`) so it
  is null exactly when the price is unknown.
- A raw win rate is meaningless across tiers. Every number reported must state
  what it needed beside what it got.
- **Do not optimize pooled Brier.** The tier baseline has zero within-tier
  resolution by construction, so a judge that merely reproduces tier base rates
  beats it on Brier while adding no betting value. The objective is within-tier
  **discrimination** (AUC, and realized hit rate of the top-N a run would
  actually select). Brier and calibration are diagnostics reported alongside.

---

## Standing engineering rules, learned the hard way

- **A behaviour change that can't be scored isn't finished.** If the measurement
  needs data the change itself will take months to produce, look for a
  reconstruction first — the quantity is often already in the log.
- **A paired comparison is worth a field.** When two estimates of the same thing
  exist at different times, log both. Comparing groups instead of pairs costs an
  order of magnitude in sample size and imports every selection effect that
  chose the groups.
- Netlify **schedules only take effect in `netlify.toml`**. In-code
  `export const config = { schedule }` is a v2-functions feature and is silently
  ignored on the v1 `export const handler` functions in this repo. Both cron
  functions carried exactly that for months and neither ever fired. Verify with
  a non-empty `function_schedules` in the deploy API — invoking the function
  over HTTP tests the function, not the schedule.

---

## Working in this repo

```bash
npm install
npm test                 # node tests/run.mjs — ~2 min, 67 suites
netlify dev              # NOT npm run dev; functions won't load otherwise
```

- Tests live in `tests/unit/` and `tests/ui/`, auto-discovered by filename
  (`*.test.mjs`). `tests/helpers/blobs.mjs` is an in-memory stand-in for
  Netlify Blobs that serializes on read and write exactly as production does.
- Test names are sentences describing the behaviour, not the function
  (`"the cutoff day is excluded whole, not split at midnight"`). Match that.
- The suite is 67/67 green. There is no standing exemption — a failure is a
  real failure. (`empty-board-message` and `stale-read` used to carry hardcoded
  future dates that the wall clock eventually caught up to; fixed in v4.39.0 by
  making the fixtures relative to `Date.now()`. If either starts failing again
  it is a new bug, not that old one recurring.)

## Versioning

`vMAJOR.MINOR.PATCH`. MAJOR for a new subsystem, MINOR for refinement and
tuning, PATCH for bug fixes. It lives in **two places that must match**:
`netlify/functions/version.js` (`VERSION`) and `public/index.html` (the footer,
`id="appVer"`). `tests/unit/version.test.mjs` fails if they drift. Check a
deploy landed with `/api/version`.

## Commits

One-line summary with the version in parentheses, then prose explaining what was
wrong and why this is the fix — not a list of files touched. Name the regression
cover at the end.

Example: `Filter calibration by grade date, not log date (v4.39.0)`

---

## How work ships here

Do all of this without asking for confirmation at each step. Ask only when a
decision is genuinely ambiguous or when something below says to stop.

1. Work on a branch named `claude/<short-description>`.
2. Make the change. Bump the version in **both** places if app behaviour
   changed (`netlify/functions/version.js` and the `id="appVer"` footer in
   `public/index.html`).
3. Run `npm test`. It takes about two minutes. The suite is 67/67 green with no
   standing exemption — any failure is yours to fix before continuing.
4. Commit in the style described above, and push the branch.
5. Open a PR with `gh pr create`, summarising what was wrong and why this fixes
   it.
6. If the suite is green, merge it: `gh pr merge --squash --delete-branch`.
7. Netlify builds from `master` automatically. Wait for the deploy, then check
   `https://atombets.netlify.app/api/version` and confirm the version matches
   what you just shipped. An older version means the build failed and Netlify
   kept the previous deploy live — read the build log and say so. Do not report
   success without this check.
8. Report what shipped in two or three sentences: what changed, what the tests
   said, and the confirmed live version.

### Stop and ask instead of merging when

- The change touches selection, sizing, tier weighting, thresholds, or any
  prompt — see the standing constraints above. These are frozen.
- Tests fail beyond the four known ones and the fix isn't obvious.
- The change would weaken, bypass, or add an override to the edge guardrail.
- A migration or anything that rewrites the pick log is involved. Blob data is
  the measurement record and there is no backup.

In those cases: push the branch, open the PR, explain the concern, and leave it
unmerged.

# AtomBets — UI ↔ backend contract

What a new front end has to honor so features don't end up wired on one side only.
Written against the code as deployed; field names below are literal.

---

## 1. How the page is actually served

`netlify.toml`:

```toml
[build]
  publish = "public"
  functions = "netlify/functions"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200
```

Two things follow, and both bite:

- **`public/index.html` is a single-file bundler export.** The entire app — markup, CSS,
  three `<script>` blocks — lives as one JSON-escaped string inside
  `<script type="__bundler/template">` on line 187. Editing it means decode → edit →
  re-encode. A hand-written HTML file cannot be dropped in next to it.
- **`src/App.jsx` is not deployed.** A Vite React app exists in `src/`, `npm run build`
  emits to `dist/`, and nothing publishes `dist/`. Everything live comes from `public/`.

So the redesign has to pick one and say which:

- **A — plain static.** Replace `public/index.html` with ordinary HTML/CSS/JS. Simplest;
  drops the bundler wrapper entirely. No build step.
- **B — React.** Build the UI in `src/`, and change `netlify.toml` to `publish = "dist"`.
  Requires the build to run on deploy.

Do not hand back another bundler-encoded file.

---

## 2. Three timing patterns — the single biggest risk

Netlify kills a **synchronous** function at ~10s. Two calls are far slower than that and
are already converted to background jobs. A UI that awaits them like normal fetches will
show a spinner forever and then a parse error.

| Call | Typical | Pattern |
|---|---|---|
| `parse-slip` | 5–7s | plain `POST`, await the response |
| `judge-slip` | 30–40s | **POST → 202 → poll status** |
| `bet-finder` | 5–8 min | **POST → 202 → poll status** |

Background shape, both cases:

1. mint a `jobId` client-side (`crypto.randomUUID()`)
2. `POST /api/<name>-background` with `{ jobId, ...payload }` → returns **202, empty body**
3. poll `GET /api/<name>-status?jobId=…` every ~2s
4. status is `running` (with a human `step` string), `done` (carries `result`), or `error`
   (carries `message`)

The UI needs real progress copy — the `step` field is written for display
("Claude grading each leg", "matching legs to live projections") — plus an elapsed
counter. A bare spinner for 40 seconds reads as broken.

**Never call `.json()` on a response without checking.** A timed-out or crashed function
answers with an HTML error page, and `.json()` on that throws a browser-specific message
that names nothing useful (in Safari: *"The string did not match the expected pattern"* —
this cost a debugging session). Read `text()`, `JSON.parse` in a `try`, and on failure
surface the status code plus a snippet of the body.

Polling should tolerate one bad poll and give up after ~5 consecutive failures — a blip
shouldn't kill a 40-second job, but a dead endpoint shouldn't spin for the full timeout.

---

## 3. Endpoints

### `GET /api/pp-leagues` — league selector

```jsonc
{ "count": 28,
  "leagues": [
    { "id": "2", "name": "MLB", "tag": "mlb", "projections": 2941,
      "parentId": null, "parentName": null, "lastFiveGames": true,
      "research": "full",     // "full" | "props"
      "kind": "game" }        // "game" | "season" | "live" | "period" | "series"
  ] }
```

Default returns only leagues with a live slate, per-game boards first. `?all=1` includes
dark ones. The list is **dynamic** — do not hardcode league buttons. A finished tournament
disappears on its own; a new sport appears on its own.

`projections` is the live slate size and is worth showing — it tells you whether filtering
is even worthwhile.

### `GET /api/pp-stats?league=mlb` — prop filter

```jsonc
{ "league": "mlb", "cached": false,
  "statTypes": [ { "stat": "Hitter Strikeouts", "display": "Hitter Ks", "count": 229 } ] }
```

**Label with `display`, submit `stat`.** See §5.

### `POST /api/bet-finder-background` → `GET /api/bet-finder-status?jobId=`

Request: `{ jobId, league, legs, today, tiers, statFilter?, maxPicks?, deepDive? }`
→ `202`, empty body.

Status: `{ status, step, elapsedMs, typicalMs, phases[], result?, message? }`.
`typicalMs` is the average of previous runs — good for a real progress bar rather than an
indeterminate one. `result` carries
`{ board, players, parlay, parlayLegs, traps, teamRecords, winProbs, oddsStatus, mlbStatus, allPicks, params, deepDive }`.

`deepDive: true` in the request runs the second, per-prop pass described in §6 after the
normal scan. `result.deepDive` is `null` when the flag wasn't set, otherwise
`{ requested, completed, errors? }` — `completed` can be less than `requested` if an
individual call failed (the run still finishes; a failed prop just keeps its stage-1
number). Any pick object that was re-judged carries `deepDive: true` plus `shallowProb`/
`shallowEdge` holding the pre-deep-dive read; every other pick carries `deepDive: false`.

### `GET /api/top-picks?format=json` — today's ledger

```jsonc
{ "date": "2026-08-13", "count": 12, "picks": [ { … } ] }
```

Pick object (same shape the grader and calibration read):

```jsonc
{ "date", "loggedAt", "league", "projectionId", "player", "stat", "line",
  "prob", "verdict", "oddsType", "recentAvg", "image", "team", "matchup",
  "result": null, "hit": null, "gradedAt": null }
```

`hit` is `null` until the game settles, then `true`/`false`. A pick card needs all three
states.

### `POST /api/parse-slip` — screenshot → legs

Request `{ image }` (base64 or data URL). ~5–7s, plain await.

```jsonc
{ "ok": true,
  "slip": { "slipType": "power", "legCount": 3, "league": "mlb", "matchup": "CIN vs CWS",
            "alreadySettled": false,
            "legs": [ { "player", "team", "position", "number", "stat", "line",
                        "pick": "over", "oddsType": "goblin" } ] },
  "warnings": [ "…" ] }
```

`warnings` must be rendered — it carries "this card is already settled" and "a line could
not be read as a number", both of which change how much the grade is worth.

### `POST /api/judge-slip-background` → `GET /api/judge-slip-status?jobId=`

Request `{ jobId, slip }` where `slip` is the parse-slip object **after the user's edits**.

`result`:

```jsonc
{ "ok": true,
  "legs": [ { "player", "stat", "line", "pick", "oddsType",
              "verdict", "prob", "key_risk", "reasoning", "team", "matchup", "image" } ],
  "slip": { "weakestLeg", "correlationFlag", "overall", "overallReasoning" },
  "dataStatus": { "matchedLegs", "totalLegs", "leagueSupported",
                  "oddsStatus", "bookLineStatus",
                  "loggedForCalibration", "skippedNoProjection" } }
```

`reasoning` and `key_risk` can contain `<cite index="…">…</cite>` — the judge runs with web
search on. Strip the tags, keep the words, and keep escaping everything else.

### `GET /api/calibration` — HTML page, `?format=json` for data

```jsonc
{ "logged", "graded", "pending", "pendingGradeable", "combos", "givenUp", "pendingByDate",
  "overall", "brier",
  "bands":   [ { "band": "60-70%", "n": 14, "predicted": 0.64, "actual": 0.57 } ],
  "byTier", "byLeague",
  "bySource": { "board": { "n", "hits", "brierSum" }, "slip": { … } },
  "byModel": { "Vilifiant": { "n", "hits", "brier", "predicted", "actual", "overstatement",
                              "baseline", "baselineDelta", "beatsBaseline" }, … },
  "plays", "playsLeans", "spend" }
```

The HTML page's top headline (the `.cards` grid) is pooled across every model this app has ever
run — right for comparing configs, wrong for "how good is it right now" once old configs stop
being used. A **VILIFIANT ONLY** section renders right below it, pulled from `byModel.Vilifiant`
(same rows the per-model table further down the page uses) — keep this pattern if another model
becomes the standing default: don't repurpose the pooled headline, add a scoped one beside it.

### Smaller ones

- `POST /api/bet-finder-size` — `{ legs, bankroll, floor, maxStake? }` → parlay sizing/EV
- `POST /api/ask` — per-pick follow-up chat, live on the board's "ask" panel.
  `{ pick, messages }` → `{ answer, revisedProb, usedSearch, stopReason }`. Runs on
  Haiku 4.5. `revisedProb` is null on most turns — only set when the model's own
  view has genuinely moved mid-chat (a scratch, a lineup change the user surfaced).
  Shown beside the board's own prob, never substituted for it: the engine's logged
  prob/verdict and the board's sort/edge/slip math are untouched by anything said
  in a chat.
- `POST /api/reevaluate` — re-grades one pick, returns what changed
- `GET /api/dev`, `GET /api/pp-probe` — internal tooling, not part of the product UI

---

## 4. Vocabulary — don't rename these

**Verdicts** are a closed set, and the thresholds are enforced in the judge prompt:

| verdict | probability | meaning |
|---|---|---|
| `play` | ≥ 0.65 | worth playing |
| `lean` | 0.58 – 0.649 | mild edge |
| `coinflip` | 0.52 – 0.579 | no real edge |
| `fade` | < 0.52 | actively bad |

Four states, four visual treatments. Don't collapse to strong/weak, and don't invent a
fifth. `fade` needs to look *unattractive* — the tool's value is talking someone out of a
leg, so a fade styled like a recommendation defeats it.

**`prob` is a decimal 0–1**, not a percentage. Multiply for display.

**Tiers** (`oddsType`): `goblin`, `standard`, `demon`. Currently ~73% of the MLB board is
demon, and the default tier selection is goblin + standard — so a normal run screens
roughly a quarter of what's posted. Worth surfacing if a scan comes back thin.

**League `kind`**: `game` is an ordinary per-game board. `season` is season-long futures,
`live` is an in-progress board, `period` is a half/quarter split, `series` is multi-game.
The engine reasons about *tonight's game* — recent form, the opposing starter, today's
win%. A confident grade on a season future is nonsense. These stay selectable but must be
visually marked; `NFLSZN` alone posts 1,352 futures and will otherwise outrank real boards.

**League `research`**: `full` means standings + win% + DraftKings line are wired. `props`
means the props load and get graded, but with no research attached — the judge is
instructed to widen toward 50%. Mark it.

---

## 5. Some labels come from PrizePicks, not from us

PrizePicks carries **two** names per stat and they differ for most props:

| `stat_type` (API, and what we filter on) | `stat_display_name` (what the card shows) |
|---|---|
| Hitter Strikeouts | **Hitter Ks** |
| Pitcher Strikeouts | **Ks** |
| Total Bases | **TB** |
| Hitter Fantasy Score | Hitter FS |
| Stolen Bases | SB |
| Pitching Outs | PO |

The user is holding a screenshot that says "Hitter Ks". A dropdown listing "Hitter
Strikeouts" reads like a different app. So: **label with `display`, submit `stat`.** Both
come back from `/api/pp-stats` on the same object.

Do not hardcode a prop list. It goes stale, and that's how the app shipped for months with
no pitcher props selectable at all.

---

## 6. Honesty features that have to survive the redesign

These exist because a confident-looking wrong answer is the failure mode that matters
here. Each needs a home in the new layout.

- **"Data behind this grade" banner.** Driven by `dataStatus`. When `matchedLegs` is 0 the
  grade came from player profile alone with probabilities widened toward 50% — that must
  look different from a fully-researched grade, not identical to it. Amber when thin.
- **Editable legs before grading.** OCR misreads lines. The user must be able to fix the
  line, flip over/under, and delete a leg *between* parse and grade. This is not optional
  polish; a wrong line silently produces a wrong grade.
- **`warnings` from parse-slip**, rendered where they can't be missed.
- **Thin / derived league markers** (§4).
- **Calibration**: Brier score, predicted-vs-actual bands, and the per-engine split
  (`bySource`). Brier is the number that answers "is this any good" — hit rate alone can't
  tell a sharp engine from a lucky one. If the calibration view gets restyled, those three
  survive.
- **A chat-side revised probability never overwrites the board's own number.** The `ask`
  panel's `revisedProb` is the user's own follow-up read, shown beside the engine's logged
  prob/verdict — not fed back into sort, edge, or slip math, and not written over the
  pick-log entry that calibration scores. A redesign that lets a chat answer silently
  change what the board shows or what a slip is built from breaks calibration integrity;
  keep the two numbers visibly distinct.
- **`ask` is available everywhere a pick appears, not just the Search board.** Today's
  Ledger cards carry it too, since the context genuinely differs — a logged pick-log row
  doesn't carry `recent5`/`oppSP`/`reasoning`, only what got persisted, and the chat
  degrades gracefully off that thinner set rather than refusing. Each surface's panels
  must stay scoped to their own container (`legKey` collides across tabs when the same
  pick appears on both at once) — see `askPanelEl`'s `root` parameter if reimplementing.
- **`ask`'s system prompt states `recent5`'s cleared-count as a computed fact, never a raw
  array left for the model to count.** `buildSystem()`'s `clearedFact()` computes it from
  the same `recent5` + `line` the board already cross-checks the judge's own claim against
  (§ above, "The judge can't reliably count to 5") — a cheap model doing that arithmetic
  live, in prose, while also weighing a differently-framed count from web search, produced
  an answer arguing from "hasn't hit 5 Ks in six starts" against a line that only needed 3.
  If the payload gains a new per-prop count the model might need to reason about, compute
  it server-side and state it as a fact — don't hand over raw numbers and trust a chat
  model's arithmetic under load.
- **Today's Ledger shows a browsable leaderboard, not an auto-built slip.** It used to
  assemble one 2-6 leg parlay automatically (capped per player, spread across games) —
  that hid every other pick worth seeing behind a single load button. Now it ranks up to
  10 eligible picks by edge and gives each its own add button; the user decides what goes
  in a slip. Keep the two rules that still matter: rank by edge (never raw probability —
  a goblin's break-even is ~79%, a demon's ~44%, so raw % misorders badly), and collapse
  duplicate LINES of the same prop to one row (they're nested, not independent — showing
  both is noise). Do not reintroduce a per-player cap or game-spreading; those belonged to
  building one slip automatically, not to ranking a list.
- **The leaderboard's tier chips (Goblin/Standard/Demon) filter, they don't re-rank.**
  `LEDGER_TIERS` narrows which tiers `ledgerTopPicks` considers before the same edge sort
  runs — a user chasing a bigger payout taps Demon to see just demon-tier picks with good
  edge, without changing how "good edge" is judged. At least one tier stays selected at all
  times; toggling the last active chip off is a no-op rather than leaving the board with
  nothing (or silently re-selecting everything). When the selected tier(s) have no eligible
  picks, say so in the box (`.rtempty`) instead of just hiding it — an empty leaderboard
  with no explanation reads as broken, not "narrow your filter."
- **Deep dive is a second, per-prop pass — not a bigger version of the first one.**
  A normal run judges the whole board in ONE call sharing a fixed search budget
  (`JUDGE_MAX_SEARCHES`) across every game; on a full slate most props get zero dedicated
  research. The `deepDive` flag re-judges the top `DEEP_DIVE_MAX` picks by edge — after the
  normal screen, not instead of it — one prop per API call, each with its own search. A
  deep-dived pick's numbers REPLACE its stage-1 entry everywhere downstream (board, parlay
  legs, pick log); the stage-1 read stays alongside it as `shallowProb`/`shallowEdge` rather
  than being discarded, so a second opinion that moved the number is visible, not silently
  applied. Off by default and never sticky — costs and takes meaningfully more, and is
  meant to run once a day, not on every scan. If extending it: keep the shortlist capped
  (deep-diving the whole board defeats the point — it's supposed to be the expensive
  treatment for the props that already cleared the cheap screen, not a replacement for it),
  and keep each shortlisted prop's `judge()` call on its own `runId` (`${jobId}-deep${i}`) —
  reusing the batch's `jobId` would each overwrite the batch's saved replay context (and
  each other's) in the `judge-context` store.
- **A tier icon claims a confirmed price — never show one for a side that doesn't have one.**
  `odds_type` describes the projection's OVER side only; PrizePicks prices the UNDER of a
  goblin/demon line separately (confirmed live: a goblin's Less rendered as a demon on the
  real card), and the feed has no field for it. `tierIcon(tier, unverified)` renders a
  neutral "?" (`.tiericon.unk`) instead of the over side's tier image whenever
  `p.sidePriceUnverified` is true, at every place a pick with a live `side` renders: the
  board (`renderBoardResults`) and the tray (`renderTray`). `recSlipHtml` and
  `renderLedgerRec` don't need it — both only ever receive picks `selectLegs`/
  `ledgerTopPicks` already filtered to priced sides. **Known gap:** a SAVED slip doesn't
  carry `sidePriceUnverified` (the `/api/slips` POST payload never included it), so My Slips
  still shows the plain over-tier icon on an unpriced-under leg someone added to the tray
  before saving — fix requires persisting the field through save/load, not just the icon.

---

## 7. States every screen needs

For each of the four data screens — board run, today's ledger, slip grading, calibration:

- **loading** — with `step` copy and elapsed time for the two background jobs
- **empty** — no slate today, no logged picks yet, nothing graded yet. Calibration is empty
  for the first day or two by design; it should say so rather than render zeros as if
  they were results.
- **error** — with the real message from `message` / `error`, not "something went wrong"
- **partial** — `dataStatus` thin, a paging warning, `oddsStatus` skipped. The data is
  usable but weaker, and the UI should say which.

A note on sample size: below roughly 50 graded picks a Brier score is mostly noise. If the
calibration screen shows a number, it should also show `n` — and ideally hold the headline
figure until there's enough to mean anything.

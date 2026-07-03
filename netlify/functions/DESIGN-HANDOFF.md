# AtomBets — Design Handoff (Frontend Tasks)

All backend endpoints below are live (or in tonight's push) at the same origin
(atombets.netlify.app). JSON in / JSON out. API keys are server-side — never put
any key in the frontend.

Every pick object from the engine already carries: player, team, position,
matchup, stat, line, verdict, prob, oddsType, key_risk, reasoning, recent5,
recentAvg, oppSP/selfSP {name, throws, era, whip, k}, parkIndex, image.

---

## 1. PRIORITY — Raise the poll timeout (unblocks Opus)

The board polls the background job and shows "Timed out after 4 minutes" if the
run isn't done. The engine now runs on a slower model (Opus) and can take 5-8
minutes; the background function itself has 15. Raise the polling timeout to
**12 minutes**. Keep polling while status is "running"; only show the timeout
error past 12 minutes or if status comes back "error".

## 2. Live run status + timer + ETA (controls STAY, status appears below)

IMPORTANT: pressing Find Bets must NOT clear or hide the controls. Keep the
league/legs/tier/button visible, and reveal a STATUS PANEL directly beneath them
for the duration of the run.

The polled job-status blob includes while running:
- `step` — current phase name: "pulling props" → "gathering data (records, odds,
  form, starters)" → "Claude researching lineups"
- `elapsedMs` — ms since run start
- `typicalMs` — average total ms of recent runs for this league (null until one
  run has completed)
- `phases` — completed phases with durations, e.g.
  `[{"phase":"pulling props","ms":4200},{"phase":"gathering data","ms":38000}]`

Status panel shows:
1. The current `step` in plain language ("Searching picks…", "Researching
   lineups…", "Judging…") driven by the backend `step` value.
2. Completed phases as checkmarks with durations:
   "✓ pulling props 4s · ✓ gathering data 38s · researching lineups…"
3. Live elapsed timer (m:ss).
4. If `typicalMs` present: "typically ~Xm Ys" + a soft progress bar
   (elapsed/typical, cap 100%). If null, just the timer.
On done, briefly show "finished in Xm Ys", then render results below.

## 3. Demo data is opt-in — and cleared on run

Demo/sample picks (Aaron Judge, Elly De La Cruz, etc.) must NOT show by default,
and must be CLEARED the moment Find Bets is pressed:
- On first load / before any run: empty state or "Run a slate to see picks" — no
  demo cards, and Today's Picks shows its real (possibly empty) ledger, not demo.
- On Find Bets: immediately clear demo, show the loading/status panel, then render
  REAL results (board + Today's Picks) from the run.
- Demo only ever appears when the user explicitly taps a "demo/preview" toggle.
- Real results always replace demo everywhere (both the Search board and Today's
  Picks tab).

## 4. Tabs: [ Search ] [ Today's Picks ]

Two tabs above the main UI.

**Search tab:** everything that exists today (league/legs/tier/Find Bets +
results board). Unchanged.

**Today's Picks tab:** calm, read-only ledger of the day's accumulated
plays/leans across all leagues. Data: `GET /api/top-picks?format=json` →
`{ date, count, picks: [...] }`, picks pre-sorted by prob and each carrying
loggedAt plus hit/result once graded.

Render a clean list:
- player, prop + line, prob%, tier, league badge
- age from loggedAt ("3h ago") for live picks
- ✓ HIT (green) / ✗ MISS (red) replaces age once hit=true/false
- "re-evaluate ↻" button per row (see §4)
- refresh data whenever the tab is opened
Minimal styling — it's a ledger, not a dashboard.

## 5. Re-evaluate button (lives in Today's Picks; optional on Search cards too)

POST `{ pick: <full pick object> }` to `/api/reevaluate`. Takes a few seconds
(it web-searches for news). Response:
`{ updated: { verdict, prob, changed, changeNote, reasoning }, previous }`.
- If changed: highlight, show old → new ("play 66% → lean 58%") + changeNote.
- If not: subtle "still good ✓ (checked just now)".
- Update the row's verdict/prob from the response (the backend also updates the
  pick log, so the feed stays in sync).

## 6. Build-my-own-parlay slip

1. Every pick card (plays, leans, passes) gets a checkbox/toggle → "My Slip".
2. Persistent slip tray (collapsible bar/drawer): player, stat, line, prob,
   tier, an (x) per leg, and a "clear slip" button.
3. Slip must SURVIVE league switches and new runs (state not cleared on board
   re-render) so MLB + NFL picks can combine. Session-only is fine for v1.
4. Claude's recommended parlay stays as-is; a pick can be in both.
5. With 2+ legs, POST them to `/api/bet-finder-size` (same payload shape the
   engine uses: legs with prob and oddsType) and show EV per dollar, hit
   distribution, and Power/Flex comparison for MY slip, updating on add/remove.
6. Honesty touch: show each leg's run age (from its loggedAt) in the tray.

## 7. Image fallback (fix the error spam)

Headshots load from static.prizepicks.com. When one fails (blocked network or
404), the current handler logs "[bundle] error" per failure, flooding the board.
Replace with a graceful fallback: player initials (avatars already support
this — VC, KC, TL) and no per-failure logging.

## 8. League badges (hardcoded — intentional)

Picks carry a league tag (mlb, nfl, nba, etc.). Render a small league badge per
pick/card from a HARDCODED inline map — inline SVG or base64 data-URIs embedded
in the HTML, keyed by league tag. Do NOT load badges from external URLs (external
images get blocked on some networks and 404s spam the console — same failure mode
as the headshot bug). Prefer stylized badges (league abbreviation in a colored
chip, or sport glyphs ⚾🏈🏀) over official trademarked logos since this doubles
as a portfolio piece. Adding a league later = adding one entry to the map.

## 9. Headshot loading — verify with real data

Cards already fall back to initials (AJ, EC) when an image fails — that part works.
Confirm real headshots actually load on a live run (demo data may have empty image
URLs, and the PrizePicks CDN can be network-blocked). Each pick carries an `image`
URL; use it, fall back to initials on error, no per-failure logging.

## 10. Board/feed polish (from live testing)

- Sort board picks by `prob` (decimal 0-1) DESCENDING — highest % on top.
- Avatar fallback: keep the colored gradient background, REMOVE the initials text
  overlay (gradient only when no photo).
- Today's Picks: gate demo like the board (read /api/top-picks?format=json, never
  show demo; empty state before any run). Show player photos (feed picks now include
  `image`). Fetch fresh on open — don't cache locally; the feed is server-side,
  date-keyed, resets daily on its own, and syncs across devices. Shows PLAYS only.

## 11. Setup controls: prop filter, max picks, verdict filter

Three controls in the board setup panel. POST body now supports statFilter and
maxPicks (both optional).

a) PROP FILTER (dropdown, LEAGUE-AWARE — options change with league, never show
   e.g. basketball props under soccer; hardcode a per-league map). "All props" =
   omit statFilter. A specific choice → send statFilter (e.g. "home runs"). When
   set, board returns ALL matching picks sorted by prob (may be low %) — render
   ranked, don't hide low ones. Suggested lists:
     mlb: Home Runs, Total Bases, Hits, Hits+Runs+RBIs, Strikeouts, RBIs, Stolen Bases
     nba/wnba: Points, Rebounds, Assists, PRA, 3-Pointers Made
     nfl: Passing/Rushing/Receiving Yards, Receptions, TDs
     soccer: Shots, Shots On Target, Passes, Goalie Saves, Goals+Assists
   (Tune labels to match real PrizePicks names; statFilter matches loosely.)

b) MAX PICKS (dropdown 10/20/30/All) → send maxPicks (omit for All). Fewer =
   faster run.

c) VERDICT FILTER (segmented Plays/Leans/Passes, multi-select, default Plays only).
   DISPLAY-ONLY — engine judges all; filter result.allPicks by selected verdicts.
   No backend change; doesn't affect run time.

## 12. Already wired (verify only)

- "?" per-pick chat → POST `/api/ask` with `{ pick, messages }`;
  response `{ answer, usedSearch }`. Working per screenshots.
- STATS button → POST `/api/player-stats` with `{ player, team?, league }`;
  now ESPN-direct (fast, free). Same response shape as before:
  `{ stats: { kind, ...fields }, asOf, source }`.

## Standalone pages (no Design work — just link to them if desired)

- `/api/calibration` — results dashboard
- `/api/top-picks` — the ledger as its own page
- `/api/dev` — private dev console

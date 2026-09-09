# The append-only bet ledger and line archive

Four stores, three endpoints, two scripts. No UI — deliberately, per the brief.

| store | key | written by | mutable? |
|---|---|---|---|
| `line-snapshots` | `capture/<iso>` or `closing/<eventId>` | snapshot-background | **no** |
| `bets` | `<slip_id>` | `POST /api/bets` | **no** |
| `bet-results` | `<leg_id>` | `POST /api/bet-results` | **no** |
| `ledger-meta` | `schema` | migration script | yes — see below |

## Why Netlify Blobs

The brief said cheapest to run on Netlify, and Blobs wins outright: included
with the site, nothing at idle, no provisioning, and the credentials are already
in this project — every other store here runs on it. Netlify DB (Neon) is also
free-tier but is a separate service that suspends when idle and has row caps
this archive would grow into. 144 captures a day, written once and read rarely,
is object-store shaped rather than query shaped.

**What that costs**, since the brief asked for tables, foreign keys and a view:

- **No SQL.** The CLV view is a function recomputed per request, not a
  `CREATE VIEW`.
- **No referential integrity.** `leg.snapshot_id` is a foreign key by
  convention. `appendBet()` verifies it before writing and `verifyIntegrity()`
  re-checks the whole ledger on demand — those two are the substitute.
- **No `REVOKE UPDATE`.** Append-only is enforced one layer up.

**The append-only guarantee is not weaker than Postgres**, which is the part
worth being precise about. Blobs supports `onlyIfNew`, a **compare-and-set
performed by the storage service**: the second write to a key returns
`{ modified: false }` and the stored bytes are untouched. That is
concurrency-safe, unlike an app-level check-then-write which two callers can
race. `ledger-store.js` turns the refusal into a thrown `AppendOnlyViolation` so
a caller cannot ignore a falsy return.

Confirmed by reverting it: with `onlyIfNew` removed, 12 assertions fail,
including `the original row is untouched — got 999, want 20`.

If this ever needs SQL, the migration is mechanical — every row is already flat,
typed and id-keyed, which is why the schema looks like this rather than like
whatever shape was handy.

## The one mutable key

`ledger-meta/schema` holds the migration version and history. It describes the
ledger rather than being part of it, and a second migration could never be
recorded if it were append-only.

## Ids

Deterministic and content-derived, never random.

```
snapshot row   <captureKey>#<sha1(league|player|market|line)[0..12]>
leg            <slip_id>#L<index>
```

A snapshot id **embeds its own capture key**, so a foreign key written months
ago resolves in a single read rather than a scan of every capture since.

Closes are keyed `closing/<eventId>` rather than by time, which makes "already
closed?" a property of the store instead of a check someone has to remember.
A second close for an event is refused, so the line taken *at* kickoff is the
one that survives.

## The Odds API bill — the real constraint

The PrizePicks half of a capture is free. The book half is metered per market
per event:

```
~15 MLB events x ~6 markets  =   ~90 credits per capture
x 144 captures/day           = ~13,000 per day
x 30                         = ~390,000 per month
```

That is not a free-tier number or a cheap-tier number. So the capture is
budgeted, and degrades in the direction that keeps the archive honest:

- **PrizePicks rows are always captured in full.** A row with a PP line and null
  book fields is a true record of what was on the board.
- **Book lookups stop when the budget is spent.** Rows still get written,
  carrying `books: []` and a `book_status` saying why.

| env | default | what it does |
|---|---|---|
| `SNAPSHOT_ODDS_BUDGET` | 60 | credits per routine capture; `0` = PrizePicks only, spend nothing |
| `SNAPSHOT_CLOSING_BUDGET` | 240 | credits per closing capture |
| `SNAPSHOT_LEAGUES` | `mlb` | comma-separated; each is a separate capture |

Closes get the larger budget because every CLV number is measured against them.
Missing an intraday capture costs resolution; missing the close costs the metric.

**Before raising the cadence, price it.** At the default budget a day costs
~8,600 credits; uncapped it is ~13,000.

## Closing captures

Taken on the **first cron firing after** an event's scheduled start, not before.
The close is the last price before the market goes off, so it must be as late as
possible — firing early archives a line with movement still left in it, and that
is a bias pointing the same way every time rather than noise.

The cron runs every 10 minutes with a 15-minute look-back, so every event gets
exactly one close and the store refuses a second.

## CLV

`GET /api/clv` — per leg, and both numbers the brief asked for:

- **`line_delta`** — movement in the stat's own units, **sign-flipped for
  unders**. On an over the line moving up is value; on an under it is the
  reverse. Reported as counts, never averaged: a point of total bases and a
  point of passing yards are not the same quantity.
- **`prob_delta`** — no-vig probability movement, which *is* comparable across
  markets and so is the one aggregated.

De-vigging is **proportional** (each side divided by the two-way total). Shin
and power methods would shade the extremes by a point or two but need a model
fitted to each book, and a de-vig method chosen because it flatters a CLV number
is worse than none. Books are de-vigged **individually, then averaged** —
averaging raw prices and de-vigging the mean folds two different margins into a
number belonging to neither.

Every leg appears in the output. One that cannot be priced carries an
`unpriced_reason` rather than being dropped: a CLV table that silently omits
what it did not understand reports the average of the legs it happened to
understand.

## Endpoints

```
POST /api/bets           append a slip                    201 / 409 on duplicate
GET  /api/bets           list slip ids
GET  /api/bets?slip=     one slip
GET  /api/bets?verify=1  integrity report
GET  /api/bets?currentAt=<iso>   the capture current at an instant

POST /api/bet-results    grade one leg                    201 / 409 on duplicate
GET  /api/bet-results    every grade

GET  /api/clv            every leg
GET  /api/clv?slip=      one slip
```

There is no PUT, PATCH or DELETE anywhere, and their absence is the design
rather than an omission — a route that could edit a bet would make the guarantee
a question of who calls what. Anything but GET/POST returns 405 with a sentence
saying why.

**Correcting a slip means appending one that supersedes it.** That keeps the
mistake in the record, which is the entire point — a bet history you can quietly
fix is one that will flatter you.

## Scripts

```
node scripts/ledger-migrate.mjs --status     version, pending work, integrity
node scripts/ledger-migrate.mjs --dry        what would happen
node scripts/ledger-migrate.mjs              apply

node scripts/seed-bets.mjs --file=docs/bets.csv --dry
node scripts/seed-bets.mjs --from=saved-slips --dry
```

Migrations may only **create**. One that needs to change the meaning of an
existing field does not get to rewrite history — it bumps `SCHEMA_VERSION` and
readers learn to handle both, which is why every row carries its own.

### Seeding

**No tracking spreadsheet is committed to this repo.** `git ls-files` finds no
`.csv`, `.tsv` or `.xlsx` anywhere, so the seeder runs, reports that, and
imports nothing. Export the sheet, commit it, point `--file` at it. Expected
columns:

```
slip_id, placed_at, slip_type, stake, payout_multiplier
leg1_player, leg1_market, leg1_line, leg1_side, leg1_tier   (…up to leg6_)
```

The other real source of history here is `saved-slips`, this app's own saved
slips — available via `--from=saved-slips`, opt-in and stamped as such, because
a saved slip is not necessarily a placed bet.

**Historical legs get `snapshot_id: null`.** The line on the board at 19:04 last
April was never recorded and cannot be reconstructed; attaching the nearest
snapshot we happen to hold would compare a bet to a different day and produce a
CLV number that looks real. A visible hole is worth more than a plausible
fiction.

## What was found while building this

- **The stat → book-market table was a private copy** inside
  `judge-slip-background.js`. Moved to `odds-markets.js` and both callers now
  share it — a second copy of a table like that drifts, and each caller's tests
  check its own copy against itself.
- **27% of the live MLB board had no book market.** The map keyed on
  `strikeouts`, `fantasyscore` and `earnedruns`; PrizePicks posts "Hitter
  Strikeouts", "Hitter Fantasy Score", "Pitcher Strikeouts" and "Earned Runs
  Allowed". Now 8%, and the remainder genuinely has no equivalent market. This
  was a pre-existing gap in the DK line attachment, not new.
- Stats where the name states the role now beat the position lookup — the name
  is a fact, the position is a lookup that can be missing or wrong.

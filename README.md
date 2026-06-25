# PrizePicks Tracker

Live prop lines from PrizePicks with ESPN season averages, DraftKings line comparison, Kalshi prediction market odds, and a parlay slip builder.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your ODDS_API_KEY (free at https://the-odds-api.com)
netlify dev   # runs both Vite + serverless functions locally
```

Open http://localhost:8888

> **Important:** Use `netlify dev`, not `npm run dev`. The serverless functions won't load without it.

## Environment Variables

| Variable | Description |
|---|---|
| `ODDS_API_KEY` | The Odds API key — get free at the-odds-api.com (500 req/month free) |

In production: Netlify dashboard → Site Settings → Environment Variables → Add `ODDS_API_KEY`.

## Deploy to Netlify

```bash
# Option A — CLI
netlify deploy --prod

# Option B — GitHub
# Push to GitHub → Import on Netlify → build: npm run build, publish: dist
# Then add ODDS_API_KEY in Site Settings → Environment Variables
```

## Serverless functions

| Function | Route | What it does |
|---|---|---|
| `prizepicks.js` | `/api/prizepicks` | Proxies PrizePicks API (bypasses CORS) |
| `dk-lines.js` | `/api/dk-lines` | Fetches DraftKings player props via The Odds API (key stays server-side) |
| `espn-stats.js` | `/api/espn-stats` | Fetches ESPN player season averages (search + stats) |
| `kalshi.js` | `/api/kalshi` | Fetches Kalshi prediction market lines (no key needed) |

## Features

- Live PrizePicks prop lines, grouped by sport → game → player
- ESPN season averages per stat with vs-line delta
- DraftKings line comparison with value indicator (≥0.5 gap)
- Kalshi prediction market probability
- Fuzzy player name matching (shows DK name when it differs from PP name)
- Goblin tier detection → disables "less" button
- "Most likely first" sort (goblin → standard → demon)
- Parlay slip builder (PrizePicks multipliers: 2=3x, 3=5x, 4=10x, 5=20x, 6=25x)
- Auto-refresh every 3 minutes
- API request counter (tracks Odds API usage)

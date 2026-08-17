# Versioning

`vMAJOR.MINOR.PATCH` — e.g. `v2.1.14`.

| Part | Bump it for | Examples from this repo |
|---|---|---|
| **MAJOR** | Major overhauls — a new subsystem, or a change in how the app works | Grading moving from PrizePicks-only to a multi-source chain; the slip builder |
| **MINOR** | Fine-tuning — refining existing behaviour, new mappings, tuning | Adding stat mappings, per-league calibration, better player matching |
| **PATCH** | Bug fixes | Never grading a live game; combos silently dropping a component |

Bumping MAJOR resets MINOR and PATCH to 0. Bumping MINOR resets PATCH to 0.

## Where it lives

Two places, and they **must** match:

1. `netlify/functions/version.js` → `export const VERSION`
2. `public/index.html` → the footer, `id="appVer"`

`tests/unit/version.test.mjs` fails if they drift. That matters: the footer
compares the two at runtime to tell you whether a deploy landed, so if they
disagree in the repo the check reports a false problem.

## Checking a deploy

```
/api/version
```

Returns the version plus the live commit SHA and branch. Three outcomes:

- **The version you expect** — the deploy landed.
- **An older version** — the build did not land. Netlify keeps the previous
  deploy live when a build fails, so old endpoints keep working while new ones
  404. This is the case that wastes the most time, because it looks like the
  push never happened.
- **404** — functions are not deploying at all. Check the build log and confirm
  Netlify is building the branch you are pushing to.

The app footer does this automatically: it shows the page version next to the
version the functions report. Matching means the whole deploy landed. A red
mismatch means only half of it did. `offline` means the functions are not
answering.

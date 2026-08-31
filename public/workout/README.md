# Muscle Map

An interactive body map. Tap a muscle to highlight it, tap it again to get what
that muscle does, where you use it outside a gym, and the exercises that train
it.

Served straight out of `public/`, like the rest of this site — no build step, no
framework. Open `public/workout/index.html` locally, or hit `/workout/` on the
deployed site.

## Files

| File | What's in it |
|---|---|
| `index.html` | The shell — header, figure stage, prompt bar, detail sheet |
| `muscles.js` | **All the content.** 17 groups, 85 exercises |
| `body.js` | SVG path data for the front and back figures |
| `app.js` | Rendering, tap handling, the detail sheet |
| `styles.css` | Everything visual |

## Adding or editing content

`muscles.js` is the only file to touch for content. Each group looks like this:

```js
chest: {
  name: 'Chest',
  latin: 'Pectoralis major',
  heads: 'Clavicular (upper) · Sternal (mid) · Costal (lower)',
  actions:  [ /* what it does mechanically */ ],
  everyday: [ /* where you use it in normal life */ ],
  training: 'How it responds — rep ranges, range of motion, quirks',
  exercises: [
    {
      name: 'Barbell bench press',
      kind: 'compound',        // compound | isolation | carry | stability
      equipment: 'Barbell + bench',
      dose: '3–5 sets × 5–8 reps',
      why: 'Why this one earns a place on the list',
    },
  ],
},
```

`kind` drives the colour of the badge on the card, so it has to be one of those
four. Nothing else is constrained — add a sixth exercise and it just renders.

To add a whole new group you also need a path for it in `body.js`, and its id in
`FRONT_GROUPS` and/or `BACK_GROUPS` at the bottom of `muscles.js`.

## The `why` lines, and adding citations

Every `why` describes a finding that is well replicated and uncontroversial —
long-length training, the Nordic curl's effect on hamstring strains, the
Copenhagen protocol and groin injuries, overhead extensions for the triceps long
head. They are deliberately written without specific numbers or study names,
because a fabricated citation is worse than none.

If you want them sourced, add a `sources` array next to `why` rather than baking
a reference into the prose:

```js
why: 'Direct comparisons show greater long-head growth from the overhead position.',
sources: [{ title: '…', url: '…', year: 2022 }],
```

Nothing renders `sources` yet — that's the next step whenever the research pass
happens.

## How the figure works

Every region is authored once for the **left half** of the body and mirrored
across the centre line, so the figure can't drift out of symmetry when a shape is
tweaked. A region with a `group` is a tappable muscle; one without is scenery
(head, hands, knees, feet, pelvis).

Regions are declared in anatomical stacking order — the lat is drawn before the
rhomboids because the rhomboids sit on top of it. When a muscle is selected it is
lifted to the front of the paint order so it doesn't light up with a dimmed
neighbour sitting over it.

Two things in the CSS are load-bearing and look like styling but aren't:

- `.prompt` has a fixed `height`, not `min-height`. The selected state is taller
  than the idle one, and any growth there shrinks the figure above it — which
  resizes the body under your finger between the first tap and the second.
- The selected halo is a `stroke`, not a `drop-shadow`. A filter changes the
  element's hit geometry, so a second tap near a seam could fall through onto
  the neighbouring muscle.

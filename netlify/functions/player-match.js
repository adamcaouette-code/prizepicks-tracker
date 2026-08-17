// netlify/functions/player-match.js
//
// Matching a PrizePicks player name to a box-score player name.
//
// Both graders used a single exact comparison on the normalised full name, and
// that silently loses a large share of picks. The sources genuinely disagree
// about names, in ways that have nothing to do with the player being absent:
//
//   PrizePicks          MLB / ESPN              why the exact match fails
//   Luis Robert         Luis Robert Jr.         suffix on one side only
//   Michael Harris      Michael Harris II       same
//   Nate Lowe           Nathaniel Lowe          short form vs legal first name
//   Cam Thomas          Cameron Thomas          same
//
// So the match runs as a chain, widening one step at a time:
//
//   1. exact        normalised full name
//   2. no-suffix    both sides stripped of Jr/Sr/II/III/IV
//   3. initial+last first initial plus last name
//
// Step 3 is the one that earns its keep and the one that could do damage, so it
// is only ever accepted when EXACTLY ONE candidate matches. Two players sharing
// a first initial and surname on the same slate is a refusal, not a coin flip —
// grading the wrong player writes a confident false result into calibration,
// which is the failure this whole pipeline is built to avoid.
//
// Every match reports HOW it was made, so a grade can be audited later and the
// looser steps can be counted rather than trusted blindly.

export const normKey = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Generational suffixes only. Deliberately excludes a bare "V": it is vanishingly
// rare as a suffix and common enough as an initial that stripping it would do
// more harm than good.
const SUFFIX = /[\s,]+(jr|sr|ii|iii|iv)\.?\s*$/i;

export const stripSuffix = (s) => String(s || '').replace(SUFFIX, '').trim();

/** First initial + last name, e.g. "Nathaniel Lowe" -> "n|lowe". */
export function initialLast(name) {
  const parts = stripSuffix(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = normKey(parts[0]);
  const last = normKey(parts[parts.length - 1]);
  if (!first || !last) return null;
  return `${first[0]}|${last}`;
}

/**
 * Build a lookup over the box score's own names.
 *
 * `entries` is [name, value] pairs — value being whatever the caller wants back
 * (a stat row, an MLB person id). Collisions in the loose tiers are recorded so
 * they can be refused at lookup time rather than resolved arbitrarily.
 */
export function buildIndex(entries) {
  const exact = new Map();
  const noSuffix = new Map();
  const loose = new Map();
  const looseDupes = new Set();

  for (const [name, value] of entries) {
    if (!name) continue;
    const e = normKey(name);
    if (e && !exact.has(e)) exact.set(e, { value, name });

    const ns = normKey(stripSuffix(name));
    if (ns && !noSuffix.has(ns)) noSuffix.set(ns, { value, name });
    else if (ns && noSuffix.get(ns)?.name !== name) looseDupes.add(`ns:${ns}`);

    const il = initialLast(name);
    if (il) {
      if (!loose.has(il)) loose.set(il, { value, name });
      // A different player with the same initial+surname makes this key unusable.
      else if (loose.get(il).name !== name) looseDupes.add(il);
    }
  }
  return { exact, noSuffix, loose, looseDupes, size: exact.size };
}

/**
 * Look a name up. Returns { value, how, matchedName } or null.
 * `how` is 'exact' | 'suffix' | 'initial' — the caller records it so loose
 * matches stay visible in the data instead of blending into the exact ones.
 */
export function matchPlayer(index, query) {
  if (!index || !query) return null;

  const e = normKey(query);
  const hitExact = index.exact.get(e);
  if (hitExact) return { value: hitExact.value, how: 'exact', matchedName: hitExact.name };

  const ns = normKey(stripSuffix(query));
  if (ns && !index.looseDupes.has(`ns:${ns}`)) {
    const hitNs = index.noSuffix.get(ns);
    if (hitNs) return { value: hitNs.value, how: 'suffix', matchedName: hitNs.name };
  }

  const il = initialLast(query);
  // Ambiguity is a refusal. Grading the wrong player is worse than not grading.
  if (il && !index.looseDupes.has(il)) {
    const hitLoose = index.loose.get(il);
    if (hitLoose) return { value: hitLoose.value, how: 'initial', matchedName: hitLoose.name };
  }
  return null;
}

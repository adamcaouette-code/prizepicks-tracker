// netlify/functions/point-in-time.js
//
// A store that CANNOT return the future.
//
// ===========================================================================
// STRUCTURAL, NOT DISCIPLINED
//
// The brief asks for it to be impossible to read the future rather than merely
// discouraged. A convention — "remember to filter on as_of" — is discouragement,
// and it fails the first time someone adds an accessor in a hurry. Three things
// make it structural here:
//
//   1. EVERY ROW MUST CARRY `ingested_at`. The constructor throws on one that
//      does not. There is no way to put data in without saying when it became
//      knowable, so there is no way to accidentally treat event time as
//      ingestion time — which is the actual mechanism of almost every real
//      leak, because a row about a 7pm game is not knowable at 7am just
//      because its event date says today.
//
//   2. THE ONLY WAY TO READ IS THROUGH A VIEW, AND A VIEW IS BOUND TO ONE
//      TIMESTAMP AT CONSTRUCTION. `store.asOf(t)` hands back an object whose
//      methods close over `t`. There is no accessor on the view that takes a
//      different timestamp, and no reference to the store on it, so a caller
//      holding a view has no path to any other moment.
//
//   3. OUTCOMES ARE NOT IN THE SAME PLACE AS FEATURES. A view returns what was
//      knowable; results live behind `store.outcomes()`, which the strategy is
//      never handed. Leakage through a stray field cannot happen because the
//      field is not in the object.
//
// Revisions matter as much as rows. A prop is not one record — it is a series
// of revisions, each with its own ingestion time, and `props()` returns the
// LATEST revision at or before the view's timestamp. That is what makes it
// possible to store a row's eventual result on the same prop without the
// morning view ever seeing it.
//
// PURE. No imports, no I/O, no clock — the timestamp always comes in.
// ===========================================================================

export class LeakError extends Error {
  constructor(msg) { super(msg); this.name = 'LeakError'; }
}

const ts = (v) => {
  const n = Date.parse(v);
  if (!isFinite(n)) throw new LeakError(`"${v}" is not a timestamp`);
  return n;
};

export class PointInTimeStore {
  /**
   * @param {Array} rows  each MUST carry `id` and `ingested_at`.
   * @param {Array} outcomes  each MUST carry `id` and `resolved_at`.
   */
  constructor(rows = [], outcomes = []) {
    this.rows = [];
    for (const [i, r] of rows.entries()) {
      if (!r || r.id == null) throw new LeakError(`row ${i} has no id`);
      if (!r.ingested_at) {
        // The single most important line in this file. A row with no ingestion
        // time cannot be placed in time, so there is no timestamp at which it
        // is safe to read, so it is refused rather than defaulted to anything.
        throw new LeakError(`row ${i} (id ${r.id}) has no ingested_at — there is no moment at which it is safe to read`);
      }
      this.rows.push({ ...r, _t: ts(r.ingested_at) });
    }
    this.rows.sort((a, b) => a._t - b._t);

    this._outcomes = [];
    for (const [i, o] of outcomes.entries()) {
      if (!o || o.id == null) throw new LeakError(`outcome ${i} has no id`);
      if (!o.resolved_at) throw new LeakError(`outcome ${i} (id ${o.id}) has no resolved_at`);
      this._outcomes.push({ ...o, _t: ts(o.resolved_at) });
    }
  }

  /** A read-only window onto one instant. The only way to read features. */
  asOf(when) {
    const cut = ts(when);
    const rows = this.rows;

    const latest = () => {
      const byId = new Map();
      for (const r of rows) {
        if (r._t > cut) break;                       // sorted, so nothing later matters
        byId.set(r.id, r);                           // later revision wins
      }
      return [...byId.values()];
    };

    // Frozen, and stripped of the bookkeeping field, so a caller cannot read
    // `_t` and start reasoning about ingestion times it should not care about.
    const clean = (r) => {
      const { _t, ...rest } = r;
      return Object.freeze(rest);
    };

    return Object.freeze({
      at: new Date(cut).toISOString(),
      props: () => latest().map(clean),
      get: (id) => {
        const hit = latest().find((r) => r.id === id);
        return hit ? clean(hit) : null;
      },
      // How much was hidden. Reported so a window with no data reads
      // differently from a window whose data all arrived too late.
      hidden: () => rows.filter((r) => r._t > cut).length,
      // A view knows nothing about outcomes, by construction. This exists only
      // so a caller that tries gets a clear error instead of `undefined`.
      outcomes: () => {
        throw new LeakError('a point-in-time view cannot read outcomes — they are on the store, and the strategy is not given the store');
      },
    });
  }

  /**
   * Outcomes, for the SCORER only.
   *
   * Deliberately not reachable from a view. The engine reads this after the
   * strategy has committed, and the strategy never receives the store.
   */
  outcomes({ upTo = null } = {}) {
    const cut = upTo == null ? Infinity : ts(upTo);
    return this._outcomes.filter((o) => o._t <= cut).map(({ _t, ...rest }) => rest);
  }

  outcomeFor(id) {
    return this._outcomes.find((o) => o.id === id) || null;
  }

  /** The window the data actually covers, for sizing walk-forward folds. */
  span() {
    if (!this.rows.length) return { from: null, to: null, rows: 0 };
    return {
      from: new Date(this.rows[0]._t).toISOString(),
      to: new Date(this.rows[this.rows.length - 1]._t).toISOString(),
      rows: this.rows.length,
    };
  }
}

/**
 * Wrap a strategy so it physically cannot be handed anything but a view.
 *
 * The engine calls this rather than the raw function. If a strategy tries to
 * reach for outcomes it gets a LeakError with a sentence explaining why, rather
 * than an undefined that quietly becomes a zero.
 */
export function sandbox(strategy) {
  return (view, ctx) => {
    if (!view || typeof view.props !== 'function') {
      throw new LeakError('a strategy must be given a point-in-time view, not a store');
    }
    return strategy(view, Object.freeze({ ...ctx }));
  };
}

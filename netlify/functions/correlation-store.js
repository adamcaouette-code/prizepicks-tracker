// netlify/functions/correlation-store.js
//
// Where the estimated correlation table lives.
//
// Separate from correlation.js on purpose: that module is pure — rows in, table
// out — and stays testable without a Netlify context or a network. This is the
// only file in the correlation stack that touches a store.
//
// The table is written under a VERSIONED key and `current` is a pointer to one
// of them, rather than a blob that gets overwritten. A slip priced last Tuesday
// was priced against a particular set of estimates, and "which correlations was
// that EV computed from" has to stay answerable after the next rebuild — the
// same reason the payout tables are dated rather than edited.

import { getStore } from '@netlify/blobs';

export const STORE = 'correlations';

const store = () => {
  try {
    return getStore({ name: STORE, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  } catch { return null; }
};

export const versionKey = (id) => `table/${id}`;

/** Write a table under its own id and point `current` at it. */
export async function saveTable(table, { id = new Date().toISOString().slice(0, 10) } = {}) {
  const s = store();
  if (!s) throw new Error('no blob store available — set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN');
  const stamped = { ...table, id, built_at: new Date().toISOString() };
  await s.setJSON(versionKey(id), stamped);
  await s.setJSON('current', { id, built_at: stamped.built_at, pairs: Object.keys(table.pairs || {}).length });
  return stamped;
}

/** The table in force, or a named version. Returns an empty table, never null. */
export async function loadTable({ id = null } = {}) {
  const s = store();
  if (!s) return { pairs: {}, missing: 'no blob store available' };
  try {
    const want = id || (await s.get('current', { type: 'json' }))?.id;
    if (!want) return { pairs: {}, missing: 'no correlation table has been built yet' };
    const t = await s.get(versionKey(want), { type: 'json' });
    return t || { pairs: {}, missing: `correlation table "${want}" is not in the store` };
  } catch (e) {
    return { pairs: {}, missing: String(e.message || e) };
  }
}

/** Every table version that has been built, newest first. */
export async function listVersions() {
  const s = store();
  if (!s) return [];
  try {
    const { blobs } = await s.list({ prefix: 'table/' });
    return blobs.map((b) => b.key.slice('table/'.length)).sort().reverse();
  } catch { return []; }
}

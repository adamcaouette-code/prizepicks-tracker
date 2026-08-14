// In-memory stand-in for @netlify/blobs so the real functions can run locally
// without a Netlify context. Same surface the functions actually use: get,
// setJSON, list, delete.
//
// Stores persist for the life of the process, so a suite that seeds a store and
// then calls a handler sees its own data. Call reset() between cases that must
// not share state.

const stores = new Map();

export function getStore({ name }) {
  if (!stores.has(name)) stores.set(name, new Map());
  const s = stores.get(name);
  return {
    async list({ prefix } = {}) {
      const keys = [...s.keys()].filter((k) => !prefix || k.startsWith(prefix));
      return { blobs: keys.map((key) => ({ key })) };
    },
    // The real client returns the parsed object for { type: 'json' } and a string
    // otherwise; setJSON is the only writer here, so values come back as stored.
    async get(k) { return s.has(k) ? s.get(k) : null; },
    async setJSON(k, v) { s.set(k, v); },
    async set(k, v) { s.set(k, v); },
    async delete(k) { s.delete(k); },
  };
}

export function seed(storeName, key, value) {
  if (!stores.has(storeName)) stores.set(storeName, new Map());
  stores.get(storeName).set(key, value);
}

export function read(storeName, key) {
  return stores.get(storeName)?.get(key) ?? null;
}

export function reset(storeName) {
  if (storeName) stores.delete(storeName);
  else stores.clear();
}

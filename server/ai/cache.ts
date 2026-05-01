/**
 * Tiny in-memory TTL cache shared across AI providers.
 * Aggressive caching is THE main cost lever — Qimen 局 changes every 2hr,
 * news headlines every 1hr, thesis only on score deltas.
 */
const store = new Map<string, { value: any; expiresAt: number }>();

export function cacheGet<T = any>(key: string): T | null {
  const r = store.get(key);
  if (!r) return null;
  if (Date.now() > r.expiresAt) {
    store.delete(key);
    return null;
  }
  return r.value as T;
}

export function cacheSet(key: string, value: any, ttlMs: number) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function cacheClear() {
  store.clear();
}

export function cacheStats() {
  return { size: store.size };
}

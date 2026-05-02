/**
 * Verdict History — lightweight per-symbol last-verdict cache.
 *
 * Purpose: When LLM analyst is called consecutively for the same symbol,
 * inject the previous verdict into the prompt so the LLM can reference it
 * (matching Yung's pattern: "維持原判" / "印證咗" / "修正為...").
 *
 * Storage: in-memory Map with 7-day TTL. For multi-instance deployments,
 * swap to Redis using IORedis with the same get/set interface.
 *
 * Design choice: only store LAST verdict per symbol (not full history) to
 * keep prompts compact. If we need multi-step reasoning later, expand to
 * an array with size cap.
 */

import type { QimenSmcVerdict } from "./qimen-smc-analyst";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface HistoryEntry {
  verdict: QimenSmcVerdict;
  storedAt: number;
}

const store = new Map<string, HistoryEntry>();

/** Returns the last cached verdict for `symbol`, or null if missing/expired. */
export function getLastVerdict(symbol: string): QimenSmcVerdict | null {
  const entry = store.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    store.delete(symbol);
    return null;
  }
  return entry.verdict;
}

/** Persists the verdict as the latest history entry for `symbol`. */
export function saveVerdictHistory(symbol: string, verdict: QimenSmcVerdict): void {
  store.set(symbol, { verdict, storedAt: Date.now() });
}

/** Clear all history (used by tests / admin endpoint). */
export function clearVerdictHistory(): void {
  store.clear();
}

/** Stats for cockpit debugging. */
export function getHistoryStats(): { size: number; symbols: string[] } {
  return { size: store.size, symbols: Array.from(store.keys()) };
}

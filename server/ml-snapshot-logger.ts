/**
 * ml-snapshot-logger.ts
 * Logs per-symbol P(spike) feature snapshots to JSONL for future ML training.
 *
 * Features: 22 columns matching the existing ml-snapshot-schema.
 * - Thread-safe queue (flush every 30s or 50 rows).
 * - JSONL rotation by day: data/ml_snapshots/YYYY-MM-DD.jsonl
 * - label is null by default — the training pipeline fills it later.
 * - No hard-coded keys or secrets.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MLSnapshotRow {
  timestamp: string;           // ISO 8601
  symbol: string;
  // P(spike) engine outputs
  probability: number;
  confidence: string;          // HIGH | MEDIUM | LOW
  expectedMagnitude: number;
  dominantDriver: string;
  spikeScore: number;          // 0-10 composite
  // Input features
  rvol: number;
  rvolZScore: number;
  oiSurgeZScore: number;
  oiDirection: string;         // RISING | FALLING | FLAT
  squeezeState: string;        // SQUEEZE | FIRING_LONG | FIRING_SHORT | NO_SQUEEZE
  squeezeBars: number;
  squeezeIntensity: number;
  fundingAnomaly: number;
  fundingSignal: string;       // SQUEEZE_FUEL | OVERCROWDED_LONG | NEUTRAL
  efficiencyRatio: number | null;
  atrRatio: number;
  atrExpanding: boolean;
  ageDays: number | null;
  vwapConfirmation: string;    // BULLISH | BEARISH | NEUTRAL
  signalType: string;          // HOT | ACTIVE | PRE | COIL | MAJOR
  // Label — null by default, filled by training pipeline
  label: number | null;
}

// ─── Queue & Flush Logic ─────────────────────────────────────────────────────

const queue: MLSnapshotRow[] = [];
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const FLUSH_THRESHOLD = 50;       // flush at 50 rows

let flushTimer: ReturnType<typeof setInterval> | null = null;

function getSnapshotDir(): string {
  const dir = path.resolve("data", "ml_snapshots");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getTodayFilePath(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getSnapshotDir(), `${today}.jsonl`);
}

function flushQueue(): void {
  if (queue.length === 0) return;

  const rows = queue.splice(0); // drain the queue
  const filePath = getTodayFilePath();

  try {
    const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(filePath, lines, "utf-8");
    console.log(`[MLSnapshot] Flushed ${rows.length} rows to ${filePath}`);
  } catch (err) {
    // Fail soft — log and discard
    console.error(`[MLSnapshot] Failed to flush: ${(err as Error).message}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Append a snapshot row to the in-memory queue.
 * Non-blocking, fail-soft — never throws.
 */
export function logSnapshot(row: MLSnapshotRow): void {
  try {
    queue.push(row);

    // Start flush timer on first call
    if (!flushTimer) {
      flushTimer = setInterval(flushQueue, FLUSH_INTERVAL_MS);
      // Unref so it doesn't keep the process alive
      if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
        (flushTimer as NodeJS.Timeout).unref();
      }
    }

    // Flush immediately if threshold reached
    if (queue.length >= FLUSH_THRESHOLD) {
      flushQueue();
    }
  } catch (err) {
    // Never throw — the screener must not break because of logging
    console.error(`[MLSnapshot] logSnapshot error: ${(err as Error).message}`);
  }
}

/**
 * Force-flush remaining rows (e.g., on shutdown).
 */
export function flushSnapshots(): void {
  flushQueue();
}

/**
 * Build a snapshot row from screener enrichment output.
 * Convenience function to reduce boilerplate in routes.ts.
 */
export function buildSnapshotRow(
  symbol: string,
  signalType: string,
  enriched: any
): MLSnapshotRow {
  const sp = enriched.spikeProbability;
  return {
    timestamp: new Date().toISOString(),
    symbol,
    probability: sp?.probability ?? 0,
    confidence: sp?.confidence ?? "LOW",
    expectedMagnitude: sp?.expectedMagnitude ?? 0,
    dominantDriver: sp?.dominantDriver ?? "UNKNOWN",
    spikeScore: enriched.spikeScore ?? 0,
    rvol: enriched.rvol ?? 1,
    rvolZScore: enriched.rvolZScore ?? 0,
    oiSurgeZScore: enriched.oiSurgeZScore ?? 0,
    oiDirection: enriched.oiDirection ?? "FLAT",
    squeezeState: enriched.squeezeState ?? "NO_SQUEEZE",
    squeezeBars: enriched.squeezeBars ?? 0,
    squeezeIntensity: enriched.squeezeData?.squeezeIntensity ?? 0,
    fundingAnomaly: enriched.fundingData?.fundingAnomaly ?? 0,
    fundingSignal: enriched.fundingSignal ?? "NEUTRAL",
    efficiencyRatio: enriched.efficiencyRatio ?? null,
    atrRatio: enriched.atrRatio ?? 1,
    atrExpanding: enriched.atrExpanding ?? false,
    ageDays: enriched.ageDays ?? null,
    vwapConfirmation: sp?.vwapConfirmation ?? "NEUTRAL",
    signalType,
    label: null, // Training pipeline fills this later
  };
}

export default { logSnapshot, flushSnapshots, buildSnapshotRow };

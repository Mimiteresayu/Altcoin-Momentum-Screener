/**
 * Cross-module signal store
 * --------------------------
 * The main `/api/tickers` route in `server/routes.ts` keeps a `cachedSignals`
 * array in its closure. The cockpit (confluence) pipeline needs to *read*
 * that same array as its universe input. Rather than refactor a 4000-line
 * file, this tiny module exposes a setter the route handler can call after
 * each screener refresh, plus a getter for any other module to consume.
 *
 * No business logic lives here — it's a single source of truth for
 * "what does the in-house pre-spike screener currently see?"
 */

export interface InHouseSignal {
  symbol: string;                                // e.g. "LABUSDT"
  side: "LONG" | "SHORT";
  signalType?: string;                           // HOT | MAJOR | ACTIVE | PRE | COIL
  signalStrength: number;                        // 0-5
  currentPrice?: number;
  priceChange24h?: number;
  volumeSpikeRatio?: number;
  rsi?: number;
  entryPrice?: number;
  slPrice?: number;
  tpLevels?: Array<{ label: string; price: number; pct: number; reason: string }>;
  htfBias?: { side: "LONG" | "SHORT"; confidence: string };
  leadingIndicators?: Record<string, unknown>;
  // Funding rate fields (populated by screener when COINGLASS_API_KEY is set,
  // otherwise undefined and the cockpit will fall back to Bitunix public API).
  fundingRate?: number;
  fundingSignal?: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL";
  // ...any other fields are ignored by the cockpit
  [k: string]: unknown;
}

let _signals: InHouseSignal[] = [];
let _updatedAt: Date | null = null;

/** Called by the screener refresh job after `cachedSignals` is rebuilt. */
export function setSignals(signals: InHouseSignal[]): void {
  _signals = signals;
  _updatedAt = new Date();
}

/** Read-only accessor used by the cockpit pipeline. */
export function getSignals(): InHouseSignal[] {
  return _signals;
}

export function getSignalsUpdatedAt(): Date | null {
  return _updatedAt;
}

/** Get a single signal by symbol (for thesis lookup). */
export function getSignalBySymbol(symbol: string): InHouseSignal | undefined {
  return _signals.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
}

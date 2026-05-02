/**
 * SMC Feature Extractor
 * ----------------------
 * Distill OHLC into the structured features an LLM needs to do Yung-style
 * SMC analysis WITHOUT seeing the chart image.
 *
 * Wraps existing detectors in bitunix-trade.ts:
 *   - detectFVG()           → fair value gaps with prices
 *   - detectOrderBlocks()   → high-vol initiating candles
 *   - getICTLocation()      → premium / equilibrium / discount
 *
 * Adds:
 *   - swing structure (last 5 swing highs / lows for HH/LH/HL/LL labelling)
 *   - CHoCH / BOS detection (last structural shift)
 *   - liquidity sweep markers (recent prior pivot violation)
 *   - volume regime (last big-vol candle relative to avg)
 *   - 90d range + current price position
 *
 * Output is a JSON blob fed verbatim into the DeepSeek prompt.
 */
import { BitunixTradeService, type Kline, type FVG, type OrderBlock } from "../bitunix-trade";

const bitunix = new BitunixTradeService();
bitunix.initialize();   // OK if creds missing — getKlines uses public endpoint

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface SwingPoint {
  type: "HH" | "LH" | "HL" | "LL";   // higher-high, lower-high, higher-low, lower-low
  price: number;
  ts: number;
  index: number;                      // candle index in the input array
}

export interface StructureShift {
  type: "BOS" | "CHoCH";              // break of structure / change of character
  side: "bull" | "bear";
  price: number;                      // level that was broken
  ts: number;
}

export interface LiquiditySweep {
  side: "BSL" | "SSL";                // buy-side / sell-side liquidity
  price: number;                      // pivot that got swept
  ts: number;
  recovered: boolean;                 // did price reverse after sweep
}

export interface SmcFeatures {
  symbol: string;
  timeframe: "1d" | "4h";
  asOf: number;
  currentPrice: number;
  // Range context
  range90d: { high: number; low: number; midpoint: number };
  pricePositionPct: number;           // 0..100 within 90d range
  ictLocation: "premium" | "equilibrium" | "discount" | "unknown";
  // Volume
  volumeAvg: number;
  lastBigVolCandle: { ts: number; close: number; volMultiple: number } | null;
  // Structure
  swings: SwingPoint[];               // last 5
  lastStructureShift: StructureShift | null;
  // Imbalance / OB
  unfilledFvgs: Array<FVG & { distancePct: number }>;
  recentOrderBlocks: Array<OrderBlock & { distancePct: number }>;
  // Liquidity
  recentSweeps: LiquiditySweep[];
  // Phase guess
  phase: "accumulation" | "markup" | "distribution" | "markdown" | "ranging";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const num = (s: string | number): number => (typeof s === "number" ? s : parseFloat(s));

/** Find pivot highs/lows with a `look` window each side. */
function findPivots(klines: Kline[], look = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = look; i < klines.length - look; i++) {
    const h = num(klines[i].high);
    const l = num(klines[i].low);
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= look; j++) {
      if (num(klines[i - j].high) >= h || num(klines[i + j].high) >= h) isHigh = false;
      if (num(klines[i - j].low) <= l || num(klines[i + j].low) <= l) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/** Label last 5 swing points as HH/LH/HL/LL. */
function buildSwings(klines: Kline[]): SwingPoint[] {
  const { highs, lows } = findPivots(klines, 3);
  // Merge & sort by index
  const events: Array<{ kind: "H" | "L"; index: number; price: number; ts: number }> = [
    ...highs.map((i) => ({ kind: "H" as const, index: i, price: num(klines[i].high), ts: klines[i].openTime })),
    ...lows.map((i) => ({ kind: "L" as const, index: i, price: num(klines[i].low), ts: klines[i].openTime })),
  ].sort((a, b) => a.index - b.index);

  const swings: SwingPoint[] = [];
  let prevH: number | null = null;
  let prevL: number | null = null;
  for (const e of events) {
    if (e.kind === "H") {
      const t = prevH === null || e.price > prevH ? "HH" : "LH";
      swings.push({ type: t, price: e.price, ts: e.ts, index: e.index });
      prevH = e.price;
    } else {
      const t = prevL === null || e.price > prevL ? "HL" : "LL";
      swings.push({ type: t, price: e.price, ts: e.ts, index: e.index });
      prevL = e.price;
    }
  }
  return swings.slice(-5);
}

/** Detect last BOS / CHoCH from labeled swings. */
function detectStructureShift(swings: SwingPoint[], klines: Kline[]): StructureShift | null {
  // CHoCH = first opposite-trend break (e.g. uptrend HH→HH→LL = CHoCH bear)
  // BOS = continuation break (uptrend HH→HH = BOS bull)
  if (swings.length < 3) return null;
  const last3 = swings.slice(-3);
  const types = last3.map((s) => s.type).join(",");
  const tip = last3[2];
  // Bullish BOS: HL→HH (swept previous high)
  if (/HL,HH$/.test(types)) {
    return { type: "BOS", side: "bull", price: tip.price, ts: tip.ts };
  }
  // Bearish BOS: LH→LL
  if (/LH,LL$/.test(types)) {
    return { type: "BOS", side: "bear", price: tip.price, ts: tip.ts };
  }
  // Bullish CHoCH: LL→HH (trend flip up)
  if (/LL,HH$/.test(types) || /LL.*HH$/.test(types)) {
    return { type: "CHoCH", side: "bull", price: tip.price, ts: tip.ts };
  }
  // Bearish CHoCH: HH→LL
  if (/HH,LL$/.test(types) || /HH.*LL$/.test(types)) {
    return { type: "CHoCH", side: "bear", price: tip.price, ts: tip.ts };
  }
  return null;
}

/** Find recent liquidity sweeps — pivot violated then price reversed. */
function detectSweeps(klines: Kline[]): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  const { highs, lows } = findPivots(klines, 3);
  const lastN = klines.length - 1;
  // Look at last ~30 candles only
  const sinceIdx = Math.max(0, lastN - 30);
  for (const hi of highs) {
    if (hi < sinceIdx) continue;
    const pivot = num(klines[hi].high);
    // Did any later candle wick above and close back below?
    for (let j = hi + 1; j <= lastN; j++) {
      if (num(klines[j].high) > pivot && num(klines[j].close) < pivot) {
        sweeps.push({ side: "BSL", price: pivot, ts: klines[j].openTime, recovered: true });
        break;
      }
    }
  }
  for (const li of lows) {
    if (li < sinceIdx) continue;
    const pivot = num(klines[li].low);
    for (let j = li + 1; j <= lastN; j++) {
      if (num(klines[j].low) < pivot && num(klines[j].close) > pivot) {
        sweeps.push({ side: "SSL", price: pivot, ts: klines[j].openTime, recovered: true });
        break;
      }
    }
  }
  return sweeps.slice(-4);
}

/** Last big-volume candle (>= 2× avg of last 30). */
function findLastBigVol(klines: Kline[]): { ts: number; close: number; volMultiple: number } | null {
  const recent = klines.slice(-30);
  if (recent.length < 10) return null;
  const avg = recent.reduce((s, k) => s + num(k.volume), 0) / recent.length;
  for (let i = klines.length - 1; i >= klines.length - 30 && i >= 0; i--) {
    const v = num(klines[i].volume);
    if (v >= avg * 2) {
      return { ts: klines[i].openTime, close: num(klines[i].close), volMultiple: +(v / avg).toFixed(2) };
    }
  }
  return null;
}

/** Phase heuristic from price position + structure shift + volume. */
function inferPhase(
  pricePosPct: number,
  shift: StructureShift | null,
  bigVol: { volMultiple: number } | null
): SmcFeatures["phase"] {
  if (shift?.type === "CHoCH" && shift.side === "bull" && pricePosPct < 40) return "accumulation";
  if (shift?.type === "CHoCH" && shift.side === "bear" && pricePosPct > 60) return "distribution";
  if (shift?.type === "BOS" && shift.side === "bull" && (bigVol?.volMultiple ?? 0) >= 2) return "markup";
  if (shift?.type === "BOS" && shift.side === "bear") return "markdown";
  if (pricePosPct >= 40 && pricePosPct <= 60) return "ranging";
  return pricePosPct < 30 ? "accumulation" : pricePosPct > 70 ? "distribution" : "ranging";
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------
export async function extractSmcFeatures(
  symbol: string,
  timeframe: "1d" | "4h" = "1d",
  limit = 120
): Promise<SmcFeatures | null> {
  const klines = await bitunix.getKlines(symbol, timeframe, limit);
  if (klines.length < 30) return null;

  const last = klines[klines.length - 1];
  const currentPrice = num(last.close);

  // 90d range (or as much as we have)
  const recent90 = klines.slice(-Math.min(90, klines.length));
  const high90 = Math.max(...recent90.map((k) => num(k.high)));
  const low90 = Math.min(...recent90.map((k) => num(k.low)));
  const midpoint = (high90 + low90) / 2;
  const pricePositionPct = +(((currentPrice - low90) / (high90 - low90)) * 100).toFixed(1);

  const ict = bitunix.getICTLocation(klines);
  const fvgs = bitunix.detectFVG(klines).filter((f) => !f.filled).slice(-6);
  const obs = bitunix.detectOrderBlocks(klines).slice(-6);
  const swings = buildSwings(klines);
  const shift = detectStructureShift(swings, klines);
  const sweeps = detectSweeps(klines);
  const volumeAvg = klines.reduce((s, k) => s + num(k.volume), 0) / klines.length;
  const bigVol = findLastBigVol(klines);
  const phase = inferPhase(pricePositionPct, shift, bigVol);

  return {
    symbol,
    timeframe,
    asOf: last.closeTime,
    currentPrice,
    range90d: { high: high90, low: low90, midpoint },
    pricePositionPct,
    ictLocation: ict.location as SmcFeatures["ictLocation"],
    volumeAvg,
    lastBigVolCandle: bigVol,
    swings,
    lastStructureShift: shift,
    unfilledFvgs: fvgs.map((f) => ({
      ...f,
      distancePct: +(((f.bottom + f.top) / 2 - currentPrice) / currentPrice * 100).toFixed(2),
    })),
    recentOrderBlocks: obs.map((o) => ({
      ...o,
      distancePct: +(((o.high + o.low) / 2 - currentPrice) / currentPrice * 100).toFixed(2),
    })),
    recentSweeps: sweeps,
    phase,
  };
}

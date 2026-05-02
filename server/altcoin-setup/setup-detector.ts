/**
 * Altcoin A+ Setup Detector
 * --------------------------
 * Detects the 6 altcoin-tailored A+ patterns. Each pattern is binary
 * (detected: true/false) plus a confidence 0..1 — the orchestrator can
 * choose to treat them as a count (out of 6) or weight by confidence.
 *
 * Patterns (locked architecture):
 *   1. 圓底 / Cup formation     — U-shape ≥ 7d, depth 20-60%
 *   2. Squeeze 低量吸籌          — BB width ≤ 60% of 5d avg, vol < 20MA
 *   3. Vol spike pre-pump       — vol ≥ 3× avg while price flat ±2% (12-24h)
 *   4. Liquidity sweep + reclaim — wick through prior pivot then close back
 *   5. Breakout 確認             — close beyond level + vol ≥ 1.5× + RSI > 50
 *   6. 奇門三吉同宮              — supplied by qimen sidecar (not detected here)
 *
 * Patterns 1-5 work for LONG by default. The detector also returns a SHORT
 * variant for each (e.g. inverted cup = distribution top, squeeze break
 * downward, etc.) so the cockpit can label LONG/SHORT setups symmetrically.
 *
 * NOTE: setupType is descriptive only — NOT a filter (per locked arch).
 */

import type { Kline } from "../bitunix-trade";

const num = (s: string | number): number => (typeof s === "number" ? s : parseFloat(s));

// ---------- types ----------

export type SetupSide = "LONG" | "SHORT";

export interface PatternResult {
  detected: boolean;
  confidence: number;          // 0..1
  details: Record<string, unknown>;
}

export interface AltcoinSetupFeatures {
  symbol: string;
  timeframe: string;
  asOf: number;
  side: SetupSide;             // dominant side from price action
  patterns: {
    cup: PatternResult;        // 圓底
    squeeze: PatternResult;    // 低量吸籌
    volSpike: PatternResult;   // pre-pump
    sweep: PatternResult;      // liquidity sweep + reclaim
    breakout: PatternResult;   // breakout confirmation
  };
  setupType: string;           // descriptive label
  patternCount: number;        // 0..5 (qimen counted separately)
}

// ---------- helpers ----------

function sma(arr: number[], n: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    out.push(i >= n - 1 ? sum / n : NaN);
  }
  return out;
}

function stddev(arr: number[], mean: number): number {
  if (arr.length === 0) return 0;
  const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(v);
}

function bollingerWidth(closes: number[], n = 20, k = 2): number[] {
  // returns array of (upper-lower)/middle for each candle
  const widths: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) {
      widths.push(NaN);
      continue;
    }
    const window = closes.slice(i - n + 1, i + 1);
    const mean = window.reduce((s, x) => s + x, 0) / window.length;
    const sd = stddev(window, mean);
    const upper = mean + k * sd;
    const lower = mean - k * sd;
    widths.push((upper - lower) / mean);
  }
  return widths;
}

function rsi(closes: number[], n = 14): number {
  if (closes.length < n + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// ---------- pattern detectors ----------

/**
 * Cup / 圓底 — U-shape over ≥ 7d.
 * Heuristic: low_min in middle 1/3 of window, depth 20-60%, current price
 * near rim (within 5%).
 */
function detectCup(klines: Kline[]): PatternResult {
  // assume daily TF: 7d = 7 candles minimum, look back up to 60
  const window = klines.slice(-60);
  if (window.length < 14) {
    return { detected: false, confidence: 0, details: { reason: "insufficient data" } };
  }
  const closes = window.map((k) => num(k.close));
  const highs = window.map((k) => num(k.high));
  const lows = window.map((k) => num(k.low));

  const startPrice = closes[0];
  const endPrice = closes[closes.length - 1];
  const minIdx = lows.indexOf(Math.min(...lows));
  const minPrice = lows[minIdx];

  const len = window.length;
  const middleStart = Math.floor(len / 3);
  const middleEnd = Math.floor((2 * len) / 3);

  const minInMiddle = minIdx >= middleStart && minIdx <= middleEnd;
  const rim = Math.max(startPrice, endPrice);
  const depth = (rim - minPrice) / rim;
  const proximityToRim = (rim - endPrice) / rim;
  const symmetry = Math.abs(startPrice - endPrice) / rim; // <0.1 = balanced

  const detected =
    minInMiddle && depth >= 0.2 && depth <= 0.6 && proximityToRim <= 0.05 && symmetry <= 0.15;

  // confidence weights each criterion
  const c1 = minInMiddle ? 1 : 0;
  const c2 = depth >= 0.2 && depth <= 0.6 ? 1 : 0;
  const c3 = Math.max(0, 1 - proximityToRim / 0.1);
  const c4 = Math.max(0, 1 - symmetry / 0.2);
  const confidence = (c1 + c2 + c3 + c4) / 4;

  return {
    detected,
    confidence: +confidence.toFixed(2),
    details: {
      depthPct: +(depth * 100).toFixed(1),
      proximityToRimPct: +(proximityToRim * 100).toFixed(1),
      symmetryPct: +(symmetry * 100).toFixed(1),
      minInMiddleThird: minInMiddle,
    },
  };
}

/**
 * Squeeze 低量吸籌 — Bollinger width ≤ 60% of 5d avg, vol < 20MA.
 */
function detectSqueeze(klines: Kline[]): PatternResult {
  if (klines.length < 30) {
    return { detected: false, confidence: 0, details: { reason: "insufficient data" } };
  }
  const closes = klines.map((k) => num(k.close));
  const vols = klines.map((k) => num(k.volume));
  const widths = bollingerWidth(closes, 20, 2);

  const last = widths[widths.length - 1];
  const recent5 = widths.slice(-6, -1).filter((x) => !isNaN(x));
  if (recent5.length < 3 || isNaN(last)) {
    return { detected: false, confidence: 0, details: { reason: "BB not ready" } };
  }
  const avg5 = recent5.reduce((s, x) => s + x, 0) / recent5.length;
  const widthRatio = last / avg5;

  const vol20 = vols.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const lastVol = vols[vols.length - 1];
  const volRatio = lastVol / vol20;

  const detected = widthRatio <= 0.6 && volRatio < 1;
  const c1 = Math.max(0, 1 - widthRatio / 0.8);
  const c2 = Math.max(0, 1 - volRatio);
  const confidence = (c1 + c2) / 2;

  return {
    detected,
    confidence: +confidence.toFixed(2),
    details: {
      bbWidth: +last.toFixed(4),
      bbWidth5dAvg: +avg5.toFixed(4),
      widthRatio: +widthRatio.toFixed(2),
      volRatio: +volRatio.toFixed(2),
    },
  };
}

/**
 * Vol spike pre-pump — vol ≥ 3× avg while price flat ±2% over 12-24 candles.
 */
function detectVolSpike(klines: Kline[]): PatternResult {
  if (klines.length < 30) {
    return { detected: false, confidence: 0, details: { reason: "insufficient data" } };
  }
  const recent24 = klines.slice(-24);
  const closes = recent24.map((k) => num(k.close));
  const vols = recent24.map((k) => num(k.volume));
  const priceMin = Math.min(...closes);
  const priceMax = Math.max(...closes);
  const priceRangePct = (priceMax - priceMin) / priceMin;

  const earlier = klines.slice(-50, -24);
  if (earlier.length === 0) {
    return { detected: false, confidence: 0, details: { reason: "no baseline" } };
  }
  const baselineAvg = earlier.reduce((s, k) => s + num(k.volume), 0) / earlier.length;
  const recentMaxVol = Math.max(...vols);
  const volRatio = recentMaxVol / baselineAvg;

  const detected = volRatio >= 3 && priceRangePct <= 0.04;
  const c1 = Math.min(1, volRatio / 4);
  const c2 = Math.max(0, 1 - priceRangePct / 0.05);
  const confidence = (c1 + c2) / 2;

  return {
    detected,
    confidence: +confidence.toFixed(2),
    details: {
      volRatio: +volRatio.toFixed(2),
      priceRangePct: +(priceRangePct * 100).toFixed(2),
      maxVolCandle: vols.indexOf(recentMaxVol),
    },
  };
}

/**
 * Liquidity sweep + reclaim — wick through prior pivot, close back inside.
 * For LONG: wick below recent pivot low, close back above (SSL sweep).
 * For SHORT: wick above recent pivot high, close back below (BSL sweep).
 */
function detectSweep(klines: Kline[], side: SetupSide): PatternResult {
  if (klines.length < 20) {
    return { detected: false, confidence: 0, details: { reason: "insufficient data" } };
  }
  // last 5 candles after a 15-candle reference window
  const ref = klines.slice(-20, -5);
  const recent = klines.slice(-5);

  if (side === "LONG") {
    const refLow = Math.min(...ref.map((k) => num(k.low)));
    for (let i = recent.length - 1; i >= 0; i--) {
      const k = recent[i];
      if (num(k.low) < refLow && num(k.close) > refLow) {
        const wickDepth = (refLow - num(k.low)) / refLow;
        const reclaimMargin = (num(k.close) - refLow) / refLow;
        const confidence = Math.min(1, wickDepth * 100) * Math.min(1, reclaimMargin * 100);
        return {
          detected: true,
          confidence: +confidence.toFixed(2),
          details: {
            sweepSide: "SSL",
            sweptPrice: refLow,
            wickDepthPct: +(wickDepth * 100).toFixed(2),
            reclaimMarginPct: +(reclaimMargin * 100).toFixed(2),
            candleIndex: klines.length - recent.length + i,
          },
        };
      }
    }
  } else {
    const refHigh = Math.max(...ref.map((k) => num(k.high)));
    for (let i = recent.length - 1; i >= 0; i--) {
      const k = recent[i];
      if (num(k.high) > refHigh && num(k.close) < refHigh) {
        const wickDepth = (num(k.high) - refHigh) / refHigh;
        const reclaimMargin = (refHigh - num(k.close)) / refHigh;
        const confidence = Math.min(1, wickDepth * 100) * Math.min(1, reclaimMargin * 100);
        return {
          detected: true,
          confidence: +confidence.toFixed(2),
          details: {
            sweepSide: "BSL",
            sweptPrice: refHigh,
            wickDepthPct: +(wickDepth * 100).toFixed(2),
            reclaimMarginPct: +(reclaimMargin * 100).toFixed(2),
            candleIndex: klines.length - recent.length + i,
          },
        };
      }
    }
  }
  return { detected: false, confidence: 0, details: { side } };
}

/**
 * Breakout 確認 — close beyond level + vol ≥ 1.5× + RSI > 50 (LONG)
 * For SHORT: close below level + vol ≥ 1.5× + RSI < 50.
 */
function detectBreakout(klines: Kline[], side: SetupSide): PatternResult {
  if (klines.length < 30) {
    return { detected: false, confidence: 0, details: { reason: "insufficient data" } };
  }
  const closes = klines.map((k) => num(k.close));
  const vols = klines.map((k) => num(k.volume));
  const lastClose = closes[closes.length - 1];
  const lastVol = vols[vols.length - 1];

  // reference level: 20d high (LONG) / 20d low (SHORT) excluding last candle
  const ref = klines.slice(-21, -1);
  const level =
    side === "LONG"
      ? Math.max(...ref.map((k) => num(k.high)))
      : Math.min(...ref.map((k) => num(k.low)));

  const beyond =
    side === "LONG" ? lastClose > level : lastClose < level;
  const beyondMargin = side === "LONG" ? (lastClose - level) / level : (level - lastClose) / level;

  const vol20 = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  const volRatio = lastVol / vol20;

  const r = rsi(closes, 14);
  const rsiOk = side === "LONG" ? r > 50 : r < 50;

  const detected = beyond && volRatio >= 1.5 && rsiOk;
  const c1 = beyond ? Math.min(1, beyondMargin * 50) : 0;
  const c2 = Math.min(1, volRatio / 2);
  const c3 = side === "LONG" ? Math.max(0, (r - 40) / 30) : Math.max(0, (60 - r) / 30);
  const confidence = (c1 + c2 + c3) / 3;

  return {
    detected,
    confidence: +confidence.toFixed(2),
    details: {
      level,
      lastClose,
      beyondMarginPct: +(beyondMargin * 100).toFixed(2),
      volRatio: +volRatio.toFixed(2),
      rsi14: +r.toFixed(1),
    },
  };
}

// ---------- side inference ----------

/**
 * Infer dominant side from recent structure:
 *   - last close vs 20d midpoint, plus RSI bias
 */
function inferSide(klines: Kline[]): SetupSide {
  const closes = klines.map((k) => num(k.close));
  const ref = klines.slice(-20);
  const high20 = Math.max(...ref.map((k) => num(k.high)));
  const low20 = Math.min(...ref.map((k) => num(k.low)));
  const mid = (high20 + low20) / 2;
  const last = closes[closes.length - 1];
  const r = rsi(closes, 14);

  if (last > mid && r > 50) return "LONG";
  if (last < mid && r < 50) return "SHORT";
  // tiebreak: above mid → LONG
  return last >= mid ? "LONG" : "SHORT";
}

// ---------- setup type label (descriptive, NOT filter) ----------

function labelSetupType(
  side: SetupSide,
  patterns: AltcoinSetupFeatures["patterns"]
): string {
  const p = patterns;
  if (side === "LONG") {
    if (p.cup.detected && p.breakout.detected) return "圓底突破";
    if (p.squeeze.detected && p.breakout.detected) return "Squeeze 點火";
    if (p.sweep.detected && !p.breakout.detected) return "Sweep 反彈";
    if (p.volSpike.detected && p.squeeze.detected) return "上升再蓄勢";
    if (p.breakout.detected) return "突破跟進";
    return "等待結構";
  } else {
    if (p.breakout.detected && p.sweep.detected) return "高位假突破";
    if (p.sweep.detected) return "流動性 sweep 反轉";
    if (p.cup.detected) return "雙頂 / 高位分布"; // inverted cup proxy
    if (p.breakout.detected) return "向下破位";
    return "等待結構";
  }
}

// ---------- main ----------

export async function detectAltcoinSetup(
  symbol: string,
  klines: Kline[],
  timeframe = "1d"
): Promise<AltcoinSetupFeatures | null> {
  if (klines.length < 30) return null;

  const side = inferSide(klines);
  const patterns = {
    cup: detectCup(klines),
    squeeze: detectSqueeze(klines),
    volSpike: detectVolSpike(klines),
    sweep: detectSweep(klines, side),
    breakout: detectBreakout(klines, side),
  };

  const patternCount = (Object.values(patterns) as PatternResult[]).reduce(
    (n, p) => n + (p.detected ? 1 : 0),
    0
  );

  return {
    symbol,
    timeframe,
    asOf: klines[klines.length - 1].closeTime,
    side,
    patterns,
    setupType: labelSetupType(side, patterns),
    patternCount,
  };
}

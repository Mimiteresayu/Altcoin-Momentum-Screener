/**
 * Signal Classifier Service
 * Extracted from routes.ts — HOT/ACTIVE/PRE/COIL/MAJOR classification,
 * signal strength scoring, TP/SL calculation, trade direction logic
 */
import type { Kline, FVG, OrderBlock } from "./indicator-pipeline";
import { MAJOR_SYMBOLS } from "./symbol-universe";

export type SignalType = "HOT" | "ACTIVE" | "PRE" | "COIL" | "MAJOR";
export type SpikeReadiness = "warming" | "primed" | "hot" | "overdue";

export interface LiquidityCluster {
  price: number;
  strength: number;
}

export interface OrderBookData {
  bids: [string, string][];
  asks: [string, string][];
}

export function getSpikeReadiness(minutesOnList: number): SpikeReadiness {
  if (minutesOnList < 5) return "warming";
  if (minutesOnList >= 5 && minutesOnList < 15) return "primed";
  if (minutesOnList >= 15 && minutesOnList < 30) return "hot";
  return "overdue";
}

export function classifySignalType(params: {
  priceChange24h: number;
  volumeSpikeRatio: number;
  rsi: number;
  isMajor: boolean;
  coilPhase?: string;
}): SignalType | null {
  const { priceChange24h, volumeSpikeRatio, rsi, isMajor, coilPhase } = params;

  // HOT: Price >= +20%, VOL >= 2.0x
  if (priceChange24h >= 20 && volumeSpikeRatio >= 2.0) return "HOT";

  // MAJOR: Always include BTC/ETH
  if (isMajor) return "MAJOR";

  // ACTIVE: VOL >= 1.0x, Price +5% to +60%, RSI 50-85
  if (volumeSpikeRatio >= 1.0 && priceChange24h >= 5 && priceChange24h <= 60 && rsi >= 50 && rsi <= 85)
    return "ACTIVE";

  // PRE: VOL 0.5-1.0x, Price -8% to +15%, RSI 35-65
  if (volumeSpikeRatio >= 0.5 && volumeSpikeRatio < 1.0 && priceChange24h >= -8 && priceChange24h <= 15 && rsi >= 35 && rsi <= 65)
    return "PRE";

  // COIL: Full analysis or heuristic fallback
  if (coilPhase === "COIL_READY" || coilPhase === "COIL_TRIGGER") return "COIL";
  if (volumeSpikeRatio < 0.8 && priceChange24h >= -5 && priceChange24h <= 8 && rsi >= 40 && rsi <= 60)
    return "COIL";

  return null;
}

export function calculateSignalStrength(params: {
  signalType: SignalType;
  priceChange24h: number;
  volumeSpikeRatio: number;
  rsi: number;
  riskReward: number;
  hasLeadingIndicators: boolean;
}): number {
  const { signalType, priceChange24h, volumeSpikeRatio, rsi, riskReward, hasLeadingIndicators } = params;
  let strength = 0;

  const priceInRange =
    signalType === "HOT" ? priceChange24h >= 20 :
    signalType === "ACTIVE" ? priceChange24h >= 5 && priceChange24h <= 60 :
    signalType === "COIL" ? priceChange24h >= -5 && priceChange24h <= 8 :
    priceChange24h >= -8 && priceChange24h <= 15;

  const volumeInRange =
    signalType === "HOT" ? volumeSpikeRatio >= 2.0 :
    signalType === "ACTIVE" ? volumeSpikeRatio >= 1.0 :
    signalType === "COIL" ? volumeSpikeRatio < 0.8 :
    volumeSpikeRatio >= 0.5 && volumeSpikeRatio < 1.0;

  const rsiInRange = signalType === "ACTIVE" ? rsi >= 50 && rsi <= 85 : rsi >= 35 && rsi <= 65;

  if (priceInRange) strength++;
  if (volumeInRange) strength++;
  if (rsiInRange) strength++;
  if (riskReward >= 1.5) strength++;
  if (hasLeadingIndicators) strength++;

  return strength;
}

export function determineTradeSide(params: {
  htfBias?: { side: "LONG" | "SHORT" } | null;
  priceChange24h: number;
  rsi: number;
  volumeSpikeRatio: number;
  oiChange24h: number | null;
  fvgType: "bullish" | "bearish" | null;
  obType: "bullish" | "bearish" | null;
}): "LONG" | "SHORT" {
  const { htfBias, priceChange24h, rsi, volumeSpikeRatio, oiChange24h, fvgType, obType } = params;

  // PRIMARY: HTF Bias (Supertrend 4H + Funding Rate)
  if (htfBias) return htfBias.side;

  // FALLBACK: Scoring system
  let longScore = 0;
  let shortScore = 0;

  if (priceChange24h >= 5) longScore += 3;
  else if (priceChange24h >= 2) longScore += 2;
  else if (priceChange24h >= 0) longScore += 1;
  else if (priceChange24h <= -5) shortScore += 3;
  else if (priceChange24h <= -2) shortScore += 2;
  else shortScore += 1;

  if (rsi >= 60 && rsi <= 75) longScore += 2;
  else if (rsi >= 50 && rsi < 60) longScore += 1;
  else if (rsi >= 40 && rsi < 50) shortScore += 1;
  else if (rsi >= 25 && rsi < 40) shortScore += 2;

  if (volumeSpikeRatio >= 3.0) { if (priceChange24h >= 0) longScore += 2; else shortScore += 2; }
  else if (volumeSpikeRatio >= 1.5) { if (priceChange24h >= 0) longScore += 1; else shortScore += 1; }

  if (oiChange24h !== null) {
    if (oiChange24h > 10 && priceChange24h >= 2) longScore += 2;
    else if (oiChange24h > 5 && priceChange24h >= 0) longScore += 1;
    else if (oiChange24h > 10 && priceChange24h <= -2) shortScore += 2;
    else if (oiChange24h > 5 && priceChange24h < 0) shortScore += 1;
  }

  if (fvgType === "bullish") longScore += 1;
  else if (fvgType === "bearish") shortScore += 1;
  if (obType === "bullish") longScore += 1;
  else if (obType === "bearish") shortScore += 1;

  return shortScore > longScore ? "SHORT" : "LONG";
}

export function detectLiquidityClusters(
  orderBook: OrderBookData | null,
  currentPrice: number,
): LiquidityCluster[] {
  if (!orderBook || !orderBook.asks.length) return [];
  const clusters: LiquidityCluster[] = [];
  let totalAskVolume = 0;
  for (const [, qty] of orderBook.asks) totalAskVolume += parseFloat(qty);
  const avgAskVolume = totalAskVolume / orderBook.asks.length;
  for (const [price, qty] of orderBook.asks) {
    const priceNum = parseFloat(price);
    const qtyNum = parseFloat(qty);
    if (qtyNum > avgAskVolume * 2 && priceNum > currentPrice) {
      clusters.push({ price: priceNum, strength: qtyNum / avgAskVolume });
    }
  }
  return clusters.sort((a, b) => a.price - b.price).slice(0, 3);
}

export function calculateOrderBookImbalance(orderBook: OrderBookData | null) {
  if (!orderBook || !orderBook.bids.length || !orderBook.asks.length)
    return { imbalance: 0, bidAskRatio: 1 };
  const bidVolume = orderBook.bids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const askVolume = orderBook.asks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const total = bidVolume + askVolume;
  return {
    imbalance: total > 0 ? (bidVolume - askVolume) / total : 0,
    bidAskRatio: askVolume > 0 ? bidVolume / askVolume : 1,
  };
}

export function calculateMultipleTPLevels(
  currentPrice: number,
  swingHighs: number[],
  liquidityClusters: LiquidityCluster[],
  fvg: FVG | null,
  ob: OrderBlock | null,
) {
  const targets: { price: number; reason: string }[] = [];
  for (const high of swingHighs) {
    if (high > currentPrice && high < currentPrice * 1.5)
      targets.push({ price: high, reason: "Swing High" });
  }
  for (const cluster of liquidityClusters) {
    if (cluster.price > currentPrice && cluster.price < currentPrice * 1.5)
      targets.push({ price: cluster.price, reason: "Liquidity Zone" });
  }
  if (fvg && fvg.type === "bearish" && fvg.level > currentPrice)
    targets.push({ price: fvg.level, reason: "FVG Resistance" });
  if (ob && ob.type === "bearish" && ob.level > currentPrice)
    targets.push({ price: ob.level, reason: "Order Block" });
  targets.sort((a, b) => a.price - b.price);

  const levels: { label: string; price: number; pct: number; reason: string }[] = [];
  const defaults = [
    { label: "TP1", fallbackPct: 5 },
    { label: "TP2", fallbackPct: 10 },
    { label: "TP3", fallbackPct: 15 },
  ];
  for (let i = 0; i < 3; i++) {
    if (targets.length > i) {
      levels.push({
        label: defaults[i].label,
        price: targets[i].price,
        pct: ((targets[i].price - currentPrice) / currentPrice) * 100,
        reason: targets[i].reason,
      });
    } else {
      levels.push({
        label: defaults[i].label,
        price: currentPrice * (1 + defaults[i].fallbackPct / 100),
        pct: defaults[i].fallbackPct,
        reason: `${defaults[i].fallbackPct}% Target`,
      });
    }
  }
  return { levels };
}

export function calculateSL(
  currentPrice: number,
  swingLows: number[],
  fvg: FVG | null,
  ob: OrderBlock | null,
): { sl: number; slReason: string } {
  let sl = currentPrice * 0.95;
  let slReason = "5% below entry";
  if (ob && ob.type === "bullish" && ob.level < currentPrice && ob.level > currentPrice * 0.92) {
    sl = ob.level * 0.995; slReason = "Below Order Block";
  } else if (fvg && fvg.type === "bullish" && fvg.level < currentPrice && fvg.level > currentPrice * 0.92) {
    sl = fvg.level * 0.995; slReason = "Below FVG";
  } else if (swingLows.length > 0 && swingLows[0] < currentPrice && swingLows[0] > currentPrice * 0.92) {
    sl = swingLows[0] * 0.995; slReason = "Below Swing Low";
  }
  return { sl, slReason };
}

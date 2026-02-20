import { Signal } from "@shared/schema";
import {
  getFundingRate,
  getLongShortRatio,
  getLiquidationMap,
  getEnhancedMarketData,
  type EnhancedMarketData,
  type LiquidationMapData,
} from "./coinglass";
import { bitunixTradeService, BitunixTradeService } from "./bitunix-trade";

// Simple kline interface for internal use
interface SimpleKline {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  openTime: number;
  closeTime: number;
}
import { getBinanceFuturesData, getBinanceKlines, getSymbolListingDate, calculateAgeDays } from "./binance";
import { getOKXMarketData, getOKXFundingRate, getOKXKlines } from "./okx";

type PriceLocation = "DISCOUNT" | "NEUTRAL" | "PREMIUM";
type MarketPhase = "ACCUMULATION" | "BREAKOUT" | "DISTRIBUTION" | "TREND" | "EXHAUST";
type Confidence = "high" | "medium" | "low";

type HtfBias = {
  side: "LONG" | "SHORT";
  confidence: "high" | "medium" | "low";
  supertrendBias: "LONG" | "SHORT";
  fundingConfirms: boolean;
  supertrendValue: number;
};

type EntryModel = "BUY DIP" | "SCALE IN" | "BOS ENTRY" | "FVG ENTRY" | "PULLBACK" | "ADD" | "TAKE PROFIT" | "SHORT SETUP" | "AVOID" | "REVERSAL" | "WAIT";

interface CandlestickAnalysis {
  isBullish: boolean;
  isBearish: boolean;
  hasLongUpperWick: boolean;  // Selling pressure
  hasLongLowerWick: boolean;  // Buying pressure
  bodySize: number;           // Relative body size
  wickRatio: number;          // Wick to body ratio
}

interface EnrichedSignalData {
  priceLocation: PriceLocation;
  marketPhase: MarketPhase;
  entryModel: EntryModel;
  preSpikeScore: number;
  fundingRate: number | undefined;
  fundingBias: "bullish" | "bearish" | "neutral" | undefined;
  longShortRatio: number | undefined;
  lsrBias: "long_dominant" | "short_dominant" | "balanced" | undefined;
  htfBias: HtfBias | undefined;
  fvgLevels: { price: number; type: "bullish" | "bearish"; strength: number }[];
  obLevels: { price: number; type: "bullish" | "bearish"; strength: number }[];
  liquidationZones: {
    nearestLongLiq: number | undefined;
    nearestShortLiq: number | undefined;
    longLiqDistance: number | undefined;
    shortLiqDistance: number | undefined;
  };
  volumeProfilePOC: number | undefined; // Point of Control - highest volume price level
  storytelling: {
    summary: string;
    interpretation: string;
    confidence: Confidence;
    actionSuggestion: string;
  };
  ageDays: number | undefined; // Days since first listed on exchange
}

export function calculatePriceLocation(
  currentPrice: number,
  high24h: number,
  low24h: number,
): PriceLocation {
  const range = high24h - low24h;
  if (range <= 0) return "NEUTRAL";

  const position = (currentPrice - low24h) / range;

  if (position <= 0.33) return "DISCOUNT";
  if (position >= 0.67) return "PREMIUM";
  return "NEUTRAL";
}

/**
 * Analyze candlestick pattern for phase refinement
 * Uses open, close, high, low to determine candle characteristics
 */
export function analyzeCandlestick(kline: SimpleKline): CandlestickAnalysis {
  const open = parseFloat(kline.open);
  const close = parseFloat(kline.close);
  const high = parseFloat(kline.high);
  const low = parseFloat(kline.low);
  
  const isBullish = close > open;
  const isBearish = close < open;
  
  const body = Math.abs(close - open);
  const fullRange = high - low;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  
  // Relative measurements (as ratio of full range)
  const bodyRatio = fullRange > 0 ? body / fullRange : 0;
  const upperWickRatio = fullRange > 0 ? upperWick / fullRange : 0;
  const lowerWickRatio = fullRange > 0 ? lowerWick / fullRange : 0;
  
  // Long wick = >30% of total range
  const hasLongUpperWick = upperWickRatio > 0.3;
  const hasLongLowerWick = lowerWickRatio > 0.3;
  
  // Wick to body ratio (for doji/reversal detection)
  const wickRatio = body > 0 ? (upperWick + lowerWick) / body : Infinity;
  
  return {
    isBullish,
    isBearish,
    hasLongUpperWick,
    hasLongLowerWick,
    bodySize: bodyRatio,
    wickRatio,
  };
}

/**
 * Calculate Entry Model based on market phase, RSI, and candlestick patterns
 */
export function calculateEntryModel(
  marketPhase: MarketPhase,
  rsi: number,
  priceLocation: PriceLocation,
  candleAnalysis?: CandlestickAnalysis,
  fvgLevels?: { price: number; type: string }[],
): EntryModel {
  const hasValidRsi = rsi !== 0 && rsi !== undefined && !isNaN(rsi);
  const hasFVG = fvgLevels && fvgLevels.length > 0;
  const hasBullishFVG = fvgLevels?.some(f => f.type === "bullish");
  const hasBearishFVG = fvgLevels?.some(f => f.type === "bearish");
  
  switch (marketPhase) {
    case "ACCUMULATION":
      // Use RSI to determine entry style
      if (hasValidRsi) {
        if (rsi < 40) return "BUY DIP";  // RSI oversold = aggressive buy
        if (rsi >= 40 && rsi <= 55) return "SCALE IN";  // Neutral = gradual entry
      }
      // Use candle pattern
      if (candleAnalysis?.hasLongLowerWick) return "BUY DIP";  // Buying pressure
      return "SCALE IN";
      
    case "BREAKOUT":
      // BOS = Break of Structure (momentum confirmation)
      // FVG = Fair Value Gap (retest entry)
      if (hasBullishFVG && priceLocation !== "PREMIUM") return "FVG ENTRY";
      if (candleAnalysis?.isBullish && candleAnalysis?.bodySize > 0.5) return "BOS ENTRY";
      return "BOS ENTRY";
      
    case "TREND":
      // Pullback = wait for dip in uptrend
      // Add = increase position on continuation
      if (hasValidRsi && rsi > 60) return "ADD";  // Strong momentum
      if (candleAnalysis?.hasLongLowerWick) return "PULLBACK";  // Rejection = good entry
      if (priceLocation === "NEUTRAL") return "PULLBACK";
      return "ADD";
      
    case "DISTRIBUTION":
      // Take Profit = close longs
      // Short Setup = consider shorting
      if (hasValidRsi && rsi > 70) return "TAKE PROFIT";  // Overbought
      if (candleAnalysis?.hasLongUpperWick) return "SHORT SETUP";  // Selling pressure
      if (priceLocation === "PREMIUM") return "TAKE PROFIT";
      return "TAKE PROFIT";
      
    case "EXHAUST":
      // Avoid = don't enter
      // Reversal = potential counter-trend
      if (candleAnalysis && candleAnalysis.wickRatio > 2) return "REVERSAL";  // High wick = reversal candle
      if (hasValidRsi && (rsi > 80 || rsi < 20)) return "AVOID";  // Extreme RSI
      return "AVOID";
      
    default:
      return "WAIT";
  }
}

/**
 * Market Phase Detection - Exact Google Doc Definitions
 * 
 * 5 Phases: ACCUMULATION | BREAKOUT | DISTRIBUTION | TREND | EXHAUST
 */
export function calculateMarketPhase(
  volumeSpike: number,
  oiChange: number | undefined,
  rsi: number,
  priceChange: number,
  volAccel: number | undefined,
  priceLocation: PriceLocation = "NEUTRAL",
  fundingRate: number | undefined = undefined,
  longShortRatio: number | undefined = undefined,
): MarketPhase {
  const oiDelta = oiChange ?? 0;
  const hasValidRsi = rsi !== 0 && rsi !== undefined && !isNaN(rsi);
  const fr = fundingRate ?? 0;
  const acceleration = volAccel ?? 1;

  // ===== SIMPLIFIED PHASE DETECTION (Google Doc criteria) =====
  // Phases distribute more evenly across all 5 categories
  
  // ===== 1. EXHAUST: Extreme RSI with declining OI and price stalling =====
  // Extreme RSI (> 75 or < 35) with declining OI
  if (hasValidRsi && (rsi > 75 || rsi < 35) && oiDelta < 0) {
    return "EXHAUST";
  }
  
  // Price stalling with extreme RSI
  if (hasValidRsi && Math.abs(priceChange) < 2) {
    if (rsi > 75 || rsi < 35) {
      return "EXHAUST";
    }
  }

  // ===== 2. BREAKOUT: Strong price move with high volume and rising OI =====
  // priceChange > 5%, volumeSpike > 2.5x, oiDelta > 15%
  if (Math.abs(priceChange) > 5 && volumeSpike > 2.5 && oiDelta > 15) {
    return "BREAKOUT";
  }
  
  // Relaxed BREAKOUT: Strong price move with high volume (no strict OI requirement)
  if (Math.abs(priceChange) > 5 && volumeSpike > 2.5) {
    return "BREAKOUT";
  }
  
  // Alternative BREAKOUT: Good volume with rising OI and notable price move
  if (Math.abs(priceChange) > 3 && volumeSpike > 2.0 && oiDelta > 10) {
    return "BREAKOUT";
  }

  // ===== 3. DISTRIBUTION: Price in PREMIUM zone with declining/flat OI and RSI > 60 =====
  // STRICT: Requires BOTH priceLocation === 'PREMIUM' AND oiDelta < 2 AND rsi > 60
  if (priceLocation === "PREMIUM" && oiDelta < 2 && hasValidRsi && rsi > 60) {
    return "DISTRIBUTION";
  }
  
  // Very high RSI at premium with any declining OI
  if (priceLocation === "PREMIUM" && oiDelta < 0 && hasValidRsi && rsi > 70) {
    return "DISTRIBUTION";
  }

  // ===== 4. ACCUMULATION: Flat price with moderate volume and building OI =====
  // priceChange < 3%, volumeSpike 1-2.5x, oiDelta 5-25%
  if (Math.abs(priceChange) < 3 && volumeSpike >= 1.0 && volumeSpike <= 2.5 && oiDelta >= 5 && oiDelta <= 25) {
    return "ACCUMULATION";
  }
  
  // Relaxed ACCUMULATION: Flat price with building OI at discount/neutral
  if (Math.abs(priceChange) < 3 && oiDelta > 3 && (priceLocation === "DISCOUNT" || priceLocation === "NEUTRAL")) {
    return "ACCUMULATION";
  }
  
  // Low RSI with building OI = accumulation
  if (hasValidRsi && rsi < 40 && oiDelta > 0) {
    return "ACCUMULATION";
  }

  // ===== 5. TREND: Moderate price movement with steady OI growth =====
  // oiDelta 5-20%, RSI 40-70 (balanced, middle-ground phase)
  if (oiDelta >= 5 && oiDelta <= 20 && hasValidRsi && rsi >= 40 && rsi <= 70) {
    return "TREND";
  }
  
  // Moderate movement with healthy OI (relaxed)
  if (oiDelta > 2 && oiDelta < 25 && volumeSpike >= 1.0) {
    return "TREND";
  }
  
  // Price moving with positive OI = trend
  if (Math.abs(priceChange) > 2 && oiDelta > 0) {
    return "TREND";
  }

  // ===== DEFAULT: TREND as balanced fallback =====
  // TREND is the most common middle-ground phase
  // Only use specific fallbacks for clear signals
  
  if (hasValidRsi) {
    // Very extreme RSI with no OI data -> EXHAUST
    if (rsi > 80 || rsi < 25) return "EXHAUST";
    // High RSI in premium -> only DISTRIBUTION if actually premium
    if (rsi > 70 && priceLocation === "PREMIUM") return "DISTRIBUTION";
    // Low RSI at discount -> ACCUMULATION
    if (rsi < 35 && priceLocation === "DISCOUNT") return "ACCUMULATION";
  }
  
  // Strong positive OI with volume = TREND (not distribution)
  if (oiDelta > 5 && volumeSpike > 1.2) return "TREND";
  
  // Discount location with any positive OI = ACCUMULATION
  if (priceLocation === "DISCOUNT" && oiDelta > 0) return "ACCUMULATION";
  
  // Default to TREND as balanced middle-ground
  return "TREND";
}

/**
 * Alternative Market Phase Detection using OI + Price Change correlation
 * Provides a complementary perspective based on position dynamics:
 * - OI up + Price up = BREAKOUT/TREND (long positions opening, bullish momentum)
 * - OI up + Price down = ACCUMULATION (shorts opening, potential reversal setup)
 * - OI down + Price up = DISTRIBUTION (shorts closing, weak rally)
 * - OI down + Price down = EXHAUST (longs closing, capitulation)
 */
export function calculateMarketPhaseAlt(
  rsi: number,
  priceChange: number,
  volumeSpike: number,
  priceLocation: PriceLocation = "NEUTRAL",
  oiChange: number | undefined = undefined,
): MarketPhase {
  const oiDelta = oiChange ?? 0;
  const hasValidOI = oiChange !== undefined && oiChange !== null;
  const hasValidRsi = rsi !== 0 && rsi !== undefined && !isNaN(rsi);
  
  // If we have valid OI data, use the OI + Price correlation method
  if (hasValidOI) {
    const oiUp = oiDelta > 2;
    const oiDown = oiDelta < -2;
    const priceUp = priceChange > 2;
    const priceDown = priceChange < -2;
    
    // OI up + Price up = BREAKOUT or TREND (long positions opening, bullish momentum)
    if (oiUp && priceUp) {
      // Strong confirmation: high volume = BREAKOUT
      if (volumeSpike >= 2.5) {
        return "BREAKOUT";
      }
      return "TREND";
    }
    
    // OI up + Price down = ACCUMULATION (shorts opening OR smart money accumulating)
    // This creates a reversal setup - new positions opening during decline
    if (oiUp && priceDown) {
      return "ACCUMULATION";
    }
    
    // OI down + Price up = DISTRIBUTION (shorts closing, weak rally)
    // Price rising on position closures = unsustainable move
    if (oiDown && priceUp) {
      return "DISTRIBUTION";
    }
    
    // OI down + Price down = EXHAUST (longs closing, capitulation)
    // Positions being liquidated = potential bottom
    if (oiDown && priceDown) {
      return "EXHAUST";
    }
    
    // Moderate OI changes - use secondary indicators
    if (Math.abs(oiDelta) <= 2 && Math.abs(priceChange) <= 2) {
      // Consolidation with high volume = absorption (smart money accumulating)
      if (volumeSpike >= 2.0) {
        return "ACCUMULATION";
      }
      // Slight OI increase with flat price = quiet accumulation
      if (oiDelta > 0 && volumeSpike >= 0.8) {
        return "ACCUMULATION";
      }
    }
  }
  
  // Fallback: Use RSI + Volume when OI data unavailable
  if (hasValidRsi) {
    // Extreme RSI = exhaustion
    if (rsi > 75 || rsi < 35) {
      return "EXHAUST";
    }
    
    // RSI momentum with price confirmation = trend
    if (rsi > 55 && rsi <= 75 && priceChange > 3 && volumeSpike >= 1.2) {
      return "TREND";
    }
    
    // RSI recovering from oversold with volume = accumulation
    if (rsi >= 30 && rsi <= 50 && volumeSpike >= 1.0) {
      return "ACCUMULATION";
    }
    
    // RSI overbought at premium = distribution
    if (rsi > 70 && priceLocation === "PREMIUM") {
      return "DISTRIBUTION";
    }
  }
  
  // Final fallback: price/volume only
  if (priceChange > 5 && volumeSpike >= 2.5) return "BREAKOUT";
  if (priceChange > 3 && volumeSpike >= 1.5) return "TREND";
  if (priceChange < -5 && volumeSpike < 0.8) return "EXHAUST";
  if (priceLocation === "DISCOUNT" && volumeSpike >= 1.0) return "ACCUMULATION";
  if (priceLocation === "PREMIUM" && volumeSpike < 0.9) return "DISTRIBUTION";
  
  return "TREND";
}

export function calculatePreSpikeScore(
  volumeSpike: number,
  volAccel: number | undefined,
  oiChange: number | undefined,
  rsi: number,
  riskReward: number,
  signalStrength: number,
  fundingRate: number | undefined,
  longShortRatio: number | undefined,
): number {
  let score = 0;

  // Volume component (0-1.5 points)
  if (volumeSpike >= 8) score += 1.5;
  else if (volumeSpike >= 5) score += 1;
  else if (volumeSpike >= 3) score += 0.5;

  // Volume acceleration (0-0.5 points)
  const accel = volAccel ?? 1;
  if (accel >= 3) score += 0.5;
  else if (accel >= 2) score += 0.25;

  // OI change (0-1 points)
  marketPhase  if (oi >= 15) score += 1;
  else if (oi >= 10) score += 0.5;
  else if (oi >= 5) score += 0.25;

  // RSI in optimal zone (0-0.5 points) - 45-70 is ideal
  if (rsi >= 45 && rsi <= 70) score += 0.5;
  else if (rsi >= 35 && rsi <= 75) score += 0.25;

  // Risk/Reward (0-0.5 points)
  if (riskReward >= 3) score += 0.5;
  else if (riskReward >= 2) score += 0.25;

  // Signal strength boost (0-0.5 points)
  if (signalStrength >= 4) score += 0.5;

  // Funding rate confluence (0-0.25 points)
  // Negative funding = bullish for longs (typical rate is 0.01% = 0.0001 decimal)
  if (fundingRate !== undefined && fundingRate < -0.0001) score += 0.25;

  // Long/Short ratio (0-0.25 points)
  // Low ratio = fewer longs = contrarian bullish
  if (longShortRatio !== undefined && longShortRatio < 0.9) score += 0.25;

  return Math.min(5, Math.round(score * 10) / 10);
}

export function calculateATR(
  klines: { high: string; low: string; close: string }[],
  period: number = 10
): number {
  if (klines.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const high = parseFloat(klines[i].high);
    const low = parseFloat(klines[i].low);
    const prevClose = parseFloat(klines[i - 1].close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return 0;
  const recentTR = trueRanges.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

export function calculateSupertrend(
  klines: { high: string; low: string; close: string }[],
  atrPeriod: number = 10,
  multiplier: number = 3
): { value: number; direction: "LONG" | "SHORT" } | null {
  // Need enough candles to calculate ATR and iterate
  if (klines.length < atrPeriod + 2) return null;

  // Calculate ATR for each candle (we need ATR values for the iteration)
  const atrValues: number[] = [];
  for (let i = atrPeriod; i < klines.length; i++) {
    const trueRanges: number[] = [];
    for (let j = i - atrPeriod + 1; j <= i; j++) {
      const high = parseFloat(klines[j].high);
      const low = parseFloat(klines[j].low);
      const prevClose = parseFloat(klines[j - 1].close);
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }
    const atr = trueRanges.reduce((a, b) => a + b, 0) / atrPeriod;
    atrValues.push(atr);
  }

  if (atrValues.length === 0) return null;

  // Initialize Supertrend state
  let prevFinalUpperBand = Infinity;
  let prevFinalLowerBand = 0;
  let prevSupertrend = 0;
  let prevDirection: "LONG" | "SHORT" = "LONG";

  // Iterate through candles starting from where we have ATR
  for (let i = 0; i < atrValues.length; i++) {
    const candleIndex = atrPeriod + i;
    const candle = klines[candleIndex];
    const atr = atrValues[i];
    
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const close = parseFloat(candle.close);
    const hl2 = (high + low) / 2;

    // Calculate basic bands
    const basicUpperBand = hl2 + (multiplier * atr);
    const basicLowerBand = hl2 - (multiplier * atr);

    // Calculate final bands (they can only move in favorable direction)
    // Final Upper Band: can only go DOWN (tighten the stop for shorts)
    let finalUpperBand: number;
    if (basicUpperBand < prevFinalUpperBand || parseFloat(klines[candleIndex - 1].close) > prevFinalUpperBand) {
      finalUpperBand = basicUpperBand;
    } else {
      finalUpperBand = prevFinalUpperBand;
    }

    // Final Lower Band: can only go UP (tighten the stop for longs)
    let finalLowerBand: number;
    if (basicLowerBand > prevFinalLowerBand || parseFloat(klines[candleIndex - 1].close) < prevFinalLowerBand) {
      finalLowerBand = basicLowerBand;
    } else {
      finalLowerBand = prevFinalLowerBand;
    }

    // Determine Supertrend value and direction
    let supertrend: number;
    let direction: "LONG" | "SHORT";

    if (prevSupertrend === prevFinalUpperBand) {
      // Was in downtrend (using upper band)
      if (close > finalUpperBand) {
        // Price crossed above - flip to uptrend
        supertrend = finalLowerBand;
        direction = "LONG";
      } else {
        supertrend = finalUpperBand;
        direction = "SHORT";
      }
    } else {
      // Was in uptrend (using lower band)
      if (close < finalLowerBand) {
        // Price crossed below - flip to downtrend
        supertrend = finalUpperBand;
        direction = "SHORT";
      } else {
        supertrend = finalLowerBand;
        direction = "LONG";
      }
    }

    // Update state for next iteration
    prevFinalUpperBand = finalUpperBand;
    prevFinalLowerBand = finalLowerBand;
    prevSupertrend = supertrend;
    prevDirection = direction;
  }

  return { value: prevSupertrend, direction: prevDirection };
}

export function calculateHtfBias(
  klines4H: { high: string; low: string; close: string }[],
  fundingRate: number | undefined,
  symbol?: string
): HtfBias | undefined {
  // Use ATR period 14, multiplier 3.5 to match TradingView defaults
  const supertrend = calculateSupertrend(klines4H, 14, 3.5);
  if (!supertrend) return undefined;
  
  // Debug logging for specific symbols
  if (symbol && ["RIVER", "BTC", "ETH"].includes(symbol.replace("USDT", ""))) {
    const lastCandle = klines4H[klines4H.length - 1];
    console.log(`[SUPERTREND] ${symbol}: price=${lastCandle?.close}, ST=${supertrend.value.toFixed(4)}, dir=${supertrend.direction}`);
  }

  const supertrendBias = supertrend.direction;
  const supertrendValue = supertrend.value;

  let fundingConfirms = false;
  let confidence: "high" | "medium" | "low" = "medium";

  if (fundingRate !== undefined) {
    if (supertrendBias === "LONG" && fundingRate >= 0) {
      fundingConfirms = true;
      confidence = "high";
    } else if (supertrendBias === "SHORT" && fundingRate <= 0) {
      fundingConfirms = true;
      confidence = "high";
    } else if (Math.abs(fundingRate) < 0.0001) {
      confidence = "medium";
    } else {
      confidence = "low";
    }
  }

  return {
    side: supertrendBias,
    confidence,
    supertrendBias,
    fundingConfirms,
    supertrendValue,
  };
}

function calculateLiquidationZones(
  currentPrice: number,
  liquidationMap: LiquidationMapData[],
): {
  nearestLongLiq: number | undefined;
  nearestShortLiq: number | undefined;
  longLiqDistance: number | undefined;
  shortLiqDistance: number | undefined;
} {
  if (!liquidationMap || liquidationMap.length === 0) {
    return {
      nearestLongLiq: undefined,
      nearestShortLiq: undefined,
      longLiqDistance: undefined,
      shortLiqDistance: undefined,
    };
  }

  // Find nearest significant liquidation levels
  let nearestLong: { price: number; amount: number } | null = null;
  let nearestShort: { price: number; amount: number } | null = null;

  // Sort by price distance from current
  const sortedByDistance = [...liquidationMap].sort(
    (a, b) =>
      Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice),
  );

  // Find nearest with significant volume (> 1M)
  for (const level of sortedByDistance) {
    if (
      !nearestLong &&
      level.longLiquidation > 1000000 &&
      level.price < currentPrice
    ) {
      nearestLong = { price: level.price, amount: level.longLiquidation };
    }
    if (
      !nearestShort &&
      level.shortLiquidation > 1000000 &&
      level.price > currentPrice
    ) {
      nearestShort = { price: level.price, amount: level.shortLiquidation };
    }
    if (nearestLong && nearestShort) break;
  }

  return {
    nearestLongLiq: nearestLong?.price,
    nearestShortLiq: nearestShort?.price,
    longLiqDistance: nearestLong
      ? ((currentPrice - nearestLong.price) / currentPrice) * 100
      : undefined,
    shortLiqDistance: nearestShort
      ? ((nearestShort.price - currentPrice) / currentPrice) * 100
      : undefined,
  };
}

function generateStorytelling(
  signal: Signal,
  marketPhase: MarketPhase,
  priceLocation: PriceLocation,
  preSpikeScore: number,
  fundingBias: "bullish" | "bearish" | "neutral" | undefined,
  lsrBias: "long_dominant" | "short_dominant" | "balanced" | undefined,
): {
  summary: string;
  interpretation: string;
  confidence: Confidence;
  actionSuggestion: string;
} {
  const volumeDesc =
    signal.volumeSpikeRatio >= 8
      ? "extreme volume"
      : signal.volumeSpikeRatio >= 5
        ? "high volume"
        : signal.volumeSpikeRatio >= 3
          ? "elevated volume"
          : "normal volume";

  const rsiDesc =
    signal.rsi > 70
      ? "overbought"
      : signal.rsi > 60
        ? "bullish momentum"
        : signal.rsi < 30
          ? "oversold"
          : signal.rsi < 40
            ? "bearish momentum"
            : "neutral momentum";

  const oiDesc =
    signal.oiChange24h && signal.oiChange24h > 10
      ? "strong OI buildup"
      : signal.oiChange24h && signal.oiChange24h > 5
        ? "moderate OI increase"
        : signal.oiChange24h && signal.oiChange24h < -5
          ? "OI declining"
          : "stable OI";

  let summary = "";
  let interpretation = "";
  let actionSuggestion = "";
  let confidence: Confidence = "medium";

  switch (marketPhase) {
    case "ACCUMULATION":
      summary = `${signal.symbol} in ${priceLocation} zone with ${volumeDesc}, ${oiDesc}`;
      interpretation = `Smart money appears to be accumulating. Volume building while price consolidates in ${priceLocation.toLowerCase()} zone. ${rsiDesc} suggests room for upside.`;
      if (preSpikeScore >= 4) {
        actionSuggestion = `Strong LONG setup. Entry near ${signal.entryPrice.toFixed(4)}, SL at ${signal.slPrice.toFixed(4)}`;
        confidence = "high";
      } else {
        actionSuggestion = "Watch for volume continuation before entry.";
        confidence = "medium";
      }
      break;

    case "DISTRIBUTION":
      summary = `${signal.symbol} showing distribution at ${priceLocation} with ${volumeDesc}`;
      interpretation = `Signs of distribution detected. ${oiDesc} with ${rsiDesc}. Smart money may be exiting.`;
      actionSuggestion =
        "Consider reducing exposure or SHORT setup if breakdown confirmed.";
      confidence = "medium";
      break;

    case "BREAKOUT":
      summary = `${signal.symbol} BREAKOUT with ${volumeDesc} and ${oiDesc}`;
      interpretation = `Explosive momentum confirmed. ${volumeDesc} with OI surge confirms institutional participation. ${fundingBias === "bearish" ? "Negative funding supports continuation." : ""}`;
      if (signal.side === "LONG" && preSpikeScore >= 4) {
        actionSuggestion = `Enter on confirmation, ride momentum with trailing stop at ${signal.slPrice.toFixed(4)}`;
        confidence = "high";
      } else {
        actionSuggestion = "Enter on confirmation, use trailing stop to ride momentum";
        confidence = "high";
      }
      break;

    case "TREND":
      summary = `${signal.symbol} in sustained TREND with ${volumeDesc}`;
      interpretation = `Multi-timeframe alignment confirmed. ${oiDesc} supports continuation. ${rsiDesc} in momentum zone.`;
      if (preSpikeScore >= 3) {
        actionSuggestion = `Trade with trend, add on pullbacks. Entry near ${signal.entryPrice.toFixed(4)}`;
        confidence = "high";
      } else {
        actionSuggestion = "Trade with trend, add on pullbacks to support levels";
        confidence = "medium";
      }
      break;

    case "EXHAUST":
      summary = `${signal.symbol} showing EXHAUST signals - reversal imminent`;
      interpretation = `Momentum exhaustion detected. ${volumeDesc} declining from peak with ${rsiDesc} at extreme. ${lsrBias === "long_dominant" ? "Crowded positioning adds reversal risk." : ""}`;
      actionSuggestion =
        "AVOID new entries. Tighten stops on existing positions. Expect reversal.";
      confidence = "medium";
      break;

    default:
      summary = `${signal.symbol} at ${priceLocation} with ${volumeDesc}`;
      interpretation = `Mixed signals. ${rsiDesc}, ${oiDesc}. Wait for clearer setup.`;
      actionSuggestion = "Monitor for phase clarity before action.";
      confidence = "low";
  }

  // Boost confidence if multiple factors align
  if (
    preSpikeScore >= 4 &&
    priceLocation === "DISCOUNT" &&
    (marketPhase === "ACCUMULATION" || marketPhase === "BREAKOUT")
  ) {
    confidence = "high";
  }

  return { summary, interpretation, confidence, actionSuggestion };
}

function estimateFVGLevels(
  currentPrice: number,
  high24h: number,
  low24h: number,
  priceChange: number,
): { price: number; type: "bullish" | "bearish"; strength: number }[] {
  const levels: {
    price: number;
    type: "bullish" | "bearish";
    strength: number;
  }[] = [];
  const range = high24h - low24h;

  if (range <= 0) return levels;

  // Estimate FVG zones based on price action
  // Bullish FVGs form on strong up moves - gaps below current price
  if (priceChange > 2) {
    const fvgZone = currentPrice - range * 0.1;
    levels.push({
      price: fvgZone,
      type: "bullish",
      strength: Math.min(1, priceChange / 10),
    });
  }

  // Bearish FVGs form on strong down moves - gaps above current price
  if (priceChange < -2) {
    const fvgZone = currentPrice + range * 0.1;
    levels.push({
      price: fvgZone,
      type: "bearish",
      strength: Math.min(1, Math.abs(priceChange) / 10),
    });
  }

  // Near the 24h low often has bullish FVG
  if (currentPrice < low24h + range * 0.3) {
    levels.push({
      price: low24h + range * 0.05,
      type: "bullish",
      strength: 0.7,
    });
  }

  return levels;
}

function estimateOBLevels(
  currentPrice: number,
  high24h: number,
  low24h: number,
  supportWalls: { price: number; amount: number }[],
  resistanceWalls: { price: number; amount: number }[],
): { price: number; type: "bullish" | "bearish"; strength: number }[] {
  const levels: {
    price: number;
    type: "bullish" | "bearish";
    strength: number;
  }[] = [];

  // Use orderbook walls as proxy for order blocks
  if (supportWalls.length > 0) {
    const strongest = supportWalls[0];
    levels.push({
      price: strongest.price,
      type: "bullish",
      strength: Math.min(1, strongest.amount / 5000000),
    });
  }

  if (resistanceWalls.length > 0) {
    const strongest = resistanceWalls[0];
    levels.push({
      price: strongest.price,
      type: "bearish",
      strength: Math.min(1, strongest.amount / 5000000),
    });
  }

  // Add levels at key price zones
  const range = high24h - low24h;
  if (range > 0) {
    levels.push({
      price: low24h + range * 0.382,
      type: "bullish",
      strength: 0.5,
    });
    levels.push({
      price: low24h + range * 0.618,
      type: "bearish",
      strength: 0.5,
    });
  }

  return levels;
}

// Calculate Volume Profile POC (Point of Control) from Klines
// POC is the price level where the most volume was traded
function calculateVolumeProfilePOC(klines: { high: string; low: string; close: string; volume?: string }[]): number | undefined {
  if (klines.length < 10) return undefined;
  
  // Create price bins and aggregate volume
  const priceVolume: Map<number, number> = new Map();
  
  // Determine price range
  const prices = klines.map(k => parseFloat(k.close));
  const highs = klines.map(k => parseFloat(k.high));
  const lows = klines.map(k => parseFloat(k.low));
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const range = maxPrice - minPrice;
  
  if (range === 0) return undefined;
  
  // Create bins (20 bins across the range)
  const numBins = 20;
  const binSize = range / numBins;
  
  // Aggregate volume into bins using typical price (H+L+C)/3
  for (const k of klines) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const close = parseFloat(k.close);
    const volume = k.volume ? parseFloat(k.volume) : 1;
    const typicalPrice = (high + low + close) / 3;
    
    // Find bin for this candle
    const binIndex = Math.floor((typicalPrice - minPrice) / binSize);
    const binPrice = minPrice + (binIndex + 0.5) * binSize; // Midpoint of bin
    
    priceVolume.set(binPrice, (priceVolume.get(binPrice) || 0) + volume);
  }
  
  // Find POC (price with highest volume)
  let pocPrice = 0;
  let maxVolume = 0;
  priceVolume.forEach((volume, price) => {
    if (volume > maxVolume) {
      maxVolume = volume;
      pocPrice = price;
    }
  });
  
  return pocPrice > 0 ? pocPrice : undefined;
}

// Helper function to fetch Binance Klines
// Helper function to fetch Bitunix Klines
async function getBitunixKlines(
  symbol: string,
  interval: string,
  limit: number = 100,
) {
  try {
    const bitunixService = new BitunixTradeService();
    const klines = await bitunixService.getKlines(
      symbol + "USDT",
      interval,
      limit,
    );
    return klines;
  } catch (error) {
    console.log(`[ENRICHMENT] Bitunix kline fetch failed for ${symbol}`);
    return [];
  }
}

export async function enrichSignalWithCoinglass(
  signal: Signal,
  high24h: number,
  low24h: number,
): Promise<EnrichedSignalData> {
  const symbol = signal.symbol.replace("USDT", "");

  // PRIORITY 1: Use OKX as primary data source (works from Replit, no geo-restrictions)
  let okxData: { fundingRate: number | null; klines4H: SimpleKline[]; klines1H: SimpleKline[]; openInterest: number | null; longShortRatio: number | null; source: string } | null = null;
  let klines4H: SimpleKline[] = [];
  let klines1H: SimpleKline[] = [];
  
  try {
    const rawOkxData = await getOKXMarketData(symbol);
    
    klines4H = rawOkxData.klines4H.map(k => ({
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      openTime: k.ts,
      closeTime: k.ts + 14400000
    }));
    
    klines1H = rawOkxData.klines1H.map(k => ({
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      openTime: k.ts,
      closeTime: k.ts + 3600000
    }));
    
    okxData = {
      fundingRate: rawOkxData.fundingRate,
      klines4H,
      klines1H,
      openInterest: rawOkxData.openInterest,
      longShortRatio: rawOkxData.longShortRatio,
      source: rawOkxData.source
    };
    
    console.log(`[ENRICHMENT] ${symbol} - OKX data: FR=${okxData.fundingRate !== null ? (okxData.fundingRate * 100).toFixed(4) + '%' : 'N/A'}, L/S=${okxData.longShortRatio ?? 'N/A'}, 4H=${klines4H.length}, 1H=${klines1H.length}`);
  } catch (error) {
    console.log(`[ENRICHMENT] OKX API failed for ${symbol}:`, error);
  }

  // PRIORITY 2: Use Coinglass as fallback (paid plan - may fail)
  let enhancedData: EnhancedMarketData | null = null;
  let liquidationMap: LiquidationMapData[] = [];

  try {
    [enhancedData, liquidationMap] = await Promise.all([
      getEnhancedMarketData(symbol).catch(() => null),
      getLiquidationMap(symbol).catch(() => []),
    ]);
  } catch (error) {
    // Coinglass may fail due to rate limits or paid plan requirements
  }

  // Calculate price location from 1H klines, with fallback estimation
  let priceLocation: PriceLocation = "NEUTRAL";
  if (klines1H.length > 0) {
    const ictResult = bitunixTradeService.getICTLocation(klines1H as any);
    priceLocation = ictResult.location.toUpperCase() as PriceLocation;
  } else if (klines4H.length > 0) {
    // Fallback: use 4H klines to estimate price location
    const closes4H = klines4H.map(k => parseFloat(k.close));
    const highs4H = klines4H.map(k => parseFloat(k.high));
    const lows4H = klines4H.map(k => parseFloat(k.low));
    const currentPrice = closes4H[closes4H.length - 1];
    const high24h = Math.max(...highs4H.slice(-6)); // ~24h with 4H candles
    const low24h = Math.min(...lows4H.slice(-6));
    priceLocation = calculatePriceLocation(currentPrice, high24h, low24h);
  } else {
    // Final fallback: estimate from price change and RSI
    const priceChange = signal.priceChange24h || 0;
    const rsi = signal.rsi || 50;
    
    // Positive price change + high RSI = likely at premium
    if (priceChange > 3 && rsi > 60) {
      priceLocation = "PREMIUM";
    }
    // Negative price change + low RSI = likely at discount
    else if (priceChange < -3 && rsi < 40) {
      priceLocation = "DISCOUNT";
    }
    // Extreme positive = premium
    else if (priceChange > 5) {
      priceLocation = "PREMIUM";
    }
    // Extreme negative = discount
    else if (priceChange < -5) {
      priceLocation = "DISCOUNT";
    }
    // Default to neutral
    else {
      priceLocation = "NEUTRAL";
    }
  }
    
  // Extract funding rate and L/S data - OKX IS PRIMARY (works from Replit)
  let fundingRate: number | undefined = undefined;
  let fundingBias: "bullish" | "bearish" | "neutral" | undefined = undefined;
  let longShortRatio: number | undefined = undefined;
  let lsrBias: "long_dominant" | "short_dominant" | "balanced" | undefined = undefined;
  
  // OKX FIRST (works from Replit, no geo-restrictions)
  if (okxData && okxData.fundingRate !== null) {
    fundingRate = okxData.fundingRate;
    fundingBias = fundingRate < -0.0001 ? "bullish" : fundingRate > 0.0003 ? "bearish" : "neutral";
    console.log(`[ENRICHMENT] ${symbol} - FR: ${(fundingRate * 100).toFixed(4)}% (${fundingBias})`);
  } else if (enhancedData?.fundingBasisAnalysis?.averageFundingRate !== undefined) {
    fundingRate = enhancedData.fundingBasisAnalysis.averageFundingRate;
    fundingBias = enhancedData.fundingBasisAnalysis.fundingBias;
  }
  
  // L/S Ratio: OKX FIRST
  if (okxData && okxData.longShortRatio !== null) {
    longShortRatio = okxData.longShortRatio;
    lsrBias = longShortRatio > 1.1 ? "long_dominant" : longShortRatio < 0.9 ? "short_dominant" : "balanced";
    console.log(`[ENRICHMENT] ${symbol} - L/S: ${longShortRatio.toFixed(2)} (${lsrBias})`);
  } else if (enhancedData?.positioningAnalysis?.longShortRatio !== undefined) {
    longShortRatio = enhancedData.positioningAnalysis.longShortRatio;
    lsrBias = enhancedData.positioningAnalysis.trend;
  }
  
  // Calculate Volume Profile POC (Point of Control) from 4H klines
  let volumeProfilePOC: number | undefined = undefined;
  if (klines4H.length >= 20) {
    volumeProfilePOC = calculateVolumeProfilePOC(klines4H);
    console.log(`[ENRICHMENT] ${symbol} - POC: $${volumeProfilePOC?.toFixed(4)}`);
  }

  // Calculate market phase using SMC + Order Flow logic with funding rate and L/S ratio
  const marketPhase = calculateMarketPhase(
    signal.volumeSpikeRatio || 1,
    signal.oiChange24h,
    signal.rsi || 50,
    signal.priceChange24h || 0,
    signal.volAccel,
    priceLocation,
    fundingRate,
    longShortRatio,
  );

  // Detect FVG and Order Blocks from 1H klines FIRST (before using in preSpikeScore)
  const fvgs1H = klines1H.length > 0 ? bitunixTradeService.detectFVG(klines1H as any) : [];
  const obs1H = klines1H.length > 0 ? bitunixTradeService.detectOrderBlocks(klines1H as any) : [];
  
  // Calculate pre-spike score using FVG/OB and ICT analysis (0-5 scale)
  let preSpikeScore = 0;

  // FVG presence (0-1 points)
  if (fvgs1H.length > 0) {
    const unfilledFVGs = fvgs1H.filter((f) => !f.filled);
    if (unfilledFVGs.length >= 2) preSpikeScore += 1;
    else if (unfilledFVGs.length === 1) preSpikeScore += 0.5;
  }

  // Order Block presence (0-1 points)
  if (obs1H.length > 0) {
    if (obs1H.length >= 2) preSpikeScore += 1;
    else preSpikeScore += 0.5;
  }

  // ICT Location (0-1 points) - discount zone favored for longs
  if (priceLocation === "DISCOUNT") preSpikeScore += 1;
  else if (priceLocation === "NEUTRAL") preSpikeScore += 0.5;

  // Volume spike (0-1 points)
  if (signal.volumeSpikeRatio && signal.volumeSpikeRatio >= 3)
    preSpikeScore += 1;
  else if (signal.volumeSpikeRatio && signal.volumeSpikeRatio >= 2)
    preSpikeScore += 0.5;

  // Signal strength from original screener (0-1 points)
  if (signal.signalStrength && signal.signalStrength >= 4) preSpikeScore += 1;
  else if (signal.signalStrength && signal.signalStrength >= 3)
    preSpikeScore += 0.5;

  preSpikeScore = Math.min(5, Math.round(preSpikeScore * 10) / 10);

  // Calculate liquidation zones
  const liquidationZones = calculateLiquidationZones(
    signal.currentPrice,
    liquidationMap,
  );

  // Extract FVG and OB levels for display
  const fvgLevels = fvgs1H.slice(-5).map((fvg) => ({
    price: (fvg.top + fvg.bottom) / 2,
    type: fvg.type,
    strength: 0.7,
  }));

  const obLevels = obs1H.slice(-5).map((ob) => ({
    price: (ob.high + ob.low) / 2,
    type: ob.type,
    strength: 0.8,
  }));

  // Generate storytelling
  const storytelling = generateStorytelling(
    signal,
    marketPhase,
    priceLocation,
    preSpikeScore,
    fundingBias,
    lsrBias,
  );

  // Analyze latest candlestick for entry model refinement
  let candleAnalysis: CandlestickAnalysis | undefined = undefined;
  if (klines1H.length > 0) {
    candleAnalysis = analyzeCandlestick(klines1H[klines1H.length - 1]);
  } else if (klines4H.length > 0) {
    candleAnalysis = analyzeCandlestick(klines4H[klines4H.length - 1]);
  }
  
  // Calculate entry model based on phase, RSI, candlestick, and FVG levels
  const entryModel = calculateEntryModel(
    marketPhase,
    signal.rsi || 50,
    priceLocation,
    candleAnalysis,
    fvgLevels,
  );

  // Calculate HTF bias using Supertrend (4H) + Funding Rate
  const htfBias = calculateHtfBias(klines4H as any, fundingRate, signal.symbol);

  // Get symbol listing age
  let ageDays: number | undefined = undefined;
  try {
    const listingTimestamp = await getSymbolListingDate(signal.symbol);
    if (listingTimestamp) {
      ageDays = calculateAgeDays(listingTimestamp);
      console.log(`[ENRICHMENT] ${signal.symbol}: ageDays=${ageDays}`);
    }
  } catch (error) {
    console.log(`[ENRICHMENT] ${signal.symbol}: ageDays error -`, (error as Error).message);
  }

  return {
    priceLocation,
    marketPhase,
    entryModel,
    preSpikeScore,
    fundingRate,
    fundingBias,
    longShortRatio,
    lsrBias,
    htfBias,
    fvgLevels,
    obLevels,
    liquidationZones,
    volumeProfilePOC,
    storytelling,
    ageDays,
  };
}

export interface ScreenerFilters {
  minPScore?: number;
  hideExhaust?: boolean;
  phaseFilter?: MarketPhase | "ALL";
  minSignalStrength?: number;
  sideFilter?: "LONG" | "SHORT" | "ALL";
}

export function applyScreenerFilters(
  signals: Signal[],
  filters: ScreenerFilters,
): Signal[] {
  return signals.filter((signal) => {
    // Filter by pre-spike score
    if (
      filters.minPScore !== undefined &&
      (signal.preSpikeScore ?? 0) < filters.minPScore
    ) {
      return false;
    }

    // Hide EXHAUST phase
    if (filters.hideExhaust && signal.marketPhase === "EXHAUST") {
      return false;
    }

    // Filter by specific phase
    if (
      filters.phaseFilter &&
      filters.phaseFilter !== "ALL" &&
      signal.marketPhase !== filters.phaseFilter
    ) {
      return false;
    }

    // Filter by signal strength
    if (
      filters.minSignalStrength !== undefined &&
      signal.signalStrength < filters.minSignalStrength
    ) {
      return false;
    }

    // Filter by side
    if (
      filters.sideFilter &&
      filters.sideFilter !== "ALL" &&
      signal.side !== filters.sideFilter
    ) {
      return false;
    }

    return true;
  });
}

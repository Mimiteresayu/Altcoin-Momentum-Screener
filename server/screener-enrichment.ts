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
import { getBinanceFuturesData, getBinanceKlines } from "./binance";
import { getOKXMarketData, getOKXFundingRate, getOKXKlines } from "./okx";

type PriceLocation = "DISCOUNT" | "NEUTRAL" | "PREMIUM";
type MarketPhase = "ACCUMULATION" | "MANIPULATION" | "DISTRIBUTION" | "EXPANSION" | "RANGING";
type Confidence = "high" | "medium" | "low";

type HtfBias = {
  side: "LONG" | "SHORT";
  confidence: "high" | "medium" | "low";
  supertrendBias: "LONG" | "SHORT";
  fundingConfirms: boolean;
  supertrendValue: number;
};

interface EnrichedSignalData {
  priceLocation: PriceLocation;
  marketPhase: MarketPhase;
  marketPhaseAlt: MarketPhase; // Alternative phase detection using RSI/OI method
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
 * SMC + Order Flow Market Phase Detection
 * Uses Smart Money Concepts with Order Flow analysis:
 * 
 * ACCUMULATION: Smart money quietly building long positions at discount
 * MANIPULATION: Stop hunts, fake breakouts - extreme moves to trap traders
 * DISTRIBUTION: Smart money selling into strength at premium
 * EXPANSION: Clear directional momentum move with volume/OI confirmation
 * RANGING: Sideways consolidation with no clear direction
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
  const frPct = fr * 100;
  const lsr = longShortRatio ?? 1.0;

  // ===== 1. MANIPULATION: Stop hunts and fake breakouts (check first - highest priority) =====
  // OI spike >5% + volume >2x + price >8% + RSI <25 or >75
  // Extreme moves designed to trap traders before reversal
  
  if (oiDelta > 5 && volumeSpike > 2 && Math.abs(priceChange) > 8) {
    if (hasValidRsi && (rsi < 25 || rsi > 75)) {
      return "MANIPULATION";
    }
  }
  
  // Strong spike characteristics even without extreme RSI
  if (oiDelta > 5 && volumeSpike > 2.5 && Math.abs(priceChange) > 10) {
    return "MANIPULATION";
  }
  
  // Extreme RSI with massive volume = likely manipulation
  if (hasValidRsi && (rsi < 20 || rsi > 80) && volumeSpike > 2.5) {
    return "MANIPULATION";
  }

  // ===== 2. EXPANSION: Clear directional momentum =====
  // OI >5% + volume >1.5x + price >5% + RSI 50-70
  // Real breakout with institutional participation
  
  if (oiDelta > 5 && volumeSpike > 1.5 && Math.abs(priceChange) > 5) {
    if (hasValidRsi && rsi >= 50 && rsi <= 70) {
      return "EXPANSION";
    }
  }
  
  // Strong OI + volume confirmation for expansion
  if (oiDelta > 5 && volumeSpike > 1.5 && priceChange > 5) {
    return "EXPANSION";
  }
  
  // Moderate move with strong confirmation
  if (oiDelta > 3 && volumeSpike > 1.5 && priceChange > 5 && hasValidRsi && rsi >= 45 && rsi <= 75) {
    return "EXPANSION";
  }

  // ===== 3. DISTRIBUTION: Smart money selling into strength =====
  // PREMIUM + OI flat/down + volume <0.8x declining + FR >0.01% + RSI 70-85 + L/S >1.2
  
  // Full criteria match
  if (priceLocation === "PREMIUM" && 
      oiDelta <= 0 && 
      volumeSpike < 0.8 && 
      frPct > 0.01 && 
      hasValidRsi && rsi >= 70 && rsi <= 85 && 
      lsr > 1.2) {
    return "DISTRIBUTION";
  }
  
  // Strong distribution signals (relaxed L/S requirement)
  if (priceLocation === "PREMIUM" && oiDelta <= 0 && volumeSpike < 0.8 && frPct > 0.01) {
    return "DISTRIBUTION";
  }
  
  // Premium location with overbought RSI and declining OI
  if (priceLocation === "PREMIUM" && hasValidRsi && rsi >= 70 && rsi <= 85 && oiDelta < 0) {
    return "DISTRIBUTION";
  }
  
  // Crowded long with declining volume at premium
  if (priceLocation === "PREMIUM" && lsr > 1.2 && volumeSpike < 0.8 && frPct > 0.01) {
    return "DISTRIBUTION";
  }
  
  // High funding at premium = overleveraged longs distributing
  if (priceLocation === "PREMIUM" && frPct > 0.015) {
    return "DISTRIBUTION";
  }

  // ===== 4. ACCUMULATION: Smart money building positions at discount =====
  // DISCOUNT + OI >2% + volume 0.5-1.2x + FR <0.005% + RSI 30-50 + price -5% to +3% + L/S <1.0
  
  // Full criteria match
  if (priceLocation === "DISCOUNT" && 
      oiDelta > 2 && 
      volumeSpike >= 0.5 && volumeSpike <= 1.2 && 
      frPct < 0.005 && 
      hasValidRsi && rsi >= 30 && rsi <= 50 && 
      priceChange >= -5 && priceChange <= 3 && 
      lsr < 1.0) {
    return "ACCUMULATION";
  }
  
  // Strong accumulation signals (relaxed criteria)
  if (priceLocation === "DISCOUNT" && 
      oiDelta > 2 && 
      volumeSpike >= 0.5 && volumeSpike <= 1.2 && 
      frPct < 0.005) {
    return "ACCUMULATION";
  }
  
  // Discount with OI building and low funding
  if (priceLocation === "DISCOUNT" && oiDelta > 2 && frPct < 0.005) {
    return "ACCUMULATION";
  }
  
  // RSI in accumulation zone at discount with shorts dominant
  if (priceLocation === "DISCOUNT" && hasValidRsi && rsi >= 30 && rsi <= 50 && lsr < 1.0) {
    return "ACCUMULATION";
  }
  
  // Discount location with quiet OI building
  if (priceLocation === "DISCOUNT" && oiDelta > 0 && volumeSpike >= 0.5 && volumeSpike <= 1.5) {
    return "ACCUMULATION";
  }

  // ===== 5. RANGING: Sideways consolidation =====
  // NEUTRAL + OI -2% to +2% + volume <0.8x + FR 0.005-0.01% + RSI 40-60 + price -3% to +3%
  
  // Full criteria match
  if (priceLocation === "NEUTRAL" && 
      oiDelta >= -2 && oiDelta <= 2 && 
      volumeSpike < 0.8 && 
      frPct >= 0.005 && frPct <= 0.01 && 
      hasValidRsi && rsi >= 40 && rsi <= 60 && 
      priceChange >= -3 && priceChange <= 3) {
    return "RANGING";
  }
  
  // Neutral location with flat OI and low volume
  if (priceLocation === "NEUTRAL" && 
      oiDelta >= -2 && oiDelta <= 2 && 
      volumeSpike < 0.8) {
    return "RANGING";
  }
  
  // Tight price range with balanced RSI
  if (priceChange >= -3 && priceChange <= 3 && 
      hasValidRsi && rsi >= 40 && rsi <= 60 && 
      volumeSpike < 0.8) {
    return "RANGING";
  }
  
  // Default to RANGING when no clear pattern matches
  return "RANGING";
}

/**
 * Alternative Market Phase Detection using OI + Price Change correlation
 * Provides a complementary perspective based on position dynamics:
 * - OI up + Price up = BREAKOUT (long positions opening, bullish momentum)
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
    
    // OI up + Price up = EXPANSION (long positions opening, bullish momentum)
    if (oiUp && priceUp) {
      // Strong confirmation: high volume adds conviction
      if (volumeSpike >= 1.5) {
        return "EXPANSION";
      }
      return "EXPANSION";
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
    
    // OI down + Price down = MANIPULATION (longs closing, potential stop hunt/capitulation)
    // Positions being liquidated = potential manipulation before reversal
    if (oiDown && priceDown) {
      return "MANIPULATION";
    }
    
    // Moderate OI changes - use secondary indicators
    if (Math.abs(oiDelta) <= 2 && Math.abs(priceChange) <= 2) {
      // Consolidation with neutral OI/price = RANGING
      if (hasValidRsi && rsi >= 40 && rsi <= 60) {
        return "RANGING";
      }
      // Slight OI increase with flat price = quiet accumulation
      if (oiDelta > 0 && volumeSpike >= 0.8) {
        return "ACCUMULATION";
      }
    }
  }
  
  // Fallback: Use RSI + Volume when OI data unavailable
  if (hasValidRsi) {
    // Extreme RSI = manipulation (stop hunt zone)
    if (rsi > 80 || rsi < 20) {
      return "MANIPULATION";
    }
    
    // RSI momentum with price confirmation = expansion
    if (rsi > 55 && rsi <= 75 && priceChange > 3 && volumeSpike >= 1.2) {
      return "EXPANSION";
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
  if (priceChange > 5 && volumeSpike >= 1.5) return "EXPANSION";
  if (priceChange < -5 && volumeSpike < 0.8) return "MANIPULATION";
  if (priceLocation === "DISCOUNT" && volumeSpike >= 1.0) return "ACCUMULATION";
  if (priceLocation === "PREMIUM" && volumeSpike < 0.9) return "DISTRIBUTION";
  
  return "RANGING";
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
  const oi = oiChange ?? 0;
  if (oi >= 15) score += 1;
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

    case "EXPANSION":
      summary = `${signal.symbol} EXPANSION with ${volumeDesc} and ${oiDesc}`;
      interpretation = `Strong momentum expansion. ${volumeDesc} confirms institutional participation. ${fundingBias === "bearish" ? "Negative funding supports continuation." : ""}`;
      if (signal.side === "LONG" && preSpikeScore >= 4) {
        actionSuggestion = `LONG on pullback to ${signal.entryPrice.toFixed(4)} or momentum continuation`;
        confidence = "high";
      } else {
        actionSuggestion = "Wait for pullback entry to reduce risk";
        confidence = "medium";
      }
      break;

    case "MANIPULATION":
      summary = `${signal.symbol} showing MANIPULATION signals - potential stop hunt`;
      interpretation = `Possible stop hunt or fake breakout detected. ${volumeDesc} with extreme ${rsiDesc}. ${lsrBias === "long_dominant" ? "Crowded positioning adds reversal risk." : ""}`;
      actionSuggestion =
        "Avoid chasing. Wait for reversal confirmation before counter-trend entry.";
      confidence = "medium";
      break;

    case "RANGING":
      summary = `${signal.symbol} in RANGING phase at ${priceLocation}`;
      interpretation = `Sideways consolidation. ${rsiDesc}, ${oiDesc}. Wait for breakout or range trade.`;
      actionSuggestion = "Trade range boundaries or wait for directional move.";
      confidence = "low";
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
    (marketPhase === "ACCUMULATION" || marketPhase === "EXPANSION")
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

  // Calculate alternative phase detection using OI + Price correlation method
  const marketPhaseAlt = calculateMarketPhaseAlt(
    signal.rsi || 50,
    signal.priceChange24h || 0,
    signal.volumeSpikeRatio || 1,
    priceLocation,
    signal.oiChange24h,
  );

  // Calculate HTF bias using Supertrend (4H) + Funding Rate
  const htfBias = calculateHtfBias(klines4H as any, fundingRate, signal.symbol);

  return {
    priceLocation,
    marketPhase,
    marketPhaseAlt,
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

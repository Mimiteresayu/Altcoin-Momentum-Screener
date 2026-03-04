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
    efficiencyRatio: number | undefined; // ER: net price change / sum of absolute changes (0-1, higher = trending)
  volatilitySpread: number | undefined; // VSpread: normalized ATR-SD spread (volatility clustering detector)
  channelRange: number | undefined; // CRange: normalized position in price channel (-1 to 1, >0.8 = breakout zone)
    permutationEntropy: number | undefined; // PE: permutation entropy from 4H klines
  erZScore: number | undefined; // Z-score of Efficiency Ratio
  vsZScore: number | undefined; // Z-score of Volatility Spread
  peZScore: number | undefined; // Z-score of Permutation Entropy
    aurVelocity: number | undefined; // AUR slope/velocity
  aurRising: boolean | undefined; // Whether AUR is rising
  preSpikeCombo: {
    comboScore: number;
    aurCondition: boolean;
    erCondition: boolean;
    vsCondition: boolean;
    peCondition: boolean;
  };
  // NEW: Intraday spike detection signals
  spikeScore: number; // New composite score 0-10
  rvol: number | undefined; // Relative Volume ratio
  rvolZScore: number | undefined; // RVOL z-score
  squeezeState: SqueezeState | undefined; // BB/KC squeeze state
  squeezeBars: number | undefined; // Consecutive bars in squeeze
  oiSurgeZScore: number | undefined; // OI surge z-score
  oiDirection: "RISING" | "FALLING" | "FLAT" | undefined;
  fundingSignal: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL" | undefined;
  atrExpanding: boolean | undefined; // ATR expansion confirmation
  atrRatio: number | undefined; // Current ATR / avg ATR
  // NEW: Spike probability engine output
  spikeProbability: SpikeProbability | undefined;
}

/**
 * SpikeProbability — output of the logistic sigmoid spike probability engine.
 * Answers: "What is the instantaneous probability of a spike in the next 15 minutes?"
 */
export interface SpikeProbability {
  probability: number;          // 0.0-1.0, P(spike in next 15min)
  confidence: "HIGH" | "MEDIUM" | "LOW"; // Based on signal agreement + data quality
  expectedMagnitude: number;    // Expected spike % if it occurs (2-20%)
  timeDecay: number;            // 0.0-1.0, how fresh signals are (1.0 = just happened)
  dominantDriver: string;       // Which signal is contributing most
  signalAgreement: number;      // 0.0-1.0, fraction of signals that agree (confluence)
  spikeScore: number;           // Backward-compatible 0-10 score
  vwapConfirmation: "BULLISH" | "BEARISH" | "NEUTRAL"; // Price vs VWAP
  koreaListingAlpha: boolean;   // True if new Korean exchange listing detected
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
  
  // Price stalling with extreme overbought RSI only (oversold goes to ACCUMULATION)
  if (hasValidRsi && Math.abs(priceChange) < 2) {
    if (rsi > 75) {
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
  
  // Low RSI = accumulation (even without OI data)
  if (hasValidRsi && rsi < 40 && oiDelta >= 0) {
    return "ACCUMULATION";
  }

  // Flat price with low volume at discount/neutral = quiet accumulation (no OI required)
  if (Math.abs(priceChange) < 3 && volumeSpike < 1.5 && hasValidRsi && rsi >= 35 && rsi <= 55) {
    if (priceLocation === "DISCOUNT" || priceLocation === "NEUTRAL") {
      return "ACCUMULATION";
    }
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
  aurData?: { aur: number; aurZScore: number; isBuyConcentrated: boolean; aurTrend: number[]; aurRising: boolean; aurSlope: number },
): number {
  let score = 0;

  // ═══════════════════════════════════════════════════════════════
  // DIMENSION 1: Volume / Supply-Demand (0-1.5 pts)
  // Research: RVOL is #1 leading indicator (Granger p<0.001)
  // Optimal pre-spike range: 2-5x (not 8x+ which is during/post-spike)
  // ═══════════════════════════════════════════════════════════════
  if (volumeSpike >= 2.0 && volumeSpike < 5.0) score += 1.5;      // Sweet spot: accumulation range
  else if (volumeSpike >= 5.0 && volumeSpike < 8.0) score += 1.0; // Getting hot, still pre-spike
  else if (volumeSpike >= 1.5) score += 0.75;                      // Early accumulation
  else if (volumeSpike >= 8.0) score += 0.5;                       // Already spiking (less pre-spike value)

  // Volume acceleration (current vs 4H average) — catches the ignition
  const accel = volAccel ?? 1;
  if (accel >= 2.0 && accel < 5.0) score += 0.5;  // Accelerating
  else if (accel >= 5.0) score += 0.25;             // Already accelerated

  // ═══════════════════════════════════════════════════════════════
  // DIMENSION 2: Derivatives Flow (0-1.0 pts)
  // Research: Funding rate alone = zero predictive power (p>0.23)
  // BUT: Negative funding + other signals = contrarian squeeze fuel
  // Research: Falling OI at breakout = BETTER (57.1% vs 50.6%)
  // ═══════════════════════════════════════════════════════════════
  // OI: Research says FALLING OI = better breakout quality
  const oi = oiChange ?? 0;
  if (oi < -5) score += 0.5;           // Falling OI = clean slate, strongest
  else if (oi >= -5 && oi <= 5) score += 0.25;  // Flat OI = neutral
  // Rising OI gets 0 points (research: worse breakout quality)

  // Funding rate: Only valuable as contrarian signal (shorts overcrowded)
  // Research: Extreme negative FR → +1.82% avg 24h return
  if (fundingRate !== undefined && fundingRate < -0.0005) score += 0.5;  // Deeply negative = squeeze fuel
  else if (fundingRate !== undefined && fundingRate < -0.0001) score += 0.25;

  // ═══════════════════════════════════════════════════════════════
  // DIMENSION 3: RSI / Momentum context (0-0.5 pts)
  // Research: Pre-spike optimal RSI is 40-60 (not yet overbought)
  // ═══════════════════════════════════════════════════════════════
  if (rsi >= 40 && rsi <= 60) score += 0.5;        // Optimal pre-spike zone
  else if (rsi >= 35 && rsi <= 70) score += 0.25;  // Acceptable range

  // Risk/Reward quality
  if (riskReward >= 3) score += 0.25;
  else if (riskReward >= 2) score += 0.15;

  // Signal strength boost
  if (signalStrength >= 4) score += 0.25;

  // Long/Short ratio: Low ratio = fewer longs = contrarian bullish setup
  if (longShortRatio !== undefined && longShortRatio < 0.8) score += 0.25;
  else if (longShortRatio !== undefined && longShortRatio < 0.95) score += 0.1;

  // ═══════════════════════════════════════════════════════════════
  // DIMENSION 4: AUR Pre-Spike Detection (0-1.5 pts)
  // Detects stealth accumulation: buying concentration rising but not extreme
  // Mind Map: AUR slope > 0 & Z < 1.5 (rising but pre-spike, not during)
  // ═══════════════════════════════════════════════════════════════
  if (aurData) {
    // Rising AUR trend = smart money accumulating
    if (aurData.aurRising && aurData.aur > 0.5) {
      score += 1.0;
    } else if (aurData.aurRising) {
      score += 0.5;
    }
    // Positive slope bonus — buying acceleration
    if (aurData.aurSlope > 0.05) {
      score += 0.25;
    }
    // Moderate Z-score (0.5-1.5) = building but not spiked
    // Research: Z > 1.5 means already in spike territory
    if (aurData.aurZScore > 0.5 && aurData.aurZScore < 1.5) {
      score += 0.25;
    }
  }

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
    // Contrarian confirmation: negative funding + LONG = shorts paying = bullish
    if (supertrendBias === "LONG" && fundingRate < -0.0001) {
      fundingConfirms = true;
      confidence = "high";
    } else if (supertrendBias === "SHORT" && fundingRate > 0.0001) {
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
): Promise<SimpleKline[]> {
  try {
    // Use PUBLIC Bitunix futures market kline API (no auth required)
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      console.log(`[ENRICHMENT] Bitunix public kline failed for ${symbol}: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
      return data.data.map((k: any) => ({
        open: String(k[1] ?? k.open ?? '0'),
        high: String(k[2] ?? k.high ?? '0'),
        low: String(k[3] ?? k.low ?? '0'),
        close: String(k[4] ?? k.close ?? '0'),
        volume: String(k[5] ?? k.volume ?? '0'),
        openTime: parseInt(k[0] ?? k.time ?? '0'),
        closeTime: parseInt(k[6] ?? k[0] ?? '0') + (interval === '4h' ? 14400000 : interval === '1h' ? 3600000 : 86400000),
      }));
    }
    return [];
  } catch (error) {
    console.log(`[ENRICHMENT] Bitunix kline fetch failed for ${symbol}`);
    return [];
  }
}
// ============================================
// HKPTRC Alpha Indicators
// ============================================

/**
 * Efficiency Ratio (ER) - Perry Kaufman
 * Measures trending strength: net price change / sum of absolute per-bar changes
 * Range: 0 to 1. Higher = stronger trend. Low ER = mean-reverting/choppy.
 * Pre-spike: ER rising from low values indicates trend forming.
 */
export function calculateEfficiencyRatio(
  klines: { close: string }[],
  period: number = 20
): number | undefined {
  if (klines.length < period + 1) return undefined;
  const recent = klines.slice(-period - 1);
  const closes = recent.map(k => parseFloat(k.close));
  const netChange = Math.abs(closes[closes.length - 1] - closes[0]);
  let sumAbsChanges = 0;
  for (let i = 1; i < closes.length; i++) {
    sumAbsChanges += Math.abs(closes[i] - closes[i - 1]);
  }
  if (sumAbsChanges === 0) return 0;
  return netChange / sumAbsChanges;
}

/**
 * Volatility Spread (VSpread) - SD vs ATR spread
 * Measures volatility clustering. When SD >> ATR, price is making directional moves.
 * When SD << ATR, price is choppy. Normalized to 0-1 range.
 * Pre-spike: VSpread rising = volatility expanding directionally.
 */
export function calculateVolatilitySpread(
  klines: { high: string; low: string; close: string }[],
  period: number = 20
): number | undefined {
  if (klines.length < period + 1) return undefined;
  const recent = klines.slice(-period - 1);
  const closes = recent.map(k => parseFloat(k.close));
  // Calculate SD of returns
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const sd = Math.sqrt(variance);
  // Calculate ATR normalized by price
  let atrSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const high = parseFloat(recent[i].high);
    const low = parseFloat(recent[i].low);
    const prevClose = parseFloat(recent[i - 1].close);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr / prevClose; // Normalize by price
  }
  const atrNorm = atrSum / (recent.length - 1);
  if (atrNorm === 0) return 0;
  // VSpread = SD / ATR ratio, clamped to 0-1
  const spread = sd / atrNorm;
  return Math.min(1, Math.max(0, spread));
}

/**
 * Channel Range (CRange) - Normalized position in Donchian channel
 * Measures where price is relative to its N-period high-low channel.
 * Range: -1 to 1. Above 0.8 = breakout zone. Below -0.8 = breakdown zone.
 * Pre-spike: CRange moving toward extremes with rising ER = imminent breakout.
 */
export function calculateChannelRange(
  klines: { high: string; low: string; close: string }[],
  period: number = 20
): number | undefined {
  if (klines.length < period) return undefined;
  const recent = klines.slice(-period);
  const highs = recent.map(k => parseFloat(k.high));
  const lows = recent.map(k => parseFloat(k.low));
  const channelHigh = Math.max(...highs);
  const channelLow = Math.min(...lows);
  const channelRange = channelHigh - channelLow;
  if (channelRange === 0) return 0;
  const currentClose = parseFloat(klines[klines.length - 1].close);
  const midline = (channelHigh + channelLow) / 2;
  // Normalize to -1 to 1 range
  return (currentClose - midline) / (channelRange / 2);
}

/**
 * Permutation Entropy (PE) - Measures complexity/randomness of price series
 * Higher PE = more random/chaotic. Lower PE = more ordered/predictable.
 * Pre-spike: PE rising above mean signals transition from order to chaos (breakout imminent).
 * Uses embedding dimension m=3, delay=1.
 */
export function calculatePermutationEntropy(
  klines: { close: string }[],
  period: number = 20,
  m: number = 3
): number | undefined {
  if (klines.length < period + m) return undefined;
  const recent = klines.slice(-period - m + 1);
  const closes = recent.map(k => parseFloat(k.close));
  // Count permutation patterns
  const patternCounts: Map<string, number> = new Map();
  let totalPatterns = 0;
  for (let i = 0; i <= closes.length - m; i++) {
    const window = closes.slice(i, i + m);
    // Get rank order (permutation pattern)
    const indexed = window.map((v, idx) => ({ v, idx }));
    indexed.sort((a, b) => a.v - b.v || a.idx - b.idx);
    const pattern = indexed.map(x => x.idx).join(',');
    patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    totalPatterns++;
  }
  if (totalPatterns === 0) return 0;
  // Calculate Shannon entropy of permutation distribution
  let entropy = 0;
    for (const count of Array.from(patternCounts.values())) {
    const p = count / totalPatterns;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  // Normalize by max possible entropy (log2(m!))
  const factorial = (n: number): number => n <= 1 ? 1 : n * factorial(n - 1);
  const maxEntropy = Math.log2(factorial(m));
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

// ============================================
// Rolling History Store for Z-Score Computation
// ============================================
const HISTORY_MAX_LENGTH = 50; // Keep last 50 readings per symbol
const indicatorHistory: Map<string, {
  er: number[];
  vs: number[];
  pe: number[];
}> = new Map();

function pushIndicatorHistory(symbol: string, er: number | undefined, vs: number | undefined, pe: number | undefined) {
  if (!indicatorHistory.has(symbol)) {
    indicatorHistory.set(symbol, { er: [], vs: [], pe: [] });
  }
  const h = indicatorHistory.get(symbol)!;
  if (er !== undefined) { h.er.push(er); if (h.er.length > HISTORY_MAX_LENGTH) h.er.shift(); }
  if (vs !== undefined) { h.vs.push(vs); if (h.vs.length > HISTORY_MAX_LENGTH) h.vs.shift(); }
  if (pe !== undefined) { h.pe.push(pe); if (h.pe.length > HISTORY_MAX_LENGTH) h.pe.shift(); }
}

function calcZScore(values: number[], current: number): number | undefined {
  if (values.length < 3) return undefined; // Reduced from 5 to 3 — history seeds faster from klines
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (current - mean) / std;
}

function calcMean(values: number[]): number | undefined {
  if (values.length < 3) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTRADAY/SHORT-SWING SPIKE DETECTION SIGNALS
// ChingTrading + MEXC 31810 Study + Deep Research Synthesis
// Optimized for sub-hourly spike catching with leverage
// ═══════════════════════════════════════════════════════════════════════════

export type SqueezeState = "SQUEEZE" | "FIRING_LONG" | "FIRING_SHORT" | "NO_SQUEEZE";

/**
 * Relative Volume (RVOL) — #1 pre-spike signal per ChingTrading
 * Compares current volume bar to rolling average of N prior bars.
 * RVOL > 3x = abnormal participation = CRITICAL trigger
 * Research: Sweet spot is 2-5x (not 8x+ which is during/post-spike)
 */
export function calculateRVOL(
  klines: { volume: string }[],
  periods: number = 10
): { rvol: number; rvolZScore: number } {
  if (klines.length < periods + 1) return { rvol: 1, rvolZScore: 0 };
  
  const volumes = klines.map(k => parseFloat(k.volume));
  const currentVol = volumes[volumes.length - 1];
  const historicalVols = volumes.slice(-(periods + 1), -1);
  
  const avgVol = historicalVols.reduce((a, b) => a + b, 0) / historicalVols.length;
  if (avgVol === 0) return { rvol: 1, rvolZScore: 0 };
  
  const rvol = currentVol / avgVol;
  
  // Z-score of volume vs rolling window
  const mean = avgVol;
  const squaredDiffs = historicalVols.map(v => Math.pow(v - mean, 2));
  const stdDev = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / historicalVols.length);
  const rvolZScore = stdDev > 0 ? (currentVol - mean) / stdDev : 0;
  
  return { rvol, rvolZScore };
}

/**
 * Bollinger Band / Keltner Channel Squeeze Detection
 * When BB is INSIDE KC → squeeze (volatility compressed)
 * When BB breaks OUTSIDE KC → firing (squeeze release = explosion imminent)
 * ChingTrading: Layer 2 CORE signal, 15% weight, on 5m-15m charts
 */
export function detectBBKCSqueeze(
  klines: { high: string; low: string; close: string }[],
  bbPeriod: number = 20,
  bbMult: number = 2.0,
  kcPeriod: number = 20,
  kcMult: number = 1.5
): { state: SqueezeState; squeezeIntensity: number; squeezeBars: number } {
  if (klines.length < Math.max(bbPeriod, kcPeriod) + 1) {
    return { state: "NO_SQUEEZE", squeezeIntensity: 0, squeezeBars: 0 };
  }
  
  const closes = klines.map(k => parseFloat(k.close));
  const highs = klines.map(k => parseFloat(k.high));
  const lows = klines.map(k => parseFloat(k.low));
  
  // Calculate BB
  const bbCloses = closes.slice(-bbPeriod);
  const bbSMA = bbCloses.reduce((a, b) => a + b, 0) / bbPeriod;
  const bbStdDev = Math.sqrt(bbCloses.map(c => Math.pow(c - bbSMA, 2)).reduce((a, b) => a + b, 0) / bbPeriod);
  const bbUpper = bbSMA + bbMult * bbStdDev;
  const bbLower = bbSMA - bbMult * bbStdDev;
  
  // Calculate KC (using ATR)
  const kcCloses = closes.slice(-kcPeriod);
  const kcSMA = kcCloses.reduce((a, b) => a + b, 0) / kcPeriod;
  
  // ATR calculation
  let atrSum = 0;
  for (let i = closes.length - kcPeriod; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    atrSum += tr;
  }
  const atr = atrSum / kcPeriod;
  const kcUpper = kcSMA + kcMult * atr;
  const kcLower = kcSMA - kcMult * atr;
  
  // Current state: BB inside KC = squeeze
  const inSqueeze = bbUpper < kcUpper && bbLower > kcLower;
  
  // Count consecutive squeeze bars (look back)
  let squeezeBars = 0;
  if (inSqueeze) {
    for (let offset = 1; offset <= Math.min(50, klines.length - bbPeriod); offset++) {
      const idx = klines.length - 1 - offset;
      if (idx < bbPeriod) break;
      const winCloses = closes.slice(idx - bbPeriod + 1, idx + 1);
      const winSMA = winCloses.reduce((a, b) => a + b, 0) / bbPeriod;
      const winStd = Math.sqrt(winCloses.map(c => Math.pow(c - winSMA, 2)).reduce((a, b) => a + b, 0) / bbPeriod);
      const winBBU = winSMA + bbMult * winStd;
      const winBBL = winSMA - bbMult * winStd;
      
      let winATRSum = 0;
      for (let j = idx - kcPeriod + 1; j <= idx; j++) {
        if (j < 1) continue;
        const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j-1]), Math.abs(lows[j] - closes[j-1]));
        winATRSum += tr;
      }
      const winATR = winATRSum / kcPeriod;
      const winKCU = winSMA + kcMult * winATR;
      const winKCL = winSMA - kcMult * winATR;
      
      if (winBBU < winKCU && winBBL > winKCL) {
        squeezeBars++;
      } else {
        break;
      }
    }
  }
  
  // Squeeze intensity: how tight (BB width / KC width, lower = tighter)
  const bbWidth = bbUpper - bbLower;
  const kcWidth = kcUpper - kcLower;
  const squeezeIntensity = kcWidth > 0 ? 1 - (bbWidth / kcWidth) : 0;
  
  // Determine direction of fire
  if (!inSqueeze && squeezeBars === 0) {
    // Check if we JUST exited squeeze (previous bar was in squeeze)
    if (klines.length > bbPeriod + 1) {
      const prevCloses = closes.slice(-(bbPeriod + 1), -1);
      const prevSMA = prevCloses.reduce((a, b) => a + b, 0) / bbPeriod;
      const prevStd = Math.sqrt(prevCloses.map(c => Math.pow(c - prevSMA, 2)).reduce((a, b) => a + b, 0) / bbPeriod);
      const prevBBU = prevSMA + bbMult * prevStd;
      const prevBBL = prevSMA - bbMult * prevStd;
      
      let prevATRSum = 0;
      for (let i = closes.length - kcPeriod - 1; i < closes.length - 1; i++) {
        if (i < 1) continue;
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
        prevATRSum += tr;
      }
      const prevATR = prevATRSum / kcPeriod;
      const prevKCU = prevSMA + kcMult * prevATR;
      const prevKCL = prevSMA - kcMult * prevATR;
      
      const wasInSqueeze = prevBBU < prevKCU && prevBBL > prevKCL;
      if (wasInSqueeze) {
        // Squeeze just released! Determine direction
        const momentum = closes[closes.length - 1] - closes[closes.length - 2];
        return {
          state: momentum > 0 ? "FIRING_LONG" : "FIRING_SHORT",
          squeezeIntensity: Math.max(0, squeezeIntensity),
          squeezeBars: 1 // just released
        };
      }
    }
    return { state: "NO_SQUEEZE", squeezeIntensity: 0, squeezeBars: 0 };
  }
  
  return {
    state: inSqueeze ? "SQUEEZE" : "NO_SQUEEZE",
    squeezeIntensity: Math.max(0, squeezeIntensity),
    squeezeBars
  };
}

/**
 * OI Surge Detection — z-score of Open Interest % change
 * ChingTrading: OI % change > 2σ on 1h = CRITICAL trigger (25% weight)
 * MEXC Study: FALLING OI = better breakout follow-through (57.1% vs 50.6%)
 * So we track BOTH: rising OI surge (new money) AND falling OI (clean slate)
 */
export function calculateOISurge(
  currentOIChange: number | undefined,
  signal: Signal
): { oiSurgeZScore: number; oiDirection: "RISING" | "FALLING" | "FLAT"; oiScore: number } {
  const oiChange = currentOIChange ?? signal.oiChange24h ?? 0;
  
  // Z-score approximation using 24h OI change
  // Normal OI change is ~0-5% per day for altcoins
  // > 10% in a short period = significant surge
  const typicalOIStd = 5; // ~5% is 1 std dev for daily OI changes
  const oiSurgeZScore = oiChange / typicalOIStd;
  
  let oiDirection: "RISING" | "FALLING" | "FLAT" = "FLAT";
  if (oiChange > 5) oiDirection = "RISING";
  else if (oiChange < -5) oiDirection = "FALLING";
  
  // Score component: per MEXC study, falling OI = better breakout quality
  // Per ChingTrading, rising OI surge = new money entering
  // Compromise: both extremes score, but differently
  let oiScore = 0;
  if (oiSurgeZScore > 2.0) oiScore = 2.0;       // Major OI surge — new money
  else if (oiSurgeZScore > 1.0) oiScore = 1.5;   // Moderate surge
  else if (oiSurgeZScore < -1.0) oiScore = 1.8;  // Falling OI — MEXC study shows 57.1% edge
  else if (oiSurgeZScore < -0.5) oiScore = 1.0;  // Moderate decline
  else oiScore = 0.5;                             // Flat — neutral
  
  return { oiSurgeZScore, oiDirection, oiScore };
}

/**
 * Funding Rate Anomaly Score
 * ChingTrading: 10% weight in SPIKE_SCORE
 * MEXC Study: Funding alone = zero predictive power (p>0.23)
 * BUT extreme negative funding = short squeeze fuel (+1.82% avg 24h)
 * Score is nonlinear: extreme values matter, moderate don't
 */
export function calculateFundingAnomaly(
  fundingRate: number | undefined
): { fundingAnomaly: number; fundingSignal: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL" } {
  if (fundingRate === undefined) return { fundingAnomaly: 0, fundingSignal: "NEUTRAL" };
  
  // Extreme negative = short squeeze setup
  if (fundingRate < -0.001) return { fundingAnomaly: 1.0, fundingSignal: "SQUEEZE_FUEL" };
  if (fundingRate < -0.0005) return { fundingAnomaly: 0.7, fundingSignal: "SQUEEZE_FUEL" };
  if (fundingRate < -0.0001) return { fundingAnomaly: 0.3, fundingSignal: "SQUEEZE_FUEL" };
  
  // Extreme positive = longs overcrowded (bearish for spikes)
  if (fundingRate > 0.001) return { fundingAnomaly: -0.5, fundingSignal: "OVERCROWDED_LONG" };
  if (fundingRate > 0.0005) return { fundingAnomaly: -0.2, fundingSignal: "OVERCROWDED_LONG" };
  
  return { fundingAnomaly: 0, fundingSignal: "NEUTRAL" };
}

/**
 * ATR Expansion Detection — confirms spike is developing
 * ChingTrading Layer 4: Current ATR > 1.5x 20-period ATR average
 * Used as confirmation filter, not scoring signal
 */
export function detectATRExpansion(
  klines: { high: string; low: string; close: string }[],
  period: number = 14,
  lookback: number = 20
): { expanding: boolean; atrRatio: number; currentATR: number } {
  if (klines.length < lookback + period) return { expanding: false, atrRatio: 1, currentATR: 0 };
  
  const highs = klines.map(k => parseFloat(k.high));
  const lows = klines.map(k => parseFloat(k.low));
  const closes = klines.map(k => parseFloat(k.close));
  
  // Calculate current ATR
  let currentATRSum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      i > 0 ? Math.abs(highs[i] - closes[i-1]) : highs[i] - lows[i],
      i > 0 ? Math.abs(lows[i] - closes[i-1]) : highs[i] - lows[i]
    );
    currentATRSum += tr;
  }
  const currentATR = currentATRSum / period;
  
  // Calculate average ATR over lookback
  let avgATRSum = 0;
  let avgCount = 0;
  for (let offset = period; offset < lookback + period && offset < klines.length; offset++) {
    const idx = klines.length - 1 - offset;
    if (idx < period) break;
    let atrSum = 0;
    for (let i = idx - period + 1; i <= idx; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        i > 0 ? Math.abs(highs[i] - closes[i-1]) : highs[i] - lows[i],
        i > 0 ? Math.abs(lows[i] - closes[i-1]) : highs[i] - lows[i]
      );
      atrSum += tr;
    }
    avgATRSum += atrSum / period;
    avgCount++;
  }
  
  const avgATR = avgCount > 0 ? avgATRSum / avgCount : currentATR;
  const atrRatio = avgATR > 0 ? currentATR / avgATR : 1;
  
  return {
    expanding: atrRatio > 1.5,
    atrRatio,
    currentATR
  };
}

/**
 * NEW COMPOSITE SPIKE_SCORE — Intraday/Short-Swing Optimized
 * Replaces old preSpikeScore (0-5 scale ICT-based) with research-validated formula
 * 
 * ChingTrading SPIKE_SCORE weights (adapted for available data):
 * - RVOL component:    30% → 0-3.0 points
 * - OI component:      25% → 0-2.5 points  
 * - Squeeze component: 15% → 0-1.5 points
 * - Funding component: 10% → 0-1.0 points
 * - Regime component:  10% → 0-1.0 points (ER-based, 1h bars)
 * - Age/AUR component: 10% → 0-1.0 points
 * 
 * Scale: 0-10 (threshold > 4.0 = pre-spike signal)
 */
export function calculateSpikeScore(params: {
  rvolData: { rvol: number; rvolZScore: number };
  oiData: { oiSurgeZScore: number; oiDirection: string; oiScore: number };
  squeezeData: { state: SqueezeState; squeezeIntensity: number; squeezeBars: number };
  fundingData: { fundingAnomaly: number; fundingSignal: string };
  efficiencyRatio: number | undefined;
  ageDays: number | undefined;
  aurData?: { aur: number; aurZScore: number; aurRising: boolean; aurSlope: number };
  volumeSpikeRatio: number | undefined;
  signalStrength: number;
  priceChange24h: number | undefined;
}): number {
  let score = 0;
  
  // ══════ RVOL COMPONENT (0-3.0) — 30% weight, #1 trigger ══════
  const { rvol, rvolZScore } = params.rvolData;
  if (rvol >= 5.0) score += 2.0;          // Extreme volume — likely in spike already
  else if (rvol >= 3.0) score += 3.0;     // Sweet spot: strong but pre-spike
  else if (rvol >= 2.0) score += 2.5;     // Good accumulation signal
  else if (rvol >= 1.5) score += 1.5;     // Early signs
  else if (rvol >= 1.2) score += 0.5;     // Slightly elevated
  // Also use z-score for extreme outliers
  if (rvolZScore > 3.0) score += 0.5;     // Bonus for statistical outlier
  
  // Also incorporate the existing volumeSpikeRatio if available
  if (params.volumeSpikeRatio && params.volumeSpikeRatio >= 3 && rvol < 2.0) {
    score += 1.0; // Cross-validate with existing signal
  }
  
  // ══════ OI COMPONENT (0-2.5) — 25% weight ══════
  score += Math.min(2.5, params.oiData.oiScore);
  
  // ══════ SQUEEZE COMPONENT (0-1.5) — 15% weight ══════
  const { state, squeezeIntensity, squeezeBars } = params.squeezeData;
  if (state === "FIRING_LONG" || state === "FIRING_SHORT") {
    score += 1.5; // Squeeze just released — maximum signal
  } else if (state === "SQUEEZE") {
    // In squeeze — score based on intensity and duration
    const intensityScore = squeezeIntensity * 0.8; // 0 to 0.8
    const durationBonus = Math.min(0.5, squeezeBars * 0.05); // Up to 0.5 for 10+ bars
    score += Math.min(1.2, intensityScore + durationBonus);
  }
  
  // ══════ FUNDING COMPONENT (0-1.0) — 10% weight ══════
  const fundingScore = Math.max(0, params.fundingData.fundingAnomaly);
  score += Math.min(1.0, fundingScore);
  
  // ══════ REGIME COMPONENT (0-1.0) — 10% weight ══════
  // ER-based: low ER (< 0.3) = consolidation → ready to break
  // Moderate ER (0.3-0.5) = starting to trend → good
  // High ER (> 0.6) = already trending → might be late
  if (params.efficiencyRatio !== undefined) {
    if (params.efficiencyRatio >= 0.25 && params.efficiencyRatio <= 0.5) score += 1.0;
    else if (params.efficiencyRatio < 0.25) score += 0.7; // Deep consolidation
    else if (params.efficiencyRatio <= 0.65) score += 0.5; // Trending but not extreme
  }
  
  // ══════ AGE/AUR COMPONENT (0-1.0) — 10% weight ══════
  // Young coins (<90 days) have higher spike probability
  if (params.ageDays !== undefined && params.ageDays < 30) score += 0.5;
  else if (params.ageDays !== undefined && params.ageDays < 90) score += 0.3;
  
  // AUR rising = smart money accumulating
  if (params.aurData) {
    if (params.aurData.aurRising && params.aurData.aur > 0.5) score += 0.5;
    else if (params.aurData.aurRising) score += 0.25;
  }
  
  // ══════ SIGNAL STRENGTH BONUS (0-0.5) ══════
  if (params.signalStrength >= 4) score += 0.5;
  else if (params.signalStrength >= 3) score += 0.25;
  
  return Math.min(10, Math.round(score * 100) / 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// SPIKE PROBABILITY ENGINE — Logistic Sigmoid Model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate VWAP from klines for the current session (rolling up to 24 bars).
 * Returns the VWAP price value.
 */
export function calculateVWAP(klines: SimpleKline[]): number | undefined {
  if (klines.length === 0) return undefined;
  // Use last 24 bars (1 session on 1H) or all available
  const window = klines.slice(-24);
  let cumulativeTPV = 0; // typical_price * volume
  let cumulativeVolume = 0;
  for (const k of window) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const close = parseFloat(k.close);
    const vol = parseFloat(k.volume);
    if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(vol) || vol === 0) continue;
    const typicalPrice = (high + low + close) / 3;
    cumulativeTPV += typicalPrice * vol;
    cumulativeVolume += vol;
  }
  if (cumulativeVolume === 0) return undefined;
  return cumulativeTPV / cumulativeVolume;
}

/**
 * Korea New Listing Detection stub.
 * Flags coins that appear to have been recently listed on Korean exchanges
 * (Upbit, Bithumb) — a known alpha: first 7 days often see massive spikes.
 * 
 * Full implementation requires Upbit/Bithumb API. For now uses ageDays < 7
 * as a proxy for new listing alpha. A dedicated Korean exchange listing feed
 * should be wired in when available.
 * 
 * @param ageDays - Days since first detected listing (from Binance listing date)
 * @returns Object with alpha flag, confidence note, and logit bonus to add
 */
export function detectKoreaListingAlpha(ageDays: number | undefined): {
  isNewKoreaListing: boolean;
  logitBonus: number;
  note: string;
} {
  if (ageDays === undefined) {
    return { isNewKoreaListing: false, logitBonus: 0, note: "age unknown" };
  }
  if (ageDays <= 3) {
    return {
      isNewKoreaListing: true,
      logitBonus: 0.8,
      note: `Very new listing (${ageDays}d) — peak Korean exchange listing alpha window`,
    };
  }
  if (ageDays <= 7) {
    return {
      isNewKoreaListing: true,
      logitBonus: 0.5,
      note: `New listing (${ageDays}d) — within Korean exchange listing alpha window`,
    };
  }
  return { isNewKoreaListing: false, logitBonus: 0, note: "not a new listing" };
}

/**
 * Order Book Imbalance scorer.
 * Accepts bid/ask volume ratio and returns a logit bonus.
 * Ratio > 3:1 = strong buying pressure (+0.3)
 * Ratio > 2:1 = moderate buying pressure (+0.15)
 * Ratio < 0.33 = strong selling pressure (-0.2)
 */
export function scoreOrderBookImbalance(bidAskVolumeRatio: number | undefined): {
  logitBonus: number;
  label: "STRONG_BID" | "MODERATE_BID" | "BALANCED" | "MODERATE_ASK" | "STRONG_ASK";
} {
  if (bidAskVolumeRatio === undefined) {
    return { logitBonus: 0, label: "BALANCED" };
  }
  if (bidAskVolumeRatio >= 3.0) {
    return { logitBonus: 0.3, label: "STRONG_BID" };
  }
  if (bidAskVolumeRatio >= 2.0) {
    return { logitBonus: 0.15, label: "MODERATE_BID" };
  }
  if (bidAskVolumeRatio <= 0.33) {
    return { logitBonus: -0.2, label: "STRONG_ASK" };
  }
  if (bidAskVolumeRatio <= 0.5) {
    return { logitBonus: -0.1, label: "MODERATE_ASK" };
  }
  return { logitBonus: 0, label: "BALANCED" };
}

/**
 * SPIKE PROBABILITY ENGINE
 * 
 * Computes P(spike in next 15 minutes) using a logistic sigmoid model:
 *   logit = β₀ + β₁·x_rvol + β₂·x_oi + β₃·x_squeeze + β₄·x_funding
 *         + β₅·x_regime + β₆·x_age + β₇·x_atr + korea_bonus + ob_bonus + vwap_mult
 *   P = sigmoid(logit)
 *
 * Coefficients calibrated from ChingTrading PDF + MEXC study to produce
 * realistic base rates (~3% for a typical coin, >50% for high-alert setups).
 */
export function calculateSpikeProbability(params: {
  rvolData: { rvol: number; rvolZScore: number };
  oiData: { oiSurgeZScore: number; oiDirection: string; oiScore: number };
  squeezeData: { state: SqueezeState; squeezeIntensity: number; squeezeBars: number };
  fundingData: { fundingAnomaly: number; fundingSignal: string };
  efficiencyRatio: number | undefined;
  ageDays: number | undefined;
  atrData: { expanding: boolean; atrRatio: number };
  klines: SimpleKline[];          // For VWAP calculation
  currentPrice: number;
  spikeScore: number;             // Pre-computed 0-10 score (backward compat)
  bidAskVolumeRatio?: number;     // Optional order book imbalance
  oiMcapRatio?: number;          // OI / Market Cap ratio (normalized OI magnitude)
}): SpikeProbability {
  const { rvolData, oiData, squeezeData, fundingData, atrData } = params;

  // ── Sigmoid helper ────────────────────────────────────────────────────────
  const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

  // ── β₀: Intercept — base rate ~3% (sigmoid(-3.5) ≈ 0.030) ────────────────
  let logit = -3.5;

  // ── β₁: RVOL (weight 1.2 per z-score unit, but we use rvol ratio directly) ─
  // RVOL ≥ 3x is the #1 predictor. Map to a continuous contribution.
  const { rvol, rvolZScore } = rvolData;
  let x_rvol = 0;
  if (rvol >= 5.0) x_rvol = 2.0;       // Extreme: strong contribution but may be mid-spike
  else if (rvol >= 3.0) x_rvol = 2.5;  // Sweet spot: pre-spike peak signal
  else if (rvol >= 2.0) x_rvol = 1.8;
  else if (rvol >= 1.5) x_rvol = 1.1;
  else if (rvol >= 1.2) x_rvol = 0.5;
  // z-score bonus for statistical outliers
  if (rvolZScore > 3.0) x_rvol += 0.4;
  else if (rvolZScore > 2.0) x_rvol += 0.2;
  const beta1_contribution = 1.2 * x_rvol;
  logit += beta1_contribution;

  // ── β₂: OI Surge (weight 0.8→1.0 adaptive) ──────────────────────────────
  // Gap #4: Normalize OI by market cap when available (OI/MCap ratio)
  // Gap #1: Raise β₂ to 1.0 when OI is RISING confirmed
  let x_oi = 0;
  const oiZ = oiData.oiSurgeZScore;
  
  // OI/MCap ratio amplifier: small-cap with high OI = much stronger signal
  let oiMcapMultiplier = 1.0;
  if (params.oiMcapRatio !== undefined && params.oiMcapRatio > 0) {
    if (params.oiMcapRatio > 0.10) oiMcapMultiplier = 1.8;       // OI > 10% of MCap = extremely leveraged
    else if (params.oiMcapRatio > 0.05) oiMcapMultiplier = 1.5;  // OI > 5% of MCap = heavily leveraged
    else if (params.oiMcapRatio > 0.02) oiMcapMultiplier = 1.2;  // OI > 2% of MCap = moderate
    // OI < 2% of MCap = default multiplier 1.0
  }

  if (!isNaN(oiZ)) {
    if (oiZ > 2.0) x_oi = 2.0 * oiMcapMultiplier;
    else if (oiZ > 1.0) x_oi = 1.2 * oiMcapMultiplier;
    else if (oiZ > 0.5) x_oi = 0.6 * oiMcapMultiplier;
    else if (oiZ < -1.0) x_oi = -0.5;
  }
  
  // Direction reinforcement (stronger when RISING)
  if (oiData.oiDirection === "RISING") x_oi += 0.4;
  else if (oiData.oiDirection === "FALLING") x_oi -= 0.2;
  
  // Gap #1: Adaptive β₂ — raise from 0.8 to 1.0 when OI direction is confirmed RISING
  const beta2_weight = oiData.oiDirection === "RISING" ? 1.0 : 0.8;
  const beta2_contribution = beta2_weight * x_oi;
  logit += beta2_contribution;

  // ── β₃: BB/KC Squeeze (weight 1.5 for FIRING, 0.5 for SQUEEZE) ────────────
  let x_squeeze = 0;
  const { state: sqzState, squeezeIntensity, squeezeBars } = squeezeData;
  if (sqzState === "FIRING_LONG" || sqzState === "FIRING_SHORT") {
    x_squeeze = 1.5; // Highest precision signal — squeeze just released
  } else if (sqzState === "SQUEEZE") {
    // In-squeeze: score by intensity and duration
    x_squeeze = 0.5 + squeezeIntensity * 0.3 + Math.min(0.4, squeezeBars * 0.04);
  }
  const beta3_contribution = x_squeeze; // β₃ already embedded in x_squeeze scaling
  logit += beta3_contribution;

  // ── β₄: Funding Anomaly (weight 0.4 for squeeze fuel, -0.3 for overcrowded) ─
  let x_funding = 0;
  const { fundingSignal, fundingAnomaly } = fundingData;
  if (fundingSignal === "SQUEEZE_FUEL") {
    x_funding = 0.4 * Math.min(1.5, fundingAnomaly);
  } else if (fundingSignal === "OVERCROWDED_LONG") {
    x_funding = -0.3; // Longs crowded = squeeze risk downward
  }
  logit += x_funding;

  // ── β₅: Regime / ER (weight 0.6 for consolidation-to-trend transition) ────
  let x_regime = 0;
  const er = params.efficiencyRatio;
  if (er !== undefined) {
    if (er >= 0.25 && er <= 0.5) x_regime = 1.0;  // Consolidation→trend transition
    else if (er < 0.25) x_regime = 0.7;           // Deep consolidation (coiling)
    else if (er <= 0.65) x_regime = 0.5;           // Trending but not extreme
    // er > 0.65 = already strongly trending, small regime bonus
    else x_regime = 0.2;
  }
  const beta5_contribution = 0.6 * x_regime;
  logit += beta5_contribution;

  // ── β₆: Age / New Listing Alpha (weight 0.3) ──────────────────────────────
  let x_age = 0;
  const koreaAlpha = detectKoreaListingAlpha(params.ageDays);
  if (params.ageDays !== undefined && params.ageDays < 7) x_age = 2.0;  // Korea listing window
  else if (params.ageDays !== undefined && params.ageDays < 30) x_age = 1.0;
  else if (params.ageDays !== undefined && params.ageDays < 90) x_age = 0.5;
  const beta6_contribution = 0.3 * x_age + koreaAlpha.logitBonus;
  logit += beta6_contribution;

  // ── β₇: ATR Expansion (weight 0.5 when ratio > 1.5) ─────────────────────
  let x_atr = 0;
  if (atrData.expanding && atrData.atrRatio > 1.5) x_atr = 1.0;
  else if (atrData.expanding) x_atr = 0.5;
  const beta7_contribution = 0.5 * x_atr;
  logit += beta7_contribution;

  // ── Gap #5: FUEL × OI_RISING interaction term ────────────────────────────
  // When a coin has FUEL tag (social/crowd activity) AND OI is RISING,
  // the combination signals both retail attention + institutional positioning
  let fuelOiInteraction = 0;
  if (params.spikeScore >= 5 && oiData.oiDirection === "RISING") {
    // spikeScore >= 5 is used as a proxy for FUEL-like conditions (high activity)
    fuelOiInteraction = 0.5;
  }
  logit += fuelOiInteraction;

  // ── Order Book Imbalance bonus ─────────────────────────────────────────────
  const obImbalance = scoreOrderBookImbalance(params.bidAskVolumeRatio);
  logit += obImbalance.logitBonus;

  // ── VWAP Confirmation (±10% multiplier on probability post-sigmoid) ────────
  const vwap = calculateVWAP(params.klines);
  let vwapConfirmation: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  let vwapMultiplier = 1.0;
  if (vwap !== undefined && params.currentPrice > 0) {
    const vwapDeviation = (params.currentPrice - vwap) / vwap;
    if (vwapDeviation > 0.005) {
      vwapConfirmation = "BULLISH";
      vwapMultiplier = 1.1; // Price above VWAP: bullish confirmation
    } else if (vwapDeviation < -0.005) {
      vwapConfirmation = "BEARISH";
      vwapMultiplier = 0.9; // Price below VWAP: reduce upspike probability
    }
  }

  // ── Gap #6: Deep Z-score mean-reversion bonus ────────────────────────────
  // When Z < -5 AND VWAP = BULL → coin is deeply oversold but buying pressure present
  // This catches mean-reversion setups like FARTCOIN (-12.1), LTC (-12.2)
  let meanReversionBonus = 0;
  if (rvolData.rvolZScore < -5 && vwapConfirmation === "BULLISH") {
    meanReversionBonus = 0.4;
  } else if (rvolData.rvolZScore < -3 && vwapConfirmation === "BULLISH") {
    meanReversionBonus = 0.2;
  }
  logit += meanReversionBonus;

  // ── Compute raw probability ────────────────────────────────────────────────
  // Cap logit at 3.5 to prevent sigmoid saturation (sigmoid(3.5) ≈ 97%)
  // No coin should show >95% — that implies certainty which doesn't exist
  logit = Math.min(3.5, logit);
  let probability = sigmoid(logit) * vwapMultiplier;
  probability = Math.max(0, Math.min(0.95, probability)); // Hard cap at 95%

  // ── Time Decay (default 0.8 for 1H klines, ~30min avg signal age) ─────────
  // Full implementation would track signal timestamps; for now use fixed default.
  const timeDecay = 0.8;

  // ── Signal Agreement / Confluence ─────────────────────────────────────────
  // Count how many of the 7 signal dimensions are meaningfully "on"
  const signalThresholds = [
    rvol >= 2.0,                                                // RVOL elevated
    !isNaN(oiData.oiSurgeZScore) && oiData.oiSurgeZScore > 1.0, // OI surging
    sqzState === "FIRING_LONG" || sqzState === "FIRING_SHORT" || sqzState === "SQUEEZE", // Squeeze present
    fundingSignal === "SQUEEZE_FUEL",                           // Funding anomaly
    er !== undefined && er >= 0.25 && er <= 0.65,              // Regime favorable
    params.ageDays !== undefined && params.ageDays < 90,       // New listing factor
    atrData.expanding,                                         // ATR expanding
  ];
  const definedSignals = signalThresholds.length; // All signals are defined (some may be false)
  const activeSignals = signalThresholds.filter(Boolean).length;
  const signalAgreement = activeSignals / definedSignals;

  // ── Data Quality Score ─────────────────────────────────────────────────────
  // Fraction of non-undefined critical inputs
  const dataPoints = [
    rvol,
    oiData.oiSurgeZScore,
    sqzState,
    fundingData.fundingSignal,
    params.efficiencyRatio,
    params.ageDays,
    atrData.atrRatio,
  ];
  const validDataPoints = dataPoints.filter(v => v !== undefined && !Number.isNaN(v)).length;
  const dataQuality = validDataPoints / dataPoints.length;

  // ── Confidence Level ──────────────────────────────────────────────────────
  let confidence: "HIGH" | "MEDIUM" | "LOW";
  if (signalAgreement >= 0.6 && dataQuality >= 0.7) {
    confidence = "HIGH";
  } else if (signalAgreement >= 0.4 || probability >= 0.3) {
    confidence = "MEDIUM";
  } else {
    confidence = "LOW";
  }

  // ── Expected Magnitude (% spike if it occurs) ─────────────────────────────
  let expectedMagnitude: number;
  const isFiring = sqzState === "FIRING_LONG" || sqzState === "FIRING_SHORT";
  if (rvol >= 5.0 && isFiring) {
    expectedMagnitude = 10 + (atrData.atrRatio - 1) * 4; // 8-15% range, ATR-adjusted
  } else if (rvol >= 3.0 && (isFiring || sqzState === "SQUEEZE")) {
    expectedMagnitude = 6 + (rvol - 3) * 2;              // 5-10% range
  } else if (rvol >= 2.0) {
    expectedMagnitude = 3 + (rvol - 2) * 2;              // 3-7% range
  } else {
    expectedMagnitude = 2 + probability * 3;              // 2-5% base range
  }
  // ATR ratio confirmation amplifier
  if (atrData.expanding && atrData.atrRatio > 1.5) {
    expectedMagnitude *= 1.15;
  }
  expectedMagnitude = Math.max(2, Math.min(20, Math.round(expectedMagnitude * 10) / 10));

  // ── Dominant Driver ───────────────────────────────────────────────────────
  const contributions: { name: string; value: number }[] = [
    { name: "RVOL",     value: beta1_contribution },
    { name: "OI_SURGE", value: beta2_contribution },
    { name: "SQUEEZE",  value: beta3_contribution },
    { name: "FUNDING",  value: x_funding },
    { name: "REGIME",   value: beta5_contribution },
    { name: "NEW_LISTING", value: beta6_contribution },
    { name: "ATR_EXPAND", value: beta7_contribution },
    { name: "FUEL_OI", value: fuelOiInteraction },
    { name: "MEAN_REVERT", value: meanReversionBonus },
  ];
  const dominant = contributions.reduce((a, b) => Math.abs(a.value) > Math.abs(b.value) ? a : b);
  const dominantDriver = dominant.name;

  return {
    probability: Math.round(probability * 1000) / 1000,
    confidence,
    expectedMagnitude,
    timeDecay,
    dominantDriver,
    signalAgreement: Math.round(signalAgreement * 100) / 100,
    spikeScore: params.spikeScore,
    vwapConfirmation,
    koreaListingAlpha: koreaAlpha.isNewKoreaListing,
  };
}

/**
 * Returns count of conditions met (0-4) and which ones are true.
 * 
 * Research-backed conditions (4 orthogonal dimensions):
 * 1. AUR: slope > 0 AND Z < 1.5 (buying rising but NOT yet spiked — pre-spike, not during-spike)
 * 2. ER: Rising from low base (ER < 0.35 consolidating → starting to trend, or crossing above mean)
 * 3. VS Z < -1.0 (volatility compressed — relaxed from -1.5 which never triggered; closest was -1.47)
 * 4. PE > rolling mean (market disorder rising, about to resolve into directional momentum)
 * 
 * Academic evidence: T-4h window is optimal — all 4 converge before price breaks out
 * Rolling Z-scores are self-calibrating across market regimes (no fixed thresholds)
 */
export function evaluatePreSpikeCombo(
  aurZScore: number | undefined,
  er: number | undefined,
  vs: number | undefined,
  pe: number | undefined,
  symbol: string,
  aurSlope?: number,
  aurRising?: boolean
): {
  comboScore: number;
  aurCondition: boolean;
  erCondition: boolean;
  vsCondition: boolean;
  peCondition: boolean;
} {
  const hist = indicatorHistory.get(symbol);
  const erMean = hist ? calcMean(hist.er) : undefined;
  const vsMean = hist ? calcMean(hist.vs) : undefined;
  const vsZScore = hist && vs !== undefined ? calcZScore(hist.vs, vs) : undefined;
  const peMean = hist ? calcMean(hist.pe) : undefined;

  // Research-aligned Primary Filters:
  // AUR: Buying concentration RISING (slope > 0) but NOT yet extreme (Z < 1.5)
  // This catches the pre-spike accumulation phase, not the spike itself
  const aurCondition = aurSlope !== undefined && aurRising !== undefined
    ? (aurSlope > 0 || aurRising) && (aurZScore === undefined || aurZScore < 1.5)
    : aurZScore !== undefined && aurZScore > 0.5 && aurZScore < 1.5;

  // ER: Efficiency rising from consolidation base (ER < 0.35 = choppy → starting to trend)
  // Research: ER < 0.35 is setup condition, crossing above mean = confirmation
  const erCondition = er !== undefined && erMean !== undefined 
    ? (er < 0.35 && er > erMean * 0.8) || (er > erMean && er < 0.6)
    : er !== undefined && er > 0.15 && er < 0.45;

  // VS: Volatility compressed — Z < -1.0 (relaxed from -1.5 which was too tight)
  // BBKC squeeze backtest: Sharpe >1.0, 83% parameter robustness
  const vsCondition = vsZScore !== undefined && vsZScore < -1.0;

  // PE: Disorder rising above mean — market about to resolve into trend
  const peCondition = pe !== undefined && peMean !== undefined && pe > peMean;

  const comboScore = (aurCondition ? 1 : 0) + (erCondition ? 1 : 0) + (vsCondition ? 1 : 0) + (peCondition ? 1 : 0);

  return { comboScore, aurCondition, erCondition, vsCondition, peCondition };
}


export async function enrichSignalWithCoinglass(
  signal: Signal,
  high24h: number,
  low24h: number,
  aurData?: { aur: number; aurZScore: number; aurRising: boolean; aurSlope: number },
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


    // FALLBACK: If OKX returned no klines, try Bitunix as kline source
  if (klines4H.length === 0) {
    try {
      console.log(`[ENRICHMENT] ${symbol} - OKX klines empty, trying Bitunix fallback...`);
      const bitunixKlines4H = await getBitunixKlines(symbol, '4h', 100);
      if (bitunixKlines4H && bitunixKlines4H.length > 0) {
        klines4H = bitunixKlines4H.map((k: any) => ({
          open: String(k.open ?? k.o ?? '0'),
          high: String(k.high ?? k.h ?? '0'),
          low: String(k.low ?? k.l ?? '0'),
          close: String(k.close ?? k.c ?? '0'),
          volume: String(k.volume ?? k.v ?? '0'),
          openTime: k.openTime ?? k.ts ?? Date.now(),
          closeTime: k.closeTime ?? (k.openTime ?? k.ts ?? Date.now()) + 14400000
        }));
        console.log(`[ENRICHMENT] ${symbol} - Bitunix 4H klines: ${klines4H.length}`);
      }
    } catch (err) {
      console.log(`[ENRICHMENT] ${symbol} - Bitunix 4H fallback failed:`, err);
    }
  }
  if (klines1H.length === 0) {
    try {
      const bitunixKlines1H = await getBitunixKlines(symbol, '1h', 100);
      if (bitunixKlines1H && bitunixKlines1H.length > 0) {
        klines1H = bitunixKlines1H.map((k: any) => ({
          open: String(k.open ?? k.o ?? '0'),
          high: String(k.high ?? k.h ?? '0'),
          low: String(k.low ?? k.l ?? '0'),
          close: String(k.close ?? k.c ?? '0'),
          volume: String(k.volume ?? k.v ?? '0'),
          openTime: k.openTime ?? k.ts ?? Date.now(),
          closeTime: k.closeTime ?? (k.openTime ?? k.ts ?? Date.now()) + 3600000
        }));
        console.log(`[ENRICHMENT] ${symbol} - Bitunix 1H klines: ${klines1H.length}`);
      }
    } catch (err) {
      console.log(`[ENRICHMENT] ${symbol} - Bitunix 1H fallback failed:`, err);
    }
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

  // Detect FVG and Order Blocks from 1H klines (supplementary, not primary scoring)
  const fvgs1H = klines1H.length > 0 ? bitunixTradeService.detectFVG(klines1H as any) : [];
  const obs1H = klines1H.length > 0 ? bitunixTradeService.detectOrderBlocks(klines1H as any) : [];

  // ═══════════════════════════════════════════════════════════════════
  // NEW INTRADAY SPIKE DETECTION SIGNALS (ChingTrading + MEXC Research)
  // ═══════════════════════════════════════════════════════════════════
  
  // 1. RVOL - Relative Volume (#1 trigger, 30% weight)
  const rvolData = calculateRVOL(klines1H.length >= 11 ? klines1H : klines4H, 10);
  if (rvolData.rvol >= 2.0) {
    console.log(`[SPIKE] ${signal.symbol}: RVOL=${rvolData.rvol.toFixed(2)}x (Z=${rvolData.rvolZScore.toFixed(2)})`);
  }
  
  // 2. BB/KC Squeeze Detection (15% weight)
  const squeezeData = detectBBKCSqueeze(klines1H.length >= 21 ? klines1H : klines4H);
  if (squeezeData.state !== "NO_SQUEEZE") {
    console.log(`[SPIKE] ${signal.symbol}: Squeeze=${squeezeData.state} (${squeezeData.squeezeBars} bars, intensity=${squeezeData.squeezeIntensity.toFixed(2)})`);
  }
  
  // 3. OI Surge Detection (25% weight)
  const oiData = calculateOISurge(signal.oiChange24h, signal);
  
  // 4. Funding Rate Anomaly (10% weight)
  const fundingAnomalyData = calculateFundingAnomaly(fundingRate);
  
  // 5. ATR Expansion (confirmation filter)
  const atrData = detectATRExpansion(klines1H.length >= 35 ? klines1H : klines4H);

  // OLD preSpikeScore preserved for backward compatibility (0-5 scale)
  let preSpikeScore = 0;
  if (fvgs1H.length > 0) {
    const unfilledFVGs = fvgs1H.filter((f) => !f.filled);
    if (unfilledFVGs.length >= 2) preSpikeScore += 1;
    else if (unfilledFVGs.length === 1) preSpikeScore += 0.5;
  }
  if (obs1H.length > 0) {
    if (obs1H.length >= 2) preSpikeScore += 1;
    else preSpikeScore += 0.5;
  }
  if (priceLocation === "DISCOUNT") preSpikeScore += 1;
  else if (priceLocation === "NEUTRAL") preSpikeScore += 0.5;
  if (signal.volumeSpikeRatio && signal.volumeSpikeRatio >= 3) preSpikeScore += 1;
  else if (signal.volumeSpikeRatio && signal.volumeSpikeRatio >= 2) preSpikeScore += 0.5;
  if (signal.signalStrength && signal.signalStrength >= 4) preSpikeScore += 1;
  else if (signal.signalStrength && signal.signalStrength >= 3) preSpikeScore += 0.5;
  if (aurData) {
    if (aurData.aurRising && aurData.aur > 0.5) preSpikeScore += 1.0;
    else if (aurData.aurRising) preSpikeScore += 0.5;
  }
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

  // Calculate HKPTRC Alpha Indicators from 4H klines
  const efficiencyRatio = klines4H.length >= 21 ? calculateEfficiencyRatio(klines4H, 20) : undefined;
  const volatilitySpread = klines4H.length >= 21 ? calculateVolatilitySpread(klines4H, 20) : undefined;
  const channelRange = klines4H.length >= 20 ? calculateChannelRange(klines4H, 20) : undefined;

    // Calculate Permutation Entropy from 4H klines
  const permutationEntropy = klines4H.length >= 23 ? calculatePermutationEntropy(klines4H, 20, 3) : undefined;

  // SEED indicatorHistory from kline rolling windows if insufficient history
  // This ensures Z-scores work from the FIRST enrichment cycle after deploy
  if (!indicatorHistory.has(symbol) || (indicatorHistory.get(symbol)?.er?.length ?? 0) < 3) {
    if (klines4H.length >= 44) { // Need at least 44 bars for 4 rolling windows of 20
      const seedHist = { er: [] as number[], vs: [] as number[], pe: [] as number[] };
      // Compute ER/VS/PE at multiple historical offsets (stepping back 5 bars each time)
      for (let offset = Math.min(klines4H.length - 21, 40); offset >= 0; offset -= 5) {
        const windowKlines = klines4H.slice(offset, offset + 21);
        if (windowKlines.length >= 21) {
          const seedER = calculateEfficiencyRatio(windowKlines, 20);
          const seedVS = calculateVolatilitySpread(windowKlines, 20);
          if (seedER !== undefined) seedHist.er.push(seedER);
          if (seedVS !== undefined) seedHist.vs.push(seedVS);
        }
        if (offset + 23 <= klines4H.length) {
          const peWindow = klines4H.slice(offset, offset + 23);
          const seedPE = calculatePermutationEntropy(peWindow, 20, 3);
          if (seedPE !== undefined) seedHist.pe.push(seedPE);
        }
      }
      if (seedHist.er.length >= 3) {
        indicatorHistory.set(symbol, seedHist);
        console.log(`[ENRICHMENT] ${symbol}: Seeded indicator history with ${seedHist.er.length} ER, ${seedHist.vs.length} VS, ${seedHist.pe.length} PE values from klines`);
      }
    }
  }

  // Push to rolling history store for Z-score computation
  pushIndicatorHistory(symbol, efficiencyRatio, volatilitySpread, permutationEntropy);

  // Compute Z-scores for ER and VSpread from rolling history
  const hist = indicatorHistory.get(symbol);
  const erZScore = hist && efficiencyRatio !== undefined ? calcZScore(hist.er, efficiencyRatio) : undefined;
  const vsZScore = hist && volatilitySpread !== undefined ? calcZScore(hist.vs, volatilitySpread) : undefined;
  const peZScore = hist && permutationEntropy !== undefined ? calcZScore(hist.pe, permutationEntropy) : undefined;

  // Evaluate Pre-Spike Combo (HKPTRC Alpha)
      const aurZScoreForCombo = aurData?.aurZScore ?? 0;
  const combo = evaluatePreSpikeCombo(aurZScoreForCombo, efficiencyRatio, volatilitySpread, permutationEntropy, symbol, aurData?.aurSlope, aurData?.aurRising);
  if (combo.comboScore >= 2) {
    console.log(`[COMBO] ${signal.symbol}: ${combo.comboScore}/4 conditions met! AUR=${combo.aurCondition} ER=${combo.erCondition} VS=${combo.vsCondition} PE=${combo.peCondition}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPOSITE SPIKE_SCORE (0-10) — PRIMARY ranking signal
  // ═══════════════════════════════════════════════════════════════════
  const spikeScore = calculateSpikeScore({
    rvolData,
    oiData,
    squeezeData,
    fundingData: fundingAnomalyData,
    efficiencyRatio,
    ageDays,
    aurData,
    volumeSpikeRatio: signal.volumeSpikeRatio,
    signalStrength: signal.signalStrength || 0,
    priceChange24h: signal.priceChange24h,
  });

  if (spikeScore >= 4.0) {
    console.log(`[SPIKE] ⚡ ${signal.symbol}: SPIKE_SCORE=${spikeScore.toFixed(1)} | RVOL=${rvolData.rvol.toFixed(1)}x | OI=${oiData.oiDirection} | SQZ=${squeezeData.state} | FR=${fundingAnomalyData.fundingSignal} | ATR=${atrData.expanding ? 'EXPANDING' : 'normal'}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // SPIKE PROBABILITY ENGINE — Logistic Sigmoid P(spike_15min)
  // ═══════════════════════════════════════════════════════════════════
  const spikeProbability = calculateSpikeProbability({
    rvolData,
    oiData,
    squeezeData,
    fundingData: fundingAnomalyData,
    efficiencyRatio,
    ageDays,
    atrData,
    klines: klines1H.length >= 5 ? klines1H : klines4H,
    currentPrice: signal.currentPrice,
    spikeScore,
    // bidAskVolumeRatio: undefined — wire in order book feed when available
  });

  if (spikeProbability.probability >= 0.3) {
    console.log(`[PROB] 🎯 ${signal.symbol}: P(spike)=${(spikeProbability.probability * 100).toFixed(1)}% | conf=${spikeProbability.confidence} | driver=${spikeProbability.dominantDriver} | mag=~${spikeProbability.expectedMagnitude.toFixed(1)}% | VWAP=${spikeProbability.vwapConfirmation}`);
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
    efficiencyRatio,
    volatilitySpread,
    permutationEntropy,
    erZScore,
    vsZScore,
    peZScore,
    ageDays,
    channelRange,
    preSpikeCombo: combo,
    aurVelocity: aurData?.aurSlope,
    aurRising: aurData?.aurRising,
    // NEW intraday spike signals
    spikeScore,
    rvol: rvolData.rvol,
    rvolZScore: rvolData.rvolZScore,
    squeezeState: squeezeData.state,
    squeezeBars: squeezeData.squeezeBars,
    oiSurgeZScore: oiData.oiSurgeZScore,
    oiDirection: oiData.oiDirection,
    fundingSignal: fundingAnomalyData.fundingSignal,
    atrExpanding: atrData.expanding,
    atrRatio: atrData.atrRatio,
    spikeProbability,
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
    // Filter by spike/pre-spike score (use spikeScore if available, fallback to preSpikeScore)
    if (
      filters.minPScore !== undefined &&
      ((signal as any).spikeScore ?? signal.preSpikeScore ?? 0) < filters.minPScore
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

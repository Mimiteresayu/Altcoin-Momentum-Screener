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
"./binance";
  import { getBinanceFuturesData } from "./binance";

type PriceLocation = "DISCOUNT" | "NEUTRAL" | "PREMIUM";
type MarketPhase =
  | "ACCUMULATION"
  | "DISTRIBUTION"
  | "BREAKOUT"
  | "EXHAUST"
  | "NEUTRAL"rom
  | "UNKNOWN";
type Confidence = "high" | "medium" | "low";

interface EnrichedSignalData {
  priceLocation: PriceLocation;
  marketPhase: MarketPhase;
  marketPhaseAlt: MarketPhase; // Alternative phase detection using RSI/OI method
  preSpikeScore: number;
  fundingRate: number | undefined;
  fundingBias: "bullish" | "bearish" | "neutral" | undefined;
  longShortRatio: number | undefined;
  lsrBias: "long_dominant" | "short_dominant" | "balanced" | undefined;
  fvgLevels: { price: number; type: "bullish" | "bearish"; strength: number }[];
  obLevels: { price: number; type: "bullish" | "bearish"; strength: number }[];
  liquidationZones: {
    nearestLongLiq: number | undefined;
    nearestShortLiq: number | undefined;
    longLiqDistance: number | undefined;
    shortLiqDistance: number | undefined;
  };
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

export function calculateMarketPhase(
  volumeSpike: number,
  oiChange: number | undefined,
  rsi: number,
  priceChange: number,
  volAccel: number | undefined,
): MarketPhase {
  const oiDelta = oiChange ?? 0;
  const acceleration = volAccel ?? 1;

  // ACCUMULATION: Smart Money Entry - price flat, volume rising, RSI not overbought, OI building
  if (Math.abs(priceChange) < 3 && volumeSpike >= 3 && rsi < 55 && oiDelta > 5) {
    return "ACCUMULATION";
  }
  // Alternative ACCUMULATION check
  if (volumeSpike >= 4 && acceleration >= 2 && rsi >= 45 && rsi <= 65) {
    return "ACCUMULATION";
  }

  // BREAKOUT: Explosive Momentum - massive volume, significant price move, RSI healthy
  if (volumeSpike >= 5 && Math.abs(priceChange) > 3 && rsi >= 40 && rsi <= 75) {
    return "BREAKOUT";
  }

  // DISTRIBUTION: Smart Money Exit - price rising but OI declining (smart money selling)
  if (priceChange > 2 && rsi > 60 && oiDelta < 0) {
    return "DISTRIBUTION";
  }

  // EXHAUST (Upside): Price pumping but volume fading, RSI overbought
  if (priceChange > 5 && volumeSpike < 2 && rsi > 75) {
    return "EXHAUST";
  }
  // EXHAUST (Downside): Price dumping but volume fading, RSI oversold
  if (priceChange < -3 && volumeSpike < 2 && rsi < 35) {
    return "EXHAUST";
  }

  return "UNKNOWN";
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
  // Negative funding = bullish for longs
  if (fundingRate !== undefined && fundingRate < -0.01) score += 0.25;

  // Long/Short ratio (0-0.25 points)
  // Low ratio = fewer longs = contrarian bullish
  if (longShortRatio !== undefined && longShortRatio < 0.9) score += 0.25;

  return Math.min(5, Math.round(score * 10) / 10);
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
      interpretation = `Strong breakout pattern. ${volumeDesc} confirms move validity. ${fundingBias === "bearish" ? "Negative funding supports continuation." : ""}`;
      if (signal.side === "LONG" && preSpikeScore >= 4) {
        actionSuggestion = `LONG on pullback to ${signal.entryPrice.toFixed(4)} or breakout continuation`;
        confidence = "high";
      } else {
        actionSuggestion = "Wait for pullback entry to reduce risk";
        confidence = "medium";
      }
      break;

    case "EXHAUST":
      summary = `${signal.symbol} showing exhaustion signals with fading ${volumeDesc}`;
      interpretation = `Potential exhaustion detected. Volume declining while ${rsiDesc}. ${lsrBias === "long_dominant" ? "Crowded long positioning adds risk." : ""}`;
      actionSuggestion =
        "Avoid new entries. Tighten stops on existing positions.";
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

  // Fetch multi-timeframe Klines for technical analysis
  let klines4H, klines1H, klines15M, klines5M;
  try {
    [klines4H, klines1H, klines15M, klines5M] = await Promise.all([
      getBitunixKlines(symbol, "4h", 100),
      getBitunixKlines(symbol, "1h", 100),
      getBitunixKlines(symbol, "15m", 100),
      getBitunixKlines(symbol, "5m", 100),
    ]);
    console.log(
      `[ENRICHMENT] ${symbol} - Fetched klines: 4H=${klines4H.length}, 1H=${klines1H.length}, 15M=${klines15M.length}, 5M=${klines5M.lengt}, 5M=${klines5M.length}`,
    );
  } catch (error) {
    console.log(`[ENRICHMENT] Failed to fetch klines for ${signal.symbol}`);
    // Set empty arrays as fallback
    klines4H = [];
    klines1H = [];
    klines15M = [];
    klines5M = [];
  }

  // PRIORITY 1: Try FREE Binance Futures API first
  let binanceData: { openInterest: number; oiChange24h: number; longShortRatio: number; longRate: number; shortRate: number; fundingRate: number; source: string } | null = null;
  try {
    binanceData = await getBinanceFuturesData(symbol);
    console.log(`[ENRICHMENT] Binance FREE data fetched for ${symbol}:`, binanceData?.source);
  } catch (error) {
    console.log(`[ENRICHMENT] Binance FREE API failed for ${symbol}, falling back to Coinglass`);
  }

  // PRIORITY 2: Use Coinglass as fallback (paid STARTUP plan)const marketPhaseAlt =
  
  let enhancedData: EnhancedMarketData | null = null;
  let liquidationMap: LiquidationMapData[] = [];

  try {
    [enhancedData, liquidationMap] = await Promise.all([
      getEnhancedMarketData(symbol).catch(() => null),
      getLiquidationMap(symbol).catch(() => []),
    ]);
  } catch (error) {
    console.log(
      `[ENRICHMENT] Failed to fetch Coinglass data for ${symbol}:`,
      error,
    );
  }

  // Calculate price location
  // Use ICT/Smart Money location from 1H klines
  const ictAnalysis = bitunixTradeService.getICTLocation(klines1H);
  const priceLocation: PriceLocation =
    ictAnalysis.location.toUpperCase() as PriceLocation;
  // Extract funding and L/S data
  const fundingRate = enhancedData?.fundingBasisAnalysis?.averageFundingRate;
  const fundingBias = enhancedData?.fundingBasisAnalysis?.fundingBias;
  const longShortRatio = enhancedData?.positioningAnalysis?.longShortRatio;
  const lsrBias = enhancedData?.positioningAnalysis?.trend;

  // Calculate market phase
  // Determine market phase using multi-timeframe structure
  let marketPhase: MarketPhase = "UNKNOWN";
  if (klines4H.length > 20 && klines1H.length > 20) {
    // Analyze 4H and 1H trend structure
    const closes4H = klines4H.slice(-20).map((k) => parseFloat(k.close));
    const closes1H = klines1H.slice(-20).map((k) => parseFloat(k.close));
    const current4H = closes4H[closes4H.length - 1];
    const prev4H_10 = closes4H[closes4H.length - 11];
    const trend4H = current4H > prev4H_10 ? "up" : "down";

    // Check for accumulation (sideways on 4H, low volume)
    const range4H = Math.max(...closes4H) - Math.min(...closes4H);
    const avgPrice4H = closes4H.reduce((a, b) => a + b, 0) / closes4H.length;
    const rangePct = (range4H / avgPrice4H) * 100;

    if (rangePct < 5 && signal.volAccel && signal.volAccel < 1.5) {
      marketPhase = "ACCUMULATION";
    } else if (
      trend4H === "up" &&
      signal.priceChange24h &&
      signal.priceChange24h > 10
    ) {
      marketPhase = "BREAKOUT";
    } else if (
      trend4H === "down" &&
      signal.priceChange24h &&
      signal.priceChange24h < -5
    ) {
      marketPhase = "DISTRIBUTION";
    } else if (rangePct > 8 && Math.abs(signal.priceChange24h || 0) < 3) {
      marketPhase = "EXHAUST";
    }
  }

  // Calculate pre-spike score
  // Calculate pattern score using FVG/OB and ICT analysis (0-5 scale)
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
  if (ictAnalysis.location === "discount") preSpikeScore += 1;
  else if (ictAnalysis.location === "equilibrium") preSpikeScore += 0.5;

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

  // Estimate FVG and OB levels
  // Detect real FVG from Klines (use 1H for significant levels)
  const fvgs1H = bitunixTradeService.detectFVG(klines1H);
  const fvgLevels = fvgs1H.slice(-5).map((fvg) => ({
    price: (fvg.top + fvg.bottom) / 2,
    type: fvg.type,
    strength: 0.7,
  }));

  // Detect real Order Blocks from Klines (use 1H for significant levels)
  const obs1H = bitunixTradeService.detectOrderBlocks(klines1H);
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

  // Calculate alternative phase detection using RSI/OI method
  const marketPhaseAlt = calculateMarketPhase(
    signal.volSpike || 1,
    enhancedData?.openInterest?.change24h || 0,
    signal.rsi14 || 50,
    signal.priceChange24h || 0,
    signal.volAccel || 1,
  );

  return {
    priceLocation,

    marketPhase,
    marketPhaseAlt,
    preSpikeScore,
    fundingRate,
    fundingBias,
    longShortRatio,
    lsrBias,
    fvgLevels,
    obLevels,
    liquidationZones,
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

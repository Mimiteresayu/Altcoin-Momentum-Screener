interface RateLimiter {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number;
}

const rateLimiter: RateLimiter = {
  tokens: 80,
  lastRefill: Date.now(),
  maxTokens: 80,
  refillRate: 80 / 60000,
};

// Cache for API responses to reduce redundant calls
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<any>>();
const CACHE_TTL = 60000; // 1 minute cache TTL

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

function consumeToken(): Promise<void> {
  return new Promise((resolve) => {
    const now = Date.now();
    const elapsed = now - rateLimiter.lastRefill;
    rateLimiter.tokens = Math.min(
      rateLimiter.maxTokens,
      rateLimiter.tokens + elapsed * rateLimiter.refillRate
    );
    rateLimiter.lastRefill = now;

    if (rateLimiter.tokens >= 1) {
      rateLimiter.tokens -= 1;
      resolve();
    } else {
      const waitTime = (1 - rateLimiter.tokens) / rateLimiter.refillRate;
      setTimeout(() => {
        rateLimiter.tokens -= 1;
        resolve();
      }, waitTime);
    }
  });
}

const BASE_URL = "https://open-api-v3.coinglass.com/api";

function getApiKey(): string {
  const key = process.env.COINGLASS_API_KEY;
  if (!key) {
    throw new Error("COINGLASS_API_KEY environment variable is not set");
  }
  return key;
}

async function apiRequest<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
  await consumeToken();
  
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, String(value));
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "coinglassSecret": getApiKey(),
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Coinglass API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.code !== "0" && data.code !== 0) {
    throw new Error(`Coinglass API error: ${data.msg || "Unknown error"}`);
  }

  return data.data;
}

export interface OpenInterestData {
  time: number;
  openInterest: number;
  openInterestUsd: number;
}

export async function getOpenInterestHistory(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100
): Promise<OpenInterestData[]> {
  return apiRequest<OpenInterestData[]>("/futures/openInterest/ohlc-history", {
    symbol,
    interval,
    limit,
  });
}

export interface LiquidationData {
  time: number;
  longLiquidationUsd: number;
  shortLiquidationUsd: number;
}

export async function getLiquidationHistory(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100
): Promise<LiquidationData[]> {
  return apiRequest<LiquidationData[]>("/futures/liquidation/history", {
    symbol,
    interval,
    limit,
  });
}

export interface LiquidationMapData {
  price: number;
  longLiquidation: number;
  shortLiquidation: number;
}

export async function getLiquidationMap(
  symbol: string = "BTC"
): Promise<LiquidationMapData[]> {
  return apiRequest<LiquidationMapData[]>("/futures/liquidation/map", {
    symbol,
  });
}

export interface OrderbookWall {
  price: number;
  amount: number;
  side: "bid" | "ask";
}

export interface OrderbookData {
  bids: { price: number; amount: number }[];
  asks: { price: number; amount: number }[];
}

export async function getOrderbookWalls(
  symbol: string = "BTC"
): Promise<OrderbookWall[]> {
  const data = await apiRequest<OrderbookData>("/futures/orderbook/depth", {
    symbol,
  });

  const walls: OrderbookWall[] = [];
  const bidThreshold = Math.max(...data.bids.map(b => b.amount)) * 0.5;
  const askThreshold = Math.max(...data.asks.map(a => a.amount)) * 0.5;

  data.bids.forEach((bid) => {
    if (bid.amount >= bidThreshold) {
      walls.push({ price: bid.price, amount: bid.amount, side: "bid" });
    }
  });

  data.asks.forEach((ask) => {
    if (ask.amount >= askThreshold) {
      walls.push({ price: ask.price, amount: ask.amount, side: "ask" });
    }
  });

  return walls.sort((a, b) => b.amount - a.amount).slice(0, 10);
}

export interface LongShortRatioData {
  time: number;
  longRate: number;
  shortRate: number;
  longShortRatio: number;
}

export async function getLongShortRatio(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100
): Promise<LongShortRatioData[]> {
  return apiRequest<LongShortRatioData[]>("/futures/globalLongShortAccountRatio/history", {
    symbol,
    interval,
    limit,
  });
}

export interface TakerBuySellData {
  time: number;
  buyVolume: number;
  sellVolume: number;
  buySellRatio: number;
}

export async function getTakerBuySell(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100
): Promise<TakerBuySellData[]> {
  return apiRequest<TakerBuySellData[]>("/futures/takerBuySellVolume/history", {
    symbol,
    interval,
    limit,
  });
}

export interface FundingRateData {
  time: number;
  fundingRate: number;
  exchange: string;
}

export async function getFundingRate(
  symbol: string = "BTC"
): Promise<FundingRateData[]> {
  return apiRequest<FundingRateData[]>("/futures/fundingRate", {
    symbol,
  });
}

export interface FuturesBasisData {
  time: number;
  basis: number;
  basisRate: number;
}

export async function getFuturesBasis(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100
): Promise<FuturesBasisData[]> {
  return apiRequest<FuturesBasisData[]>("/futures/basis/history", {
    symbol,
    interval,
    limit,
  });
}

export interface FearGreedData {
  time: number;
  value: number;
  classification: string;
}

export async function getFearGreedIndex(): Promise<FearGreedData> {
  const data = await apiRequest<FearGreedData[]>("/index/fearGreed/history", {
    limit: 1,
  });
  return data[0];
}

export interface LiquidationAnalysis {
  maxPainLong: number;
  maxPainShort: number;
  totalLongLiquidation: number;
  totalShortLiquidation: number;
  liquidationBias: "long" | "short" | "neutral";
}

export interface OrderbookAnalysis {
  strongestSupport: number | null;
  strongestResistance: number | null;
  supportWalls: OrderbookWall[];
  resistanceWalls: OrderbookWall[];
}

export interface PositioningAnalysis {
  currentLongRatio: number;
  currentShortRatio: number;
  longShortRatio: number;
  trend: "long_dominant" | "short_dominant" | "balanced";
}

export interface FlowAnalysis {
  buyVolume: number;
  sellVolume: number;
  netFlow: number;
  flowBias: "buying" | "selling" | "neutral";
}

export interface FundingBasisAnalysis {
  averageFundingRate: number;
  fundingBias: "bullish" | "bearish" | "neutral";
  basis: number;
  basisRate: number;
}

export interface EnhancedMarketData {
  symbol: string;
  timestamp: number;
  liquidationAnalysis: LiquidationAnalysis;
  orderbookAnalysis: OrderbookAnalysis;
  positioningAnalysis: PositioningAnalysis;
  flowAnalysis: FlowAnalysis;
  fundingBasisAnalysis: FundingBasisAnalysis;
  fearGreed: FearGreedData;
  accumulationScore: number;
  distributionScore: number;
  momentumStrength: "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish";
}

function calculateAccumulationScore(
  flowAnalysis: FlowAnalysis,
  positioningAnalysis: PositioningAnalysis,
  fundingBasisAnalysis: FundingBasisAnalysis
): number {
  let score = 50;

  if (flowAnalysis.flowBias === "buying") score += 15;
  else if (flowAnalysis.flowBias === "selling") score -= 15;

  if (positioningAnalysis.trend === "long_dominant") score += 10;
  else if (positioningAnalysis.trend === "short_dominant") score -= 10;

  if (fundingBasisAnalysis.fundingBias === "bullish") score += 10;
  else if (fundingBasisAnalysis.fundingBias === "bearish") score -= 10;

  if (fundingBasisAnalysis.basisRate > 0) score += 5;
  else if (fundingBasisAnalysis.basisRate < 0) score -= 5;

  return Math.max(0, Math.min(100, score));
}

function calculateDistributionScore(accumulationScore: number): number {
  return 100 - accumulationScore;
}

function classifyMomentum(
  accumulationScore: number,
  flowAnalysis: FlowAnalysis,
  fearGreed: FearGreedData
): "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish" {
  const fearGreedValue = fearGreed.value;
  let momentumScore = accumulationScore;

  if (fearGreedValue >= 75) momentumScore += 10;
  else if (fearGreedValue >= 55) momentumScore += 5;
  else if (fearGreedValue <= 25) momentumScore -= 10;
  else if (fearGreedValue <= 45) momentumScore -= 5;

  const netFlowRatio = flowAnalysis.netFlow / (flowAnalysis.buyVolume + flowAnalysis.sellVolume || 1);
  if (netFlowRatio > 0.2) momentumScore += 10;
  else if (netFlowRatio < -0.2) momentumScore -= 10;

  if (momentumScore >= 75) return "strong_bullish";
  if (momentumScore >= 60) return "bullish";
  if (momentumScore <= 25) return "strong_bearish";
  if (momentumScore <= 40) return "bearish";
  return "neutral";
}

export async function getEnhancedMarketData(symbol: string = "BTC"): Promise<EnhancedMarketData> {
  // Check cache first to avoid redundant API calls
  const cacheKey = `enhanced_${symbol}`;
  const cached = getCached<EnhancedMarketData>(cacheKey);
  if (cached) {
    return cached;
  }

  const [
    liquidationMap,
    orderbookWalls,
    longShortRatio,
    takerBuySell,
    fundingRates,
    futuresBasis,
    fearGreed,
  ] = await Promise.all([
    getLiquidationMap(symbol).catch(() => [] as LiquidationMapData[]),
    getOrderbookWalls(symbol).catch(() => [] as OrderbookWall[]),
    getLongShortRatio(symbol, "1h", 1).catch(() => [] as LongShortRatioData[]),
    getTakerBuySell(symbol, "1h", 1).catch(() => [] as TakerBuySellData[]),
    getFundingRate(symbol).catch(() => [] as FundingRateData[]),
    getFuturesBasis(symbol, "1h", 1).catch(() => [] as FuturesBasisData[]),
    getFearGreedIndex().catch(() => ({ time: Date.now(), value: 50, classification: "Neutral" })),
  ]);

  const liquidationAnalysis: LiquidationAnalysis = {
    maxPainLong: 0,
    maxPainShort: 0,
    totalLongLiquidation: 0,
    totalShortLiquidation: 0,
    liquidationBias: "neutral",
  };

  if (liquidationMap.length > 0) {
    let maxLong = { price: 0, amount: 0 };
    let maxShort = { price: 0, amount: 0 };
    
    liquidationMap.forEach((level) => {
      liquidationAnalysis.totalLongLiquidation += level.longLiquidation;
      liquidationAnalysis.totalShortLiquidation += level.shortLiquidation;
      
      if (level.longLiquidation > maxLong.amount) {
        maxLong = { price: level.price, amount: level.longLiquidation };
      }
      if (level.shortLiquidation > maxShort.amount) {
        maxShort = { price: level.price, amount: level.shortLiquidation };
      }
    });

    liquidationAnalysis.maxPainLong = maxLong.price;
    liquidationAnalysis.maxPainShort = maxShort.price;
    
    const ratio = liquidationAnalysis.totalLongLiquidation / (liquidationAnalysis.totalShortLiquidation || 1);
    liquidationAnalysis.liquidationBias = ratio > 1.2 ? "long" : ratio < 0.8 ? "short" : "neutral";
  }

  const supportWalls = orderbookWalls.filter((w) => w.side === "bid");
  const resistanceWalls = orderbookWalls.filter((w) => w.side === "ask");

  const orderbookAnalysis: OrderbookAnalysis = {
    strongestSupport: supportWalls.length > 0 ? supportWalls[0].price : null,
    strongestResistance: resistanceWalls.length > 0 ? resistanceWalls[0].price : null,
    supportWalls,
    resistanceWalls,
  };

  const latestLongShort = longShortRatio[0];
  const positioningAnalysis: PositioningAnalysis = {
    currentLongRatio: latestLongShort?.longRate || 50,
    currentShortRatio: latestLongShort?.shortRate || 50,
    longShortRatio: latestLongShort?.longShortRatio || 1,
    trend: !latestLongShort
      ? "balanced"
      : latestLongShort.longShortRatio > 1.1
      ? "long_dominant"
      : latestLongShort.longShortRatio < 0.9
      ? "short_dominant"
      : "balanced",
  };

  const latestTakerFlow = takerBuySell[0];
  const flowAnalysis: FlowAnalysis = {
    buyVolume: latestTakerFlow?.buyVolume || 0,
    sellVolume: latestTakerFlow?.sellVolume || 0,
    netFlow: (latestTakerFlow?.buyVolume || 0) - (latestTakerFlow?.sellVolume || 0),
    flowBias: !latestTakerFlow
      ? "neutral"
      : latestTakerFlow.buySellRatio > 1.05
      ? "buying"
      : latestTakerFlow.buySellRatio < 0.95
      ? "selling"
      : "neutral",
  };

  const avgFundingRate = fundingRates.length > 0
    ? fundingRates.reduce((sum, fr) => sum + fr.fundingRate, 0) / fundingRates.length
    : 0;
  
  const latestBasis = futuresBasis[0];
  const fundingBasisAnalysis: FundingBasisAnalysis = {
    averageFundingRate: avgFundingRate,
    fundingBias: avgFundingRate > 0.0001 ? "bullish" : avgFundingRate < -0.0001 ? "bearish" : "neutral",
    basis: latestBasis?.basis || 0,
    basisRate: latestBasis?.basisRate || 0,
  };

  const accumulationScore = calculateAccumulationScore(flowAnalysis, positioningAnalysis, fundingBasisAnalysis);
  const distributionScore = calculateDistributionScore(accumulationScore);
  const momentumStrength = classifyMomentum(accumulationScore, flowAnalysis, fearGreed);

  const result: EnhancedMarketData = {
    symbol,
    timestamp: Date.now(),
    liquidationAnalysis,
    orderbookAnalysis,
    positioningAnalysis,
    flowAnalysis,
    fundingBasisAnalysis,
    fearGreed,
    accumulationScore,
    distributionScore,
    momentumStrength,
  };

  // Cache the result for 1 minute to reduce API calls on repeated requests
  setCache(cacheKey, result);

  return result;
}

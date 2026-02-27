interface RateLimiter {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number;
}

const rateLimiter: RateLimiter = {
  tokens: 10,
  lastRefill: Date.now(),
  maxTokens: 10,
  refillRate: 0.5, // 1 token per 2 seconds = 30 requests per minute
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
      rateLimiter.tokens + elapsed * rateLimiter.refillRate,
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
  
const BINANCE_FAPI = "https://fapi.binance.com";
const BITUNIX_FAPI = "https://fapi.bitunix.com";

async function binanceRequest<T>(path: string): Promise<T> {
  await consumeToken();
  const url = `${BINANCE_FAPI}${path}`;
  console.log(`[BINANCE] Calling: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance error: ${response.status}`);
  return response.json();
}

async function bitunixRequest<T>(path: string): Promise<T> {
  await consumeToken();
  const url = `${BITUNIX_FAPI}${path}`;
  console.log(`[BITUNIX] Calling: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Bitunix error: ${response.status}`);
  const data = await response.json();
  return data.data || data;
}


export interface OpenInterestData {
  time: number;
  openInterest: number;
  openInterestUsd: number;
}

export async function getOpenInterestHistory(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100,
): Promise<OpenInterestData[]> {
  const pair = `${symbol.toUpperCase()}USDT`;
  const data = await binanceRequest<any[]>(`/futures/data/openInterestHist?symbol=${pair}&period=${interval}&limit=${limit}`);
  return data.map((d: any) => ({ time: d.timestamp, openInterest: parseFloat(d.sumOpenInterest), openInterestUsd: parseFloat(d.sumOpenInterestValue) }));
}

export interface LiquidationData {
  time: number;
  longLiquidationUsd: number;
  shortLiquidationUsd: number;
}

export async function getLiquidationHistory(
  symbol: string = "BTC",
  interval: string = "1h",
  limit: number = 100,
): Promise<LiquidationData[]> {
  // No free liquidation history API - return empty
  return [];
}

export interface LiquidationMapData {
  price: number;
  longLiquidation: number;
  shortLiquidation: number;
}

export async function getLiquidationMap(
  symbol: string = "BTC",
): Promise<LiquidationMapData[]> {
  // No free liquidation map API - return empty
  return [];
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
  symbol: string = "BTC",
): Promise<OrderbookWall[]> {
  try {
      const pair = `${symbol.toUpperCase()}USDT`;
      const raw = await binanceRequest<any>(`/fapi/v1/depth?symbol=${pair}&limit=50`);
      const data = [...(raw.bids||[]).map((b: any) => ({price: parseFloat(b[0]), amount: parseFloat(b[1]), side: "buy"})), ...(raw.asks||[]).map((a: any) => ({price: parseFloat(a[0]), amount: parseFloat(a[1]), side: "sell"}))];

    const walls: OrderbookWall[] = [];
    if (!data || !Array.isArray(data)) return walls;

    data.forEach((order: any) => {
      if (order.price && order.amount) {
        walls.push({
          price: order.price,
          amount: order.amount,
          side: order.side === "buy" ? "bid" : "ask",
        });
      }
    });

    return walls.sort((a, b) => b.amount - a.amount).slice(0, 10);
  } catch {
    return [];
  }
}

export interface LongShortRatioData {
  time: number;
  longRate: number;
  shortRate: number;
  longShortRatio: number;
}

export async function getLongShortRatio(
  symbol: string = "BTC",
  interval: string = "h1",
  limit: number = 100,
  exchange: string = "Binance",
): Promise<LongShortRatioData[]> {
  try {
      const pair = `${symbol.toUpperCase()}USDT`;
      const periodMap: Record<string,string> = {"1h":"1h","h1":"1h","4h":"4h","h4":"4h","1d":"1d"};
      const p = periodMap[interval] || "1h";
      const data = await binanceRequest<any[]>(`/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=${p}&limit=${limit}`);
      return data.map((item: any) => ({
        time: item.timestamp,
        longRate: parseFloat(item.longAccount) * 100,
        shortRate: parseFloat(item.shortAccount) * 100,
        longShortRatio: parseFloat(item.longShortRatio),
      }));
  } catch {
    return [];
  }
}

export interface TakerBuySellData {
  time: number;
  buyVolume: number;
  sellVolume: number;
  buySellRatio: number;
}

export async function getTakerBuySell(
  symbol: string = "BTC",
  interval: string = "h1",
  limit: number = 100,
  exchange: string = "Binance",
): Promise<TakerBuySellData[]> {
  try {
      const pair = `${symbol.toUpperCase()}USDT`;
      const periodMap: Record<string,string> = {"1h":"1h","h1":"1h","4h":"4h","h4":"4h","1d":"1d"};
      const p = periodMap[interval] || "1h";
      const data = await binanceRequest<any[]>(`/futures/data/takerlongshortRatio?symbol=${pair}&period=${p}&limit=${limit}`);
      return data.map((item: any) => ({
        time: item.timestamp,
        buyVolume: parseFloat(item.buyVol),
        sellVolume: parseFloat(item.sellVol),
        buySellRatio: parseFloat(item.buySellRatio),
      }));
  } catch {
    return [];
  }
}

export interface FundingRateData {
  time: number;
  fundingRate: number;
  exchange: string;
}

export async function getFundingRate(
  symbol: string = "BTC",
): Promise<FundingRateData[]> {
  try {
      const pair = `${symbol.toUpperCase()}USDT`;
      const data = await binanceRequest<any[]>(`/fapi/v1/fundingRate?symbol=${pair}&limit=100`);
      return data.map((item: any) => ({
        time: item.fundingTime,
        fundingRate: parseFloat(item.fundingRate),
        exchange: "Binance",
      }));
  } catch {
    return [];
  }
}

export interface FuturesBasisData {
  time: number;
  basis: number;
  basisRate: number;
}

export async function getFuturesBasis(
  symbol: string = "BTC",
  interval: string = "h1",
  limit: number = 100,
  exchange: string = "Binance",
): Promise<FuturesBasisData[]> {
  try {
      // No free futures basis API - calculate from spot vs futures
      const pair = `${symbol.toUpperCase()}USDT`;
      const [spot, futures] = await Promise.all([
        fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`).then(r => r.json()),
        fetch(`${BINANCE_FAPI}/fapi/v1/ticker/price?symbol=${pair}`).then(r => r.json()),
      ]);
      const spotPrice = parseFloat(spot.price);
      const futuresPrice = parseFloat(futures.price);
      const basis = futuresPrice - spotPrice;
      const basisRate = (basis / spotPrice) * 100;
      return [{ time: Date.now(), basis, basisRate }];
  } catch {
    return [];
  }
}

export interface FearGreedData {
  time: number;
  value: number;
  classification: string;
}

export async function getFearGreedIndex(): Promise<FearGreedData> {
  try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1");
      const json = await res.json();
      const data = json.data?.map((d: any) => ({ time: parseInt(d.timestamp) * 1000, value: parseInt(d.value), classification: d.value_classification })) || [];
    if (Array.isArray(data) && data.length > 0) {
      const item = data[0];
      return {
        time: item.time || Date.now(),
        value: item.value || 50,
        classification:
          item.classification || getClassification(item.value || 50),
      };
    }
    return { time: Date.now(), value: 50, classification: "Neutral" };
  } catch {
    return { time: Date.now(), value: 50, classification: "Neutral" };
  }
}

function getClassification(value: number): string {
  if (value <= 25) return "Extreme Fear";
  if (value <= 45) return "Fear";
  if (value <= 55) return "Neutral";
  if (value <= 75) return "Greed";
  return "Extreme Greed";
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
  momentumStrength:
    | "strong_bullish"
    | "bullish"
    | "neutral"
    | "bearish"
    | "strong_bearish";
}

function calculateAccumulationScore(
  flowAnalysis: FlowAnalysis,
  positioningAnalysis: PositioningAnalysis,
  fundingBasisAnalysis: FundingBasisAnalysis,
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
  fearGreed: FearGreedData,
): "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish" {
  const fearGreedValue = fearGreed.value;
  let momentumScore = accumulationScore;

  if (fearGreedValue >= 75) momentumScore += 10;
  else if (fearGreedValue >= 55) momentumScore += 5;
  else if (fearGreedValue <= 25) momentumScore -= 10;
  else if (fearGreedValue <= 45) momentumScore -= 5;

  const netFlowRatio =
    flowAnalysis.netFlow /
    (flowAnalysis.buyVolume + flowAnalysis.sellVolume || 1);
  if (netFlowRatio > 0.2) momentumScore += 10;
  else if (netFlowRatio < -0.2) momentumScore -= 10;

  if (momentumScore >= 75) return "strong_bullish";
  if (momentumScore >= 60) return "bullish";
  if (momentumScore <= 25) return "strong_bearish";
  if (momentumScore <= 40) return "bearish";
  return "neutral";
}


export async function getEnhancedMarketData(
  symbol: string = "BTC",
): Promise<EnhancedMarketData> {
  // Check cache first to avoid redundant API calls
  const cacheKey = `enhanced_${symbol}`;
  const cached = getCached<EnhancedMarketData>(cacheKey);
  if (cached) {
    return cached;
  }

  console.log(`[ENHANCED-MARKET] Fetching data for ${symbol}...`);

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
    getLongShortRatio(symbol, "h1", 1).catch(() => [] as LongShortRatioData[]),
    getTakerBuySell(symbol, "h1", 1).catch(() => [] as TakerBuySellData[]),
    getFundingRate(symbol).catch(() => [] as FundingRateData[]),
    getFuturesBasis(symbol, "h1", 1).catch(() => [] as FuturesBasisData[]),
    getFearGreedIndex().catch(() => ({
      time: Date.now(),
      value: 50,
      classification: "Neutral",
    })),
  ]);

  console.log(
    `[ENHANCED-MARKET] Data fetched - funding rates: ${fundingRates.length}, fear/greed value: ${fearGreed.value}`,
  );

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

    const ratio =
      liquidationAnalysis.totalLongLiquidation /
      (liquidationAnalysis.totalShortLiquidation || 1);
    liquidationAnalysis.liquidationBias =
      ratio > 1.2 ? "long" : ratio < 0.8 ? "short" : "neutral";
  }

  const supportWalls = orderbookWalls.filter((w) => w.side === "bid");
  const resistanceWalls = orderbookWalls.filter((w) => w.side === "ask");

  const orderbookAnalysis: OrderbookAnalysis = {
    strongestSupport: supportWalls.length > 0 ? supportWalls[0].price : null,
    strongestResistance:
      resistanceWalls.length > 0 ? resistanceWalls[0].price : null,
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
    netFlow:
      (latestTakerFlow?.buyVolume || 0) - (latestTakerFlow?.sellVolume || 0),
    flowBias: !latestTakerFlow
      ? "neutral"
      : latestTakerFlow.buySellRatio > 1.05
        ? "buying"
        : latestTakerFlow.buySellRatio < 0.95
          ? "selling"
          : "neutral",
  };

  const validFundingRates = fundingRates.filter(
    (fr) => typeof fr.fundingRate === "number" && !isNaN(fr.fundingRate),
  );
  const avgFundingRate =
    validFundingRates.length > 0
      ? validFundingRates.reduce((sum, fr) => sum + fr.fundingRate, 0) /
        validFundingRates.length
      : 0;
  console.log(
    `[ENHANCED-MARKET] Avg funding rate: ${avgFundingRate}, from ${validFundingRates.length} entries`,
  );

  const latestBasis = futuresBasis[0];
  const fundingBasisAnalysis: FundingBasisAnalysis = {
    averageFundingRate: avgFundingRate,
    fundingBias:
      avgFundingRate > 0.0001
        ? "bullish"
        : avgFundingRate < -0.0001
          ? "bearish"
          : "neutral",
    basis: latestBasis?.basis || 0,
    basisRate: latestBasis?.basisRate || 0,
  };

  const accumulationScore = calculateAccumulationScore(
    flowAnalysis,
    positioningAnalysis,
    fundingBasisAnalysis,
  );
  const distributionScore = calculateDistributionScore(accumulationScore);
  const momentumStrength = classifyMomentum(
    accumulationScore,
    flowAnalysis,
    fearGreed,
  );

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

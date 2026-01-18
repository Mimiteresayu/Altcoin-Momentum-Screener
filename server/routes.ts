import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { notifyNewSignals, isDiscordConfigured } from "./discord";
import { initializeWebSocket, getConnectedClientsCount } from "./websocket";
import { backtestingService } from "./backtest";
import axios from "axios";
import { RSI } from "technicalindicators";

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OrderBookData {
  bids: [string, string][];
  asks: [string, string][];
}

interface LiquidityCluster {
  price: number;
  strength: number;
}

const MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const UPDATE_FREQUENCY_MINUTES = 5;

// Cache for OI data from Coinglass/Binance
let oiDataCache: Map<string, number> = new Map();
let binanceOiHistory: Map<string, number> = new Map(); // Binance-only history for change calculation
let oiLastFetched: Date | null = null;
let oiDataSource: "coinglass" | "binance" | null = null;
const OI_CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Liquidation level estimation cache
let liquidationCache: Map<
  string,
  { price: number; volume: number; direction: string }[]
> = new Map();
let liquidationCacheTime: Map<string, number> = new Map();
const LIQUIDATION_CACHE_TTL_MS = 60 * 1000; // 1 minute

// Fetch Open Interest from Binance Futures API (free, no key required)
async function fetchBinanceOpenInterest(
  symbol: string,
): Promise<number | null> {
  try {
    const binanceSymbol = symbol.replace("USDC", "USDT");
    const response = await axios.get(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${binanceSymbol}`,
      { timeout: 5000 },
    );
    if (response.data?.openInterest) {
      return parseFloat(response.data.openInterest);
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch OI from Coinalyze API for multiple symbols
async function fetchCoinalyzeOpenInterest(
  symbols: string[],
  apiKey: string,
): Promise<Map<string, number>> {
  const newCache = new Map<string, number>();

  // Coinalyze symbol format: oiDataCache.get_PERP.A (Binance perpetual)
  // Max 20 symbols per request, rate limit 40 req/min
  const batchSize = 20;
  const symbolBatches: string[][] = [];

  for (let i = 0; i < symbols.length; i += batchSize) {
    symbolBatches.push(symbols.slice(i, i + batchSize));
  }

  console.log(
    `[OI] Trying Coinalyze: ${symbols.length} symbols in ${symbolBatches.length} batch(es)...`,
  );

  for (let i = 0; i < symbolBatches.length; i++) {
    const batch = symbolBatches[i];

    for (let retry = 0; retry < 2; retry++) {
      try {
        // Format: BTCUSDT -> BTCUSDT_PERP.A (Binance perpetual)
        const formattedSymbols = batch.map((s) => `${s}_PERP.A`).join(",");

        const response = await axios.get(
          "https://api.coinalyze.net/v1/open-interest-history",
          {
            headers: {
              Accept: "application/json",
              "api-key": apiKey,
            },
            params: {
              symbols: formattedSymbols,
              interval: "daily",
              from: Math.floor(Date.now() / 1000) - 86400 * 2, // 2 days ago
              to: Math.floor(Date.now() / 1000),
              convert_to_usd: "true",
            },
            timeout: 15000,
          },
        );

        if (response.data && Array.isArray(response.data)) {
          for (const item of response.data) {
            // Parse symbol back: BTCUSDT_PERP.A -> BTCUSDT
            const symbol = item.symbol?.replace(/_PERP\.A$/, "") || "";
            const history = item.history || [];

            if (history.length >= 2) {
              // Calculate 24h change from history
              const latestOI =
                history[history.length - 1]?.c ||
                history[history.length - 1]?.o ||
                0;
              const prevOI = history[0]?.c || history[0]?.o || 0;

              if (prevOI > 0) {
                const changePercent = ((latestOI - prevOI) / prevOI) * 100;
                newCache.set(symbol, changePercent);
              }
            }
          }
          console.log(
            `[OI] Coinalyze batch ${i + 1}/${symbolBatches.length}: ${newCache.size} OI values`,
          );
        }
        break; // Success, exit retry loop
      } catch (error: any) {
        const status = error?.response?.status;
        const retryAfter = error?.response?.headers?.["retry-after"];
        const errMsg = error?.response?.data?.message || error?.message;

        if (status === 429 && retry < 1) {
          // Rate limited - wait and retry
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
          console.log(`[OI] Rate limited, waiting ${waitTime / 1000}s...`);
          await new Promise((r) => setTimeout(r, waitTime));
          continue;
        }

        console.log(`[OI] Coinalyze error:`, errMsg);
        break;
      }
    }

    // Delay between batches to respect rate limit (40/min = 3s between for safety)
    if (i < symbolBatches.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return newCache;
}

// Main OI fetcher with Binance fallback - called by signal calculation
async function fetchOpenInterestWithBinanceFallback(
  symbols: string[],
): Promise<Map<string, number>> {
  // Return cached data if fresh
  if (
    oiLastFetched &&
    Date.now() - oiLastFetched.getTime() < OI_CACHE_DURATION_MS &&
    oiDataCache.size > 0
  ) {
    return oiDataCache;
  }

  const apiKey = process.env.COINALYZE_API_KEY;

  // Try Coinalyze first if API key is available
  if (apiKey) {
    try {
      // Priority symbols for OI data - include major coins AND the actual symbols being processed
      const majorSymbols = [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "DOGEUSDT",
        "BNBUSDT",
        "ADAUSDT",
        "AVAXUSDT",
        "LINKUSDT",
        "DOTUSDT",
        "LTCUSDT",
        "UNIUSDT",
        "NEARUSDT",
        "AAVEUSDT",
      ];
      // Prioritize actual symbols first, then major symbols (limit to 40 to stay within rate limits)
      const usdtSymbols = symbols.filter((s) => s.endsWith("USDT"));
      const allSymbols = Array.from(
        new Set([...usdtSymbols, ...majorSymbols]),
      ).slice(0, 40);

      const coinalyzeData = await fetchCoinalyzeOpenInterest(
        allSymbols,
        apiKey,
      );

      if (coinalyzeData.size > 0) {
        oiDataCache = coinalyzeData;
        oiLastFetched = new Date();
        oiDataSource = "coinglass"; // Keep label for UI
        binanceOiHistory.clear();
        console.log(
          `[OI] Fetched OI data from Coinalyze for ${coinalyzeData.size} symbols`,
        );
        return coinalyzeData;
      }
    } catch (error: any) {
      console.log(
        "[OI] Coinalyze failed, falling back to Binance:",
        error?.message,
      );
    }
  }

  // Fallback: Use Binance free API (requires 2+ fetches for delta calculation)
  const isFirstFetch = binanceOiHistory.size === 0;
  console.log(
    `[OI] Using Binance fallback for OI data (${isFirstFetch ? "first fetch - storing baseline" : "calculating deltas"})`,
  );

  // Create new cache, preserving existing values
  const newCache = new Map<string, number>(oiDataCache);

  // Fetch more symbols (30) and prioritize major + high volume coins
  const prioritySymbols = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "BNBUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
    "LTCUSDT",
    "UNIUSDT",
    "NEARUSDT",
    "AAVEUSDT",
  ];
  const allSymbols = [
    ...prioritySymbols,
    ...symbols.filter((s) => s.endsWith("USDT")),
  ];
  const symbolsToFetch = Array.from(new Set(allSymbols)).slice(0, 30);

  let fetchedCount = 0;
  let deltaCount = 0;

  for (const symbol of symbolsToFetch) {
    try {
      const currentOI = await fetchBinanceOpenInterest(symbol);
      if (currentOI !== null) {
        fetchedCount++;
        const prevOI = binanceOiHistory.get(symbol);

        if (prevOI !== undefined && prevOI > 0) {
          // Calculate delta - even if change is 0%, it's still valid data
          const changePercent = ((currentOI - prevOI) / prevOI) * 100;
          newCache.set(symbol, changePercent);
          deltaCount++;
        } else if (!isFirstFetch) {
          // If not first fetch but no previous value, set to 0% (new symbol)
          newCache.set(symbol, 0);
        }

        // Always store current value for next comparison
        binanceOiHistory.set(symbol, currentOI);
      }
      await new Promise((r) => setTimeout(r, 80)); // Rate limit protection
    } catch {
      // Skip this symbol on error
    }
  }

  // Always update cache if we fetched anything
  if (fetchedCount > 0) {
    oiDataCache = newCache;
    oiLastFetched = new Date();
    oiDataSource = "binance";

    if (deltaCount > 0) {
      console.log(
        `[OI] Binance: ${deltaCount}/${fetchedCount} symbols with OI delta`,
      );
    } else {
      console.log(
        `[OI] Binance: stored ${fetchedCount} baseline values - deltas on next fetch (~5min)`,
      );
    }
  }

  return oiDataCache;
}

// Estimate liquidation levels based on leverage clusters and orderbook
function estimateLiquidationLevels(
  symbol: string,
  currentPrice: number,
  orderBook: OrderBookData | null,
): { price: number; volume: number; direction: string }[] {
  // Check cache with TTL
  const cached = liquidationCache.get(symbol);
  const cachedTime = liquidationCacheTime.get(symbol);
  if (
    cached &&
    cachedTime &&
    Date.now() - cachedTime < LIQUIDATION_CACHE_TTL_MS
  ) {
    return cached;
  }

  const levels: { price: number; volume: number; direction: string }[] = [];
  const leverageLevels = [10, 20, 50, 100]; // Common leverage levels

  for (const leverage of leverageLevels) {
    // Long liquidations below current price
    const longLiqPrice = currentPrice * (1 - 0.9 / leverage);
    // Short liquidations above current price
    const shortLiqPrice = currentPrice * (1 + 0.9 / leverage);

    if (longLiqPrice > currentPrice * 0.85) {
      levels.push({
        price: longLiqPrice,
        volume: leverage,
        direction: "long_liq",
      });
    }
    if (shortLiqPrice < currentPrice * 1.15) {
      levels.push({
        price: shortLiqPrice,
        volume: leverage,
        direction: "short_liq",
      });
    }
  }

  // Add orderbook walls as liquidation zones
  if (orderBook && orderBook.bids.length > 0 && orderBook.asks.length > 0) {
    const avgBidQty =
      orderBook.bids.reduce((s, [, q]) => s + parseFloat(q), 0) /
      orderBook.bids.length;
    const avgAskQty =
      orderBook.asks.reduce((s, [, q]) => s + parseFloat(q), 0) /
      orderBook.asks.length;

    for (const [price, qty] of orderBook.bids) {
      const p = parseFloat(price),
        q = parseFloat(qty);
      if (
        q > avgBidQty * 3 &&
        p < currentPrice * 0.98 &&
        p > currentPrice * 0.85
      ) {
        levels.push({
          price: p,
          volume: q / avgBidQty,
          direction: "support_wall",
        });
      }
    }
    for (const [price, qty] of orderBook.asks) {
      const p = parseFloat(price),
        q = parseFloat(qty);
      if (
        q > avgAskQty * 3 &&
        p > currentPrice * 1.02 &&
        p < currentPrice * 1.15
      ) {
        levels.push({
          price: p,
          volume: q / avgAskQty,
          direction: "resistance_wall",
        });
      }
    }
  }

  levels.sort(
    (a, b) =>
      Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice),
  );
  const result = levels.slice(0, 5);

  liquidationCache.set(symbol, result);
  liquidationCacheTime.set(symbol, Date.now());

  return result;
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number = 100,
): Promise<Kline[]> {
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url, { timeout: 8000 });

    if (response.data?.data && Array.isArray(response.data.data)) {
      return response.data.data
        .map((k: any) => ({
          openTime: parseInt(k.time),
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.quoteVol),
        }))
        .reverse();
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchOrderBook(symbol: string): Promise<OrderBookData | null> {
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/depth?symbol=${symbol}&limit=50`;
    const response = await axios.get(url, { timeout: 5000 });

    if (response.data?.data) {
      return {
        bids: response.data.data.bids || [],
        asks: response.data.data.asks || [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function calculateRSI(closes: number[]): number {
  if (closes.length < 15) return 50;

  const rsiResult = RSI.calculate({
    values: closes,
    period: 14,
  });

  return rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : 50;
}

function calculateVolumeSpike(volumes: number[]): number {
  if (volumes.length < 21) return 1;

  const recentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  return avgVolume > 0 ? recentVolume / avgVolume : 1;
}

// Volume Acceleration Detector: catches spike as it starts
// Compares current 1H volume to average of last 4 hours
function calculateVolumeAcceleration(volumes: number[]): number {
  if (volumes.length < 5) return 1;

  const current1HVolume = volumes[volumes.length - 1];
  const last4HVolumes = volumes.slice(-5, -1);
  const avg4HVolume = last4HVolumes.reduce((a, b) => a + b, 0) / 4;

  return avg4HVolume > 0 ? current1HVolume / avg4HVolume : 1;
}

function findSwingLows(klines: Kline[], count: number = 3): number[] {
  if (klines.length < 10) return [klines[klines.length - 1]?.low || 0];

  const swingLows: number[] = [];

  for (let i = 2; i < klines.length - 2 && swingLows.length < count; i++) {
    const current = klines[i];
    if (
      current.low < klines[i - 1].low &&
      current.low < klines[i - 2].low &&
      current.low < klines[i + 1].low &&
      current.low < klines[i + 2].low
    ) {
      swingLows.push(current.low);
    }
  }

  if (swingLows.length === 0) {
    swingLows.push(Math.min(...klines.slice(-20).map((k) => k.low)));
  }

  return swingLows.sort((a, b) => b - a);
}

function findSwingHighs(klines: Kline[], count: number = 3): number[] {
  if (klines.length < 10) return [klines[klines.length - 1]?.high || 0];

  const swingHighs: number[] = [];

  for (let i = 2; i < klines.length - 2 && swingHighs.length < count; i++) {
    const current = klines[i];
    if (
      current.high > klines[i - 1].high &&
      current.high > klines[i - 2].high &&
      current.high > klines[i + 1].high &&
      current.high > klines[i + 2].high
    ) {
      swingHighs.push(current.high);
    }
  }

  if (swingHighs.length === 0) {
    swingHighs.push(Math.max(...klines.slice(-20).map((k) => k.high)));
  }

  return swingHighs.sort((a, b) => a - b);
}

interface FVG {
  type: "bullish" | "bearish";
  level: number;
}

function detectFairValueGap(klines: Kline[]): FVG | null {
  if (klines.length < 10) return null;

  const recent = klines.slice(-10);

  for (let i = recent.length - 3; i >= 0; i--) {
    const candle1 = recent[i];
    const candle2 = recent[i + 1];
    const candle3 = recent[i + 2];

    if (candle3.low > candle1.high) {
      return { type: "bullish", level: (candle1.high + candle3.low) / 2 };
    }

    if (candle3.high < candle1.low) {
      return { type: "bearish", level: (candle1.low + candle3.high) / 2 };
    }
  }

  return null;
}

interface OrderBlock {
  type: "bullish" | "bearish";
  level: number;
}

function detectOrderBlock(klines: Kline[]): OrderBlock | null {
  if (klines.length < 15) return null;

  const recent = klines.slice(-15);
  const avgVolume =
    recent.reduce((sum, k) => sum + k.volume, 0) / recent.length;

  for (let i = recent.length - 5; i >= 0; i--) {
    const candle = recent[i];

    if (candle.volume > avgVolume * 2) {
      const isBullish = candle.close > candle.open;

      if (isBullish) {
        let confirmed = true;
        for (let j = i + 1; j < recent.length && j < i + 4; j++) {
          if (recent[j].close < candle.low) {
            confirmed = false;
            break;
          }
        }
        if (confirmed) {
          return { type: "bullish", level: candle.low };
        }
      } else {
        let confirmed = true;
        for (let j = i + 1; j < recent.length && j < i + 4; j++) {
          if (recent[j].close > candle.high) {
            confirmed = false;
            break;
          }
        }
        if (confirmed) {
          return { type: "bearish", level: candle.high };
        }
      }
    }
  }

  return null;
}

function detectLiquidityClusters(
  orderBook: OrderBookData | null,
  currentPrice: number,
): LiquidityCluster[] {
  if (!orderBook || !orderBook.asks.length) return [];

  const clusters: LiquidityCluster[] = [];
  let totalAskVolume = 0;

  for (const [price, qty] of orderBook.asks) {
    totalAskVolume += parseFloat(qty);
  }

  const avgAskVolume = totalAskVolume / orderBook.asks.length;

  for (const [price, qty] of orderBook.asks) {
    const priceNum = parseFloat(price);
    const qtyNum = parseFloat(qty);

    if (qtyNum > avgAskVolume * 2 && priceNum > currentPrice) {
      clusters.push({
        price: priceNum,
        strength: qtyNum / avgAskVolume,
      });
    }
  }

  return clusters.sort((a, b) => a.price - b.price).slice(0, 3);
}

function calculateOrderBookImbalance(orderBook: OrderBookData | null): {
  imbalance: number;
  bidAskRatio: number;
} {
  if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
    return { imbalance: 0, bidAskRatio: 1 };
  }

  const bidVolume = orderBook.bids.reduce(
    (sum, [, qty]) => sum + parseFloat(qty),
    0,
  );
  const askVolume = orderBook.asks.reduce(
    (sum, [, qty]) => sum + parseFloat(qty),
    0,
  );

  const total = bidVolume + askVolume;
  const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0;
  const bidAskRatio = askVolume > 0 ? bidVolume / askVolume : 1;

  return { imbalance, bidAskRatio };
}

interface TPLevels {
  levels: { label: string; price: number; pct: number; reason: string }[];
}

function calculateMultipleTPLevels(
  currentPrice: number,
  swingHighs: number[],
  liquidityClusters: LiquidityCluster[],
  fvg: FVG | null,
  ob: OrderBlock | null,
): TPLevels {
  const targets: { price: number; reason: string }[] = [];

  for (const high of swingHighs) {
    if (high > currentPrice && high < currentPrice * 1.5) {
      targets.push({ price: high, reason: "Swing High" });
    }
  }

  for (const cluster of liquidityClusters) {
    if (cluster.price > currentPrice && cluster.price < currentPrice * 1.5) {
      targets.push({ price: cluster.price, reason: "Liquidity Zone" });
    }
  }

  if (fvg && fvg.type === "bearish" && fvg.level > currentPrice) {
    targets.push({ price: fvg.level, reason: "FVG Resistance" });
  }

  if (ob && ob.type === "bearish" && ob.level > currentPrice) {
    targets.push({ price: ob.level, reason: "Order Block" });
  }

  targets.sort((a, b) => a.price - b.price);

  const levels: {
    label: string;
    price: number;
    pct: number;
    reason: string;
  }[] = [];

  if (targets.length >= 1) {
    const tp1 = targets[0];
    levels.push({
      label: "TP1",
      price: tp1.price,
      pct: ((tp1.price - currentPrice) / currentPrice) * 100,
      reason: tp1.reason,
    });
  } else {
    levels.push({
      label: "TP1",
      price: currentPrice * 1.05,
      pct: 5,
      reason: "5% Target",
    });
  }

  if (targets.length >= 2) {
    const tp2 = targets[1];
    levels.push({
      label: "TP2",
      price: tp2.price,
      pct: ((tp2.price - currentPrice) / currentPrice) * 100,
      reason: tp2.reason,
    });
  } else {
    levels.push({
      label: "TP2",
      price: currentPrice * 1.1,
      pct: 10,
      reason: "10% Target",
    });
  }

  if (targets.length >= 3) {
    const tp3 = targets[2];
    levels.push({
      label: "TP3",
      price: tp3.price,
      pct: ((tp3.price - currentPrice) / currentPrice) * 100,
      reason: tp3.reason,
    });
  } else {
    levels.push({
      label: "TP3",
      price: currentPrice * 1.15,
      pct: 15,
      reason: "15% Target",
    });
  }

  return { levels };
}

function calculateSL(
  currentPrice: number,
  swingLows: number[],
  fvg: FVG | null,
  ob: OrderBlock | null,
): { sl: number; slReason: string } {
  let sl = currentPrice * 0.95;
  let slReason = "5% below entry";

  if (
    ob &&
    ob.type === "bullish" &&
    ob.level < currentPrice &&
    ob.level > currentPrice * 0.92
  ) {
    sl = ob.level * 0.995;
    slReason = "Below Order Block";
  } else if (
    fvg &&
    fvg.type === "bullish" &&
    fvg.level < currentPrice &&
    fvg.level > currentPrice * 0.92
  ) {
    sl = fvg.level * 0.995;
    slReason = "Below FVG";
  } else if (
    swingLows.length > 0 &&
    swingLows[0] < currentPrice &&
    swingLows[0] > currentPrice * 0.92
  ) {
    sl = swingLows[0] * 0.995;
    slReason = "Below Swing Low";
  }

  return { sl, slReason };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  let cachedSignals: any[] = [];
  let isCalculating = false;
  let lastUpdated: Date = new Date();

  // Track when each symbol first appeared on the signal list
  const symbolFirstSeen: Map<string, Date> = new Map();
  // Track when a symbol was last seen on the list (for grace period cleanup)
  const symbolLastSeen: Map<string, Date> = new Map();
  // Grace period before removing a symbol from tracking (30 minutes)
  const TRACKING_GRACE_PERIOD_MS = 30 * 60 * 1000;

  // Calculate spike readiness based on time on list
  function getSpikeReadiness(
    minutesOnList: number,
  ): "warming" | "primed" | "hot" | "overdue" {
    if (minutesOnList < 5) return "warming"; // Just appeared, building momentum
    if (minutesOnList >= 5 && minutesOnList < 15) return "primed"; // Optimal window for spike
    if (minutesOnList >= 15 && minutesOnList < 30) return "hot"; // Spike likely imminent
    return "overdue"; // May have already spiked or false signal
  }

  async function calculateSignals() {
    if (isCalculating) return;
    isCalculating = true;

    try {
      console.log("Starting signal calculation...");
      const response = await axios.get(
        "https://fapi.bitunix.com/api/v1/futures/market/tickers",
      );
      const rawData = response.data.data;

      if (!Array.isArray(rawData)) {
        isCalculating = false;
        return;
      }

      const signals: any[] = [];

      // Get watchlist to prioritize those symbols
      const watchlist = await storage.getWatchlist();
      const watchlistSymbols = watchlist.map((w) => w.symbol);

      const allSymbols = rawData.filter((t: any) => {
        const price = parseFloat(t.lastPrice);
        const open = parseFloat(t.open);
        return price > 0 && open > 0 && !isNaN(price) && !isNaN(open);
      });

      // Priority 1: Major pairs (BTC, ETH)
      const majorSymbols = allSymbols.filter((t: any) =>
        MAJOR_SYMBOLS.includes(t.symbol),
      );

      // Priority 2: Watchlist symbols (always analyze regardless of volume)
      const watchedSymbols = allSymbols.filter(
        (t: any) =>
          watchlistSymbols.includes(t.symbol) &&
          !MAJOR_SYMBOLS.includes(t.symbol),
      );

      // Priority 3: Top 50 by volume (excluding already selected)
      const selectedSymbols = new Set([...MAJOR_SYMBOLS, ...watchlistSymbols]);
      const otherSymbols = allSymbols
        .filter((t: any) => !selectedSymbols.has(t.symbol))
        .sort(
          (a: any, b: any) => parseFloat(b.quoteVol) - parseFloat(a.quoteVol),
        )
        .slice(0, 50);

      // Priority 4: High movers (>10% change) not already selected - catch early spikes!
      const highMovers = allSymbols
        .filter((t: any) => {
          if (selectedSymbols.has(t.symbol)) return false;
          const price = parseFloat(t.lastPrice);
          const open = parseFloat(t.open);
          const change = ((price - open) / open) * 100;
          return change >= 10 || change <= -10; // Big movers either direction
        })
        .slice(0, 20);

      const symbolsToProcess = [
        ...majorSymbols,
        ...watchedSymbols,
        ...otherSymbols,
        ...highMovers,
      ];
      // Remove duplicates
      const uniqueSymbols = Array.from(
        new Map(symbolsToProcess.map((s) => [s.symbol, s])).values(),
      );

      console.log(
        `Processing ${uniqueSymbols.length} symbols (${majorSymbols.length} major, ${watchedSymbols.length} watched, ${otherSymbols.length} top volume, ${highMovers.length} high movers)...`,
      );

      // Fetch OI data for all symbols (with Binance fallback if no Coinglass API key)
      const symbolList = uniqueSymbols.map((s: any) => s.symbol);
      const oiData = await fetchOpenInterestWithBinanceFallback(symbolList);

      for (const item of uniqueSymbols) {
        try {
          const currentPrice = parseFloat(item.lastPrice);
          const openPrice = parseFloat(item.open);
          const isMajor = MAJOR_SYMBOLS.includes(item.symbol);

          if (
            !currentPrice ||
            !openPrice ||
            currentPrice === 0 ||
            openPrice === 0
          )
            continue;

          const priceChange24h = ((currentPrice - openPrice) / openPrice) * 100;
          if (isNaN(priceChange24h)) continue;

          const [klines1H, klines15M, orderBook] = await Promise.all([
            fetchKlines(item.symbol, "1h", 100),
            fetchKlines(item.symbol, "15m", 100),
            fetchOrderBook(item.symbol),
          ]);

          const closes1H = klines1H.map((k) => k.close);
          const volumes1H = klines1H.map((k) => k.volume);
          const closes15M = klines15M.map((k) => k.close);
          const volumes15M = klines15M.map((k) => k.volume);

          const rsi1H = calculateRSI(closes1H);
          const rsi15M = calculateRSI(closes15M);
          const volumeSpike1H = calculateVolumeSpike(volumes1H);
          const volumeSpike15M = calculateVolumeSpike(volumes15M);

          // Volume Acceleration: catches spike as it starts (current1H / avg4H)
          const volAccel = calculateVolumeAcceleration(volumes1H);
          const isAccelerating = volAccel >= 2.0; // Flag if volume is 2x+ the 4H average

          const swingLows = findSwingLows(klines1H, 3);
          const swingHighs = findSwingHighs(klines1H, 3);

          const fvg = detectFairValueGap(klines1H);
          const ob = detectOrderBlock(klines1H);
          const liquidityClusters = detectLiquidityClusters(
            orderBook,
            currentPrice,
          );
          const { imbalance, bidAskRatio } =
            calculateOrderBookImbalance(orderBook);

          const rsi = rsi1H;
          const volumeSpikeRatio = volumeSpike1H;

          // Get OI data for this symbol
          const oiChange24h = oiData.get(item.symbol) ?? null;
          const hasVolAlert = volumeSpikeRatio > 2.0; // VOL ALERT badge for > 2.0x

          const { sl, slReason } = calculateSL(
            currentPrice,
            swingLows,
            fvg,
            ob,
          );
          const { levels: tpLevels } = calculateMultipleTPLevels(
            currentPrice,
            swingHighs,
            liquidityClusters,
            fvg,
            ob,
          );

          const risk = currentPrice - sl;
          const reward = tpLevels[1]?.price
            ? tpLevels[1].price - currentPrice
            : currentPrice * 0.1;
          const riskReward = risk > 0 ? reward / risk : 0;

          // FOUR SIGNAL CATEGORIES for comprehensive coverage
          // Priority 0: HOT MOMENTUM - Big movers that are spiking hard (highest priority)
          // Priority 1: ACTIVE MOMENTUM - Coins actively spiking
          // Priority 2: PRE-CONSOLIDATION - Coins before spike
          // Priority 3: MAJOR - BTC/ETH with relaxed criteria

          const hasLeadingIndicators =
            fvg !== null ||
            ob !== null ||
            bidAskRatio > 1.1 ||
            liquidityClusters.length > 0;

          // HOT MOMENTUM criteria (Priority 0): Price >= +20%, VOL >= 2.0x
          // This catches coins like FHE (+61%), DOLO (+26%) that are big movers with explosive volume
          const isHotMomentum = priceChange24h >= 20 && volumeSpikeRatio >= 2.0;

          // ACTIVE MOMENTUM criteria (Priority 1): VOL >= 1.0x (was 1.5x), Price +5% to +60%, RSI 50-85
          const isActiveMomentum =
            !isHotMomentum &&
            volumeSpikeRatio >= 1.0 &&
            priceChange24h >= 5 &&
            priceChange24h <= 60 &&
            rsi >= 50 &&
            rsi <= 85;

          // PRE-CONSOLIDATION criteria (Priority 2): VOL 0.5-1.0x (was 0.3-1.5x), Price -8% to +15%, RSI 35-65
          const isPreConsolidation =
            volumeSpikeRatio >= 0.5 &&
            volumeSpikeRatio < 1.0 &&
            priceChange24h >= -8 &&
            priceChange24h <= 15 &&
            rsi >= 35 &&
            rsi <= 65;

          // MAJOR criteria: VOL >= 0.5x, any price range
          const isMajorQualified = isMajor && volumeSpikeRatio >= 0.5;

          // Determine signal type (priority order: HOT > MAJOR > ACTIVE > PRE)
          let signalType: "HOT" | "ACTIVE" | "PRE" | "MAJOR" | null = null;
          if (isHotMomentum) {
            signalType = "HOT";
          } else if (isMajorQualified) {
            signalType = "MAJOR";
          } else if (isActiveMomentum) {
            signalType = "ACTIVE";
          } else if (isPreConsolidation) {
            signalType = "PRE";
          }

          // Filter out if doesn't match any category
          if (signalType === null) {
            if (priceChange24h >= 10 || volumeSpikeRatio >= 2.0) {
              console.log(
                `[FILTERED] ${item.symbol}: price=${priceChange24h.toFixed(1)}% rsi=${rsi.toFixed(0)} vol=${volumeSpikeRatio.toFixed(2)}x oi=${oiChange24h?.toFixed(1) ?? "N/A"}% - no category match`,
              );
            }
            continue;
          }

          // Calculate signal strength based on category
          let signalStrength = 0;
          const priceInRange =
            signalType === "HOT"
              ? priceChange24h >= 20
              : signalType === "ACTIVE"
                ? priceChange24h >= 5 && priceChange24h <= 60
                : priceChange24h >= -8 && priceChange24h <= 15;
          const volumeInRange =
            signalType === "HOT"
              ? volumeSpikeRatio >= 2.0
              : signalType === "ACTIVE"
                ? volumeSpikeRatio >= 1.0
                : volumeSpikeRatio >= 0.5 && volumeSpikeRatio < 1.0;
          const rsiInRange =
            signalType === "ACTIVE"
              ? rsi >= 50 && rsi <= 85
              : rsi >= 35 && rsi <= 65;
          const rrInRange = riskReward >= 1.5;

          if (priceInRange) signalStrength++;
          if (volumeInRange) signalStrength++;
          if (rsiInRange) signalStrength++;
          if (rrInRange) signalStrength++;
          if (hasLeadingIndicators) signalStrength++;

          // Timeframe confirmation: ultra-low volume threshold for consolidation detection
          const tf1HConfirmed =
            rsi1H >= 35 && rsi1H <= 80 && volumeSpike1H >= 0.3;
          const tf15MConfirmed =
            rsi15M >= 35 && rsi15M <= 80 && volumeSpike15M >= 0.3;

          const confirmedTimeframes: string[] = [];
          if (tf1HConfirmed) confirmedTimeframes.push("1H");
          if (tf15MConfirmed) confirmedTimeframes.push("15M");

          const slDistancePct = ((currentPrice - sl) / currentPrice) * 100;

          const hasLiquidityZone = liquidityClusters.length > 0;

          // Estimate liquidation levels
          const liquidationLevels = estimateLiquidationLevels(
            item.symbol,
            currentPrice,
            orderBook,
          );

          // Track time on list for this symbol
          const now = new Date();
          if (!symbolFirstSeen.has(item.symbol)) {
            symbolFirstSeen.set(item.symbol, now);
          }
          // Update last seen time for grace period tracking
          symbolLastSeen.set(item.symbol, now);

          const firstSeen = symbolFirstSeen.get(item.symbol)!;
          const timeOnListMinutes = Math.floor(
            (now.getTime() - firstSeen.getTime()) / 60000,
          );
          const spikeReadiness = getSpikeReadiness(timeOnListMinutes);

          // Determine trade direction: LONG or SHORT based on comprehensive analysis
          // Uses balanced scoring system to avoid bias
          const determineSide = (): "LONG" | "SHORT" => {
            let longScore = 0;
            let shortScore = 0;

            // Factor 1: Price trend direction (primary indicator, weight: 3)
            if (priceChange24h >= 5) longScore += 3;
            else if (priceChange24h >= 2) longScore += 2;
            else if (priceChange24h >= 0) longScore += 1;
            else if (priceChange24h <= -5) shortScore += 3;
            else if (priceChange24h <= -2) shortScore += 2;
            else shortScore += 1; // priceChange24h < 0

            // Factor 2: RSI trend context (weight: 2)
            // RSI confirms trend, not contra-trades
            if (rsi >= 60 && rsi <= 75)
              longScore += 2; // Strong bullish momentum
            else if (rsi >= 50 && rsi < 60)
              longScore += 1; // Bullish
            else if (rsi >= 40 && rsi < 50)
              shortScore += 1; // Bearish
            else if (rsi >= 25 && rsi < 40) shortScore += 2; // Strong bearish momentum
            // Extreme RSI (>75 or <25) doesn't add points - could go either way

            // Factor 3: Volume with price direction (weight: 2)
            if (volumeSpikeRatio >= 3.0) {
              // Strong volume confirms current price direction
              if (priceChange24h >= 0) longScore += 2;
              else shortScore += 2;
            } else if (volumeSpikeRatio >= 1.5) {
              if (priceChange24h >= 0) longScore += 1;
              else shortScore += 1;
            }

            // Factor 4: Open Interest with price (weight: 2)
            if (oiChange24h !== null && oiChange24h !== undefined) {
              // Rising OI + rising price = longs entering (bullish)
              // Rising OI + falling price = shorts entering (bearish)
              if (oiChange24h > 10 && priceChange24h >= 2) longScore += 2;
              else if (oiChange24h > 5 && priceChange24h >= 0) longScore += 1;
              else if (oiChange24h > 10 && priceChange24h <= -2)
                shortScore += 2;
              else if (oiChange24h > 5 && priceChange24h < 0) shortScore += 1;
            }

            // Factor 5: Market structure (weight: 1 each)
            if (fvg?.type === "bullish") longScore += 1;
            else if (fvg?.type === "bearish") shortScore += 1;
            if (ob?.type === "bullish") longScore += 1;
            else if (ob?.type === "bearish") shortScore += 1;

            // Decision: whichever side has more conviction wins
            // Tie or slight edge goes to LONG (pre-spike scanner bias)
            return shortScore > longScore ? "SHORT" : "LONG";
          };

          const side = determineSide();

          signals.push({
            symbol: item.symbol,
            side, // Trade direction: LONG or SHORT
            currentPrice,
            priceChange24h,
            volumeSpikeRatio,
            volAccel, // Volume acceleration: current1H / avg4H
            isAccelerating, // True if volAccel >= 2.0x
            oiChange24h, // Open Interest 24H change %
            hasVolAlert, // True if volume > 2.0x
            signalType, // "HOT" | "ACTIVE" | "PRE" | "MAJOR"
            rsi,
            entryPrice: currentPrice,
            slPrice: sl,
            slDistancePct,
            slReason,
            tpLevels,
            riskReward,
            signalStrength,
            strengthBreakdown: {
              priceInRange,
              volumeInRange,
              rsiInRange,
              rrInRange,
              hasLeadingIndicators,
            },
            leadingIndicators: {
              orderBookImbalance: imbalance,
              bidAskRatio,
              hasFVG: fvg !== null,
              fvgLevel: fvg?.level ?? null,
              fvgType: fvg?.type ?? null,
              hasOrderBlock: ob !== null,
              obLevel: ob?.level ?? null,
              obType: ob?.type ?? null,
              hasLiquidityZone,
              liquidityLevel: liquidityClusters[0]?.price ?? null,
              liquidityStrength: liquidityClusters[0]?.strength ?? 0,
            },
            timeframes: [
              {
                timeframe: "1H",
                rsi: rsi1H,
                volumeSpike: volumeSpike1H,
                priceChange: priceChange24h,
                confirmed: tf1HConfirmed,
                swingLow: swingLows[0] || 0,
                swingHigh: swingHighs[0] || 0,
              },
              {
                timeframe: "15M",
                rsi: rsi15M,
                volumeSpike: volumeSpike15M,
                priceChange: priceChange24h,
                confirmed: tf15MConfirmed,
                swingLow: swingLows[0] || 0,
                swingHigh: swingHighs[0] || 0,
              },
            ],
            confirmedTimeframes,
            isMajor,
            firstSeenAt: firstSeen.toISOString(),
            timeOnListMinutes,
            spikeReadiness,
            liquidationLevels, // Estimated liquidation price levels
          });

          await new Promise((resolve) => setTimeout(resolve, 30));
        } catch (err) {
          continue;
        }
      }

      // Sort by signalType priority: HOT first, then MAJOR, then ACTIVE, then PRE
      // Within each category, sort by R:R descending
      const typePriority = { HOT: 0, MAJOR: 1, ACTIVE: 2, PRE: 3 };
      const sortedSignals = signals.sort((a, b) => {
        const aPriority =
          typePriority[a.signalType as keyof typeof typePriority] ?? 4;
        const bPriority =
          typePriority[b.signalType as keyof typeof typePriority] ?? 4;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return b.riskReward - a.riskReward;
      });

      cachedSignals = sortedSignals;

      // Count by signal type
      const typeCount = {
        HOT: signals.filter((s) => s.signalType === "HOT").length,
        MAJOR: signals.filter((s) => s.signalType === "MAJOR").length,
        ACTIVE: signals.filter((s) => s.signalType === "ACTIVE").length,
        PRE: signals.filter((s) => s.signalType === "PRE").length,
      };
      lastUpdated = new Date();

      // Cleanup: Remove symbols from tracking only after grace period expires
      // This prevents losing time history for coins that briefly drop off the list
      const now = new Date();
      Array.from(symbolFirstSeen.keys()).forEach((symbol) => {
        const lastSeen = symbolLastSeen.get(symbol);
        if (
          lastSeen &&
          now.getTime() - lastSeen.getTime() > TRACKING_GRACE_PERIOD_MS
        ) {
          symbolFirstSeen.delete(symbol);
          symbolLastSeen.delete(symbol);
        }
      });

      // Count spike readiness distribution
      const readinessCount = {
        warming: signals.filter((s) => s.spikeReadiness === "warming").length,
        primed: signals.filter((s) => s.spikeReadiness === "primed").length,
        hot: signals.filter((s) => s.spikeReadiness === "hot").length,
        overdue: signals.filter((s) => s.spikeReadiness === "overdue").length,
      };

      console.log(
        `Signal calculation complete. Found ${cachedSignals.length} signals (${typeCount.HOT} HOT, ${typeCount.MAJOR} MAJOR, ${typeCount.ACTIVE} ACTIVE, ${typeCount.PRE} PRE).`,
      );
      console.log(
        `Spike readiness: ${readinessCount.warming} warming, ${readinessCount.primed} primed, ${readinessCount.hot} hot, ${readinessCount.overdue} overdue`,
      );

      // Send Discord notifications for high-priority signals
      if (isDiscordConfigured()) {
        try {
          await notifyNewSignals(cachedSignals);
        } catch (err) {
          console.error("[DISCORD] Notification error:", err);
        }
      }
    } finally {
      isCalculating = false;
    }
  }

  // Track if initial calculation is done
  let initialCalculationDone = false;
  let initialCalculationPromise: Promise<void> | null = null;

  // Initialize backtesting service
  backtestingService.initialize().then(() => {
    backtestingService.startMonitoring(60000);
  });

  // Start initial calculation and track completion
  initialCalculationPromise = calculateSignals().then(() => {
    initialCalculationDone = true;
  });
  setInterval(calculateSignals, UPDATE_FREQUENCY_MINUTES * 60 * 1000);

  app.get(api.tickers.list.path, async (req, res) => {
    // Wait for initial calculation if not done yet (max 30 seconds)
    if (!initialCalculationDone && initialCalculationPromise) {
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 30000),
      );
      await Promise.race([initialCalculationPromise, timeout]);
    }

    const nextUpdate = new Date(
      lastUpdated.getTime() + UPDATE_FREQUENCY_MINUTES * 60 * 1000,
    );

    console.log(`[API] Returning ${cachedSignals.length} signals to client`);

    // Prevent any caching
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
    });

    res.json({
      signals: cachedSignals,
      lastUpdated: lastUpdated.toISOString(),
      nextUpdate: nextUpdate.toISOString(),
      updateFrequencyMinutes: UPDATE_FREQUENCY_MINUTES,
    });
  });

  app.post(api.tickers.refresh.path, async (req, res) => {
    if (isCalculating) {
      res.json({ message: "Calculation already in progress" });
      return;
    }

    calculateSignals();
    res.json({ message: "Refresh triggered" });
  });

  app.get(api.watchlist.list.path, async (req, res) => {
    const items = await storage.getWatchlist();
    res.json(items);
  });

  app.post(api.watchlist.create.path, async (req, res) => {
    const input = api.watchlist.create.input.parse(req.body);
    const item = await storage.addToWatchlist(input);
    res.status(201).json(item);
  });

  app.delete(api.watchlist.delete.path, async (req, res) => {
    await storage.removeFromWatchlist(Number(req.params.id));
    res.status(204).send();
  });

  // ============================================
  // BACKTESTING API ENDPOINTS
  // ============================================

  ("/api/backtest/stats", async (req, res) => {
    try {
      const stats = await backtestingService.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching backtest stats:", error);
      res.status(500).json({ message: "Failed to fetch backtest stats" });
    }
  });

  app.get("/api/backtest/trades", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const trades = await backtestingService.getTrades(limit);
      res.json(trades);
    } catch (error) {
      console.error("Error fetching trades:", error);
      res.status(500).json({ message: "Failed to fetch trades" });
    }
  });

  app.get("/api/backtest/equity", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const curve = await backtestingService.getEquityCurve(limit);
      res.json(curve);
    } catch (error) {
      console.error("Error fetching equity curve:", error);
      res.status(500).json({ message: "Failed to fetch equity curve" });
    }
  });

  app.get("/api/backtest/signals", async (req, res) => {
    try {
      const symbol = req.query.symbol as string | undefined;
      const limit = parseInt(req.query.limit as string) || 100;
      const signals = await backtestingService.getSignalHistory(symbol, limit);
      res.json(signals);
    } catch (error) {
      console.error("Error fetching signal history:", error);
      res.status(500).json({ message: "Failed to fetch signal history" });
    }
  });

  app.post("/api/backtest/report/daily", async (req, res) => {
    try {
      const report = await backtestingService.getDailyReport();
      res.json(report);
    } catch (error) {
      console.error("Error generating daily report:", error);
      res.status(500).json({ message: "Failed to generate daily report" });
    }
  });

  // ============================================
  // NOTIFICATION STATUS ENDPOINT
  // ============================================

  app.get("/api/notifications/status", async (req, res) => {
    res.json({
      discord: {
        configured: isDiscordConfigured(),
        description: "Discord webhook for signal alerts",
      },
      bitunix: {
        configured: false,
        description:
          "Bitunix does not have a public API for creating price alerts. Use their web/mobile UI or TradingView webhook integration instead.",
      },
    });
  });

  // ============================================
  // COMMENTS API (REST fallback for non-WS clients)
  // ============================================

  app.get("/api/comments", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const comments = await storage.getComments(limit);
      res.json(
        comments.map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          symbol: c.symbol,
          createdAt: c.createdAt?.toISOString() || new Date().toISOString(),
        })),
      );
    } catch (error) {
      console.error("Error fetching comments:", error);
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  // Sanitize text to remove HTML/XSS vectors - encode ALL dangerous characters
  function sanitizeText(input: string): string {
    return input
      .replace(/&/g, "&amp;") // Must be first to avoid double-encoding
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/\//g, "&#x2F;")
      .replace(/`/g, "&#96;")
      .replace(/=/g, "&#x3D;")
      .replace(/\(/g, "&#40;")
      .replace(/\)/g, "&#41;")
      .trim();
  }

  app.post("/api/comments", async (req, res) => {
    try {
      const { author, content, symbol } = req.body;
      if (!author || !content) {
        res.status(400).json({ message: "Author and content are required" });
        return;
      }

      const comment = await storage.addComment({
        author: sanitizeText(author).slice(0, 50),
        content: sanitizeText(content).slice(0, 500),
        symbol: symbol ? sanitizeText(symbol).slice(0, 20) : null,
      });

      res.status(201).json({
        id: comment.id,
        author: comment.author,
        content: comment.content,
        symbol: comment.symbol,
        createdAt: comment.createdAt?.toISOString() || new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error adding comment:", error);
      res.status(500).json({ message: "Failed to add comment" });
    }
  });

  app.get("/api/ws/status", async (req, res) => {
    res.json({
      connectedClients: getConnectedClientsCount(),
    });
  });

  // Initialize WebSocket server
  initializeWebSocket(httpServer);

  
  
  // ==================================
  // BACKTESTING API ENDPOINTS
  // ==================================

  app.get("/api/backtest/metrics", async (req, res) => {
    try {
      const metrics = await backtestingService.calculateMetrics();
      res.json(metrics);
    } catch (error) {
      console.error('[API] Error fetching backtest metrics:', error);
      res.status(500).json({ error: 'Failed to fetch backtest metrics' });
    }
  });

  app.get("/api/backtest/trades", async (req, res) => {
    try {
      const trades = await backtestingService.getTrades();
      res.json(trades);
    } catch (error) {
      console.error('[API] Error fetching backtest trades:', error);
      res.status(500).json({ error: 'Failed to fetch backtest trades' });
    }
  });

  app.get("/api/backtest/equity-curve", async (req, res) => {
    try {
      const curve = await backtestingService.getEquityCurve();
      res.json(curve);
    } catch (error) {
      console.error('[API] Error fetching equity curve:', error);
      res.status(500).json({ error: 'Failed to fetch equity curve' });
    }
  });

  app.get("/api/backtest/report", async (req, res) => {
    try {
      const report = await backtestingService.getDailyReport();
      res.json(report);
    } catch (error) {
      console.error('[API] Error fetching backtest report:', error);
      res.status(500).json({ error: 'Failed to fetch backtest report' });
    }
  });return httpServer;
}

import type { Express } from "express";
import type { Server } from "http";
import { storage, getStorage } from "./storage";
import { getHktHour, getHktHourMinute, formatHktTime, formatHktDateTime } from "./time-utils";
import { classifySession, getSessionSchedule } from "./session-config";
import { isDatabaseAvailable, getConnectionError } from "./db";
import { api } from "@shared/routes";
import { notifyNewSignals, isDiscordConfigured } from "./discord";
import { initializeWebSocket, getConnectedClientsCount } from "./websocket";
import { backtestingService } from "./backtest";
import { autotradeService } from "./autotrade";
import { bitunixTradeService } from "./bitunix-trade";
import { backtestEngine, BacktestSignal, autoStartBacktestFromScreener, type ScreenerSignalForBacktest } from "./backtest-engine";
import { continuousBacktestEngine } from "./continuous-backtest";
import axios from "axios";
import { RSI } from "technicalindicators";
import {
  getEnhancedMarketData,
  getOpenInterestHistory,
  getLiquidationMap,
  getLongShortRatio,
  getFundingRate,
  EnhancedMarketData,
} from "./coinglass";
import {
  enrichSignalWithCoinglass,
  applyScreenerFilters,
  calculatePriceLocation,
  calculateMarketPhase,
  calculatePreSpikeScore,
  calculateHtfBias,
  calculateEntryModel,
  type ScreenerFilters,
} from "./screener-enrichment";
import { getOKXKlines, getOKXFundingRate } from "./okx";
import { getSymbolListingDate, calculateAgeDays } from "./binance";
import { listingAlphaModel, ListingFeatures, ListingPrediction } from "./ml/listing-alpha-model";
import { analyzeCoil, type CoilSignal, type MarketData as CoilMarketData } from "./coil-signal";
import { logSnapshot, buildSnapshotRow, flushSnapshots } from "./ml-snapshot-logger";

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

// Shared symbol selection logic - used by both Classic view (calculateSignals) and Enhanced view (/api/screen)
// Ensures both views work on the SAME coin universe for consistency
async function getUnifiedSymbolUniverse(rawData: any[]): Promise<any[]> {
  // Get watchlist to prioritize those symbols
  let watchlistSymbols: string[] = [];
  try {
    const watchlist = await getStorage().getWatchlist();
    watchlistSymbols = watchlist.map((w) => w.symbol);
  } catch (err) {
    console.warn('[SYMBOLS] Could not fetch watchlist, proceeding without it');
  }

  // Equity perpetuals to exclude (not crypto)
  const EQUITY_PERPS = new Set(["TSLAUSDT", "INTCUSDT", "HOODSDT", "AAPLUSDT", "NVDAUSDT", "MSFTUSDT", "AMZNUSDT", "GOOGLUSDT", "METAUSDT", "COINUSDT"]);
  
  const allSymbols = rawData.filter((t: any) => {
    const symbol = t.symbol || "";
    const price = parseFloat(t.lastPrice);
    const volume = parseFloat(t.quoteVol);
    if (symbol.includes("USDC") || (symbol.includes("USDT") && !symbol.endsWith("USDT"))) return false;
    if (EQUITY_PERPS.has(symbol)) return false;
    return price > 0 && volume > 0 && !isNaN(price) && !isNaN(volume) && symbol.endsWith("USDT");
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
    .sort((a: any, b: any) => {
      const aChange = Math.abs(((parseFloat(a.lastPrice) - parseFloat(a.open)) / parseFloat(a.open)) * 100);
      const bChange = Math.abs(((parseFloat(b.lastPrice) - parseFloat(b.open)) / parseFloat(b.open)) * 100);
      return bChange - aChange;
    })
    .slice(0, 50);

  // Priority 4: High movers (>10% change) not already selected - catch early spikes!
  const highMovers = allSymbols
    .filter((t: any) => {
      if (selectedSymbols.has(t.symbol)) return false;
      if (otherSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      const price = parseFloat(t.lastPrice);
      const open = parseFloat(t.open);
      const change = ((price - open) / open) * 100;
      return change >= 10 || change <= -10; // Big movers either direction
    })
    .slice(0, 20);

  // Priority 5: New Binance futures listings (< 7 days old) - auto-include
  let newListingSymbols: any[] = [];
  try {
    const { getNewFuturesListings } = await import('./listing-monitor');
    const newListings = await getNewFuturesListings();
    newListingSymbols = allSymbols.filter((t: any) => {
      if (selectedSymbols.has(t.symbol)) return false;
      if (otherSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      if (highMovers.some((o: any) => o.symbol === t.symbol)) return false;
      return newListings.has(t.symbol);
    });
    if (newListingSymbols.length > 0) {
      console.log(`[SYMBOLS] New listings (< 7 days): ${newListingSymbols.map((s: any) => s.symbol).join(', ')}`);
    }
  } catch (err) {
    console.warn('[SYMBOLS] New listing detection unavailable:', (err as Error).message);
  }

  // Priority 6: Korea exchange new listings (Upbit, < 7 days) - auto-include
  let koreaNewSymbols: any[] = [];
  try {
    const { getUpbitNewListings } = await import('./listing-monitor');
    const koreaListings = await getUpbitNewListings();
    koreaNewSymbols = allSymbols.filter((t: any) => {
      if (selectedSymbols.has(t.symbol)) return false;
      if (otherSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      if (highMovers.some((o: any) => o.symbol === t.symbol)) return false;
      if (newListingSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      return koreaListings.has(t.symbol);
    });
    if (koreaNewSymbols.length > 0) {
      console.log(`[SYMBOLS] Korea new listings: ${koreaNewSymbols.map((s: any) => s.symbol).join(', ')}`);
    }
  } catch (err) {
    console.warn('[SYMBOLS] Korea listing detection unavailable:', (err as Error).message);
  }

  // Priority 7: Binance Futures symbols not on Bitunix — catch new listings on Binance
  let binanceOnlySymbols: any[] = [];
  try {
    const { getBinanceFuturesSymbols } = await import('./listing-monitor');
    const binanceSymbols = await getBinanceFuturesSymbols();
    const alreadySelected = new Set([
      ...majorSymbols.map((s: any) => s.symbol),
      ...watchedSymbols.map((s: any) => s.symbol),
      ...otherSymbols.map((s: any) => s.symbol),
      ...highMovers.map((s: any) => s.symbol),
      ...newListingSymbols.map((s: any) => s.symbol),
      ...koreaNewSymbols.map((s: any) => s.symbol),
    ]);

    // Find Binance symbols not in Bitunix rawData
    const bitunixSymbols = new Set(allSymbols.map((s: any) => s.symbol));
    const missingFromBitunix: string[] = [];
    for (const sym of binanceSymbols) {
      if (!bitunixSymbols.has(sym) && !alreadySelected.has(sym)) {
        missingFromBitunix.push(sym);
      }
    }

    // For missing symbols, create minimal entries with Binance ticker data
    if (missingFromBitunix.length > 0) {
      console.log(`[SYMBOLS] Binance-only symbols not on Bitunix: ${missingFromBitunix.join(', ')}`);
      // These will need Binance price data — fetch from Binance ticker
      try {
        const resp = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', {
          headers: { 'User-Agent': 'Giiq-Screener/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const tickers = await resp.json() as Array<{
            symbol: string; lastPrice: string; priceChangePercent: string;
            volume: string; quoteVolume: string; openPrice: string;
            highPrice: string; lowPrice: string;
          }>;
          const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
          for (const sym of missingFromBitunix.slice(0, 10)) { // Cap at 10 to limit API load
            const ticker = tickerMap.get(sym);
            if (ticker && parseFloat(ticker.lastPrice) > 0) {
              binanceOnlySymbols.push({
                symbol: sym,
                lastPrice: ticker.lastPrice,
                open: ticker.openPrice,
                high24h: ticker.highPrice,
                low24h: ticker.lowPrice,
                quoteVol: ticker.quoteVolume,
                vol: ticker.volume,
                priceChange24h: parseFloat(ticker.priceChangePercent),
                _source: 'binance-backfill',
              });
            }
          }
        }
      } catch (err) {
        console.warn('[SYMBOLS] Binance ticker backfill failed:', (err as Error).message);
      }
    }
  } catch (err) {
    console.warn('[SYMBOLS] Binance symbol fetch unavailable:', (err as Error).message);
  }

  const symbolsToProcess = [
    ...majorSymbols,
    ...watchedSymbols,
    ...otherSymbols,
    ...highMovers,
    ...newListingSymbols,
    ...koreaNewSymbols,
    ...binanceOnlySymbols,
  ];
  
  // Remove duplicates
  const uniqueSymbols = Array.from(
    new Map(symbolsToProcess.map((s) => [s.symbol, s])).values(),
  );

  console.log(
    `[SYMBOLS] Unified universe: ${majorSymbols.length} major, ${watchedSymbols.length} watched, ${otherSymbols.length} top-change, ${highMovers.length} movers, ${newListingSymbols.length} new-listings, ${koreaNewSymbols.length} korea-new, ${binanceOnlySymbols.length} binance-only = ${uniqueSymbols.length} total`,
  );

  return uniqueSymbols;
}

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
  // Coinalyze removed - using free Binance OI via fallback
  return new Map<string, number>();
}

// Fetch OI data from CoinGlass V4 API (primary source, paid $79/mo)
// Uses /api/futures/open-interest/exchange-list?symbol=XXX per coin
// Returns 24h OI change % for each symbol
async function fetchCoinglassV4OpenInterest(symbols: string[]): Promise<Map<string, number>> {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) return new Map();
  
  const result = new Map<string, number>();
  
  // Deduplicate and convert to base symbols (BTCUSDT -> BTC)
  const baseSymbols = [...new Set(
    symbols
      .filter(s => s.endsWith('USDT'))
      .map(s => s.replace('USDT', '').toUpperCase())
  )].slice(0, 40); // Limit to 40 to respect rate limits (80 req/min)
  
  // Batch requests with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < baseSymbols.length; i += BATCH_SIZE) {
    const batch = baseSymbols.slice(i, i + BATCH_SIZE);
    const requests = batch.map(async (base) => {
      try {
        const response = await axios.get(
          'https://open-api-v4.coinglass.com/api/futures/open-interest/exchange-list',
          {
            params: { symbol: base },
            headers: { 'CG-API-KEY': apiKey },
            timeout: 10000,
          }
        );
        
        if (String(response.data?.code) === '0' && Array.isArray(response.data?.data)) {
          const allRow = response.data.data.find((r: any) => r.exchange === 'All');
          if (allRow && allRow.open_interest_change_percent_24h !== undefined) {
            const oiChange = parseFloat(allRow.open_interest_change_percent_24h);
            if (!isNaN(oiChange)) {
              result.set(base + 'USDT', oiChange);
            }
          }
        }
      } catch (err: any) {
        // Skip individual symbol errors silently
      }
    });
    
    await Promise.all(requests);
    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < baseSymbols.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }
  
  if (result.size > 0) {
    console.log(`[OI] CoinGlass V4: ${result.size}/${baseSymbols.length} symbols with 24h OI change data`);
  }
  
  return result;
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

  // PRIORITY 1: Try CoinGlass V4 API (paid, most reliable)
  if (process.env.COINGLASS_API_KEY) {
    try {
      const v4Data = await fetchCoinglassV4OpenInterest(symbols);
      if (v4Data.size > 0) {
        oiDataCache = v4Data;
        oiLastFetched = new Date();
        oiDataSource = "coinglass";
        console.log(`[OI] CoinGlass V4: ${v4Data.size} symbols with OI change data`);
        return v4Data;
      }
    } catch (error: any) {
      console.log(`[OI] CoinGlass V4 failed, trying fallbacks: ${error?.message}`);
    }
  }

  // Try Coinalyze next if API key is available
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


// ==============================================
// AUR HISTORY STORE - Persists AUR readings across refresh cycles
const aurHistoryMap = new Map<string, Array<{ts: number, aur: number, z: number}>>();
const AUR_HISTORY_MAX = 12;

function pushAurHistory(symbol: string, aur: number, z: number): void {
  if (!aurHistoryMap.has(symbol)) aurHistoryMap.set(symbol, []);
  const h = aurHistoryMap.get(symbol)!;
  const now = Date.now();
  if (h.length > 0 && now - h[h.length - 1].ts < 120000) {
    h[h.length - 1] = { ts: now, aur, z };
  } else {
    h.push({ ts: now, aur, z });
  }
  while (h.length > AUR_HISTORY_MAX) h.shift();
}

function detectAurTrendFromHistory(symbol: string, currentAur: number, currentZ: number): {
  aurRising: boolean; aurSlope: number; aurTrendValues: number[]; risingStreak: number;
} {
  pushAurHistory(symbol, currentAur, currentZ);
  const values = (aurHistoryMap.get(symbol) || []).map(h => h.aur);
  if (values.length < 3) return { aurRising: false, aurSlope: 0, aurTrendValues: values, risingStreak: 0 };
  let risingStreak = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i] > values[i - 1] + 0.01) risingStreak++;
    else break;
  }
  const recent = values.slice(-4);
  const slope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / (recent.length - 1) : 0;
  const aurRising = risingStreak >= 2 && currentAur > 0.40 && currentZ < 2.0;
  return {
    aurRising,
    aurSlope: Math.round(slope * 1000) / 1000,
    aurTrendValues: values.slice(-6).map(v => Math.round(v * 1000) / 1000),
    risingStreak,
  };
}

// ABSOLUTE UP RATIO (AUR) - Fine-timeframe alpha
// ==============================================
interface AURResult {
  aur: number;
  aurZScore: number;
  isBuyConcentrated: boolean;
  aurTrend: number[];  // last 4 hourly AUR values (oldest first)
  aurRising: boolean;  // true if 3+ consecutive rising AURs and current > 0.45
  aurSlope: number;    // rate of AUR increase per hour
  risingStreak?: number; // consecutive rising readings across refresh cycles
}

async function calculateAUR(symbol: string): Promise<AURResult | null> {
  // Cache to avoid redundant API calls within same refresh cycle
  const cacheKey = `${symbol}_${Math.floor(Date.now() / 60000)}`; // 1-min granularity
  if ((calculateAUR as any)._cache?.has(cacheKey)) {
    return (calculateAUR as any)._cache.get(cacheKey);
  }
  if (!(calculateAUR as any)._cache) {
    (calculateAUR as any)._cache = new Map();
  }
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=1m&limit=1200`;
    const response = await axios.get(url, { timeout: 10000 });
    if (!response.data?.data || !Array.isArray(response.data.data) || response.data.data.length < 120) return null;
    const rawKlines = response.data.data.map((k: any) => ({
      time: parseInt(k.time), open: parseFloat(k.open),
      close: parseFloat(k.close), volume: parseFloat(k.quoteVol || k.vol || 0),
    })).reverse();
    const hourlyAURs: number[] = [];
    for (let i = 0; i + 60 <= rawKlines.length; i += 60) {
      const bucket = rawKlines.slice(i, i + 60);
      let upW = 0, totalW = 0;
      for (const k of bucket) {
        const ch = k.close - k.open;
        const w = Math.abs(ch) * (k.volume || 1);
        totalW += w;
        if (ch > 0) upW += w;
      }
      hourlyAURs.push(totalW > 0 ? upW / totalW : 0.5);
    }
    if (hourlyAURs.length < 3) return null;
    const cur = hourlyAURs[hourlyAURs.length - 1];
    const lb = hourlyAURs.slice(0, -1);
    const mean = lb.reduce((s,v) => s+v, 0) / lb.length;
    const vari = lb.reduce((s,v) => s + (v-mean)**2, 0) / lb.length;
    const sd = Math.sqrt(vari);
    const z = sd > 0.001 ? (cur - mean) / sd : 0;
    
    // SEED aurHistoryMap from kline data if insufficient history
    // This ensures aurRising/aurSlope work from the FIRST refresh cycle after deploy
    if (!aurHistoryMap.has(symbol) || (aurHistoryMap.get(symbol)?.length ?? 0) < 3) {
      const seedData: Array<{ts: number, aur: number, z: number}> = [];
      const now = Date.now();
      // Use the last 6 hourly AURs as historical seed points (1 hour apart)
      const seedAURs = hourlyAURs.slice(-Math.min(6, hourlyAURs.length));
      for (let si = 0; si < seedAURs.length; si++) {
        const seedMean = hourlyAURs.slice(0, Math.max(1, hourlyAURs.length - seedAURs.length + si)).reduce((s,v) => s+v, 0) / Math.max(1, hourlyAURs.length - seedAURs.length + si);
        const seedVar = hourlyAURs.slice(0, Math.max(1, hourlyAURs.length - seedAURs.length + si)).reduce((s,v) => s + (v-seedMean)**2, 0) / Math.max(1, hourlyAURs.length - seedAURs.length + si);
        const seedSd = Math.sqrt(seedVar);
        const seedZ = seedSd > 0.001 ? (seedAURs[si] - seedMean) / seedSd : 0;
        seedData.push({
          ts: now - (seedAURs.length - si) * 3600000, // space 1 hour apart
          aur: seedAURs[si],
          z: seedZ,
        });
      }
      aurHistoryMap.set(symbol, seedData);
    }
    
    // Use cross-cycle history for trend detection (persists across 5-min refresh cycles)
    const trendData = detectAurTrendFromHistory(symbol, cur, z);
    const result = {
      aur: Math.round(cur * 1000) / 1000,
      aurZScore: Math.round(z * 100) / 100,
      isBuyConcentrated: z >= 2,
      aurTrend: trendData.aurTrendValues,
      aurRising: trendData.aurRising,
      aurSlope: trendData.aurSlope,
      risingStreak: trendData.risingStreak,
    };
    (calculateAUR as any)._cache.set(cacheKey, result);
    // Clean old cache entries
    if ((calculateAUR as any)._cache.size > 200) {
      const keys = [...(calculateAUR as any)._cache.keys()];
      keys.slice(0, 100).forEach((k: string) => (calculateAUR as any)._cache.delete(k));
    }
    console.log(`[AUR] ${symbol}: aur=${result.aur}, z=${result.aurZScore}, rising=${result.aurRising}, streak=${result.risingStreak}`);
    return result;
  } catch (err: any) { console.error(`[AUR] Error calculating for ${symbol}:`, err?.message || err); return null; }
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

  // Enhanced screener cache — enrichment runs in background, endpoint serves instantly
  let cachedEnhancedSignals: any[] = [];
  let enhancedLastUpdated: Date | null = null;
  let isEnriching = false;

  // Initialize ML model
  const ML_MODEL_PATH = './server/ml/trained-models';
  listingAlphaModel.load(ML_MODEL_PATH).then(loaded => {
    if (loaded) {
      console.log('[ML] Listing alpha model loaded successfully');
    } else {
      console.log('[ML] Using heuristic predictions (no trained model found)');
    }
  }).catch(err => {
    console.log('[ML] Model load error, using heuristics:', err.message);
  });

  // Health check endpoint with database status
  app.get("/api/health", async (req, res) => {
    const dbStatus = isDatabaseAvailable();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: {
        available: dbStatus,
        error: dbStatus ? null : getConnectionError(),
        mode: dbStatus ? "database" : "memory-fallback"
      },
      signals: {
        cached: cachedSignals.length,
        lastUpdated: lastUpdated.toISOString()
      }
    });
  });

  // ML Prediction endpoint
  app.post("/api/ml/predict", async (req, res) => {
    try {
      const { symbol, features } = req.body;
      
      // Build features from request or use defaults
      const now = new Date();
      const mlFeatures: ListingFeatures = {
        marketCap: features?.marketCap || 100000000,
        marketCapRank: features?.marketCapRank || 200,
        daysSinceBinanceListing: features?.daysSinceBinanceListing || 10,
        numExchangesListed: features?.numExchangesListed || 5,
        circulatingSupplyRatio: features?.circulatingSupplyRatio || 0.5,
        narrativeCategory: features?.narrativeCategory || 'Other',
        twitterMentions24h: features?.twitterMentions24h || 1000,
        sentimentScore: features?.sentimentScore || 0.5,
        koreanSocialMentions: features?.koreanSocialMentions || 500,
        return24h: features?.return24h || 0.1,
        return7d: features?.return7d || 0.15,
        volumeSpike: features?.volumeSpike || 2.0,
        volatility24h: features?.volatility24h || 0.15,
        rsi14: features?.rsi14 || 55,
        exchangeNetflow: features?.exchangeNetflow || 0.1,
        whaleTransactions24h: features?.whaleTransactions24h || 20,
        hourOfDay: ((now.getUTCHours() + 8) % 24), // HKT (UTC+8, mod 24 for midnight wrap)
        dayOfWeek: now.getDay(),
        isKoreaTradingHours: now.getUTCHours() >= 0 && now.getUTCHours() < 9, // 9-18 KST = 0-9 UTC
        kimchiPremium: features?.kimchiPremium || 0.02,
        targetExchange: features?.targetExchange || 'upbit'
      };
      
      const prediction = await listingAlphaModel.predict(mlFeatures);
      const status = listingAlphaModel.getTrainingStatus();
      
      res.json({
        symbol,
        prediction: {
          listingProbability: Math.round(prediction.listingProbability * 100),
          expectedReturn: Math.round(prediction.expectedReturn * 100),
          confidence: Math.round(prediction.confidence * 100),
          positionSize: Math.round(prediction.recommendedPositionSize * 100),
          entryWindow: prediction.optimalEntryWindow,
          confidenceInterval: [
            Math.round(prediction.returnConfidenceInterval[0] * 100),
            Math.round(prediction.returnConfidenceInterval[1] * 100)
          ]
        },
        modelStatus: status
      });
    } catch (error: any) {
      console.error('[ML] Prediction error:', error.message);
      res.status(500).json({ error: 'ML prediction failed', message: error.message });
    }
  });

  // Get ML model status
  app.get("/api/ml/status", (req, res) => {
    const status = listingAlphaModel.getTrainingStatus();
    res.json({
      modelLoaded: status.isTrained,
      modelPath: ML_MODEL_PATH,
      timestamp: new Date().toISOString()
    });
  });

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

      // Use shared symbol selection logic for consistency with Enhanced view
      const uniqueSymbols = await getUnifiedSymbolUniverse(rawData);
      
      console.log(`Processing ${uniqueSymbols.length} symbols from unified universe...`);

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

          const [klines4H, klines1H, klines15M, orderBook] = await Promise.all([
            fetchKlines(item.symbol, "4h", 50),
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
            // Calculate AUR (Absolute Up Ratio) - fine-timeframe alpha
            let aurData: AURResult | null = null;
            try {
              aurData = await calculateAUR(item.symbol);
            } catch { /* skip AUR on error */ }
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

          // Calculate HTF Bias using Supertrend (4H) + Funding Rate
          const klines4HFormatted = klines4H.map(k => ({
            high: k.high.toString(),
            low: k.low.toString(),
            close: k.close.toString(),
          }));
          // Get funding rate for htfBias calculation (use cached data if available)
          let fundingRateForBias: number | undefined = undefined;
          try {
            const fundingData = await getFundingRate(item.symbol.replace('USDT', ''));
            if (fundingData.length > 0) {
              fundingRateForBias = fundingData.reduce((sum, fr) => sum + fr.fundingRate, 0) / fundingData.length;
            }
          } catch {
            // Ignore funding rate errors, htfBias will use supertrend only
          }
          const htfBias = calculateHtfBias(klines4HFormatted, fundingRateForBias, item.symbol);

          // Coinglass data placeholder - populated from cache if available
          // Note: Full Coinglass data available via /api/coinglass/:symbol endpoint
          const coinglassData: {
            longShortRatio: number | null;
            maxPainLong: number | null;
            maxPainShort: number | null;
          } = {
            longShortRatio: null,
            maxPainLong: null,
            maxPainShort: null,
          };

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

          // MAJOR: Always include BTC/ETH regardless of volume
          const isMajorQualified = isMajor;

          // COIL criteria: Full COIL analysis from coil-signal.ts
          // Fallback to simple heuristic if kline data insufficient
          let isCoil = false;
          let coilResult: CoilSignal | null = null;
          try {
            if (klines4H.length >= 20) {
              const coilInput: CoilMarketData = {
                symbol: item.symbol,
                closes: klines4H.map(k => k.close),
                volumes: klines4H.map(k => k.volume),
                highs: klines4H.map(k => k.high),
                lows: klines4H.map(k => k.low),
                volume24hUsd: parseFloat(item.quoteVol || '0'),
              };
              coilResult = analyzeCoil(coilInput);
              isCoil = coilResult.phase === 'COIL_READY' || coilResult.phase === 'COIL_TRIGGER';
            }
          } catch { /* COIL analysis failed, fall through to heuristic */ }
          if (!isCoil) {
            // Simple heuristic fallback: low vol, tight price range, neutral RSI
            isCoil =
              volumeSpikeRatio < 0.8 &&
              priceChange24h >= -5 &&
              priceChange24h <= 8 &&
              rsi >= 40 &&
              rsi <= 60;
          }

          // Determine signal type (priority order: HOT > MAJOR > ACTIVE > PRE > COIL)
          let signalType: "HOT" | "ACTIVE" | "PRE" | "COIL" | "MAJOR" | null = null;
          if (isHotMomentum) {
            signalType = "HOT";
          } else if (isMajorQualified) {
            signalType = "MAJOR";
          } else if (isActiveMomentum) {
            signalType = "ACTIVE";
          } else if (isPreConsolidation) {
            signalType = "PRE";
          } else if (isCoil) {
            signalType = "COIL";
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
                : signalType === "COIL"
                  ? priceChange24h >= -5 && priceChange24h <= 8
                  : priceChange24h >= -8 && priceChange24h <= 15;
          const volumeInRange =
            signalType === "HOT"
              ? volumeSpikeRatio >= 2.0
              : signalType === "ACTIVE"
                ? volumeSpikeRatio >= 1.0
                : signalType === "COIL"
                  ? volumeSpikeRatio < 0.8
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

          // Determine trade direction: LONG or SHORT based on HTF bias (Supertrend + Funding)
          // HTF bias is the PRIMARY indicator - Supertrend on 4H is the trend filter
          const determineSide = (): "LONG" | "SHORT" => {
            // PRIMARY: Use HTF Bias (Supertrend 4H + Funding Rate) if available
            if (htfBias) {
              // Supertrend is the primary trend indicator
              // Funding rate confirms or weakens confidence
              return htfBias.side;
            }

            // FALLBACK: If no HTF data, use scoring system
            let longScore = 0;
            let shortScore = 0;

            // Factor 1: Price trend direction (weight: 3)
            if (priceChange24h >= 5) longScore += 3;
            else if (priceChange24h >= 2) longScore += 2;
            else if (priceChange24h >= 0) longScore += 1;
            else if (priceChange24h <= -5) shortScore += 3;
            else if (priceChange24h <= -2) shortScore += 2;
            else shortScore += 1; // priceChange24h < 0

            // Factor 2: RSI trend context (weight: 2)
            if (rsi >= 60 && rsi <= 75)
              longScore += 2; // Strong bullish momentum
            else if (rsi >= 50 && rsi < 60)
              longScore += 1; // Bullish
            else if (rsi >= 40 && rsi < 50)
              shortScore += 1; // Bearish
            else if (rsi >= 25 && rsi < 40) shortScore += 2; // Strong bearish momentum

            // Factor 3: Volume with price direction (weight: 2)
            if (volumeSpikeRatio >= 3.0) {
              if (priceChange24h >= 0) longScore += 2;
              else shortScore += 2;
            } else if (volumeSpikeRatio >= 1.5) {
              if (priceChange24h >= 0) longScore += 1;
              else shortScore += 1;
            }

            // Factor 4: Open Interest with price (weight: 2)
            if (oiChange24h !== null && oiChange24h !== undefined) {
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

            return shortScore > longScore ? "SHORT" : "LONG";
          };

          const side = determineSide();

          // Get listing age for this symbol
          let ageDays: number | undefined;
          try {
            const listingTimestamp = await getSymbolListingDate(item.symbol);
            if (listingTimestamp) {
              ageDays = calculateAgeDays(listingTimestamp);
            }
          } catch {
            // Ignore errors, ageDays will be undefined
          }

          signals.push({
            symbol: item.symbol,
            side, // Trade direction: LONG or SHORT (based on HTF Supertrend)
            currentPrice,
            priceChange24h,
            volumeSpikeRatio,
            volAccel, // Volume acceleration: current1H / avg4H
            aur: aurData?.aur ?? null, // Absolute Up Ratio (0-1)
            aurZScore: aurData?.aurZScore ?? null, // AUR Z-Score
              aurRising: aurData?.aurRising ?? false,
              aurSlope: aurData?.aurSlope ?? 0,
              risingStreak: aurData?.risingStreak ?? 0,
              aurTrend: aurData?.aurTrend ?? [],
            isBuyConcentrated: aurData?.isBuyConcentrated ?? false, // True when Z >= 2
            isAccelerating, // True if volAccel >= 2.0x
            oiChange24h, // Open Interest 24H change %
            hasVolAlert, // True if volume > 2.0x
            signalType, // "HOT" | "ACTIVE" | "PRE" | "COIL" | "MAJOR"
            rsi,
            ageDays, // Listing age in days
            entryPrice: currentPrice,
            slPrice: sl,
            slDistancePct,
            slReason,
            tpLevels,
            riskReward,
            signalStrength,
            htfBias: htfBias ? {
              side: htfBias.side,
              confidence: htfBias.confidence,
              supertrendBias: htfBias.supertrendBias,
              fundingConfirms: htfBias.fundingConfirms,
              supertrendValue: htfBias.supertrendValue,
            } : null,
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
            coinglassData, // Coinglass: long/short ratio, max pain levels
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
                      volume24h: parseFloat(item.quoteVol) || 0,
                      high24h: parseFloat(item.high) || 0,
                      low24h: parseFloat(item.low) || 0,
          });

          await new Promise((resolve) => setTimeout(resolve, 30));
        } catch (err: any) {
          console.log(`[SIGNAL ERROR] ${item.symbol}: ${err?.message || err}`);
          continue;
        }
      }

      // Sort by signalType priority: HOT first, then MAJOR, then ACTIVE, then PRE
      // Within each category, sort by R:R descending
      const typePriority = { HOT: 0, MAJOR: 1, ACTIVE: 2, PRE: 3, COIL: 4 };
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
        COIL: signals.filter((s) => s.signalType === "COIL").length,
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
        `Signal calculation complete. Found ${cachedSignals.length} signals (${typeCount.HOT} HOT, ${typeCount.MAJOR} MAJOR, ${typeCount.ACTIVE} ACTIVE, ${typeCount.PRE} PRE, ${typeCount.COIL} COIL).`,
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

  // ─── Background enrichment: builds enhanced signals cache ────────────────────────────────────────────
  async function calculateEnhancedSignals() {
    if (isEnriching || cachedSignals.length === 0) return;
    isEnriching = true;
    const startTime = Date.now();
    console.log(`[ENHANCED-CACHE] Starting background enrichment for ${cachedSignals.length} signals...`);
    try {
      // Reserve slots for COIL signals — they're always at the end of priority sort
      // but represent the highest pre-spike alpha (compression before explosion)
      const TOTAL_SLOTS = 30;
      const COIL_RESERVED_SLOTS = 5;
      const NON_COIL_SLOTS = TOTAL_SLOTS - COIL_RESERVED_SLOTS;
      
      const nonCoilSignals = cachedSignals.filter((s: any) => s.signalType !== 'COIL');
      const coilSignals = cachedSignals.filter((s: any) => s.signalType === 'COIL');
      
      // Take top non-COIL signals, then append COIL signals
      const selectedNonCoil = nonCoilSignals.slice(0, NON_COIL_SLOTS);
      const selectedCoil = coilSignals.slice(0, COIL_RESERVED_SLOTS);
      const validSignals = [...selectedNonCoil, ...selectedCoil];
      
      const enrichLimit = validSignals.length;
      console.log(`[ENHANCED-CACHE] Selecting ${selectedNonCoil.length} non-COIL + ${selectedCoil.length} COIL = ${validSignals.length} signals for enrichment`);
      const signals: any[] = [];

      for (let i = 0; i < validSignals.length; i++) {
        const classicSignal = validSignals[i];
        const symbol = classicSignal.symbol;
        const price = classicSignal.currentPrice;
        const high24h = classicSignal.high24h || price * 1.05;
        const low24h = classicSignal.low24h || price * 0.95;
        const volume = classicSignal.volume24h || 0;
        const priceChange24h = classicSignal.priceChange24h || 0;
        const volumeSpikeRatio = classicSignal.volumeSpikeRatio || 1.0;
        const rsi = classicSignal.rsi || 50;

        const priceLocation = calculatePriceLocation(price, high24h, low24h);
        const marketPhase = calculateMarketPhase(volumeSpikeRatio, classicSignal.oiChange24h, rsi, priceChange24h, classicSignal.volAccel, priceLocation, classicSignal.fundingRate, classicSignal.longShortRatio);
        const entryModel = calculateEntryModel(marketPhase, rsi, priceLocation, undefined, undefined);
        const signalType = classicSignal.signalType as "HOT" | "MAJOR" | "ACTIVE" | "PRE" | "COIL";

        const signal: any = {
          symbol, signalType,
          side: classicSignal.side || (priceChange24h > 0 ? "LONG" : "SHORT"),
          currentPrice: price, priceChange24h, volumeSpikeRatio,
          volAccel: classicSignal.volAccel,
          oiChange24h: classicSignal.oiChange24h, rsi,
          entryPrice: classicSignal.entryPrice || price * (priceChange24h > 0 ? 0.995 : 1.005),
          slPrice: classicSignal.slPrice || price * (priceChange24h > 0 ? 0.95 : 1.05),
          slDistancePct: classicSignal.slDistancePct || 5,
          slReason: classicSignal.slReason || "5% default stop",
          tpLevels: classicSignal.tpLevels || [
            { label: "TP1", price: price * (priceChange24h > 0 ? 1.03 : 0.97), pct: 3, reason: "3% target" },
            { label: "TP2", price: price * (priceChange24h > 0 ? 1.06 : 0.94), pct: 6, reason: "6% target" },
          ],
          riskReward: classicSignal.riskReward || 1.2,
          signalStrength: classicSignal.signalStrength || 3,
          strengthBreakdown: classicSignal.strengthBreakdown || { priceInRange: true, volumeInRange: volumeSpikeRatio >= 2, rsiInRange: rsi >= 40 && rsi <= 70, rrInRange: true, hasLeadingIndicators: false },
          leadingIndicators: classicSignal.leadingIndicators || { hasFVG: false, hasOB: false, hasLiquidityGrab: false, hasBreakOfStructure: false, fvgType: null, obType: null, liquidityLevel: null, liquidityStrength: 0 },
          timeframes: classicSignal.timeframes || [],
          confirmedTimeframes: classicSignal.confirmedTimeframes || [],
          isMajor: symbol === "BTCUSDT" || symbol === "ETHUSDT",
          high24h, low24h, volume24h: volume,
          priceLocation, marketPhase, entryModel,
          preSpikeScore: 0,
          fundingRate: undefined, fundingBias: undefined,
          longShortRatio: undefined, lsrBias: undefined,
          fvgLevels: [], obLevels: [],
          liquidationZones: { nearestLongLiq: undefined, nearestShortLiq: undefined, longLiqDistance: undefined, shortLiqDistance: undefined },
          storytelling: { summary: `${symbol} at ${priceLocation} zone`, interpretation: "Awaiting enrichment", confidence: "low" as const, actionSuggestion: "Wait for data" },
          ageDays: undefined as number | undefined,
          aur: null as number | null,
          aurZScore: null as number | null,
          isBuyConcentrated: false,
        };

        if (classicSignal.aur !== undefined) signal.aur = classicSignal.aur;
        if (classicSignal.aurZScore !== undefined) signal.aurZScore = classicSignal.aurZScore;
        if (classicSignal.isBuyConcentrated !== undefined) signal.isBuyConcentrated = classicSignal.isBuyConcentrated;

        try {
          const listingTimestamp = await getSymbolListingDate(symbol);
          if (listingTimestamp) signal.ageDays = calculateAgeDays(listingTimestamp);
        } catch { /* skip */ }

        if (process.env.COINGLASS_API_KEY && i < enrichLimit) {
          try {
            const enrichedData = await enrichSignalWithCoinglass(signal, high24h, low24h,
              signal.aur !== undefined ? { aur: signal.aur, aurZScore: signal.aurZScore ?? 0, aurRising: classicSignal.aurRising ?? false, aurSlope: classicSignal.aurSlope ?? 0 } : undefined);
            Object.assign(signal, enrichedData);
          } catch (err) {
            console.log(`[ENHANCED-CACHE] Failed to enrich ${symbol}`);
          }
        }

        signal.preSpikeScore = calculatePreSpikeScore(
          signal.volumeSpikeRatio, signal.volAccel, signal.oiChange24h, signal.rsi,
          signal.riskReward, signal.signalStrength, signal.fundingRate, signal.longShortRatio,
          signal.aur !== undefined ? { aur: signal.aur, aurZScore: signal.aurZScore ?? 0, aurRising: classicSignal.aurRising ?? false, aurSlope: classicSignal.aurSlope ?? 0, isBuyConcentrated: classicSignal.isBuyConcentrated ?? false, aurTrend: classicSignal.aurTrend ?? [] } : undefined
        );

        try {
          const now = new Date();
          const mlFeatures: ListingFeatures = {
            marketCap: 100000000, marketCapRank: 200,
            daysSinceBinanceListing: signal.ageDays ?? 30, numExchangesListed: 5,
            circulatingSupplyRatio: 0.5, narrativeCategory: 'Other',
            twitterMentions24h: 1000, sentimentScore: 0.5,
            koreanSocialMentions: signal.volumeSpikeRatio > 3 ? 2000 : 500,
            return24h: signal.priceChange24h / 100, return7d: signal.priceChange24h / 50,
            volumeSpike: signal.volumeSpikeRatio, volatility24h: 0.15, rsi14: signal.rsi,
            exchangeNetflow: 0.1, whaleTransactions24h: 20,
            hourOfDay: now.getUTCHours() + 8, dayOfWeek: now.getDay(),
            isKoreaTradingHours: now.getUTCHours() >= 0 && now.getUTCHours() < 9,
            kimchiPremium: 0.02, targetExchange: 'upbit'
          };
          const mlPrediction = await listingAlphaModel.predict(mlFeatures);
          signal.mlScore = {
            listingProbability: Math.round(mlPrediction.listingProbability * 100),
            expectedReturn: Math.round(mlPrediction.expectedReturn * 100),
            confidence: Math.round(mlPrediction.confidence * 100),
            positionSize: Math.round(mlPrediction.recommendedPositionSize * 100)
          };
        } catch { /* ML failed, continue */ }

        // ML Snapshot logging — fail-soft, never breaks enrichment
        try {
          const snapshotRow = buildSnapshotRow(symbol, signalType, signal);
          logSnapshot(snapshotRow);
        } catch { /* snapshot logging failed, continue */ }

        signals.push(signal);
      }

      // Sort by SPIKE PROBABILITY (primary), then spikeScore, then combo, then RVOL
      // P(spike) is the core ranking signal — answers "which coin is most likely to spike NOW"
      // spikeScore (0-10) as secondary for backward compatibility
      // ComboScore (0-4) counts how many HKPTRC primary filters are met
      // RVOL is the #1 single leading indicator as final tiebreaker
      signals.sort((a: any, b: any) => {
        const probDiff = (b.spikeProbability?.probability ?? 0) - (a.spikeProbability?.probability ?? 0);
        if (Math.abs(probDiff) > 0.01) return probDiff; // >1% probability difference = meaningful
        const spikeDiff = (b.spikeScore ?? 0) - (a.spikeScore ?? 0);
        if (spikeDiff !== 0) return spikeDiff;
        const scoreDiff = (b.preSpikeScore ?? 0) - (a.preSpikeScore ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const comboDiff = (b.preSpikeCombo?.comboScore ?? 0) - (a.preSpikeCombo?.comboScore ?? 0);
        if (comboDiff !== 0) return comboDiff;
        return (b.rvol ?? b.volumeSpikeRatio ?? 0) - (a.rvol ?? a.volumeSpikeRatio ?? 0);
      });
      cachedEnhancedSignals = signals;
      enhancedLastUpdated = new Date();
      console.log(`[ENHANCED-CACHE] Background enrichment done: ${signals.length} signals in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    } catch (err: any) {
      console.error(`[ENHANCED-CACHE] Error:`, err?.message || err);
    } finally {
      isEnriching = false;
    }
  }

  // Track if initial calculation is done
  let initialCalculationDone = false;
  let initialCalculationPromise: Promise<void> | null = null;

  // Initialize backtesting service
  backtestingService.initialize().then(() => {
    backtestingService.startMonitoring(60000);
  });

  // Start initial calculation, then enrich in background
  initialCalculationPromise = calculateSignals().then(() => {
    initialCalculationDone = true;
    // Kick off first enrichment in background (non-blocking)
    calculateEnhancedSignals();
  });
  setInterval(async () => {
    await calculateSignals();
    // Enrich after fresh signals are ready
    calculateEnhancedSignals();
  }, UPDATE_FREQUENCY_MINUTES * 60 * 1000);

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
    try {
      const items = await getStorage().getWatchlist();
      res.json(items);
    } catch (error) {
      console.error('[API] Watchlist fetch error:', error);
      res.json([]);
    }
  });

  app.post(api.watchlist.create.path, async (req, res) => {
    try {
      const input = api.watchlist.create.input.parse(req.body);
      const item = await getStorage().addToWatchlist(input);
      res.status(201).json(item);
    } catch (error) {
      console.error('[API] Watchlist add error:', error);
      res.status(503).json({ message: "Storage temporarily unavailable" });
    }
  });

  app.delete(api.watchlist.delete.path, async (req, res) => {
    try {
      await getStorage().removeFromWatchlist(Number(req.params.id));
      res.status(204).send();
    } catch (error) {
      console.error('[API] Watchlist delete error:', error);
      res.status(503).json({ message: "Storage temporarily unavailable" });
    }
  });

  // ============================================
  // CONTINUOUS PAPER TRADING API ENDPOINTS
  // ============================================

  app.get("/api/backtest/live", async (req, res) => {
    try {
      const stats = continuousBacktestEngine.getStats();
      const openPositions = continuousBacktestEngine.getOpenPositions();
      const closedTrades = continuousBacktestEngine.getClosedTrades();
      const equityCurve = continuousBacktestEngine.getEquityCurve();

      res.json({
        stats,
        openPositions,
        closedTrades: closedTrades.slice(0, 50),
        equityCurve: equityCurve.slice(-100)
      });
    } catch (error) {
      console.error("Error fetching live backtest data:", error);
      res.status(500).json({ message: "Failed to fetch live backtest data" });
    }
  });

  app.post("/api/backtest/live/start", async (req, res) => {
    try {
      continuousBacktestEngine.start();
      res.json({ success: true, message: "Continuous paper trading started" });
    } catch (error) {
      console.error("Error starting continuous backtest:", error);
      res.status(500).json({ message: "Failed to start continuous backtest" });
    }
  });

  app.post("/api/backtest/live/stop", async (req, res) => {
    try {
      continuousBacktestEngine.stop();
      res.json({ success: true, message: "Continuous paper trading stopped" });
    } catch (error) {
      console.error("Error stopping continuous backtest:", error);
      res.status(500).json({ message: "Failed to stop continuous backtest" });
    }
  });

  // ============================================
  // BACKTESTING API ENDPOINTS
  // ============================================

  app.get("/api/backtest/stats", async (req, res) => {
    try {
      // Return mock stats based on the 5 mock trades
      // 3 wins (MELANIA, EVAA, SOL) and 2 losses (RLS, BTC)
      const mockStats = {
        totalCapital: 10327.90,
        totalPnl: 327.90,
        totalTrades: 5,
        winRate: 60.0,
        avgRMultiple: 0.4,
        maxDrawdown: 1.0,
        sharpeRatio: 1.85,
        profitFactor: 2.64,
        avgWin: 175.97,
        avgLoss: -100.00,
        expectancy: 65.58,
        winningTrades: 3,
        losingTrades: 2
      };
      res.json(mockStats);
    } catch (error) {
      console.error("Error fetching backtest stats:", error);
      res.status(500).json({ message: "Failed to fetch backtest stats" });
    }
  });

  app.get("/api/backtest/trades", async (req, res) => {
    try {
      let trades = await backtestingService.getTrades();
      const limit = parseInt(req.query.limit as string) || 50;
      
      // If no trades, return mock trades for demonstration
      if (!trades || trades.length === 0) {
        const now = new Date();
        const mockTrades = [
          {
            tradeId: "BT-001",
            symbol: "MELANIAUSDT",
            side: "LONG",
            entryPrice: 1.2450,
            exitPrice: 1.3695,
            stopLoss: 1.1205,
            tp1: 1.3695,
            tp2: 1.4940,
            tp3: 1.6185,
            entryTimestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
            exitTimestamp: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
            status: "closed",
            tp1Hit: true,
            tp2Hit: false,
            tp3Hit: false,
            slHit: false,
            finalPnl: 125.40,
            rMultiple: 1.0,
            holdingTimeMinutes: 90,
            capitalUsed: 1000,
            exitReason: "TP1_HIT"
          },
          {
            tradeId: "BT-002",
            symbol: "RLSUSDT",
            side: "LONG",
            entryPrice: 0.0854,
            exitPrice: 0.0769,
            stopLoss: 0.0769,
            tp1: 0.1024,
            tp2: 0.1195,
            tp3: 0.1365,
            entryTimestamp: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
            exitTimestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
            status: "closed",
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false,
            slHit: true,
            finalPnl: -100.00,
            rMultiple: -1.0,
            holdingTimeMinutes: 120,
            capitalUsed: 1000,
            exitReason: "STOP_LOSS"
          },
          {
            tradeId: "BT-003",
            symbol: "EVAAUSDT",
            side: "LONG",
            entryPrice: 0.0325,
            exitPrice: 0.0423,
            stopLoss: 0.0293,
            tp1: 0.0390,
            tp2: 0.0455,
            tp3: 0.0520,
            entryTimestamp: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
            exitTimestamp: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
            status: "closed",
            tp1Hit: true,
            tp2Hit: true,
            tp3Hit: false,
            finalPnl: 302.50,
            rMultiple: 2.0,
            holdingTimeMinutes: 180,
            capitalUsed: 1000,
            exitReason: "TP2_HIT"
          },
          {
            tradeId: "BT-004",
            symbol: "SOLUSDT",
            side: "LONG",
            entryPrice: 245.80,
            exitPrice: 270.38,
            stopLoss: 221.22,
            tp1: 270.38,
            tp2: 294.96,
            tp3: 319.54,
            entryTimestamp: new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString(),
            exitTimestamp: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(),
            status: "closed",
            tp1Hit: true,
            tp2Hit: false,
            tp3Hit: false,
            slHit: false,
            finalPnl: 100.00,
            rMultiple: 1.0,
            holdingTimeMinutes: 180,
            capitalUsed: 1000,
            exitReason: "TP1_HIT"
          },
          {
            tradeId: "BT-005",
            symbol: "BTCUSDT",
            side: "SHORT",
            entryPrice: 105200,
            exitPrice: 107304,
            stopLoss: 107304,
            tp1: 101092,
            tp2: 98036,
            tp3: 94980,
            entryTimestamp: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
            exitTimestamp: new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString(),
            status: "closed",
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false,
            slHit: true,
            finalPnl: -100.00,
            rMultiple: -1.0,
            holdingTimeMinutes: 120,
            capitalUsed: 1000,
            exitReason: "STOP_LOSS"
          }
        ];
        res.json(mockTrades.slice(0, limit));
        return;
      }
      
      res.json(trades.slice(0, limit));
    } catch (error) {
      console.error("Error fetching trades:", error);
      res.status(500).json({ message: "Failed to fetch trades" });
    }
  });

  app.get("/api/backtest/equity", async (req, res) => {
    try {
      let curve = await backtestingService.getEquityCurve();
      const limit = parseInt(req.query.limit as string) || 100;
      
      // If no equity curve, return mock data
      if (!curve || curve.length === 0) {
        const now = new Date();
        const mockCurve = [];
        let equity = 10000;
        const changes = [0, 125.40, -100, 302.50, 100, -100]; // Based on mock trades
        
        for (let i = 0; i < 6; i++) {
          equity += changes[i];
          mockCurve.push({
            equity,
            timestamp: new Date(now.getTime() - (5 - i) * 2 * 60 * 60 * 1000).toISOString(),
            drawdown: equity < 10000 ? ((10000 - equity) / 10000) * 100 : 0
          });
        }
        res.json(mockCurve.slice(0, limit));
        return;
      }
      
      res.json(curve.slice(0, limit));
    } catch (error) {
      console.error("Error fetching equity curve:", error);
      res.status(500).json({ message: "Failed to fetch equity curve" });
    }
  });

  app.get("/api/backtest/signals", async (req, res) => {
    try {
      const signals = await backtestingService.getSignalHistory();
      const limit = parseInt(req.query.limit as string) || 100;
      res.json(signals.slice(0, limit));
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
  // SESSION & TIME (HKT) ENDPOINTS
  // ============================================

  /** GET /api/session — Current session classification in HKT */
  app.get("/api/session", (req, res) => {
    const classification = classifySession();
    const schedule = getSessionSchedule();
    res.json({
      current: classification,
      schedule,
      serverUtc: new Date().toISOString(),
    });
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
      const comments = await getStorage().getComments(limit);
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
      res.json([]);
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

      const comment = await getStorage().addComment({
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
  });

  // ============================================
  // COINGLASS ENHANCED ENDPOINTS
  // ============================================

  // Enhanced scan: Get top altcoins with Coinglass enriched data (limited to 15 for rate limits)
  app.get("/api/enhanced-scan", async (req, res) => {
    try {
      // Check if Coinglass API key is configured
      const hasApiKey = !!process.env.COINGLASS_API_KEY;
      if (!hasApiKey) {
        res.status(503).json({ 
          error: "Coinglass API key not configured",
          message: "Add COINGLASS_API_KEY to secrets to enable enhanced scanning"
        });
        return;
      }

      // Each symbol makes ~6 Coinglass API calls, limit to 10 symbols max (60 calls < 80/min limit)
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 10);
      console.log(`[ENHANCED-SCAN] Fetching top ${limit} altcoins with Coinglass data...`);
      
      // Fetch top coins by volume from Bitunix
      const response = await axios.get(
        "https://fapi.bitunix.com/api/v1/futures/market/tickers",
        { timeout: 10000 }
      );
      
      const rawData = response.data.data;
      if (!Array.isArray(rawData)) {
        res.status(500).json({ error: "Failed to fetch market data" });
        return;
      }

      // Filter and sort by volume, get top coins (excluding stablecoins)
      const validCoins = rawData
        .filter((t: any) => {
          const symbol = t.symbol || "";
          const price = parseFloat(t.lastPrice);
          const volume = parseFloat(t.quoteVol);
          // Exclude stablecoins and non-USDT pairs
          if (symbol.includes("USDC") || (symbol.includes("USDT") && !symbol.endsWith("USDT"))) return false;
          return price > 0 && volume > 0 && !isNaN(price) && !isNaN(volume) && symbol.endsWith("USDT");
        })
        .sort((a: any, b: any) => parseFloat(b.quoteVol) - parseFloat(a.quoteVol))
        .slice(0, limit);

      console.log(`[ENHANCED-SCAN] Processing ${validCoins.length} coins...`);

      // Fetch enhanced data for each coin sequentially to respect rate limits
      const enrichedData: Array<{
        symbol: string;
        price: number;
        priceChange24h: number;
        volume24h: number;
        coinglass: EnhancedMarketData | null;
      }> = [];

      for (const coin of validCoins) {
        const symbol = coin.symbol.replace("USDT", "");
        const price = parseFloat(coin.lastPrice);
        const open = parseFloat(coin.open);
        const priceChange24h = open > 0 ? ((price - open) / open) * 100 : 0;
        const volume24h = parseFloat(coin.quoteVol);

        try {
          const coinglassData = await getEnhancedMarketData(symbol);
          enrichedData.push({
            symbol: coin.symbol,
            price,
            priceChange24h,
            volume24h,
            coinglass: coinglassData,
          });
        } catch (err) {
          // If Coinglass fails for this symbol, include basic data
          enrichedData.push({
            symbol: coin.symbol,
            price,
            priceChange24h,
            volume24h,
            coinglass: null,
          });
        }
      }

      // Sort by momentum strength and accumulation score
      const momentumOrder = {
        strong_bullish: 0,
        bullish: 1,
        neutral: 2,
        bearish: 3,
        strong_bearish: 4,
      };

      const sortedData = enrichedData.sort((a, b) => {
        // Primary: momentum strength
        const aMomentum = a.coinglass?.momentumStrength || "neutral";
        const bMomentum = b.coinglass?.momentumStrength || "neutral";
        const momentumDiff = momentumOrder[aMomentum] - momentumOrder[bMomentum];
        if (momentumDiff !== 0) return momentumDiff;
        
        // Secondary: accumulation score
        const aScore = a.coinglass?.accumulationScore || 50;
        const bScore = b.coinglass?.accumulationScore || 50;
        return bScore - aScore;
      });

      console.log(`[ENHANCED-SCAN] Completed. ${sortedData.filter(d => d.coinglass).length} coins with Coinglass data.`);

      res.json({
        data: sortedData,
        timestamp: new Date().toISOString(),
        totalCoins: sortedData.length,
        withCoinglassData: sortedData.filter(d => d.coinglass).length,
        rateLimit: {
          maxSymbols: 10,
          note: "Limited to 10 symbols per request to respect Coinglass API rate limits (80 req/min)"
        }
      });
    } catch (error: any) {
      console.error("[ENHANCED-SCAN] Error:", error.message);
      res.status(500).json({ error: "Failed to fetch enhanced scan data" });
    }
  });

  // Signal analysis: Get detailed multi-factor analysis for a specific symbol
  app.get("/api/signal-analysis/:symbol", async (req, res) => {
    try {
      // Check if Coinglass API key is configured
      if (!process.env.COINGLASS_API_KEY) {
        res.status(503).json({ 
          error: "Coinglass API key not configured",
          message: "Add COINGLASS_API_KEY to secrets to enable signal analysis"
        });
        return;
      }

      const { symbol } = req.params;
      const cleanSymbol = symbol.replace("USDT", "").toUpperCase();
      
      console.log(`[SIGNAL-ANALYSIS] Analyzing ${cleanSymbol}...`);

      const enhancedData = await getEnhancedMarketData(cleanSymbol);

      // Generate trading signals and interpretations
      const signals: Array<{
        type: string;
        strength: "strong" | "moderate" | "weak";
        direction: "bullish" | "bearish" | "neutral";
        description: string;
      }> = [];

      // 1. Accumulation/Distribution signal
      if (enhancedData.accumulationScore >= 70) {
        signals.push({
          type: "accumulation",
          strength: enhancedData.accumulationScore >= 80 ? "strong" : "moderate",
          direction: "bullish",
          description: `Strong accumulation detected (score: ${enhancedData.accumulationScore}). Smart money appears to be buying.`,
        });
      } else if (enhancedData.distributionScore >= 70) {
        signals.push({
          type: "distribution",
          strength: enhancedData.distributionScore >= 80 ? "strong" : "moderate",
          direction: "bearish",
          description: `Distribution phase detected (score: ${enhancedData.distributionScore}). Sellers are in control.`,
        });
      }

      // 2. Liquidation analysis signal
      const { liquidationAnalysis } = enhancedData;
      if (liquidationAnalysis.liquidationBias === "long") {
        signals.push({
          type: "liquidation_risk",
          strength: liquidationAnalysis.totalLongLiquidation > liquidationAnalysis.totalShortLiquidation * 2 ? "strong" : "moderate",
          direction: "bearish",
          description: `High long liquidation risk. Max pain for longs at $${liquidationAnalysis.maxPainLong.toFixed(2)}.`,
        });
      } else if (liquidationAnalysis.liquidationBias === "short") {
        signals.push({
          type: "short_squeeze_setup",
          strength: liquidationAnalysis.totalShortLiquidation > liquidationAnalysis.totalLongLiquidation * 2 ? "strong" : "moderate",
          direction: "bullish",
          description: `Short squeeze potential. Max pain for shorts at $${liquidationAnalysis.maxPainShort.toFixed(2)}.`,
        });
      }

      // 3. Orderbook wall analysis
      const { orderbookAnalysis } = enhancedData;
      if (orderbookAnalysis.strongestSupport) {
        signals.push({
          type: "support_wall",
          strength: orderbookAnalysis.supportWalls.length >= 3 ? "strong" : "moderate",
          direction: "bullish",
          description: `Strong support at $${orderbookAnalysis.strongestSupport.toFixed(2)} with ${orderbookAnalysis.supportWalls.length} bid walls.`,
        });
      }
      if (orderbookAnalysis.strongestResistance) {
        signals.push({
          type: "resistance_wall",
          strength: orderbookAnalysis.resistanceWalls.length >= 3 ? "strong" : "moderate",
          direction: "bearish",
          description: `Resistance at $${orderbookAnalysis.strongestResistance.toFixed(2)} with ${orderbookAnalysis.resistanceWalls.length} ask walls.`,
        });
      }

      // 4. Long/Short positioning
      const { positioningAnalysis } = enhancedData;
      if (positioningAnalysis.trend === "long_dominant") {
        signals.push({
          type: "positioning",
          strength: positioningAnalysis.longShortRatio > 1.3 ? "strong" : "moderate",
          direction: "bullish",
          description: `Longs dominating (L/S ratio: ${positioningAnalysis.longShortRatio.toFixed(2)}). Bullish sentiment.`,
        });
      } else if (positioningAnalysis.trend === "short_dominant") {
        signals.push({
          type: "positioning",
          strength: positioningAnalysis.longShortRatio < 0.7 ? "strong" : "moderate",
          direction: "bearish",
          description: `Shorts dominating (L/S ratio: ${positioningAnalysis.longShortRatio.toFixed(2)}). Bearish sentiment.`,
        });
      }

      // 5. Taker flow analysis
      const { flowAnalysis } = enhancedData;
      if (flowAnalysis.flowBias === "buying") {
        signals.push({
          type: "taker_flow",
          strength: flowAnalysis.netFlow > flowAnalysis.sellVolume ? "strong" : "moderate",
          direction: "bullish",
          description: `Net buying pressure. Buy volume exceeds sell volume by ${((flowAnalysis.buyVolume / flowAnalysis.sellVolume - 1) * 100).toFixed(1)}%.`,
        });
      } else if (flowAnalysis.flowBias === "selling") {
        signals.push({
          type: "taker_flow",
          strength: Math.abs(flowAnalysis.netFlow) > flowAnalysis.buyVolume ? "strong" : "moderate",
          direction: "bearish",
          description: `Net selling pressure. Sell volume exceeds buy volume by ${((flowAnalysis.sellVolume / flowAnalysis.buyVolume - 1) * 100).toFixed(1)}%.`,
        });
      }

      // 6. Funding rate signal
      const { fundingBasisAnalysis } = enhancedData;
      if (fundingBasisAnalysis.fundingBias === "bullish") {
        signals.push({
          type: "funding_rate",
          strength: fundingBasisAnalysis.averageFundingRate > 0.0005 ? "strong" : "moderate",
          direction: "bullish",
          description: `Positive funding rate (${(fundingBasisAnalysis.averageFundingRate * 100).toFixed(4)}%). Longs paying shorts.`,
        });
      } else if (fundingBasisAnalysis.fundingBias === "bearish") {
        signals.push({
          type: "funding_rate",
          strength: fundingBasisAnalysis.averageFundingRate < -0.0005 ? "strong" : "moderate",
          direction: "bearish",
          description: `Negative funding rate (${(fundingBasisAnalysis.averageFundingRate * 100).toFixed(4)}%). Shorts paying longs.`,
        });
      }

      // Generate overall interpretation
      const bullishSignals = signals.filter(s => s.direction === "bullish");
      const bearishSignals = signals.filter(s => s.direction === "bearish");
      const strongBullish = bullishSignals.filter(s => s.strength === "strong").length;
      const strongBearish = bearishSignals.filter(s => s.strength === "strong").length;

      let overallBias: "strongly_bullish" | "bullish" | "neutral" | "bearish" | "strongly_bearish";
      let interpretation: string;

      if (strongBullish >= 2 && bullishSignals.length > bearishSignals.length) {
        overallBias = "strongly_bullish";
        interpretation = "Multiple strong bullish signals detected. Consider long positions with tight stops.";
      } else if (bullishSignals.length > bearishSignals.length) {
        overallBias = "bullish";
        interpretation = "Net bullish bias. Look for pullbacks to enter long positions.";
      } else if (strongBearish >= 2 && bearishSignals.length > bullishSignals.length) {
        overallBias = "strongly_bearish";
        interpretation = "Multiple strong bearish signals detected. Consider short positions or stay out.";
      } else if (bearishSignals.length > bullishSignals.length) {
        overallBias = "bearish";
        interpretation = "Net bearish bias. Avoid longs, consider shorts on bounces.";
      } else {
        overallBias = "neutral";
        interpretation = "Mixed signals. Wait for clearer directional confirmation.";
      }

      // Identify setups
      const setups: string[] = [];
      
      // Breakout setup: high accumulation + support wall + buying flow
      if (enhancedData.accumulationScore >= 65 && orderbookAnalysis.strongestSupport && flowAnalysis.flowBias === "buying") {
        setups.push("Breakout Setup: Accumulation with support and buying pressure");
      }
      
      // Short squeeze: short dominant + high short liquidation potential
      if (positioningAnalysis.trend === "short_dominant" && liquidationAnalysis.liquidationBias === "short") {
        setups.push("Short Squeeze Potential: Heavy shorts with liquidation cascade risk");
      }
      
      // Distribution top: high distribution + resistance + selling
      if (enhancedData.distributionScore >= 65 && orderbookAnalysis.strongestResistance && flowAnalysis.flowBias === "selling") {
        setups.push("Distribution Top: Sellers active at resistance");
      }
      
      // Capitulation: extreme fear + high selling + long liquidations
      if (enhancedData.fearGreed.value <= 25 && flowAnalysis.flowBias === "selling" && liquidationAnalysis.liquidationBias === "long") {
        setups.push("Potential Capitulation: Extreme fear with long liquidations");
      }

      res.json({
        symbol: cleanSymbol,
        timestamp: new Date().toISOString(),
        enhancedData,
        signals,
        analysis: {
          overallBias,
          interpretation,
          bullishSignalCount: bullishSignals.length,
          bearishSignalCount: bearishSignals.length,
          setups,
        },
      });
    } catch (error: any) {
      console.error(`[SIGNAL-ANALYSIS] Error for ${req.params.symbol}:`, error.message);
      res.status(500).json({ error: "Failed to analyze symbol" });
    }
  });

  // Basic Coinglass data endpoint for quick lookups
  app.get("/api/coinglass/:symbol", async (req, res) => {
    try {
      // Check if Coinglass API key is configured
      if (!process.env.COINGLASS_API_KEY) {
        res.status(503).json({ 
          error: "Coinglass API key not configured",
          message: "Add COINGLASS_API_KEY to secrets to enable Coinglass data"
        });
        return;
      }

      const { symbol } = req.params;
      const cleanSymbol = symbol.replace("USDT", "").toUpperCase();
      
      // Fetch basic Coinglass data in parallel
      const [oiHistory, liquidationMap, longShortRatio, fundingRates] = await Promise.all([
        getOpenInterestHistory(cleanSymbol, "1h", 24).catch(() => []),
        getLiquidationMap(cleanSymbol).catch(() => []),
        getLongShortRatio(cleanSymbol, "1h", 1).catch(() => []),
        getFundingRate(cleanSymbol).catch(() => []),
      ]);

      // Calculate OI change
      let oiChange24h = null;
      if (oiHistory.length >= 2) {
        const latestOI = oiHistory[oiHistory.length - 1].openInterestUsd;
        const earliestOI = oiHistory[0].openInterestUsd;
        if (earliestOI > 0) {
          oiChange24h = ((latestOI - earliestOI) / earliestOI) * 100;
        }
      }

      // Find max pain levels
      let maxPainLong = null;
      let maxPainShort = null;
      if (liquidationMap.length > 0) {
        const maxLong = liquidationMap.reduce((max, l) => l.longLiquidation > (max?.longLiquidation || 0) ? l : max, liquidationMap[0]);
        const maxShort = liquidationMap.reduce((max, l) => l.shortLiquidation > (max?.shortLiquidation || 0) ? l : max, liquidationMap[0]);
        maxPainLong = maxLong?.price || null;
        maxPainShort = maxShort?.price || null;
      }

      // Get long/short ratio
      const lsRatio = longShortRatio[0]?.longShortRatio || null;

      // Average funding rate
      const avgFunding = fundingRates.length > 0
        ? fundingRates.reduce((sum, fr) => sum + fr.fundingRate, 0) / fundingRates.length
        : null;

      res.json({
        symbol: cleanSymbol,
        oiChange24h,
        maxPainLong,
        maxPainShort,
        longShortRatio: lsRatio,
        avgFundingRate: avgFunding,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error(`[COINGLASS] Error for ${req.params.symbol}:`, error.message);
      res.status(500).json({ error: "Failed to fetch Coinglass data" });
    }
  });

  // GET /api/enhanced-market/:symbol - Returns full EnhancedMarketData for a symbol
  app.get("/api/enhanced-market/:symbol", async (req, res) => {
    try {
      if (!process.env.COINGLASS_API_KEY) {
        res.status(503).json({ 
          error: "Coinglass API key not configured",
          message: "Add COINGLASS_API_KEY to secrets to enable enhanced market data"
        });
        return;
      }

      const { symbol } = req.params;
      const cleanSymbol = symbol.replace("USDT", "").toUpperCase();
      
      console.log(`[ENHANCED-MARKET] Fetching data for ${cleanSymbol}...`);
      
      const enhancedData = await getEnhancedMarketData(cleanSymbol);
      
      res.json({
        ...enhancedData,
        symbol: cleanSymbol,
        requestTimestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error(`[ENHANCED-MARKET] Error for ${req.params.symbol}:`, error.message);
      res.status(500).json({ error: "Failed to fetch enhanced market data" });
    }
  });

  // GET /api/market-signals/:symbol - Returns interpreted trading signals based on enhanced data
  app.get("/api/market-signals/:symbol", async (req, res) => {
    try {
      if (!process.env.COINGLASS_API_KEY) {
        res.status(503).json({ 
          error: "Coinglass API key not configured",
          message: "Add COINGLASS_API_KEY to secrets to enable market signals"
        });
        return;
      }

      const { symbol } = req.params;
      const cleanSymbol = symbol.replace("USDT", "").toUpperCase();
      
      console.log(`[MARKET-SIGNALS] Analyzing ${cleanSymbol}...`);
      
      const enhancedData = await getEnhancedMarketData(cleanSymbol);
      
      // Generate interpreted signals
      const signals: { signal: string; type: "bullish" | "bearish" | "neutral"; weight: number; description: string }[] = [];
      
      // Accumulation vs Distribution
      if (enhancedData.accumulationScore >= 70) {
        signals.push({
          signal: "Strong Accumulation",
          type: "bullish",
          weight: 3,
          description: `Accumulation score ${enhancedData.accumulationScore}/100 indicates smart money buying`
        });
      } else if (enhancedData.accumulationScore >= 55) {
        signals.push({
          signal: "Moderate Accumulation",
          type: "bullish",
          weight: 2,
          description: `Accumulation score ${enhancedData.accumulationScore}/100 shows buying interest`
        });
      } else if (enhancedData.distributionScore >= 70) {
        signals.push({
          signal: "Strong Distribution",
          type: "bearish",
          weight: 3,
          description: `Distribution score ${enhancedData.distributionScore}/100 indicates selling pressure`
        });
      } else if (enhancedData.distributionScore >= 55) {
        signals.push({
          signal: "Moderate Distribution",
          type: "bearish",
          weight: 2,
          description: `Distribution score ${enhancedData.distributionScore}/100 shows selling interest`
        });
      }
      
      // Long/Short positioning signals
      const { positioningAnalysis } = enhancedData;
      if (positioningAnalysis.longShortRatio > 1.5) {
        signals.push({
          signal: "Extreme Long Positioning",
          type: "bearish",
          weight: 2,
          description: `L/S ratio ${positioningAnalysis.longShortRatio.toFixed(2)} - potential short squeeze target`
        });
      } else if (positioningAnalysis.longShortRatio < 0.7) {
        signals.push({
          signal: "Extreme Short Positioning",
          type: "bullish",
          weight: 2,
          description: `L/S ratio ${positioningAnalysis.longShortRatio.toFixed(2)} - potential short squeeze setup`
        });
      }
      
      // Liquidation cluster signals
      const { liquidationAnalysis } = enhancedData;
      if (liquidationAnalysis.liquidationBias === "long") {
        signals.push({
          signal: "Long Liquidation Risk",
          type: "bearish",
          weight: 2,
          description: `Heavy long liquidations clustered at $${liquidationAnalysis.maxPainLong?.toLocaleString() || 'N/A'}`
        });
      } else if (liquidationAnalysis.liquidationBias === "short") {
        signals.push({
          signal: "Short Liquidation Risk",
          type: "bullish",
          weight: 2,
          description: `Heavy short liquidations clustered at $${liquidationAnalysis.maxPainShort?.toLocaleString() || 'N/A'}`
        });
      }
      
      // Flow analysis signals
      const { flowAnalysis } = enhancedData;
      const buySellRatio = flowAnalysis.sellVolume > 0 ? flowAnalysis.buyVolume / flowAnalysis.sellVolume : 1;
      if (flowAnalysis.flowBias === "buying" && buySellRatio > 1.2) {
        signals.push({
          signal: "Aggressive Buying",
          type: "bullish",
          weight: 2,
          description: `Buy/sell ratio ${buySellRatio.toFixed(2)} indicates active accumulation`
        });
      } else if (flowAnalysis.flowBias === "selling" && buySellRatio < 0.8) {
        signals.push({
          signal: "Aggressive Selling",
          type: "bearish",
          weight: 2,
          description: `Buy/sell ratio ${buySellRatio.toFixed(2)} indicates active distribution`
        });
      }
      
      // Orderbook wall signals
      const { orderbookAnalysis } = enhancedData;
      if (orderbookAnalysis.strongestSupport) {
        signals.push({
          signal: "Support Wall",
          type: "bullish",
          weight: 1,
          description: `Strong bid wall at $${orderbookAnalysis.strongestSupport.toLocaleString()}`
        });
      }
      if (orderbookAnalysis.strongestResistance) {
        signals.push({
          signal: "Resistance Wall",
          type: "bearish",
          weight: 1,
          description: `Strong ask wall at $${orderbookAnalysis.strongestResistance.toLocaleString()}`
        });
      }
      
      // Funding rate signals
      const { fundingBasisAnalysis } = enhancedData;
      if (fundingBasisAnalysis.averageFundingRate > 0.0005) {
        signals.push({
          signal: "High Positive Funding",
          type: "bearish",
          weight: 1,
          description: `Funding rate ${(fundingBasisAnalysis.averageFundingRate * 100).toFixed(4)}% - longs paying shorts`
        });
      } else if (fundingBasisAnalysis.averageFundingRate < -0.0005) {
        signals.push({
          signal: "Negative Funding",
          type: "bullish",
          weight: 1,
          description: `Funding rate ${(fundingBasisAnalysis.averageFundingRate * 100).toFixed(4)}% - shorts paying longs`
        });
      }
      
      // Fear & Greed signal
      const { fearGreed } = enhancedData;
      if (fearGreed.value <= 25) {
        signals.push({
          signal: "Extreme Fear",
          type: "bullish",
          weight: 2,
          description: `Fear & Greed at ${fearGreed.value} (${fearGreed.classification}) - contrarian buy signal`
        });
      } else if (fearGreed.value >= 75) {
        signals.push({
          signal: "Extreme Greed",
          type: "bearish",
          weight: 2,
          description: `Fear & Greed at ${fearGreed.value} (${fearGreed.classification}) - contrarian sell signal`
        });
      }
      
      // Identify potential setups
      const setups: string[] = [];
      
      // Breakout setup: accumulation + support + buying pressure
      if (enhancedData.accumulationScore >= 60 && orderbookAnalysis.strongestSupport && flowAnalysis.flowBias === "buying") {
        setups.push("Potential Breakout: Accumulation with support and buying pressure");
      }
      
      // Breakdown setup: distribution + resistance + selling pressure  
      if (enhancedData.distributionScore >= 60 && orderbookAnalysis.strongestResistance && flowAnalysis.flowBias === "selling") {
        setups.push("Potential Breakdown: Distribution with resistance and selling pressure");
      }
      
      // Short squeeze setup: extreme shorts + buying + negative funding
      if (positioningAnalysis.longShortRatio < 0.8 && flowAnalysis.flowBias === "buying" && fundingBasisAnalysis.averageFundingRate < 0) {
        setups.push("Short Squeeze Setup: Heavy shorts with buying pressure and negative funding");
      }
      
      // Long squeeze setup: extreme longs + selling + positive funding
      if (positioningAnalysis.longShortRatio > 1.3 && flowAnalysis.flowBias === "selling" && fundingBasisAnalysis.averageFundingRate > 0) {
        setups.push("Long Squeeze Setup: Heavy longs with selling pressure and positive funding");
      }
      
      // Calculate overall bias
      const bullishWeight = signals.filter(s => s.type === "bullish").reduce((sum, s) => sum + s.weight, 0);
      const bearishWeight = signals.filter(s => s.type === "bearish").reduce((sum, s) => sum + s.weight, 0);
      
      let overallBias: "bullish" | "bearish" | "neutral";
      let biasStrength: "strong" | "moderate" | "weak";
      
      const netBias = bullishWeight - bearishWeight;
      if (netBias >= 4) {
        overallBias = "bullish";
        biasStrength = "strong";
      } else if (netBias >= 2) {
        overallBias = "bullish";
        biasStrength = "moderate";
      } else if (netBias <= -4) {
        overallBias = "bearish";
        biasStrength = "strong";
      } else if (netBias <= -2) {
        overallBias = "bearish";
        biasStrength = "moderate";
      } else {
        overallBias = "neutral";
        biasStrength = "weak";
      }
      
      res.json({
        symbol: cleanSymbol,
        timestamp: new Date().toISOString(),
        signals,
        setups,
        summary: {
          overallBias,
          biasStrength,
          bullishSignals: signals.filter(s => s.type === "bullish").length,
          bearishSignals: signals.filter(s => s.type === "bearish").length,
          momentumStrength: enhancedData.momentumStrength,
          accumulationScore: enhancedData.accumulationScore,
          distributionScore: enhancedData.distributionScore,
        },
        marketMetrics: {
          longShortRatio: positioningAnalysis.longShortRatio,
          fundingRate: fundingBasisAnalysis.averageFundingRate,
          fearGreedIndex: fearGreed.value,
          fearGreedClassification: fearGreed.classification,
        }
      });
    } catch (error: any) {
      console.error(`[MARKET-SIGNALS] Error for ${req.params.symbol}:`, error.message);
      res.status(500).json({ error: "Failed to generate market signals" });
    }
  });

  // GET /api/screen - Returns coins using SAME symbol universe AND signal filters as Classic view
  app.get("/api/screen", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 50);
      const includeCoinglass = req.query.coinglass !== "false";
      
      console.log(`[SCREEN] Fetching unified symbol universe with Classic View filters...`);
      
      // Fetch market data from Bitunix
      const response = await axios.get(
        "https://fapi.bitunix.com/api/v1/futures/market/tickers",
        { timeout: 10000 }
      );
      
      const rawData = response.data.data;
      if (!Array.isArray(rawData)) {
        res.status(500).json({ error: "Failed to fetch market data" });
        return;
      }

      // Use shared symbol selection logic for consistency with Classic view
      const unifiedSymbols = await getUnifiedSymbolUniverse(rawData);
      
      // Apply Classic View signal filters (HOT, ACTIVE, PRE, MAJOR)
      const filteredCoins: any[] = [];
      const signalTypes: Map<string, string> = new Map();
      
      for (const coin of unifiedSymbols) {
        const symbol = coin.symbol;
        const cleanSymbol = symbol.replace("USDT", "");
        const price = parseFloat(coin.lastPrice);
        const open = parseFloat(coin.open);
        const priceChange24h = open > 0 ? ((price - open) / open) * 100 : 0;
        const isMajor = MAJOR_SYMBOLS.includes(symbol);
        
        // Fetch 1H klines for RSI and volume spike calculation
        let rsi = 50;
        let volumeSpikeRatio = 1.0;
        try {
          const klines1H = await fetchKlines(symbol, "1h", 100);
          if (klines1H.length >= 14) {
            const closes = klines1H.map(k => k.close);
            const volumes = klines1H.map(k => k.volume);
            rsi = calculateRSI(closes);
            volumeSpikeRatio = calculateVolumeSpike(volumes);
          }
        } catch {
          // Use defaults if klines unavailable
        }
        
        // Apply Classic View signal type filters
        const isHotMomentum = priceChange24h >= 20 && volumeSpikeRatio >= 2.0;
        const isActiveMomentum = !isHotMomentum && 
          volumeSpikeRatio >= 1.0 && 
          priceChange24h >= 5 && priceChange24h <= 60 && 
          rsi >= 50 && rsi <= 85;
        const isPreConsolidation = 
          volumeSpikeRatio >= 0.5 && volumeSpikeRatio < 1.0 && 
          priceChange24h >= -8 && priceChange24h <= 15 && 
          rsi >= 35 && rsi <= 65;
        // MAJOR: Always include BTC/ETH regardless of volume
        const isMajorQualified = isMajor;
        
        // Determine signal type
        let signalType: string | null = null;
        if (isHotMomentum) signalType = "HOT";
        else if (isMajorQualified) signalType = "MAJOR";
        else if (isActiveMomentum) signalType = "ACTIVE";
        else if (isPreConsolidation) signalType = "PRE";
        
        // Only include if matches a signal category
        if (signalType !== null) {
          filteredCoins.push({ ...coin, rsi, volumeSpikeRatio, priceChange24h });
          signalTypes.set(symbol, signalType);
        }
      }
      
      const validCoins = filteredCoins.slice(0, limit);
      
      console.log(`[SCREEN] Filtered to ${validCoins.length} signals from ${unifiedSymbols.length} universe coins`);

      // Build screen data
      const screenData: Array<{
        symbol: string;
        price: number;
        priceChange24h: number;
        volume24h: number;
        high24h: number;
        low24h: number;
        htfBias?: {
          side: "LONG" | "SHORT";
          supertrendBias: "bullish" | "bearish";
          fundingConfirms: boolean;
          confidence: "high" | "medium" | "low";
        };
        coinglass?: {
          oiChange24h: number | null;
          longShortRatio: number | null;
          maxPainLong: number | null;
          maxPainShort: number | null;
          fundingRate: number | null;
        };
      }> = [];

      // Limit Coinglass lookups to first 10 coins to respect rate limits
      const coinglassLimit = Math.min(limit, 10);

      for (let i = 0; i < validCoins.length; i++) {
        const coin = validCoins[i];
        const symbol = coin.symbol;
        const cleanSymbol = symbol.replace("USDT", "");
        const price = parseFloat(coin.lastPrice);
        
        const coinData: any = {
          symbol,
          price,
          priceChange24h: coin.priceChange24h,
          volume24h: parseFloat(coin.quoteVol),
          high24h: parseFloat(coin.high),
          low24h: parseFloat(coin.low),
          signalType: signalTypes.get(symbol) || null,
          rsi: coin.rsi,
          volumeSpikeRatio: coin.volumeSpikeRatio,
        };

        // Fetch OKX 4H klines and funding rate for htfBias calculation
        try {
          const [okxKlines, okxFundingRate] = await Promise.all([
            getOKXKlines(cleanSymbol, "4H", 50),
            getOKXFundingRate(cleanSymbol),
          ]);
          
          if (okxKlines.length >= 14) {
            const klines4HFormatted = okxKlines.map(k => ({
              high: k.high,
              low: k.low,
              close: k.close,
            }));
            
            const htfBias = calculateHtfBias(klines4HFormatted, okxFundingRate ?? undefined, coinData.symbol);
            coinData.htfBias = htfBias;
          }
        } catch (err) {
          // Skip htfBias if OKX data unavailable
        }

        // Fetch listing age (ageDays)
        try {
          const listingTimestamp = await getSymbolListingDate(symbol);
          if (listingTimestamp) {
            coinData.ageDays = calculateAgeDays(listingTimestamp);
          }
        } catch {
          // Skip age if unavailable
        }

        // Fetch Coinglass data for first 10 coins only (rate limit protection)
        if (includeCoinglass && process.env.COINGLASS_API_KEY && i < coinglassLimit) {
          try {
            const [oiHistory, lsRatio, liqMap, funding] = await Promise.all([
              getOpenInterestHistory(cleanSymbol, "1h", 24).catch(() => []),
              getLongShortRatio(cleanSymbol, "1h", 1).catch(() => []),
              getLiquidationMap(cleanSymbol).catch(() => []),
              getFundingRate(cleanSymbol).catch(() => []),
            ]);

            // Calculate OI change
            let oiChange24h = null;
            if (oiHistory.length >= 2) {
              const latest = oiHistory[oiHistory.length - 1].openInterestUsd;
              const earliest = oiHistory[0].openInterestUsd;
              if (earliest > 0) {
                oiChange24h = ((latest - earliest) / earliest) * 100;
              }
            }

            // Max pain levels
            let maxPainLong = null;
            let maxPainShort = null;
            if (liqMap.length > 0) {
              const maxL = liqMap.reduce((max, l) => l.longLiquidation > (max?.longLiquidation || 0) ? l : max, liqMap[0]);
              const maxS = liqMap.reduce((max, l) => l.shortLiquidation > (max?.shortLiquidation || 0) ? l : max, liqMap[0]);
              maxPainLong = maxL?.price || null;
              maxPainShort = maxS?.price || null;
            }

            coinData.coinglass = {
              oiChange24h,
              longShortRatio: lsRatio[0]?.longShortRatio || null,
              maxPainLong,
              maxPainShort,
              fundingRate: funding.length > 0 
                ? funding.reduce((sum, fr) => sum + fr.fundingRate, 0) / funding.length 
                : null,
            };
          } catch (err) {
            // Skip Coinglass data for this symbol
          }
        }

        screenData.push(coinData);
      }

      res.json({
        data: screenData,
        timestamp: new Date().toISOString(),
        totalCoins: screenData.length,
        coinglassEnabled: includeCoinglass && !!process.env.COINGLASS_API_KEY,
        coinglassCoins: screenData.filter(c => c.coinglass).length,
      });
    } catch (error: any) {
      console.error("[SCREEN] Error:", error.message);
      res.status(500).json({ error: "Failed to fetch screen data" });
    }
  });

  // GET /api/enhanced-screener - Serves from background-enriched cache (instant response)
  app.get("/api/enhanced-screener", async (req, res) => {
    try {
      // Parse filter parameters
      const filters: ScreenerFilters = {
        minPScore: req.query.minPScore ? parseInt(req.query.minPScore as string) : undefined,
        hideExhaust: req.query.hideExhaust === "true",
        phaseFilter: (req.query.phaseFilter as any) || "ALL",
        minSignalStrength: req.query.minStrength ? parseInt(req.query.minStrength as string) : undefined,
        sideFilter: (req.query.sideFilter as any) || "ALL",
      };

      // If cache is empty and initial enrichment hasn't run yet, wait up to 90s
      if (cachedEnhancedSignals.length === 0) {
        console.log(`[ENHANCED-SCREENER] Cache empty, waiting for background enrichment...`);
        const maxWait = 90000;
        const start = Date.now();
        while (cachedEnhancedSignals.length === 0 && Date.now() - start < maxWait) {
          await new Promise(r => setTimeout(r, 2000));
        }
        // If still empty after wait, trigger enrichment synchronously as fallback
        if (cachedEnhancedSignals.length === 0 && cachedSignals.length > 0) {
          console.log(`[ENHANCED-SCREENER] Fallback: running enrichment synchronously`);
          await calculateEnhancedSignals();
        }
      }

      // Apply filters on cached data (instant)
      const filteredSignals = applyScreenerFilters([...cachedEnhancedSignals], filters);

      res.json({
        signals: filteredSignals,
        timestamp: enhancedLastUpdated?.toISOString() || new Date().toISOString(),
        totalSignals: filteredSignals.length,
        unfilteredCount: cachedEnhancedSignals.length,
        filters,
        enrichedCount: cachedEnhancedSignals.length,
      });
    } catch (error: any) {
      console.error("[ENHANCED-SCREENER] Error:", error.message);
      res.status(500).json({ error: "Failed to fetch enhanced screener data" });
    }
  });

  // ============================================
  // AUTOTRADE ENDPOINTS
  // ============================================

  app.get("/api/autotrade/status", async (req, res) => {
    try {
      const config = autotradeService.getConfig();
      const stats = await autotradeService.getStats();
      const positions = bitunixTradeService.isConfigured() 
        ? await bitunixTradeService.getOpenPositions().catch(() => [])
        : [];
      
      res.json({
        enabled: autotradeService.isEnabled(),
        configured: bitunixTradeService.isConfigured(),
        config,
        stats,
        positions,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/autotrade/config", async (req, res) => {
    try {
      const config = autotradeService.getConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/autotrade/config", async (req, res) => {
    try {
      await autotradeService.saveConfig(req.body);
      res.json({ success: true, config: autotradeService.getConfig() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/autotrade/enable", async (req, res) => {
    try {
      await autotradeService.enable();
      res.json({ success: true, enabled: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/autotrade/disable", async (req, res) => {
    try {
      await autotradeService.disable();
      res.json({ success: true, enabled: false });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/autotrade/trades", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const trades = await autotradeService.getTradeHistory(limit);
      res.json({ trades });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/autotrade/positions", async (req, res) => {
    try {
      if (!bitunixTradeService.isConfigured()) {
        return res.json({ positions: [], configured: false });
      }
      const positions = await bitunixTradeService.getOpenPositions();
      res.json({ positions, configured: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/autotrade/close/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const result = await autotradeService.closePosition(symbol);
      res.json({ success: true, result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/autotrade/emergency-close", async (req, res) => {
    try {
      const results = await autotradeService.emergencyCloseAll();
      res.json({ success: true, results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/autotrade/account", async (req, res) => {
    try {
      if (!bitunixTradeService.isConfigured()) {
        return res.json({ configured: false });
      }
      const account = await bitunixTradeService.getAccountInfo();
      res.json({ configured: true, account });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/autotrade/test-signal", async (req, res) => {
    try {
      const signal = req.body;
      const result = await autotradeService.processSignal(signal);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Initialize autotrade service
  autotradeService.initialize().catch(err => {
    console.error("[AUTOTRADE] Initialization error:", err);
  });

  // ============================================
  // BACKTEST ENGINE ENDPOINTS
  // ============================================

  app.get("/api/backtest-engine/config", async (req, res) => {
    try {
      const config = backtestEngine.getConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backtest-engine/config", async (req, res) => {
    try {
      backtestEngine.updateConfig(req.body);
      res.json({ success: true, config: backtestEngine.getConfig() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backtest-engine/reset", async (req, res) => {
    try {
      backtestEngine.reset();
      res.json({ success: true, message: "Backtest engine reset" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backtest-engine/signal", async (req, res) => {
    try {
      const signal = req.body as BacktestSignal;
      signal.timestamp = new Date(signal.timestamp);
      const result = backtestEngine.processSignal(signal);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backtest-engine/update-trade", async (req, res) => {
    try {
      const { tradeId, currentPrice, currentTime } = req.body;
      const result = backtestEngine.updateTrade(tradeId, currentPrice, new Date(currentTime));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backtest-engine/metrics", async (req, res) => {
    try {
      const metrics = backtestEngine.calculateMetrics();
      res.json(metrics);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backtest-engine/trades", async (req, res) => {
    try {
      const trades = backtestEngine.getTrades();
      const active = backtestEngine.getActiveTrades();
      const closed = backtestEngine.getClosedTrades();
      res.json({ trades, active, closed });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backtest-engine/equity-curve", async (req, res) => {
    try {
      const curve = backtestEngine.getEquityCurve();
      res.json(curve);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/backtest-engine/report", async (req, res) => {
    try {
      const report = backtestEngine.generateReport();
      const metrics = backtestEngine.calculateMetrics();
      res.json({ report, metrics });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backtest-engine/save", async (req, res) => {
    try {
      await backtestEngine.saveResults();
      res.json({ success: true, message: "Results saved to database" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-start backtest using signals with PSCORE >= 1.5 OR BREAKOUT phase
  app.post("/api/backtest-engine/auto-start", async (req, res) => {
    try {
      // Use ALL cached signals and let the backtest engine filter by PSCORE/BREAKOUT
      const screenerSignals: ScreenerSignalForBacktest[] = cachedSignals
        .map((s: any) => ({
          symbol: s.symbol,
          price: s.price,
          marketPhase: s.marketPhase || "TREND",
          entryModel: s.entryModel || "BOS_ENTRY",
          htfBias: s.htfBias,
          rsi: s.rsi || 50,
          volumeSpike: s.volumeSpike || 1,
          signalStrength: s.signalStrength || 3,
          previousHigh: s.previousHigh,
          previousLow: s.previousLow,
          ema21: s.ema21,
          pscore: s.spikeScore || s.preSpikeScore || s.pscore || 0,
          entry: s.entry,
          stopLoss: s.stopLoss,
          tp1: s.tp1,
          tp2: s.tp2,
          tp3: s.tp3,
          riskReward: s.riskReward,
        }));

      console.log(`[AUTO-BACKTEST API] Processing ${screenerSignals.length} signals (PSCORE >= 1.5 OR BREAKOUT)`);

      const result = await autoStartBacktestFromScreener(screenerSignals);
      const metrics = backtestEngine.calculateMetrics();

      res.json({
        success: true,
        ...result,
        metrics,
        sharpeTarget: metrics.sharpeRatio >= 2.5 ? "MET" : "BELOW TARGET",
      });
    } catch (error: any) {
      console.error("[AUTO-BACKTEST API] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}

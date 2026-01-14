import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
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

async function fetchKlines(symbol: string, interval: string, limit: number = 100): Promise<Kline[]> {
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url, { timeout: 8000 });
    
    if (response.data?.data && Array.isArray(response.data.data)) {
      return response.data.data.map((k: any) => ({
        openTime: parseInt(k.time),
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.quoteVol),
      })).reverse();
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
    swingLows.push(Math.min(...klines.slice(-20).map(k => k.low)));
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
    swingHighs.push(Math.max(...klines.slice(-20).map(k => k.high)));
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
  const avgVolume = recent.reduce((sum, k) => sum + k.volume, 0) / recent.length;
  
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

function detectLiquidityClusters(orderBook: OrderBookData | null, currentPrice: number): LiquidityCluster[] {
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

function calculateOrderBookImbalance(orderBook: OrderBookData | null): { imbalance: number; bidAskRatio: number } {
  if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
    return { imbalance: 0, bidAskRatio: 1 };
  }
  
  const bidVolume = orderBook.bids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const askVolume = orderBook.asks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  
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
  ob: OrderBlock | null
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
  
  const levels: { label: string; price: number; pct: number; reason: string }[] = [];
  
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
      price: currentPrice * 1.10,
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
  ob: OrderBlock | null
): { sl: number; slReason: string } {
  let sl = currentPrice * 0.95;
  let slReason = "5% below entry";
  
  if (ob && ob.type === "bullish" && ob.level < currentPrice && ob.level > currentPrice * 0.92) {
    sl = ob.level * 0.995;
    slReason = "Below Order Block";
  } else if (fvg && fvg.type === "bullish" && fvg.level < currentPrice && fvg.level > currentPrice * 0.92) {
    sl = fvg.level * 0.995;
    slReason = "Below FVG";
  } else if (swingLows.length > 0 && swingLows[0] < currentPrice && swingLows[0] > currentPrice * 0.92) {
    sl = swingLows[0] * 0.995;
    slReason = "Below Swing Low";
  }
  
  return { sl, slReason };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
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
  function getSpikeReadiness(minutesOnList: number): "warming" | "primed" | "hot" | "overdue" {
    if (minutesOnList < 5) return "warming";      // Just appeared, building momentum
    if (minutesOnList >= 5 && minutesOnList < 15) return "primed";  // Optimal window for spike
    if (minutesOnList >= 15 && minutesOnList < 30) return "hot";    // Spike likely imminent
    return "overdue";  // May have already spiked or false signal
  }

  async function calculateSignals() {
    if (isCalculating) return;
    isCalculating = true;
    
    try {
      console.log("Starting signal calculation...");
      const response = await axios.get("https://fapi.bitunix.com/api/v1/futures/market/tickers");
      const rawData = response.data.data;

      if (!Array.isArray(rawData)) {
        isCalculating = false;
        return;
      }

      const signals: any[] = [];
      
      // Get watchlist to prioritize those symbols
      const watchlist = await storage.getWatchlist();
      const watchlistSymbols = watchlist.map(w => w.symbol);
      
      const allSymbols = rawData.filter((t: any) => {
        const price = parseFloat(t.lastPrice);
        const open = parseFloat(t.open);
        return price > 0 && open > 0 && !isNaN(price) && !isNaN(open);
      });
      
      // Priority 1: Major pairs (BTC, ETH)
      const majorSymbols = allSymbols.filter((t: any) => MAJOR_SYMBOLS.includes(t.symbol));
      
      // Priority 2: Watchlist symbols (always analyze regardless of volume)
      const watchedSymbols = allSymbols.filter((t: any) => 
        watchlistSymbols.includes(t.symbol) && !MAJOR_SYMBOLS.includes(t.symbol)
      );
      
      // Priority 3: Top 50 by volume (excluding already selected)
      const selectedSymbols = new Set([...MAJOR_SYMBOLS, ...watchlistSymbols]);
      const otherSymbols = allSymbols
        .filter((t: any) => !selectedSymbols.has(t.symbol))
        .sort((a: any, b: any) => parseFloat(b.quoteVol) - parseFloat(a.quoteVol))
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
      
      const symbolsToProcess = [...majorSymbols, ...watchedSymbols, ...otherSymbols, ...highMovers];
      // Remove duplicates
      const uniqueSymbols = Array.from(new Map(symbolsToProcess.map(s => [s.symbol, s])).values());
      
      console.log(`Processing ${uniqueSymbols.length} symbols (${majorSymbols.length} major, ${watchedSymbols.length} watched, ${otherSymbols.length} top volume, ${highMovers.length} high movers)...`);

      for (const item of uniqueSymbols) {
        try {
          const currentPrice = parseFloat(item.lastPrice);
          const openPrice = parseFloat(item.open);
          const isMajor = MAJOR_SYMBOLS.includes(item.symbol);
          
          if (!currentPrice || !openPrice || currentPrice === 0 || openPrice === 0) continue;

          const priceChange24h = ((currentPrice - openPrice) / openPrice) * 100;
          if (isNaN(priceChange24h)) continue;

          const [klines1H, klines15M, orderBook] = await Promise.all([
            fetchKlines(item.symbol, "1h", 100),
            fetchKlines(item.symbol, "15m", 100),
            fetchOrderBook(item.symbol),
          ]);

          const closes1H = klines1H.map(k => k.close);
          const volumes1H = klines1H.map(k => k.volume);
          const closes15M = klines15M.map(k => k.close);
          const volumes15M = klines15M.map(k => k.volume);

          const rsi1H = calculateRSI(closes1H);
          const rsi15M = calculateRSI(closes15M);
          const volumeSpike1H = calculateVolumeSpike(volumes1H);
          const volumeSpike15M = calculateVolumeSpike(volumes15M);

          const swingLows = findSwingLows(klines1H, 3);
          const swingHighs = findSwingHighs(klines1H, 3);

          const fvg = detectFairValueGap(klines1H);
          const ob = detectOrderBlock(klines1H);
          const liquidityClusters = detectLiquidityClusters(orderBook, currentPrice);
          const { imbalance, bidAskRatio } = calculateOrderBookImbalance(orderBook);

          const rsi = rsi1H;
          const volumeSpikeRatio = volumeSpike1H;

          const { sl, slReason } = calculateSL(currentPrice, swingLows, fvg, ob);
          const { levels: tpLevels } = calculateMultipleTPLevels(currentPrice, swingHighs, liquidityClusters, fvg, ob);

          const risk = currentPrice - sl;
          const reward = tpLevels[1]?.price ? tpLevels[1].price - currentPrice : currentPrice * 0.1;
          const riskReward = risk > 0 ? reward / risk : 0;

          // RELAXED FILTERS to catch more pre-spike opportunities
          // Price: Allow up to +30% (was +15%) to catch momentum plays
          // RSI: Allow 40-80 (was 50-75) for earlier entries and continued momentum
          // R:R: Allow >= 1.5 (was >= 2) for more opportunities
          const priceInRange = priceChange24h >= -5 && priceChange24h <= 30;
          const volumeInRange = volumeSpikeRatio >= 1.5;  // Removed upper limit
          const rsiInRange = rsi >= 40 && rsi <= 80;
          const rrInRange = riskReward >= 1.5;
          const hasLeadingIndicators = (fvg !== null || ob !== null || bidAskRatio > 1.1 || liquidityClusters.length > 0);

          // Relaxed filter: require only 2 of 3 conditions (was all 3)
          // OR if it has strong leading indicators, allow it through
          const passesMinCriteria = [priceInRange, rsiInRange, rrInRange].filter(Boolean).length >= 2;
          const hasStrongMomentum = priceChange24h >= 5 && volumeSpikeRatio >= 1.2;
          
          if (!isMajor && !passesMinCriteria && !hasStrongMomentum) {
            // Log why it was filtered for debugging
            if (priceChange24h >= 5) {
              console.log(`[FILTERED] ${item.symbol}: price=${priceChange24h.toFixed(1)}% rsi=${rsi.toFixed(0)} rr=${riskReward.toFixed(2)} vol=${volumeSpikeRatio.toFixed(2)}x`);
            }
            continue;
          }

          let signalStrength = 0;
          if (priceInRange) signalStrength++;
          if (volumeInRange) signalStrength++;
          if (rsiInRange) signalStrength++;
          if (rrInRange) signalStrength++;
          if (hasLeadingIndicators) signalStrength++;

          const tf1HConfirmed = rsi1H >= 50 && rsi1H <= 75 && volumeSpike1H >= 1.5;
          const tf15MConfirmed = rsi15M >= 50 && rsi15M <= 75 && volumeSpike15M >= 1.5;
          
          const confirmedTimeframes: string[] = [];
          if (tf1HConfirmed) confirmedTimeframes.push("1H");
          if (tf15MConfirmed) confirmedTimeframes.push("15M");

          const slDistancePct = ((currentPrice - sl) / currentPrice) * 100;

          const hasLiquidityZone = liquidityClusters.length > 0;

          // Track time on list for this symbol
          const now = new Date();
          if (!symbolFirstSeen.has(item.symbol)) {
            symbolFirstSeen.set(item.symbol, now);
          }
          // Update last seen time for grace period tracking
          symbolLastSeen.set(item.symbol, now);
          
          const firstSeen = symbolFirstSeen.get(item.symbol)!;
          const timeOnListMinutes = Math.floor((now.getTime() - firstSeen.getTime()) / 60000);
          const spikeReadiness = getSpikeReadiness(timeOnListMinutes);
          
          signals.push({
            symbol: item.symbol,
            currentPrice,
            priceChange24h,
            volumeSpikeRatio,
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
          });

          await new Promise(resolve => setTimeout(resolve, 30));
        } catch (err) {
          continue;
        }
      }

      const majorSignals = signals.filter(s => s.isMajor);
      const otherSignals = signals.filter(s => !s.isMajor).sort((a, b) => b.riskReward - a.riskReward);
      
      cachedSignals = [...majorSignals, ...otherSignals];
      lastUpdated = new Date();
      
      // Cleanup: Remove symbols from tracking only after grace period expires
      // This prevents losing time history for coins that briefly drop off the list
      const now = new Date();
      Array.from(symbolFirstSeen.keys()).forEach(symbol => {
        const lastSeen = symbolLastSeen.get(symbol);
        if (lastSeen && (now.getTime() - lastSeen.getTime()) > TRACKING_GRACE_PERIOD_MS) {
          symbolFirstSeen.delete(symbol);
          symbolLastSeen.delete(symbol);
        }
      });
      
      // Count spike readiness distribution
      const readinessCount = {
        warming: signals.filter(s => s.spikeReadiness === "warming").length,
        primed: signals.filter(s => s.spikeReadiness === "primed").length,
        hot: signals.filter(s => s.spikeReadiness === "hot").length,
        overdue: signals.filter(s => s.spikeReadiness === "overdue").length,
      };
      
      console.log(`Signal calculation complete. Found ${cachedSignals.length} signals (${majorSignals.length} major).`);
      console.log(`Spike readiness: ${readinessCount.warming} warming, ${readinessCount.primed} primed, ${readinessCount.hot} hot, ${readinessCount.overdue} overdue`);
      
      // Process signals for backtesting
      try {
        await backtestingService.processSignals(cachedSignals);
      } catch (err) {
        console.error("Backtest processing error:", err);
      }
      
    } catch (error) {
      console.error("Signal calculation error:", error);
    }
    
    isCalculating = false;
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
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30000));
      await Promise.race([initialCalculationPromise, timeout]);
    }
    
    const nextUpdate = new Date(lastUpdated.getTime() + UPDATE_FREQUENCY_MINUTES * 60 * 1000);
    
    console.log(`[API] Returning ${cachedSignals.length} signals to client`);
    
    // Prevent any caching
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
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
  
  app.get("/api/backtest/stats", async (req, res) => {
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

  return httpServer;
}

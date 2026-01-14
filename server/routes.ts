import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
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

async function fetchKlines(symbol: string, interval: string, limit: number = 100): Promise<Kline[]> {
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url, { timeout: 5000 });
    
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
    const url = `https://fapi.bitunix.com/api/v1/futures/market/depth?symbol=${symbol}&limit=15`;
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

function findSwingLow(klines: Kline[], lookback: number = 20): number {
  if (klines.length < lookback) return klines[klines.length - 1]?.low || 0;
  
  const recentKlines = klines.slice(-lookback);
  let swingLow = Infinity;
  
  for (let i = 2; i < recentKlines.length - 2; i++) {
    const current = recentKlines[i];
    if (
      current.low < recentKlines[i - 1].low &&
      current.low < recentKlines[i - 2].low &&
      current.low < recentKlines[i + 1].low &&
      current.low < recentKlines[i + 2].low
    ) {
      if (current.low < swingLow) {
        swingLow = current.low;
      }
    }
  }
  
  return swingLow === Infinity ? Math.min(...recentKlines.map(k => k.low)) : swingLow;
}

function findSwingHigh(klines: Kline[], lookback: number = 20): number {
  if (klines.length < lookback) return klines[klines.length - 1]?.high || 0;
  
  const recentKlines = klines.slice(-lookback);
  let swingHigh = 0;
  
  for (let i = 2; i < recentKlines.length - 2; i++) {
    const current = recentKlines[i];
    if (
      current.high > recentKlines[i - 1].high &&
      current.high > recentKlines[i - 2].high &&
      current.high > recentKlines[i + 1].high &&
      current.high > recentKlines[i + 2].high
    ) {
      if (current.high > swingHigh) {
        swingHigh = current.high;
      }
    }
  }
  
  return swingHigh === 0 ? Math.max(...recentKlines.map(k => k.high)) : swingHigh;
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

function calculateStructuredSLTP(
  currentPrice: number,
  swingLow: number,
  swingHigh: number,
  fvg: FVG | null,
  ob: OrderBlock | null
): { sl: number; slReason: string; tp: number; tpReason: string } {
  let sl = currentPrice * 0.95;
  let slReason = "5% below entry";
  
  if (ob && ob.type === "bullish" && ob.level < currentPrice && ob.level > currentPrice * 0.92) {
    sl = ob.level * 0.995;
    slReason = "Below Order Block";
  } else if (fvg && fvg.type === "bullish" && fvg.level < currentPrice && fvg.level > currentPrice * 0.92) {
    sl = fvg.level * 0.995;
    slReason = "Below FVG";
  } else if (swingLow < currentPrice && swingLow > currentPrice * 0.92) {
    sl = swingLow * 0.995;
    slReason = "Below Swing Low";
  }
  
  let tp = currentPrice * 1.15;
  let tpReason = "15% above entry";
  
  if (swingHigh > currentPrice && swingHigh < currentPrice * 1.25) {
    tp = swingHigh * 0.995;
    tpReason = "At Swing High";
  } else if (fvg && fvg.type === "bearish" && fvg.level > currentPrice && fvg.level < currentPrice * 1.25) {
    tp = fvg.level * 0.995;
    tpReason = "At FVG Resistance";
  } else if (ob && ob.type === "bearish" && ob.level > currentPrice && ob.level < currentPrice * 1.25) {
    tp = ob.level * 0.995;
    tpReason = "At Order Block";
  }
  
  return { sl, slReason, tp, tpReason };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  let cachedSignals: any[] = [];
  let isCalculating = false;

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
      const topSymbols = rawData
        .filter((t: any) => {
          const price = parseFloat(t.lastPrice);
          const open = parseFloat(t.open);
          return price > 0 && open > 0 && !isNaN(price) && !isNaN(open);
        })
        .sort((a: any, b: any) => parseFloat(b.quoteVol) - parseFloat(a.quoteVol))
        .slice(0, 100);

      console.log(`Processing ${topSymbols.length} symbols...`);

      for (const item of topSymbols) {
        try {
          const currentPrice = parseFloat(item.lastPrice);
          const openPrice = parseFloat(item.open);
          
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

          const swingLow1H = findSwingLow(klines1H);
          const swingHigh1H = findSwingHigh(klines1H);
          const swingLow15M = findSwingLow(klines15M);
          const swingHigh15M = findSwingHigh(klines15M);

          const fvg = detectFairValueGap(klines1H);
          const ob = detectOrderBlock(klines1H);
          const { imbalance, bidAskRatio } = calculateOrderBookImbalance(orderBook);

          const rsi = rsi1H;
          const volumeSpikeRatio = volumeSpike1H;

          const { sl, slReason, tp, tpReason } = calculateStructuredSLTP(
            currentPrice, swingLow1H, swingHigh1H, fvg, ob
          );

          const risk = currentPrice - sl;
          const reward = tp - currentPrice;
          const riskReward = risk > 0 ? reward / risk : 0;

          const priceInRange = priceChange24h >= -5 && priceChange24h <= 15;
          const volumeInRange = volumeSpikeRatio >= 1.5 && volumeSpikeRatio <= 3;
          const rsiInRange = rsi >= 50 && rsi <= 75;
          const rrInRange = riskReward >= 2;
          const hasLeadingIndicators = (fvg !== null || ob !== null || bidAskRatio > 1.2);

          if (!priceInRange || !rsiInRange || !rrInRange) {
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
          const tpDistancePct = ((tp - currentPrice) / currentPrice) * 100;

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
            tpPrice: tp,
            tpDistancePct,
            tpReason,
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
            },
            timeframes: [
              {
                timeframe: "1H",
                rsi: rsi1H,
                volumeSpike: volumeSpike1H,
                priceChange: priceChange24h,
                confirmed: tf1HConfirmed,
                swingLow: swingLow1H,
                swingHigh: swingHigh1H,
              },
              {
                timeframe: "15M",
                rsi: rsi15M,
                volumeSpike: volumeSpike15M,
                priceChange: priceChange24h,
                confirmed: tf15MConfirmed,
                swingLow: swingLow15M,
                swingHigh: swingHigh15M,
              },
            ],
            confirmedTimeframes,
          });

          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (err) {
          continue;
        }
      }

      cachedSignals = signals.sort((a, b) => b.riskReward - a.riskReward);
      console.log(`Signal calculation complete. Found ${cachedSignals.length} quality signals.`);
      
    } catch (error) {
      console.error("Signal calculation error:", error);
    }
    
    isCalculating = false;
  }

  calculateSignals();
  setInterval(calculateSignals, 5 * 60 * 1000);

  app.get(api.tickers.list.path, async (req, res) => {
    res.json(cachedSignals);
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

  return httpServer;
}

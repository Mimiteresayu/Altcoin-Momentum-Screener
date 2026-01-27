import { db } from "./db";
import { backtestTrades, equityCurve } from "../shared/schema";
import { eq, desc, and } from "drizzle-orm";
import axios from "axios";
import { getBinanceKlines, BinanceKline } from "./binance";

type MarketPhase = "ACCUMULATION" | "BREAKOUT" | "DISTRIBUTION" | "TREND" | "EXHAUST";

interface FiveMinEntry {
  valid: boolean;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  ema9: number;
  rsi14: number;
  supertrendDir: "LONG" | "SHORT";
  reason: string;
}

function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);
  
  if (prices.length < period) return [];
  
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema[period - 1] = sum / period;
  
  for (let i = period; i < prices.length; i++) {
    ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }
  
  return ema;
}

function calculateRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];
  
  if (closes.length < period + 1) return [];
  
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }
  
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = 0; i < period; i++) {
    rsi.push(0);
  }
  
  for (let i = period; i < closes.length; i++) {
    if (i === period) {
      if (avgLoss === 0) {
        rsi.push(100);
      } else {
        const rs = avgGain / avgLoss;
        rsi.push(100 - (100 / (1 + rs)));
      }
    } else {
      avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
      if (avgLoss === 0) {
        rsi.push(100);
      } else {
        const rs = avgGain / avgLoss;
        rsi.push(100 - (100 / (1 + rs)));
      }
    }
  }
  
  return rsi;
}

function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 10): number[] {
  const atr: number[] = [];
  const tr: number[] = [];
  
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
    } else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr.push(Math.max(hl, hc, lc));
    }
  }
  
  for (let i = 0; i < highs.length; i++) {
    if (i < period - 1) {
      atr.push(0);
    } else if (i === period - 1) {
      atr.push(tr.slice(0, period).reduce((a, b) => a + b, 0) / period);
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
  }
  
  return atr;
}

function calculateSupertrend5m(
  highs: number[], 
  lows: number[], 
  closes: number[], 
  atrPeriod: number = 10, 
  multiplier: number = 2
): { direction: ("LONG" | "SHORT")[]; upperBand: number[]; lowerBand: number[] } {
  const atr = calculateATR(highs, lows, closes, atrPeriod);
  const direction: ("LONG" | "SHORT")[] = [];
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  
  for (let i = 0; i < closes.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpperBand = hl2 + (multiplier * atr[i]);
    const basicLowerBand = hl2 - (multiplier * atr[i]);
    
    if (i === 0) {
      upperBand.push(basicUpperBand);
      lowerBand.push(basicLowerBand);
      direction.push(closes[i] > basicLowerBand ? "LONG" : "SHORT");
    } else {
      const prevUpper = upperBand[i - 1];
      const prevLower = lowerBand[i - 1];
      
      const finalUpperBand = (basicUpperBand < prevUpper || closes[i - 1] > prevUpper) 
        ? basicUpperBand 
        : prevUpper;
      const finalLowerBand = (basicLowerBand > prevLower || closes[i - 1] < prevLower) 
        ? basicLowerBand 
        : prevLower;
      
      upperBand.push(finalUpperBand);
      lowerBand.push(finalLowerBand);
      
      const prevDir = direction[i - 1];
      if (prevDir === "SHORT" && closes[i] > finalUpperBand) {
        direction.push("LONG");
      } else if (prevDir === "LONG" && closes[i] < finalLowerBand) {
        direction.push("SHORT");
      } else {
        direction.push(prevDir);
      }
    }
  }
  
  return { direction, upperBand, lowerBand };
}

function findSwingLow(lows: number[], lookback: number = 5): number {
  const recentLows = lows.slice(-lookback);
  return Math.min(...recentLows);
}

function findSwingHigh(highs: number[], lookback: number = 5): number {
  const recentHighs = highs.slice(-lookback);
  return Math.max(...recentHighs);
}

interface PaperPosition {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  entryTimestamp: Date;
  status: "open" | "closed";
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  slHit: boolean;
  exitPrice?: number;
  exitTimestamp?: Date;
  finalPnl?: number;
  rMultiple?: number;
  capitalUsed: number;
  exitReason?: string;
  marketPhase: MarketPhase;
  pscore: number;
  entryTimeframe: string;
  ema9?: number;
  rsi14?: number;
  supertrendDir?: "LONG" | "SHORT";
}

interface EnrichedSignal {
  symbol: string;
  lastPrice: number;
  priceChange24h: number;
  volume24h: number;
  rsi: number;
  signalStrength: number;
  volumeSpike: number;
  marketPhase: MarketPhase;
  preSpikeScore: number;
  htfBias?: { side: "LONG" | "SHORT" };
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
}

interface LiveStats {
  totalCapital: number;
  totalPnl: number;
  openPositions: number;
  closedTrades: number;
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  lastScanTime: Date | null;
  isRunning: boolean;
}

export class ContinuousBacktestEngine {
  private positions: Map<string, PaperPosition> = new Map();
  private closedTrades: PaperPosition[] = [];
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastScanTime: Date | null = null;
  private startingCapital: number = 10000;
  private capitalPerTrade: number = 1000;
  private maxOpenPositions: number = 5;
  private equityHistory: { timestamp: Date; equity: number; drawdown: number }[] = [];

  constructor() {
    this.loadClosedTradesFromDb();
  }

  private async loadClosedTradesFromDb() {
    try {
      if (!db) return;
      const trades = await db
        .select()
        .from(backtestTrades)
        .where(eq(backtestTrades.status, "closed"))
        .orderBy(desc(backtestTrades.exitTimestamp))
        .limit(100);

      for (const trade of trades) {
        if (trade.tradeId?.startsWith("CONT-")) {
          let exitPrice: number | undefined;
          if (trade.slHit) {
            exitPrice = trade.originalSlPrice;
          } else if (trade.tp3Hit) {
            exitPrice = trade.tp3Price;
          } else if (trade.tp2Hit) {
            exitPrice = trade.tp2Price;
          } else if (trade.tp1Hit) {
            exitPrice = trade.tp1Price;
          }

          const exitReason = trade.slHit 
            ? "STOP_LOSS" 
            : trade.tp3Hit 
              ? "TP3_HIT" 
              : trade.tp2Hit 
                ? "TP2_HIT" 
                : trade.tp1Hit 
                  ? "TP1_HIT" 
                  : "MANUAL";

          this.closedTrades.push({
            tradeId: trade.tradeId,
            symbol: trade.symbol,
            side: "LONG",
            entryPrice: trade.entryPrice,
            stopLoss: trade.originalSlPrice,
            tp1: trade.tp1Price,
            tp2: trade.tp2Price,
            tp3: trade.tp3Price,
            entryTimestamp: trade.entryTimestamp || new Date(),
            status: "closed",
            tp1Hit: trade.tp1Hit || false,
            tp2Hit: trade.tp2Hit || false,
            tp3Hit: trade.tp3Hit || false,
            slHit: trade.slHit || false,
            exitPrice,
            exitTimestamp: trade.exitTimestamp || undefined,
            finalPnl: trade.finalPnl || undefined,
            rMultiple: trade.rMultiple || undefined,
            capitalUsed: trade.capitalUsed,
            exitReason,
            marketPhase: "TREND",
            pscore: 0,
            entryTimeframe: "4h"
          });
        }
      }
      console.log(`[ContinuousBacktest] Loaded ${this.closedTrades.length} historical trades from DB`);
    } catch (error) {
      console.error("[ContinuousBacktest] Error loading trades from DB:", error);
    }
  }

  start() {
    if (this.isRunning) {
      console.log("[ContinuousBacktest] Already running");
      return;
    }

    console.log("[ContinuousBacktest] Starting continuous paper trading engine...");
    this.isRunning = true;

    this.runScan();

    this.intervalId = setInterval(() => {
      this.runScan();
    }, 5 * 60 * 1000);

    console.log("[ContinuousBacktest] Engine started - scanning every 5 minutes");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("[ContinuousBacktest] Engine stopped");
  }

  private async runScan() {
    try {
      console.log("[ContinuousBacktest] Running scan at", new Date().toISOString());
      this.lastScanTime = new Date();

      await this.monitorOpenPositions();

      if (this.positions.size < this.maxOpenPositions) {
        await this.scanForNewSignals();
      }

      this.updateEquityHistory();
    } catch (error) {
      console.error("[ContinuousBacktest] Scan error:", error);
    }
  }

  private async scanForNewSignals() {
    try {
      const response = await axios.get("http://localhost:5000/api/screen", { timeout: 120000 });
      const signals: EnrichedSignal[] = response.data || [];

      console.log(`[ContinuousBacktest] Received ${signals.length} signals from screener`);

      const qualifyingSignals = signals.filter((signal) => {
        const pscore = signal.preSpikeScore || 0;
        const phase = signal.marketPhase || "TREND";
        const meetsEntry = pscore >= 1.5 || phase === "BREAKOUT" || phase === "ACCUMULATION";
        const notAlreadyOpen = !this.positions.has(signal.symbol);
        return meetsEntry && notAlreadyOpen;
      });

      console.log(`[ContinuousBacktest] ${qualifyingSignals.length} signals meet 4H screener criteria (PSCORE>=1.5 or BREAKOUT/ACCUMULATION)`);

      for (const signal of qualifyingSignals.slice(0, this.maxOpenPositions - this.positions.size)) {
        const fiveMinEntry = await this.check5minEntry(signal);
        if (fiveMinEntry.valid) {
          await this.openPosition(signal, fiveMinEntry);
        } else {
          console.log(`[ContinuousBacktest] ${signal.symbol} 5min entry not valid: ${fiveMinEntry.reason}`);
        }
      }
    } catch (error) {
      console.error("[ContinuousBacktest] Error scanning signals:", error);
    }
  }

  private async check5minEntry(signal: EnrichedSignal): Promise<FiveMinEntry> {
    const invalidEntry: FiveMinEntry = {
      valid: false,
      entryPrice: 0,
      stopLoss: 0,
      tp1: 0,
      tp2: 0,
      tp3: 0,
      ema9: 0,
      rsi14: 0,
      supertrendDir: "LONG",
      reason: "No data"
    };

    try {
      const symbolClean = signal.symbol.replace("USDT", "");
      const klines = await getBinanceKlines(symbolClean, "5m", 100);
      
      if (klines.length < 30) {
        return { ...invalidEntry, reason: `Insufficient 5min candles: ${klines.length}` };
      }

      const closes = klines.map(k => parseFloat(k.close));
      const highs = klines.map(k => parseFloat(k.high));
      const lows = klines.map(k => parseFloat(k.low));
      
      const ema9Values = calculateEMA(closes, 9);
      const rsi14Values = calculateRSI(closes, 14);
      const supertrend = calculateSupertrend5m(highs, lows, closes, 10, 2);
      
      const lastIndex = closes.length - 1;
      const prevIndex = lastIndex - 1;
      
      const currentPrice = closes[lastIndex];
      const prevHigh = highs[prevIndex];
      const ema9 = ema9Values[lastIndex] || 0;
      const rsi14 = rsi14Values[lastIndex] || 0;
      const supertrendDir = supertrend.direction[lastIndex];
      
      const side = signal.htfBias?.side || "LONG";
      
      let valid = false;
      let reason = "";
      
      if (side === "LONG") {
        const priceAboveEMA = currentPrice > ema9;
        const rsiInRange = rsi14 > 50 && rsi14 < 70;
        const breakoutConfirm = currentPrice > prevHigh;
        const supertrendLong = supertrendDir === "LONG";
        
        if (priceAboveEMA && rsiInRange && breakoutConfirm) {
          valid = true;
          reason = `LONG: Price>${ema9.toFixed(2)} EMA9, RSI=${rsi14.toFixed(1)}, breakout above ${prevHigh.toFixed(2)}`;
        } else if (supertrendLong && rsiInRange) {
          valid = true;
          reason = `LONG: Supertrend LONG, RSI=${rsi14.toFixed(1)}`;
        } else {
          reason = `LONG rejected: EMA=${priceAboveEMA}, RSI(${rsi14.toFixed(1)})=${rsiInRange}, breakout=${breakoutConfirm}, ST=${supertrendLong}`;
        }
      } else {
        const priceBelowEMA = currentPrice < ema9;
        const rsiInRange = rsi14 < 50 && rsi14 > 30;
        const breakdownConfirm = currentPrice < lows[prevIndex];
        const supertrendShort = supertrendDir === "SHORT";
        
        if (priceBelowEMA && rsiInRange && breakdownConfirm) {
          valid = true;
          reason = `SHORT: Price<${ema9.toFixed(2)} EMA9, RSI=${rsi14.toFixed(1)}, breakdown below ${lows[prevIndex].toFixed(2)}`;
        } else if (supertrendShort && rsiInRange) {
          valid = true;
          reason = `SHORT: Supertrend SHORT, RSI=${rsi14.toFixed(1)}`;
        } else {
          reason = `SHORT rejected: EMA=${priceBelowEMA}, RSI(${rsi14.toFixed(1)})=${rsiInRange}, breakdown=${breakdownConfirm}, ST=${supertrendShort}`;
        }
      }
      
      const swingLow = findSwingLow(lows, 5);
      const swingHigh = findSwingHigh(highs, 5);
      
      let stopLoss: number;
      let tp1: number, tp2: number, tp3: number;
      
      if (side === "LONG") {
        stopLoss = Math.max(swingLow, currentPrice * 0.99);
        const risk = currentPrice - stopLoss;
        tp1 = currentPrice + (risk * 1.5);
        tp2 = currentPrice + (risk * 2.5);
        tp3 = currentPrice + (risk * 4);
      } else {
        stopLoss = Math.min(swingHigh, currentPrice * 1.01);
        const risk = stopLoss - currentPrice;
        tp1 = currentPrice - (risk * 1.5);
        tp2 = currentPrice - (risk * 2.5);
        tp3 = currentPrice - (risk * 4);
      }
      
      return {
        valid,
        entryPrice: currentPrice,
        stopLoss,
        tp1,
        tp2,
        tp3,
        ema9,
        rsi14,
        supertrendDir,
        reason
      };
      
    } catch (error) {
      console.error(`[ContinuousBacktest] Error checking 5min entry for ${signal.symbol}:`, error);
      return { ...invalidEntry, reason: `Error: ${error}` };
    }
  }

  private async openPosition(signal: EnrichedSignal, fiveMinEntry: FiveMinEntry) {
    const tradeId = `CONT-${Date.now()}-${signal.symbol}`;
    const side: "LONG" | "SHORT" = signal.htfBias?.side || "LONG";

    const position: PaperPosition = {
      tradeId,
      symbol: signal.symbol,
      side,
      entryPrice: fiveMinEntry.entryPrice,
      stopLoss: fiveMinEntry.stopLoss,
      tp1: fiveMinEntry.tp1,
      tp2: fiveMinEntry.tp2,
      tp3: fiveMinEntry.tp3,
      entryTimestamp: new Date(),
      status: "open",
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      slHit: false,
      capitalUsed: this.capitalPerTrade,
      marketPhase: signal.marketPhase || "TREND",
      pscore: signal.preSpikeScore || 0,
      entryTimeframe: "5m",
      ema9: fiveMinEntry.ema9,
      rsi14: fiveMinEntry.rsi14,
      supertrendDir: fiveMinEntry.supertrendDir
    };

    this.positions.set(signal.symbol, position);

    try {
      if (!db) return;
      await db.insert(backtestTrades).values({
        tradeId,
        symbol: signal.symbol,
        signalTimestamp: new Date(),
        entryTimestamp: new Date(),
        entryPrice: position.entryPrice,
        currentSlPrice: position.stopLoss,
        originalSlPrice: position.stopLoss,
        tp1Price: position.tp1,
        tp2Price: position.tp2,
        tp3Price: position.tp3,
        positionSize: this.capitalPerTrade / position.entryPrice,
        capitalUsed: this.capitalPerTrade,
        status: "open",
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        slHit: false
      });
    } catch (error) {
      console.error(`[ContinuousBacktest] Error saving trade to DB:`, error);
    }

    console.log(`[ContinuousBacktest] OPENED ${side} position: ${signal.symbol} @ ${position.entryPrice} | TF: 5m | Phase: ${signal.marketPhase} | PSCORE: ${signal.preSpikeScore} | ${fiveMinEntry.reason}`);
  }

  private async monitorOpenPositions() {
    if (this.positions.size === 0) return;

    console.log(`[ContinuousBacktest] Monitoring ${this.positions.size} open positions`);

    const entries = Array.from(this.positions.entries());
    for (const [symbol, position] of entries) {
      try {
        const currentPrice = await this.fetchCurrentPrice(symbol);
        if (!currentPrice) continue;

        const isLong = position.side === "LONG";

        const slHit = isLong
          ? currentPrice <= position.stopLoss
          : currentPrice >= position.stopLoss;

        const tp1Hit = isLong
          ? currentPrice >= position.tp1
          : currentPrice <= position.tp1;

        const tp2Hit = isLong
          ? currentPrice >= position.tp2
          : currentPrice <= position.tp2;

        const tp3Hit = isLong
          ? currentPrice >= position.tp3
          : currentPrice <= position.tp3;

        if (slHit) {
          await this.closePosition(symbol, currentPrice, "STOP_LOSS", { slHit: true });
        } else if (tp1Hit && !position.tp1Hit) {
          position.tp1Hit = true;
          position.stopLoss = position.entryPrice;
          console.log(`[ContinuousBacktest] ${symbol} TP1 hit! Moving SL to breakeven`);

          if (tp2Hit) {
            await this.closePosition(symbol, currentPrice, "TP2_HIT", { tp1Hit: true, tp2Hit: true });
          }
        } else if (tp2Hit && position.tp1Hit && !position.tp2Hit) {
          position.tp2Hit = true;
          console.log(`[ContinuousBacktest] ${symbol} TP2 hit!`);

          if (tp3Hit) {
            await this.closePosition(symbol, currentPrice, "TP3_HIT", { tp1Hit: true, tp2Hit: true, tp3Hit: true });
          }
        } else if (tp3Hit && position.tp2Hit) {
          await this.closePosition(symbol, currentPrice, "TP3_HIT", { tp1Hit: true, tp2Hit: true, tp3Hit: true });
        }
      } catch (error) {
        console.error(`[ContinuousBacktest] Error monitoring ${symbol}:`, error);
      }
    }
  }

  private async closePosition(
    symbol: string,
    exitPrice: number,
    reason: string,
    tpSlStatus: { tp1Hit?: boolean; tp2Hit?: boolean; tp3Hit?: boolean; slHit?: boolean }
  ) {
    const position = this.positions.get(symbol);
    if (!position) return;

    const isLong = position.side === "LONG";
    const pnlPercent = isLong
      ? (exitPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - exitPrice) / position.entryPrice;

    const pnl = pnlPercent * position.capitalUsed;
    const riskAmount = Math.abs(position.entryPrice - position.stopLoss) / position.entryPrice * position.capitalUsed;
    const rMultiple = riskAmount > 0 ? pnl / riskAmount : 0;

    position.status = "closed";
    position.exitPrice = exitPrice;
    position.exitTimestamp = new Date();
    position.finalPnl = pnl;
    position.rMultiple = rMultiple;
    position.exitReason = reason;
    position.tp1Hit = tpSlStatus.tp1Hit || false;
    position.tp2Hit = tpSlStatus.tp2Hit || false;
    position.tp3Hit = tpSlStatus.tp3Hit || false;
    position.slHit = tpSlStatus.slHit || false;

    this.closedTrades.push({ ...position });
    this.positions.delete(symbol);

    try {
      if (!db) return;
      await db
        .update(backtestTrades)
        .set({
          status: "closed",
          exitTimestamp: new Date(),
          finalPnl: pnl,
          rMultiple,
          tp1Hit: tpSlStatus.tp1Hit || false,
          tp2Hit: tpSlStatus.tp2Hit || false,
          tp3Hit: tpSlStatus.tp3Hit || false,
          slHit: tpSlStatus.slHit || false
        })
        .where(eq(backtestTrades.tradeId, position.tradeId));
    } catch (error) {
      console.error(`[ContinuousBacktest] Error updating trade in DB:`, error);
    }

    const pnlSign = pnl >= 0 ? "+" : "";
    console.log(`[ContinuousBacktest] CLOSED ${position.side} ${symbol} @ ${exitPrice} | ${reason} | PnL: ${pnlSign}$${pnl.toFixed(2)} | R: ${rMultiple.toFixed(2)}`);
  }

  private async fetchCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
        { timeout: 5000 }
      );
      return parseFloat(response.data.price);
    } catch {
      try {
        const okxSymbol = symbol.replace("USDT", "-USDT-SWAP");
        const response = await axios.get(
          `https://www.okx.com/api/v5/market/ticker?instId=${okxSymbol}`,
          { timeout: 5000 }
        );
        if (response.data?.data?.[0]?.last) {
          return parseFloat(response.data.data[0].last);
        }
      } catch {
        console.error(`[ContinuousBacktest] Failed to fetch price for ${symbol}`);
      }
    }
    return null;
  }

  private updateEquityHistory() {
    const totalPnl = this.closedTrades.reduce((sum, t) => sum + (t.finalPnl || 0), 0);
    const currentEquity = this.startingCapital + totalPnl;

    const peak = Math.max(this.startingCapital, ...this.equityHistory.map((e) => e.equity), currentEquity);
    const drawdown = peak > 0 ? ((peak - currentEquity) / peak) * 100 : 0;

    this.equityHistory.push({
      timestamp: new Date(),
      equity: currentEquity,
      drawdown
    });

    if (this.equityHistory.length > 1000) {
      this.equityHistory = this.equityHistory.slice(-500);
    }
  }

  getOpenPositions(): PaperPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedTrades(): PaperPosition[] {
    return [...this.closedTrades].sort((a, b) =>
      (b.exitTimestamp?.getTime() || 0) - (a.exitTimestamp?.getTime() || 0)
    );
  }

  getStats(): LiveStats {
    const closed = this.closedTrades;
    const totalPnl = closed.reduce((sum, t) => sum + (t.finalPnl || 0), 0);
    const wins = closed.filter((t) => (t.finalPnl || 0) > 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const returns = closed.map((t) => (t.finalPnl || 0) / t.capitalUsed);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 / 6) : 0;

    const maxDrawdown = this.equityHistory.length > 0
      ? Math.max(...this.equityHistory.map((e) => e.drawdown))
      : 0;

    return {
      totalCapital: this.startingCapital + totalPnl,
      totalPnl,
      openPositions: this.positions.size,
      closedTrades: closed.length,
      winRate,
      sharpeRatio,
      maxDrawdown,
      lastScanTime: this.lastScanTime,
      isRunning: this.isRunning
    };
  }

  getEquityCurve() {
    return this.equityHistory;
  }
}

export const continuousBacktestEngine = new ContinuousBacktestEngine();

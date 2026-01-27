import { db } from "./db";
import { backtestTrades, equityCurve } from "../shared/schema";
import { eq, desc, and } from "drizzle-orm";
import axios from "axios";

type MarketPhase = "ACCUMULATION" | "BREAKOUT" | "DISTRIBUTION" | "TREND" | "EXHAUST";

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
            pscore: 0
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
      const response = await axios.get("http://localhost:5000/api/screen", { timeout: 30000 });
      const signals: EnrichedSignal[] = response.data || [];

      console.log(`[ContinuousBacktest] Received ${signals.length} signals from screener`);

      const qualifyingSignals = signals.filter((signal) => {
        const pscore = signal.preSpikeScore || 0;
        const phase = signal.marketPhase || "TREND";
        const meetsEntry = pscore >= 1.5 || phase === "BREAKOUT";
        const notAlreadyOpen = !this.positions.has(signal.symbol);
        return meetsEntry && notAlreadyOpen;
      });

      console.log(`[ContinuousBacktest] ${qualifyingSignals.length} signals meet entry criteria`);

      for (const signal of qualifyingSignals.slice(0, this.maxOpenPositions - this.positions.size)) {
        await this.openPosition(signal);
      }
    } catch (error) {
      console.error("[ContinuousBacktest] Error scanning signals:", error);
    }
  }

  private async openPosition(signal: EnrichedSignal) {
    const tradeId = `CONT-${Date.now()}-${signal.symbol}`;
    const side: "LONG" | "SHORT" = signal.htfBias?.side || "LONG";

    const position: PaperPosition = {
      tradeId,
      symbol: signal.symbol,
      side,
      entryPrice: signal.lastPrice || signal.entryPrice,
      stopLoss: signal.slPrice,
      tp1: signal.tp1Price,
      tp2: signal.tp2Price,
      tp3: signal.tp3Price,
      entryTimestamp: new Date(),
      status: "open",
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      slHit: false,
      capitalUsed: this.capitalPerTrade,
      marketPhase: signal.marketPhase || "TREND",
      pscore: signal.preSpikeScore || 0
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

    console.log(`[ContinuousBacktest] OPENED ${side} position: ${signal.symbol} @ ${position.entryPrice} | Phase: ${signal.marketPhase} | PSCORE: ${signal.preSpikeScore}`);
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

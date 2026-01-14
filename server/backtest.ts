import { storage } from "./storage";
import type { Signal, BacktestTrade, TradeEvent, BacktestSummary, TradeDisplay, Exit } from "@shared/schema";
import axios from "axios";

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  INITIAL_CAPITAL: 10000,
  RISK_PER_TRADE_MIN: 0.02,
  RISK_PER_TRADE_MAX: 0.05,
  DEFAULT_RISK_PCT: 0.03,
  TP1_EXIT_PCT: 0.35,
  TP2_EXIT_PCT: 0.35,
  TP3_EXIT_PCT: 0.30,
  MAX_CONCURRENT_TRADES: 10,
  SIGNAL_STRENGTH_MIN: 3,
};

// ============================================
// POSITION MANAGER
// ============================================
class PositionManager {
  private capital: number = CONFIG.INITIAL_CAPITAL;
  private peakEquity: number = CONFIG.INITIAL_CAPITAL;
  private maxDrawdown: number = 0;

  async initialize() {
    const latestEquity = await storage.getLatestEquity();
    if (latestEquity) {
      this.capital = latestEquity.equity;
      this.peakEquity = Math.max(this.peakEquity, this.capital);
    }
  }

  getAvailableCapital(): number {
    return this.capital;
  }

  calculatePositionSize(entryPrice: number, slPrice: number): { size: number; capitalUsed: number } {
    const riskPerUnit = Math.abs(entryPrice - slPrice);
    const riskPct = riskPerUnit / entryPrice;
    
    let capitalToRisk = this.capital * CONFIG.DEFAULT_RISK_PCT;
    capitalToRisk = Math.max(
      this.capital * CONFIG.RISK_PER_TRADE_MIN,
      Math.min(capitalToRisk, this.capital * CONFIG.RISK_PER_TRADE_MAX)
    );
    
    const size = capitalToRisk / riskPerUnit;
    const capitalUsed = size * entryPrice;
    
    return { size, capitalUsed };
  }

  async updateEquity(pnlDelta: number) {
    this.capital += pnlDelta;
    this.peakEquity = Math.max(this.peakEquity, this.capital);
    const currentDrawdown = (this.peakEquity - this.capital) / this.peakEquity;
    this.maxDrawdown = Math.max(this.maxDrawdown, currentDrawdown);
    
    await storage.addEquityPoint({
      equity: this.capital,
      drawdown: currentDrawdown,
      dailyPnl: pnlDelta,
    });
  }

  getMaxDrawdown(): number {
    return this.maxDrawdown;
  }

  getCurrentEquity(): number {
    return this.capital;
  }
}

// ============================================
// STATISTICS ENGINE
// ============================================
class StatisticsEngine {
  async calculateStats(): Promise<BacktestSummary> {
    const trades = await storage.getAllTrades(1000);
    const equityCurve = await storage.getEquityCurve(365);
    
    const closedTrades = trades.filter(t => t.status === "closed");
    const activeTrades = trades.filter(t => t.status === "active");
    const winningTrades = closedTrades.filter(t => (t.finalPnl || 0) > 0);
    const losingTrades = closedTrades.filter(t => (t.finalPnl || 0) <= 0);
    
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.finalPnl || 0), 0);
    const avgRMultiple = closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + (t.rMultiple || 0), 0) / closedTrades.length
      : 0;
    
    const winRate = closedTrades.length > 0
      ? winningTrades.length / closedTrades.length
      : 0;
    
    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.finalPnl || 0), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + (t.finalPnl || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    const maxDrawdown = this.calculateMaxDrawdown(equityCurve);
    const sharpeRatio = this.calculateSharpeRatio(equityCurve);
    
    const latestEquity = await storage.getLatestEquity();
    const currentCapital = latestEquity?.equity || CONFIG.INITIAL_CAPITAL;
    
    return {
      totalCapital: currentCapital,
      availableCapital: currentCapital,
      totalTrades: trades.length,
      activeTrades: activeTrades.length,
      closedTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: winRate * 100,
      totalPnl,
      totalPnlPct: (totalPnl / CONFIG.INITIAL_CAPITAL) * 100,
      avgRMultiple,
      maxDrawdown: maxDrawdown * 100,
      sharpeRatio,
      profitFactor,
    };
  }

  private calculateMaxDrawdown(equityCurve: { equity: number; drawdown: number }[]): number {
    if (equityCurve.length === 0) return 0;
    return Math.max(...equityCurve.map(e => e.drawdown));
  }

  private calculateSharpeRatio(equityCurve: { equity: number; dailyPnl: number | null }[]): number {
    const returns = equityCurve
      .filter(e => e.dailyPnl !== null)
      .map(e => e.dailyPnl as number);
    
    if (returns.length < 2) return 0;
    
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) return 0;
    
    return (avgReturn / stdDev) * Math.sqrt(252);
  }

  async generateDailyReport() {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    
    const trades = await storage.getTradesByDateRange(startOfDay, endOfDay);
    const closedTrades = trades.filter(t => t.status === "closed");
    const winningTrades = closedTrades.filter(t => (t.finalPnl || 0) > 0);
    
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.finalPnl || 0), 0);
    const winRate = closedTrades.length > 0 ? winningTrades.length / closedTrades.length : 0;
    const avgRMultiple = closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + (t.rMultiple || 0), 0) / closedTrades.length
      : 0;
    
    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.finalPnl || 0), 0);
    const grossLoss = Math.abs(closedTrades.filter(t => (t.finalPnl || 0) <= 0).reduce((sum, t) => sum + (t.finalPnl || 0), 0));
    
    const stats = await storage.saveStats({
      periodType: "daily",
      periodStart: startOfDay,
      periodEnd: endOfDay,
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: closedTrades.length - winningTrades.length,
      winRate,
      totalPnl,
      avgRMultiple,
      maxDrawdown: 0,
      sharpeRatio: 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
    });
    
    return stats;
  }
}

// ============================================
// SIGNAL TRACKER
// ============================================
class SignalTracker {
  async captureSignals(signals: Signal[]) {
    const snapshots = [];
    
    for (const signal of signals) {
      if (signal.signalStrength >= CONFIG.SIGNAL_STRENGTH_MIN) {
        const snapshot = await storage.saveSignalSnapshot({
          symbol: signal.symbol,
          entryPrice: signal.entryPrice,
          slPrice: signal.slPrice,
          tp1Price: signal.tpLevels[0]?.price || signal.entryPrice * 1.05,
          tp2Price: signal.tpLevels[1]?.price || signal.entryPrice * 1.10,
          tp3Price: signal.tpLevels[2]?.price || signal.entryPrice * 1.15,
          rsi: signal.rsi,
          volumeSpike: signal.volumeSpikeRatio,
          signalStrength: signal.signalStrength,
          metadata: {
            priceChange24h: signal.priceChange24h,
            riskReward: signal.riskReward,
            leadingIndicators: signal.leadingIndicators,
          },
        });
        snapshots.push(snapshot);
      }
    }
    
    return snapshots;
  }
}

// ============================================
// PRICE MONITOR
// ============================================
class PriceMonitor {
  private positionManager: PositionManager;

  constructor(positionManager: PositionManager) {
    this.positionManager = positionManager;
  }

  async fetchCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const url = `https://fapi.bitunix.com/api/v1/futures/market/tickers`;
      const response = await axios.get(url, { timeout: 5000 });
      const ticker = response.data.data?.find((t: any) => t.symbol === symbol);
      return ticker ? parseFloat(ticker.lastPrice) : null;
    } catch {
      return null;
    }
  }

  async checkActiveTrades() {
    const activeTrades = await storage.getActiveTrades();
    
    for (const trade of activeTrades) {
      const currentPrice = await this.fetchCurrentPrice(trade.symbol);
      if (!currentPrice) continue;
      
      await this.evaluateTrade(trade, currentPrice);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async evaluateTrade(trade: BacktestTrade, currentPrice: number) {
    const riskPerUnit = trade.entryPrice - trade.originalSlPrice;
    let totalPnl = 0;
    let remainingSize = trade.positionSize;
    
    const events = await storage.getTradeEvents(trade.tradeId);
    for (const event of events) {
      if (event.size) {
        remainingSize -= event.size;
        totalPnl += event.pnlDelta || 0;
      }
    }
    
    if (currentPrice <= trade.currentSlPrice && !trade.slHit) {
      const slPnl = (trade.currentSlPrice - trade.entryPrice) * remainingSize;
      totalPnl += slPnl;
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "SL",
        price: trade.currentSlPrice,
        size: remainingSize,
        pnlDelta: slPnl,
      });
      
      const rMultiple = totalPnl / (riskPerUnit * trade.positionSize);
      
      await storage.updateTrade(trade.tradeId, {
        status: "closed",
        slHit: true,
        exitTimestamp: new Date(),
        finalPnl: totalPnl,
        rMultiple,
      });
      
      await this.positionManager.updateEquity(totalPnl);
      console.log(`[BACKTEST] ${trade.symbol} SL HIT at ${trade.currentSlPrice}, PnL: $${totalPnl.toFixed(2)}, R: ${rMultiple.toFixed(2)}`);
      return;
    }
    
    if (currentPrice >= trade.tp1Price && !trade.tp1Hit) {
      const exitSize = trade.positionSize * CONFIG.TP1_EXIT_PCT;
      const tp1Pnl = (trade.tp1Price - trade.entryPrice) * exitSize;
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "TP1",
        price: trade.tp1Price,
        size: exitSize,
        pnlDelta: tp1Pnl,
      });
      
      await storage.updateTrade(trade.tradeId, {
        tp1Hit: true,
        currentSlPrice: trade.entryPrice,
      });
      
      await this.positionManager.updateEquity(tp1Pnl);
      console.log(`[BACKTEST] ${trade.symbol} TP1 HIT at ${trade.tp1Price}, Partial PnL: $${tp1Pnl.toFixed(2)}, SL moved to entry`);
    }
    
    if (currentPrice >= trade.tp2Price && !trade.tp2Hit && trade.tp1Hit) {
      const exitSize = trade.positionSize * CONFIG.TP2_EXIT_PCT;
      const tp2Pnl = (trade.tp2Price - trade.entryPrice) * exitSize;
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "TP2",
        price: trade.tp2Price,
        size: exitSize,
        pnlDelta: tp2Pnl,
      });
      
      await storage.updateTrade(trade.tradeId, {
        tp2Hit: true,
      });
      
      await this.positionManager.updateEquity(tp2Pnl);
      console.log(`[BACKTEST] ${trade.symbol} TP2 HIT at ${trade.tp2Price}, Partial PnL: $${tp2Pnl.toFixed(2)}`);
    }
    
    if (currentPrice >= trade.tp3Price && !trade.tp3Hit && trade.tp2Hit) {
      const exitSize = trade.positionSize * CONFIG.TP3_EXIT_PCT;
      const tp3Pnl = (trade.tp3Price - trade.entryPrice) * exitSize;
      totalPnl = 0;
      
      const allEvents = await storage.getTradeEvents(trade.tradeId);
      for (const event of allEvents) {
        totalPnl += event.pnlDelta || 0;
      }
      totalPnl += tp3Pnl;
      
      const rMultiple = totalPnl / (riskPerUnit * trade.positionSize);
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "TP3",
        price: trade.tp3Price,
        size: exitSize,
        pnlDelta: tp3Pnl,
      });
      
      await storage.updateTrade(trade.tradeId, {
        status: "closed",
        tp3Hit: true,
        exitTimestamp: new Date(),
        finalPnl: totalPnl,
        rMultiple,
      });
      
      await this.positionManager.updateEquity(tp3Pnl);
      console.log(`[BACKTEST] ${trade.symbol} TP3 HIT at ${trade.tp3Price}, Final PnL: $${totalPnl.toFixed(2)}, R: ${rMultiple.toFixed(2)}`);
    }
  }
}

// ============================================
// BACKTESTING SERVICE
// ============================================
export class BacktestingService {
  private positionManager: PositionManager;
  private statisticsEngine: StatisticsEngine;
  private signalTracker: SignalTracker;
  private priceMonitor: PriceMonitor;
  private isRunning: boolean = false;

  constructor() {
    this.positionManager = new PositionManager();
    this.statisticsEngine = new StatisticsEngine();
    this.signalTracker = new SignalTracker();
    this.priceMonitor = new PriceMonitor(this.positionManager);
  }

  async initialize() {
    await this.positionManager.initialize();
    console.log(`[BACKTEST] Initialized with capital: $${this.positionManager.getCurrentEquity().toFixed(2)}`);
  }

  async processSignals(signals: Signal[]) {
    await this.signalTracker.captureSignals(signals);
    
    const activeTrades = await storage.getActiveTrades();
    const activeSymbols = new Set(activeTrades.map(t => t.symbol));
    
    if (activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) {
      console.log(`[BACKTEST] Max concurrent trades (${CONFIG.MAX_CONCURRENT_TRADES}) reached, skipping new entries`);
      return;
    }
    
    for (const signal of signals) {
      if (activeSymbols.has(signal.symbol)) continue;
      if (signal.signalStrength < CONFIG.SIGNAL_STRENGTH_MIN) continue;
      if (signal.riskReward < 2) continue;
      
      const { size, capitalUsed } = this.positionManager.calculatePositionSize(
        signal.entryPrice,
        signal.slPrice
      );
      
      if (capitalUsed > this.positionManager.getAvailableCapital() * 0.2) {
        continue;
      }
      
      const tradeId = this.generateTradeId();
      const now = new Date();
      
      await storage.createTrade({
        tradeId,
        symbol: signal.symbol,
        signalTimestamp: now,
        entryTimestamp: now,
        entryPrice: signal.entryPrice,
        currentSlPrice: signal.slPrice,
        originalSlPrice: signal.slPrice,
        tp1Price: signal.tpLevels[0]?.price || signal.entryPrice * 1.05,
        tp2Price: signal.tpLevels[1]?.price || signal.entryPrice * 1.10,
        tp3Price: signal.tpLevels[2]?.price || signal.entryPrice * 1.15,
        positionSize: size,
        capitalUsed,
        status: "active",
      });
      
      await storage.addTradeEvent({
        tradeId,
        eventType: "ENTRY",
        price: signal.entryPrice,
        size,
        pnlDelta: 0,
      });
      
      console.log(`[BACKTEST] NEW TRADE: ${signal.symbol} @ $${signal.entryPrice.toFixed(6)}, Size: ${size.toFixed(4)}, Capital: $${capitalUsed.toFixed(2)}`);
      
      if (activeTrades.length + 1 >= CONFIG.MAX_CONCURRENT_TRADES) break;
    }
  }

  async monitorPositions() {
    await this.priceMonitor.checkActiveTrades();
  }

  async getStats(): Promise<BacktestSummary> {
    return await this.statisticsEngine.calculateStats();
  }

  async getTrades(limit: number = 50): Promise<TradeDisplay[]> {
    const trades = await storage.getAllTrades(limit);
    const result: TradeDisplay[] = [];
    
    for (const trade of trades) {
      const events = await storage.getTradeEvents(trade.tradeId);
      const exits: Exit[] = events
        .filter(e => e.eventType !== "ENTRY")
        .map(e => ({
          type: e.eventType,
          price: e.price,
          size: e.size || 0,
          pnl: e.pnlDelta || 0,
          timestamp: e.timestamp?.toISOString() || "",
        }));
      
      let currentPrice: number | undefined;
      let unrealizedPnl: number | undefined;
      
      if (trade.status === "active") {
        currentPrice = await this.priceMonitor.fetchCurrentPrice(trade.symbol) || undefined;
        if (currentPrice) {
          let remainingSize = trade.positionSize;
          for (const exit of exits) {
            remainingSize -= exit.size;
          }
          unrealizedPnl = (currentPrice - trade.entryPrice) * remainingSize;
        }
      }
      
      result.push({
        id: trade.id,
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        signalTimestamp: trade.signalTimestamp?.toISOString() || "",
        entryTimestamp: trade.entryTimestamp?.toISOString() || null,
        entryPrice: trade.entryPrice,
        currentSlPrice: trade.currentSlPrice,
        tp1Price: trade.tp1Price,
        tp2Price: trade.tp2Price,
        tp3Price: trade.tp3Price,
        positionSize: trade.positionSize,
        capitalUsed: trade.capitalUsed,
        status: trade.status,
        tp1Hit: trade.tp1Hit || false,
        tp2Hit: trade.tp2Hit || false,
        tp3Hit: trade.tp3Hit || false,
        slHit: trade.slHit || false,
        finalPnl: trade.finalPnl,
        rMultiple: trade.rMultiple,
        exits,
        currentPrice,
        unrealizedPnl,
      });
    }
    
    return result;
  }

  async getEquityCurve(limit: number = 100) {
    return await storage.getEquityCurve(limit);
  }

  async getDailyReport() {
    return await this.statisticsEngine.generateDailyReport();
  }

  async getSignalHistory(symbol?: string, limit?: number) {
    return await storage.getSignalSnapshots(symbol, limit);
  }

  private generateTradeId(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    return `BT_${dateStr}_${random}`;
  }

  startMonitoring(intervalMs: number = 60000) {
    if (this.isRunning) return;
    this.isRunning = true;
    
    console.log(`[BACKTEST] Starting position monitoring every ${intervalMs / 1000}s`);
    
    setInterval(async () => {
      try {
        await this.monitorPositions();
      } catch (error) {
        console.error("[BACKTEST] Monitoring error:", error);
      }
    }, intervalMs);
  }
}

export const backtestingService = new BacktestingService();

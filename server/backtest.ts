import type { Signal, BacktestTrade, BacktestSummary, TradeDisplay, Exit } from "@shared/schema";
import { storage } from "./storage";
import axios from "axios";

// ============================================
// CONFIGURATION - Optimized for Sharpe ≥2.5
// ============================================
const CONFIG = {
  INITIAL_CAPITAL: 10000,
  RISK_PER_TRADE_MIN: 0.02,
  RISK_PER_TRADE_MAX: 0.05,
  DEFAULT_RISK_PCT: 0.03,
  MAX_CONCURRENT_TRADES: 10,
  SIGNAL_STRENGTH_MIN: 4,
  
  // Entry Filters (Tighter for quality signals)
  MIN_VOL_SPIKE: 8.0,        // Require 8x volume spike
  MIN_VOL_ACCEL: 3.0,        // Require 3x acceleration
  MIN_OI_CHANGE: 15.0,       // Require 15% OI change
  RSI_MIN: 45,               // RSI lower bound
  RSI_MAX: 70,               // RSI upper bound
  
  // Flexible Stop Loss
  SWING_LOW_BUFFER_PCT: 0.005, // 0.5% buffer below swing low
  DEFAULT_SL_PCT: 0.05,        // 5% fallback if no swing low
  
  // Momentum Trailing TP (replaces fixed TP1/TP2/TP3)
  TRAIL_VOL_THRESHOLD: 2.0,    // Trail when VOL drops below 2x
  TRAIL_PRICE_DROP_PCT: 0.03,  // Trail when price drops 3% from peak
  TRAIL_DISTANCE_PCT: 0.015,   // 1.5% trailing distance
  BREAKEVEN_ACTIVATION_R: 0.5, // Move to breakeven after 0.5R
  
  // Legacy TP levels for compatibility
  TP1_EXIT_PCT: 0.25,
  TP2_EXIT_PCT: 0.35,
  TP3_EXIT_PCT: 0.40,
  MIN_TP1_R_MULTIPLE: 0.5,
};

// ============================================
// POSITION MANAGER
// ============================================
class PositionManager {
  private capital: number = CONFIG.INITIAL_CAPITAL;
  private reservedCapital: number = 0;
  private peakEquity: number = CONFIG.INITIAL_CAPITAL;
  private maxDrawdown: number = 0;

  async initialize() {
    const latestEquity = await storage.getLatestEquity();
    if (latestEquity) {
      this.capital = latestEquity.equity;
      this.peakEquity = Math.max(this.peakEquity, this.capital);
    }
    
    const activeTrades = await storage.getActiveTrades();
    this.reservedCapital = activeTrades.reduce((sum, t) => sum + t.capitalUsed, 0);
  }

  getAvailableCapital(): number {
    return this.capital - this.reservedCapital;
  }

  getTotalEquity(): number {
    return this.capital;
  }

  reserveCapital(amount: number) {
    this.reservedCapital += amount;
  }

  releaseCapital(amount: number) {
    this.reservedCapital = Math.max(0, this.reservedCapital - amount);
  }

  calculatePositionSize(entryPrice: number, slPrice: number): { size: number; capitalUsed: number } {
    const riskPerUnit = Math.abs(entryPrice - slPrice);
    
    if (riskPerUnit === 0) {
      return { size: 0, capitalUsed: 0 };
    }
    
    const availableCapital = this.getAvailableCapital();
    let capitalToRisk = availableCapital * CONFIG.DEFAULT_RISK_PCT;
    capitalToRisk = Math.max(
      availableCapital * CONFIG.RISK_PER_TRADE_MIN,
      Math.min(capitalToRisk, availableCapital * CONFIG.RISK_PER_TRADE_MAX)
    );
    
    const size = capitalToRisk / riskPerUnit;
    const capitalUsed = size * entryPrice;
    
    if (capitalUsed > availableCapital * 0.2) {
      const adjustedSize = (availableCapital * 0.2) / entryPrice;
      return { size: adjustedSize, capitalUsed: adjustedSize * entryPrice };
    }
    
    return { size, capitalUsed };
  }

  async updateEquity(pnlDelta: number, capitalReleased: number = 0) {
    this.capital += pnlDelta;
    this.releaseCapital(capitalReleased);
    
    this.peakEquity = Math.max(this.peakEquity, this.capital);
    const currentDrawdown = this.peakEquity > 0 ? (this.peakEquity - this.capital) / this.peakEquity : 0;
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
  private positionManager: PositionManager;

  constructor(positionManager: PositionManager) {
    this.positionManager = positionManager;
  }

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
    
    return {
      totalCapital: this.positionManager.getTotalEquity(),
      availableCapital: this.positionManager.getAvailableCapital(),
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
// PRICE MONITOR - Momentum Trailing Implementation
// ============================================
class PriceMonitor {
  private positionManager: PositionManager;
  private peakPrices: Map<string, number> = new Map();

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

  // Store the latest volume spike ratios from signal processing
  private volumeSpikes: Map<string, number> = new Map();
  
  updateVolumeSpike(symbol: string, volumeSpike: number) {
    this.volumeSpikes.set(symbol, volumeSpike);
  }
  
  getVolumeSpike(symbol: string): number | null {
    return this.volumeSpikes.get(symbol) ?? null;
  }

  async checkActiveTrades() {
    const activeTrades = await storage.getActiveTrades();
    
    for (const trade of activeTrades) {
      const currentPrice = await this.fetchCurrentPrice(trade.symbol);
      if (!currentPrice) continue;
      
      // Track peak price for momentum trailing
      const existingPeak = this.peakPrices.get(trade.tradeId) || trade.entryPrice;
      if (currentPrice > existingPeak) {
        this.peakPrices.set(trade.tradeId, currentPrice);
      }
      
      // Get current volume spike from the latest signal data
      const currentVolume = this.getVolumeSpike(trade.symbol);
      await this.evaluateTrade(trade, currentPrice, currentVolume);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async evaluateTrade(trade: BacktestTrade, currentPrice: number, currentVolume: number | null) {
    const riskPerUnit = trade.entryPrice - trade.originalSlPrice;
    
    if (riskPerUnit <= 0) return;
    
    let accumulatedPnl = 0;
    let exitedSize = 0;
    
    const events = await storage.getTradeEvents(trade.tradeId);
    for (const event of events) {
      if (event.eventType !== "ENTRY" && event.size) {
        exitedSize += event.size;
        accumulatedPnl += event.pnlDelta || 0;
      }
    }
    
    const remainingSize = trade.positionSize - exitedSize;
    
    if (remainingSize <= 0) return;
    
    const currentRMultiple = (currentPrice - trade.entryPrice) / riskPerUnit;
    const peakPrice = this.peakPrices.get(trade.tradeId) || trade.entryPrice;
    const priceDropFromPeak = peakPrice > 0 ? (peakPrice - currentPrice) / peakPrice : 0;
    
    // STOP LOSS CHECK
    if (currentPrice <= trade.currentSlPrice && !trade.slHit) {
      const slPnl = (trade.currentSlPrice - trade.entryPrice) * remainingSize;
      const totalPnl = accumulatedPnl + slPnl;
      const rMultiple = totalPnl / (riskPerUnit * trade.positionSize);
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "SL",
        price: trade.currentSlPrice,
        size: remainingSize,
        pnlDelta: slPnl,
      });
      
      await storage.updateTrade(trade.tradeId, {
        status: "closed",
        slHit: true,
        exitTimestamp: new Date(),
        finalPnl: totalPnl,
        rMultiple,
      });
      
      // Clean up peak tracking
      this.peakPrices.delete(trade.tradeId);
      
      await this.positionManager.updateEquity(slPnl, trade.capitalUsed);
      console.log(`[BACKTEST] ${trade.symbol} SL HIT at ${trade.currentSlPrice}, PnL: $${totalPnl.toFixed(2)}, R: ${rMultiple.toFixed(2)}`);
      return;
    }
    
    // MOMENTUM TRAILING TP - Exit when momentum fades
    // Triggers when: VOL drops below 2x OR price drops 3% from peak (and we're in profit)
    const shouldTrailMomentum = currentRMultiple > 0 && (
      (currentVolume !== null && currentVolume < CONFIG.TRAIL_VOL_THRESHOLD) ||
      priceDropFromPeak >= CONFIG.TRAIL_PRICE_DROP_PCT
    );
    
    if (shouldTrailMomentum && !trade.slHit) {
      // Close entire remaining position at current price (momentum exit)
      const exitPnl = (currentPrice - trade.entryPrice) * remainingSize;
      const totalPnl = accumulatedPnl + exitPnl;
      const rMultiple = totalPnl / (riskPerUnit * trade.positionSize);
      
      const exitReason = currentVolume !== null && currentVolume < CONFIG.TRAIL_VOL_THRESHOLD 
        ? `VOL_FADE (${currentVolume.toFixed(1)}x)` 
        : `PRICE_DROP (${(priceDropFromPeak * 100).toFixed(1)}%)`;
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "MOMENTUM_EXIT",
        price: currentPrice,
        size: remainingSize,
        pnlDelta: exitPnl,
      });
      
      await storage.updateTrade(trade.tradeId, {
        status: "closed",
        tp3Hit: true, // Mark as completed exit
        exitTimestamp: new Date(),
        finalPnl: totalPnl,
        rMultiple,
      });
      
      // Clean up peak tracking
      this.peakPrices.delete(trade.tradeId);
      
      await this.positionManager.updateEquity(exitPnl, trade.capitalUsed);
      console.log(`[BACKTEST] ${trade.symbol} MOMENTUM EXIT (${exitReason}) at $${currentPrice.toFixed(6)}, R: ${rMultiple.toFixed(2)}, PnL: $${totalPnl.toFixed(2)}`);
      return;
    }
    
    // BREAKEVEN STOP - Move SL to breakeven after 0.5R profit
    if (currentRMultiple >= CONFIG.BREAKEVEN_ACTIVATION_R && trade.currentSlPrice < trade.entryPrice) {
      await storage.updateTrade(trade.tradeId, {
        currentSlPrice: trade.entryPrice,
      });
      console.log(`[BACKTEST] ${trade.symbol} SL moved to BREAKEVEN at ${currentRMultiple.toFixed(2)}R`);
    }
    
    // TRAILING STOP - Trail when price moves higher (after breakeven)
    if (currentRMultiple > CONFIG.BREAKEVEN_ACTIVATION_R && currentPrice > trade.entryPrice) {
      const trailingSlPrice = currentPrice * (1 - CONFIG.TRAIL_DISTANCE_PCT);
      if (trailingSlPrice > trade.currentSlPrice) {
        await storage.updateTrade(trade.tradeId, {
          currentSlPrice: trailingSlPrice,
        });
      }
    }
    
    // Legacy TP levels (optional partial exits) - kept for compatibility but less used now
    if (currentPrice >= trade.tp1Price && !trade.tp1Hit) {
      const exitSize = trade.positionSize * CONFIG.TP1_EXIT_PCT;
      const tp1Pnl = (currentPrice - trade.entryPrice) * exitSize;
      
      await storage.addTradeEvent({
        tradeId: trade.tradeId,
        eventType: "TP1",
        price: currentPrice,
        size: exitSize,
        pnlDelta: tp1Pnl,
      });
      
      await storage.updateTrade(trade.tradeId, {
        tp1Hit: true,
      });
      
      const partialCapitalReleased = trade.capitalUsed * CONFIG.TP1_EXIT_PCT;
      await this.positionManager.updateEquity(tp1Pnl, partialCapitalReleased);
      console.log(`[BACKTEST] ${trade.symbol} TP1 at $${currentPrice.toFixed(6)}, Partial PnL: $${tp1Pnl.toFixed(2)}`);
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
      
      const partialCapitalReleased = trade.capitalUsed * CONFIG.TP2_EXIT_PCT;
      await this.positionManager.updateEquity(tp2Pnl, partialCapitalReleased);
      console.log(`[BACKTEST] ${trade.symbol} TP2 at ${trade.tp2Price}, Partial PnL: $${tp2Pnl.toFixed(2)}`);
    }
    
    if (currentPrice >= trade.tp3Price && !trade.tp3Hit && trade.tp2Hit) {
      const exitSize = trade.positionSize * CONFIG.TP3_EXIT_PCT;
      const tp3Pnl = (trade.tp3Price - trade.entryPrice) * exitSize;
      
      let totalPnl = 0;
      const allEvents = await storage.getTradeEvents(trade.tradeId);
      for (const event of allEvents) {
        if (event.eventType !== "ENTRY") {
          totalPnl += event.pnlDelta || 0;
        }
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
      
      // Clean up peak tracking
      this.peakPrices.delete(trade.tradeId);
      
      const partialCapitalReleased = trade.capitalUsed * CONFIG.TP3_EXIT_PCT;
      await this.positionManager.updateEquity(tp3Pnl, partialCapitalReleased);
      console.log(`[BACKTEST] ${trade.symbol} TP3 at ${trade.tp3Price}, Final PnL: $${totalPnl.toFixed(2)}, R: ${rMultiple.toFixed(2)}`);
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
    this.statisticsEngine = new StatisticsEngine(this.positionManager);
    this.signalTracker = new SignalTracker();
    this.priceMonitor = new PriceMonitor(this.positionManager);
  }

  async initialize() {
    await this.positionManager.initialize();
    console.log(`[BACKTEST] Initialized with capital: $${this.positionManager.getCurrentEquity().toFixed(2)}, available: $${this.positionManager.getAvailableCapital().toFixed(2)}`);
  }

  async processSignals(signals: Signal[]) {
    await this.signalTracker.captureSignals(signals);
    
    // Update volume spikes for all signals (used for momentum trailing)
    for (const signal of signals) {
      this.priceMonitor.updateVolumeSpike(signal.symbol, signal.volumeSpikeRatio);
    }
    
    const activeTrades = await storage.getActiveTrades();
    const activeSymbols = new Set(activeTrades.map(t => t.symbol));
    
    if (activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) {
      console.log(`[BACKTEST] Max concurrent trades (${CONFIG.MAX_CONCURRENT_TRADES}) reached, skipping new entries`);
      return;
    }
    
    // TIGHTER ENTRY FILTERS for Sharpe ≥2.5
    const eligibleSignals = signals.filter(signal => {
      // Basic eligibility
      if (activeSymbols.has(signal.symbol)) return false;
      if (signal.signalStrength < CONFIG.SIGNAL_STRENGTH_MIN) return false;
      if (signal.riskReward < 2) return false;
      
      // Volume filter: Require 8x volume spike
      if (signal.volumeSpikeRatio < CONFIG.MIN_VOL_SPIKE) return false;
      
      // Acceleration filter: Require 3x acceleration (skip if no data available)
      const accel = signal.volAccel;
      if (accel !== null && accel !== undefined && accel < CONFIG.MIN_VOL_ACCEL) return false;
      
      // OI filter: Require 15% OI change (if available)
      if (signal.oiChange24h !== null && signal.oiChange24h !== undefined) {
        if (Math.abs(signal.oiChange24h) < CONFIG.MIN_OI_CHANGE) return false;
      }
      
      // RSI filter: Require RSI between 45-70
      if (signal.rsi < CONFIG.RSI_MIN || signal.rsi > CONFIG.RSI_MAX) return false;
      
      return true;
    });
    
    console.log(`[BACKTEST] ${eligibleSignals.length} signals passed filters (VOL≥${CONFIG.MIN_VOL_SPIKE}x, ACCEL≥${CONFIG.MIN_VOL_ACCEL}x, RSI ${CONFIG.RSI_MIN}-${CONFIG.RSI_MAX})`);
    
    for (const signal of eligibleSignals) {
      // FLEXIBLE SL: Use swing low from timeframe data with 0.5% buffer
      let slPrice = signal.slPrice;
      
      // Try to get 5min swing low from timeframes (15M has similar granularity)
      const tf15m = signal.timeframes?.find(tf => tf.timeframe === "15M");
      const tf1h = signal.timeframes?.find(tf => tf.timeframe === "1H");
      
      // Use swing low with buffer if available
      if (tf15m?.swingLow && tf15m.swingLow > 0) {
        const swingLowWithBuffer = tf15m.swingLow * (1 - CONFIG.SWING_LOW_BUFFER_PCT);
        // Only use if it provides a tighter stop than default
        if (swingLowWithBuffer > signal.entryPrice * (1 - CONFIG.DEFAULT_SL_PCT)) {
          slPrice = swingLowWithBuffer;
        }
      } else if (tf1h?.swingLow && tf1h.swingLow > 0) {
        const swingLowWithBuffer = tf1h.swingLow * (1 - CONFIG.SWING_LOW_BUFFER_PCT);
        if (swingLowWithBuffer > signal.entryPrice * (1 - CONFIG.DEFAULT_SL_PCT)) {
          slPrice = swingLowWithBuffer;
        }
      }
      
      const { size, capitalUsed } = this.positionManager.calculatePositionSize(
        signal.entryPrice,
        slPrice
      );
      
      if (size <= 0 || capitalUsed <= 0) {
        continue;
      }
      
      if (capitalUsed > this.positionManager.getAvailableCapital()) {
        console.log(`[BACKTEST] Insufficient capital for ${signal.symbol}, need $${capitalUsed.toFixed(2)}, available $${this.positionManager.getAvailableCapital().toFixed(2)}`);
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
        currentSlPrice: slPrice,
        originalSlPrice: slPrice,
        tp1Price: signal.tpLevels[0]?.price || signal.entryPrice * 1.05,
        tp2Price: signal.tpLevels[1]?.price || signal.entryPrice * 1.10,
        tp3Price: signal.tpLevels[2]?.price || signal.entryPrice * 1.15,
        positionSize: size,
        capitalUsed,
        status: "active",
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        slHit: false,
      });
      
      await storage.addTradeEvent({
        tradeId,
        eventType: "ENTRY",
        price: signal.entryPrice,
        size,
        pnlDelta: 0,
      });
      
      this.positionManager.reserveCapital(capitalUsed);
      
      console.log(`[BACKTEST] NEW TRADE: ${signal.symbol} @ $${signal.entryPrice.toFixed(6)}, Size: ${size.toFixed(4)}, Capital: $${capitalUsed.toFixed(2)}`);
      
      const currentActiveTrades = await storage.getActiveTrades();
      if (currentActiveTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) break;
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
          let exitedSize = 0;
          for (const exit of exits) {
            exitedSize += exit.size;
          }
          const remainingSize = trade.positionSize - exitedSize;
          unrealizedPnl = (currentPrice - trade.entryPrice) * remainingSize;
        }
      }
      
      // Calculate holding time in minutes
      let holdingTimeMinutes: number | null = null;
      if (trade.entryTimestamp && trade.exitTimestamp) {
        const entryTime = new Date(trade.entryTimestamp).getTime();
        const exitTime = new Date(trade.exitTimestamp).getTime();
        holdingTimeMinutes = Math.round((exitTime - entryTime) / 60000);
      } else if (trade.entryTimestamp && trade.status === "active") {
        // For active trades, show time since entry
        const entryTime = new Date(trade.entryTimestamp).getTime();
        holdingTimeMinutes = Math.round((Date.now() - entryTime) / 60000);
      }
      
      result.push({
        id: trade.id,
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        signalTimestamp: trade.signalTimestamp?.toISOString() || "",
        entryTimestamp: trade.entryTimestamp?.toISOString() || null,
        exitTimestamp: trade.exitTimestamp?.toISOString() || null,
        holdingTimeMinutes,
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

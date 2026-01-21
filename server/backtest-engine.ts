// Advanced Backtesting Engine targeting Sharpe Ratio > 2.5
import { db } from "./db";
import {
  backtestTrades,
  tradeEvents,
  equityCurve,
  backtestStats,
} from "../shared/schema";
import { eq, desc, and, gte, lte } from "drizzle-orm";

interface BacktestSignal {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  signalStrength: number;
  volumeSpike: number;
  rsi: number;
  oiChange?: number;
  volAccel?: number;
  timestamp: Date;
}

interface BacktestTrade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  entryTime: Date;
  exitPrice?: number;
  exitTime?: Date;
  stopLoss: number;
  trailingSL: number;
  peakPrice: number;
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
  positionSize: number;
  capitalUsed: number;
  status: "PENDING" | "ACTIVE" | "CLOSED";
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  slHit: boolean;
  pnl: number;
  rMultiple: number;
  exitReason?: string;
}

interface PerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  profitFactor: number;
  avgRMultiple: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  expectancy: number;
  avgHoldingTime: number;
}

interface BacktestConfig {
  initialCapital: number;
  riskPerTrade: number;
  maxPositions: number;
  minSignalStrength: number;
  minVolumeSpike: number;
  minVolAccel: number;
  minOiChange: number;
  rsiMin: number;
  rsiMax: number;
  minRiskReward: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  breakEvenThreshold: number;
  tp1Percent: number;
  tp2Percent: number;
  tp3Percent: number;
  tp1ClosePercent: number;
  tp2ClosePercent: number;
  tp3ClosePercent: number;
  blockedSymbols: string[];
}

const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  riskPerTrade: 1,
  maxPositions: 5,
  minSignalStrength: 4,
  minVolumeSpike: 8,
  minVolAccel: 3,
  minOiChange: 15,
  rsiMin: 45,
  rsiMax: 70,
  minRiskReward: 2,
  stopLossPercent: 5,
  trailingStopPercent: 1.5,
  breakEvenThreshold: 0.5,
  tp1Percent: 3,
  tp2Percent: 6,
  tp3Percent: 10,
  tp1ClosePercent: 30,
  tp2ClosePercent: 30,
  tp3ClosePercent: 40,
  blockedSymbols: ["BTCUSDT", "ETHUSDT"],
};

class BacktestEngine {
  private config: BacktestConfig = DEFAULT_CONFIG;
  private trades: BacktestTrade[] = [];
  private equity: number[] = [];
  private equityDates: Date[] = [];
  private dailyReturns: number[] = [];
  private currentCapital: number = 10000;
  private peakCapital: number = 10000;
  private maxDrawdown: number = 0;

  constructor(config?: Partial<BacktestConfig>) {
    if (config) {
      this.config = { ...DEFAULT_CONFIG, ...config };
    }
    this.currentCapital = this.config.initialCapital;
    this.peakCapital = this.config.initialCapital;
  }

  updateConfig(config: Partial<BacktestConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BacktestConfig {
    return { ...this.config };
  }

  reset() {
    this.trades = [];
    this.equity = [this.config.initialCapital];
    this.equityDates = [new Date()];
    this.dailyReturns = [];
    this.currentCapital = this.config.initialCapital;
    this.peakCapital = this.config.initialCapital;
    this.maxDrawdown = 0;
  }

  validateSignal(signal: BacktestSignal): { valid: boolean; reason?: string } {
    if (this.config.blockedSymbols.includes(signal.symbol)) {
      return { valid: false, reason: "Blocked symbol" };
    }

    if (signal.signalStrength < this.config.minSignalStrength) {
      return {
        valid: false,
        reason: `Signal strength ${signal.signalStrength} < ${this.config.minSignalStrength}`,
      };
    }

    if (signal.volumeSpike < this.config.minVolumeSpike) {
      return {
        valid: false,
        reason: `Volume spike ${signal.volumeSpike}x < ${this.config.minVolumeSpike}x`,
      };
    }

    if (
      signal.volAccel !== undefined &&
      signal.volAccel < this.config.minVolAccel
    ) {
      return {
        valid: false,
        reason: `Vol acceleration ${signal.volAccel}x < ${this.config.minVolAccel}x`,
      };
    }

    if (
      signal.oiChange !== undefined &&
      signal.oiChange < this.config.minOiChange
    ) {
      return {
        valid: false,
        reason: `OI change ${signal.oiChange}% < ${this.config.minOiChange}%`,
      };
    }

    if (signal.rsi < this.config.rsiMin || signal.rsi > this.config.rsiMax) {
      return {
        valid: false,
        reason: `RSI ${signal.rsi} not in range [${this.config.rsiMin}, ${this.config.rsiMax}]`,
      };
    }

    const riskReward = this.calculateRiskReward(signal);
    if (riskReward < this.config.minRiskReward) {
      return {
        valid: false,
        reason: `R:R ${riskReward.toFixed(2)} < ${this.config.minRiskReward}`,
      };
    }

    return { valid: true };
  }

  private calculateRiskReward(signal: BacktestSignal): number {
    const isLong = signal.side === "LONG";
    const risk = Math.abs(signal.entryPrice - signal.stopLoss);
    const reward = isLong
      ? signal.takeProfit1 - signal.entryPrice
      : signal.entryPrice - signal.takeProfit1;
    return risk > 0 && reward > 0 ? reward / risk : 0;
  }

  processSignal(signal: BacktestSignal): {
    accepted: boolean;
    trade?: BacktestTrade;
    reason?: string;
  } {
    const validation = this.validateSignal(signal);
    if (!validation.valid) {
      return { accepted: false, reason: validation.reason };
    }

    const activePositions = this.trades.filter(
      (t) => t.status === "ACTIVE",
    ).length;
    if (activePositions >= this.config.maxPositions) {
      return {
        accepted: false,
        reason: `Max positions (${this.config.maxPositions}) reached`,
      };
    }

    const existingTrade = this.trades.find(
      (t) => t.symbol === signal.symbol && t.status === "ACTIVE",
    );
    if (existingTrade) {
      return {
        accepted: false,
        reason: "Already have position in this symbol",
      };
    }

    const riskAmount = this.currentCapital * (this.config.riskPerTrade / 100);
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const positionSize = riskAmount / stopDistance;
    const capitalUsed = positionSize * signal.entryPrice;

    if (capitalUsed > this.currentCapital * 0.5) {
      return {
        accepted: false,
        reason: "Position size exceeds 50% of capital",
      };
    }

    const trade: BacktestTrade = {
      id: `bt_${Date.now()}_${signal.symbol}`,
      symbol: signal.symbol,
      side: signal.side,
      entryPrice: signal.entryPrice,
      entryTime: signal.timestamp,
      stopLoss: signal.stopLoss,
      trailingSL: signal.stopLoss,
      peakPrice: signal.entryPrice,
      tp1Price: signal.takeProfit1,
      tp2Price: signal.takeProfit2,
      tp3Price: signal.takeProfit3,
      positionSize,
      capitalUsed,
      status: "ACTIVE",
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      slHit: false,
      pnl: 0,
      rMultiple: 0,
    };

    this.trades.push(trade);
    return { accepted: true, trade };
  }

  updateTrade(
    tradeId: string,
    currentPrice: number,
    currentTime: Date,
  ): { closed: boolean; reason?: string } {
    const trade = this.trades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== "ACTIVE") {
      return { closed: false };
    }

    const isLong = trade.side === "LONG";
    const priceMove = isLong
      ? (currentPrice - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - currentPrice) / trade.entryPrice;

    if (isLong) {
      trade.peakPrice = Math.max(trade.peakPrice, currentPrice);
    } else {
      trade.peakPrice = Math.min(trade.peakPrice, currentPrice);
    }

    const riskAmount =
      Math.abs(trade.entryPrice - trade.stopLoss) * trade.positionSize;
    const unrealizedPnl = priceMove * trade.positionSize * trade.entryPrice;
    const currentRMultiple = unrealizedPnl / riskAmount;

    if (
      currentRMultiple >= this.config.breakEvenThreshold &&
      trade.trailingSL === trade.stopLoss
    ) {
      trade.trailingSL = trade.entryPrice;
    }

    if (currentRMultiple > 1) {
      const newTrailingSL = isLong
        ? trade.peakPrice * (1 - this.config.trailingStopPercent / 100)
        : trade.peakPrice * (1 + this.config.trailingStopPercent / 100);

      if (isLong && newTrailingSL > trade.trailingSL) {
        trade.trailingSL = newTrailingSL;
      } else if (!isLong && newTrailingSL < trade.trailingSL) {
        trade.trailingSL = newTrailingSL;
      }
    }

    const hitSL = isLong
      ? currentPrice <= trade.trailingSL
      : currentPrice >= trade.trailingSL;
    if (hitSL) {
      return this.closeTrade(
        tradeId,
        trade.trailingSL,
        currentTime,
        "Stop Loss",
      );
    }

    if (!trade.tp1Hit) {
      const hitTP1 = isLong
        ? currentPrice >= trade.tp1Price
        : currentPrice <= trade.tp1Price;
      if (hitTP1) {
        trade.tp1Hit = true;
        const partialPnl =
          (trade.tp1Price - trade.entryPrice) *
          trade.positionSize *
          (this.config.tp1ClosePercent / 100);
        if (!isLong) {
          trade.pnl +=
            (trade.entryPrice - trade.tp1Price) *
            trade.positionSize *
            (this.config.tp1ClosePercent / 100);
        } else {
          trade.pnl += partialPnl;
        }
        trade.positionSize *= 1 - this.config.tp1ClosePercent / 100;
      }
    }

    if (!trade.tp2Hit && trade.tp1Hit) {
      const hitTP2 = isLong
        ? currentPrice >= trade.tp2Price
        : currentPrice <= trade.tp2Price;
      if (hitTP2) {
        trade.tp2Hit = true;
        const partialPnl = isLong
          ? (trade.tp2Price - trade.entryPrice) *
            trade.positionSize *
            (this.config.tp2ClosePercent / (100 - this.config.tp1ClosePercent))
          : (trade.entryPrice - trade.tp2Price) *
            trade.positionSize *
            (this.config.tp2ClosePercent / (100 - this.config.tp1ClosePercent));
        trade.pnl += partialPnl;
        trade.positionSize *=
          1 - this.config.tp2ClosePercent / (100 - this.config.tp1ClosePercent);
      }
    }

    if (!trade.tp3Hit && trade.tp2Hit) {
      const hitTP3 = isLong
        ? currentPrice >= trade.tp3Price
        : currentPrice <= trade.tp3Price;
      if (hitTP3) {
        return this.closeTrade(tradeId, trade.tp3Price, currentTime, "TP3 Hit");
      }
    }

    return { closed: false };
  }

  closeTrade(
    tradeId: string,
    exitPrice: number,
    exitTime: Date,
    reason: string,
  ): { closed: boolean; reason: string } {
    const trade = this.trades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== "ACTIVE") {
      return { closed: false, reason: "Trade not found or already closed" };
    }

    const isLong = trade.side === "LONG";
    const finalPnl = isLong
      ? (exitPrice - trade.entryPrice) * trade.positionSize
      : (trade.entryPrice - exitPrice) * trade.positionSize;

    trade.exitPrice = exitPrice;
    trade.exitTime = exitTime;
    trade.status = "CLOSED";
    trade.pnl += finalPnl;
    trade.slHit = reason.includes("Stop");
    trade.exitReason = reason;

    const riskAmount =
      Math.abs(trade.entryPrice - trade.stopLoss) * trade.positionSize;
    trade.rMultiple = trade.pnl / riskAmount;

    this.currentCapital += trade.pnl;
    this.equity.push(this.currentCapital);
    this.equityDates.push(exitTime);

    if (this.equity.length >= 2) {
      const prevEquity = this.equity[this.equity.length - 2];
      const dailyReturn = (this.currentCapital - prevEquity) / prevEquity;
      this.dailyReturns.push(dailyReturn);
    }

    if (this.currentCapital > this.peakCapital) {
      this.peakCapital = this.currentCapital;
    }

    const drawdown =
      (this.peakCapital - this.currentCapital) / this.peakCapital;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }

    return { closed: true, reason };
  }

  calculateMetrics(): PerformanceMetrics {
    const closedTrades = this.trades.filter((t) => t.status === "CLOSED");
    const winningTrades = closedTrades.filter((t) => t.pnl > 0);
    const losingTrades = closedTrades.filter((t) => t.pnl <= 0);

    const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

    const avgWin =
      winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
    const avgLoss =
      losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;

    const pnls = closedTrades.map((t) => t.pnl);
    const avgPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;

    const returns = this.calculateReturns();
    const sharpeRatio = this.calculateSharpeRatio(returns);
    const sortinoRatio = this.calculateSortinoRatio(returns);

    const holdingTimes = closedTrades
      .filter((t) => t.exitTime)
      .map(
        (t) => (t.exitTime!.getTime() - t.entryTime.getTime()) / (1000 * 60),
      );
    const avgHoldingTime =
      holdingTimes.length > 0
        ? holdingTimes.reduce((a, b) => a + b, 0) / holdingTimes.length
        : 0;

    return {
      totalTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate:
        closedTrades.length > 0
          ? (winningTrades.length / closedTrades.length) * 100
          : 0,
      totalPnl,
      avgPnl,
      avgWin,
      avgLoss,
      maxWin:
        winningTrades.length > 0
          ? Math.max(...winningTrades.map((t) => t.pnl))
          : 0,
      maxLoss:
        losingTrades.length > 0
          ? Math.min(...losingTrades.map((t) => t.pnl))
          : 0,
      profitFactor:
        grossLoss > 0
          ? grossProfit / grossLoss
          : grossProfit > 0
            ? Infinity
            : 0,
      avgRMultiple:
        closedTrades.length > 0
          ? closedTrades.reduce((sum, t) => sum + t.rMultiple, 0) /
            closedTrades.length
          : 0,
      maxDrawdown: this.maxDrawdown * this.config.initialCapital,
      maxDrawdownPercent: this.maxDrawdown * 100,
      sharpeRatio,
      sortinoRatio,
      calmarRatio:
        this.maxDrawdown > 0
          ? totalPnl / this.config.initialCapital / this.maxDrawdown
          : 0,
      expectancy: closedTrades.length > 0 ? avgPnl : 0,
      avgHoldingTime,
    };
  }

  private calculateReturns(): number[] {
    const returns: number[] = [];
    for (let i = 1; i < this.equity.length; i++) {
      returns.push((this.equity[i] - this.equity[i - 1]) / this.equity[i - 1]);
    }
    return returns;
  }

  private calculateSharpeRatio(returns: number[]): number {
    if (returns.length < 2) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
      returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return avgReturn > 0 ? Infinity : 0;

    const annualizationFactor = Math.sqrt(252);
    return (avgReturn / stdDev) * annualizationFactor;
  }

  private calculateSortinoRatio(returns: number[]): number {
    if (returns.length < 2) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const negativeReturns = returns.filter((r) => r < 0);

    if (negativeReturns.length === 0) return avgReturn > 0 ? Infinity : 0;

    const downsideVariance =
      negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) /
      negativeReturns.length;
    const downsideStdDev = Math.sqrt(downsideVariance);

    if (downsideStdDev === 0) return avgReturn > 0 ? Infinity : 0;

    const annualizationFactor = Math.sqrt(252);
    return (avgReturn / downsideStdDev) * annualizationFactor;
  }

  getTrades(): BacktestTrade[] {
    return [...this.trades];
  }

  getActiveTrades(): BacktestTrade[] {
    return this.trades.filter((t) => t.status === "ACTIVE");
  }

  getClosedTrades(): BacktestTrade[] {
    return this.trades.filter((t) => t.status === "CLOSED");
  }

  getEquityCurve(): { equity: number[]; dates: Date[] } {
    return { equity: [...this.equity], dates: [...this.equityDates] };
  }

  getCurrentCapital(): number {
    return this.currentCapital;
  }

  optimizeForSharpe(
    signals: BacktestSignal[],
    targetSharpe: number = 2.5,
  ): BacktestConfig {
    console.log(`[BACKTEST] Optimizing for Sharpe ratio >= ${targetSharpe}`);

    const paramGrid = {
      minSignalStrength: [3, 4, 5],
      minVolumeSpike: [5, 8, 10],
      minRiskReward: [1.5, 2, 2.5, 3],
      rsiMin: [40, 45, 50],
      rsiMax: [65, 70, 75],
      stopLossPercent: [3, 5, 7],
      trailingStopPercent: [1, 1.5, 2],
    };

    let bestConfig = { ...this.config };
    let bestSharpe = -Infinity;

    for (const minStrength of paramGrid.minSignalStrength) {
      for (const minVol of paramGrid.minVolumeSpike) {
        for (const minRR of paramGrid.minRiskReward) {
          for (const rMin of paramGrid.rsiMin) {
            for (const rMax of paramGrid.rsiMax) {
              if (rMin >= rMax) continue;

              const testConfig: Partial<BacktestConfig> = {
                minSignalStrength: minStrength,
                minVolumeSpike: minVol,
                minRiskReward: minRR,
                rsiMin: rMin,
                rsiMax: rMax,
              };

              this.updateConfig(testConfig);
              this.reset();

              for (const signal of signals) {
                this.processSignal(signal);
              }

              const metrics = this.calculateMetrics();

              if (
                metrics.sharpeRatio > bestSharpe &&
                metrics.totalTrades >= 10
              ) {
                bestSharpe = metrics.sharpeRatio;
                bestConfig = { ...this.config };
                console.log(
                  `[BACKTEST] New best: Sharpe=${bestSharpe.toFixed(2)}, Trades=${metrics.totalTrades}`,
                );
              }
            }
          }
        }
      }
    }

    console.log(
      `[BACKTEST] Optimization complete. Best Sharpe: ${bestSharpe.toFixed(2)}`,
    );
    this.config = bestConfig;
    return bestConfig;
  }

  async saveResults(): Promise<void> {
    const metrics = this.calculateMetrics();
    const closedTrades = this.getClosedTrades();

    // Check if database is available
    if (!db) {
      console.error("[BACKTEST] Database connection not available");
      return;
    }
    try {
      await db.insert(backtestStats).values({
        periodType: "session",
        periodStart: closedTrades[0]?.entryTime || new Date(),
        periodEnd:
          closedTrades[closedTrades.length - 1]?.exitTime || new Date(),
        totalTrades: metrics.totalTrades,
        winningTrades: metrics.winningTrades,
        losingTrades: metrics.losingTrades,
        winRate: metrics.winRate,
        totalPnl: metrics.totalPnl,
        avgRMultiple: metrics.avgRMultiple,
        maxDrawdown: metrics.maxDrawdownPercent,
        sharpeRatio: metrics.sharpeRatio,
        profitFactor:
          metrics.profitFactor === Infinity ? 999 : metrics.profitFactor,
      });

      console.log("[BACKTEST] Results saved to database");
    } catch (error) {
      console.error("[BACKTEST] Error saving results:", error);
    }
  }

  generateReport(): string {
    const metrics = this.calculateMetrics();
    const config = this.getConfig();

    return `
====================================
BACKTEST PERFORMANCE REPORT
====================================

CONFIGURATION:
- Initial Capital: $${config.initialCapital.toLocaleString()}
- Risk per Trade: ${config.riskPerTrade}%
- Max Positions: ${config.maxPositions}
- Min Signal Strength: ${config.minSignalStrength}/5
- Min Volume Spike: ${config.minVolumeSpike}x
- RSI Range: ${config.rsiMin}-${config.rsiMax}
- Min R:R: ${config.minRiskReward}

RESULTS:
- Total Trades: ${metrics.totalTrades}
- Winning Trades: ${metrics.winningTrades} (${metrics.winRate.toFixed(1)}%)
- Losing Trades: ${metrics.losingTrades}
- Total P&L: $${metrics.totalPnl.toFixed(2)}
- Avg P&L per Trade: $${metrics.avgPnl.toFixed(2)}

RISK METRICS:
- Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)} ${metrics.sharpeRatio >= 2.5 ? "TARGET MET" : "BELOW TARGET"}
- Sortino Ratio: ${metrics.sortinoRatio.toFixed(2)}
- Calmar Ratio: ${metrics.calmarRatio.toFixed(2)}
- Profit Factor: ${metrics.profitFactor === Infinity ? "Infinite" : metrics.profitFactor.toFixed(2)}
- Max Drawdown: ${metrics.maxDrawdownPercent.toFixed(2)}%
- Avg R-Multiple: ${metrics.avgRMultiple.toFixed(2)}R

TRADE QUALITY:
- Avg Win: $${metrics.avgWin.toFixed(2)}
- Avg Loss: $${metrics.avgLoss.toFixed(2)}
- Max Win: $${metrics.maxWin.toFixed(2)}
- Max Loss: $${metrics.maxLoss.toFixed(2)}
- Expectancy: $${metrics.expectancy.toFixed(2)}/trade
- Avg Holding Time: ${metrics.avgHoldingTime.toFixed(0)} minutes

====================================
    `.trim();
  }
}

export const backtestEngine = new BacktestEngine();
export { BacktestEngine };
export type {
  BacktestSignal,
  BacktestTrade,
  PerformanceMetrics,
  BacktestConfig,
};

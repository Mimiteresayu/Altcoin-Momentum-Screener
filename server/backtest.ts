// Backtesting service for simulating trades based on signals
import { db } from "./db";
import { backtestTrades } from "../shared/schema";
import { eq, desc } from "drizzle-orm";

interface Trade {
  id?: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice?: number;
  entryTime: Date;
  exitTime?: Date;
  status: "ACTIVE" | "CLOSED";
  pnl?: number;
  pnlPercent?: number;
  riskRewardRatio?: number;
}

interface Signal {
  symbol: string;
  direction: "LONG" | "SHORT";
  price: number;
  momentum: number;
  timestamp: Date;
}

interface PerformanceMetrics {
  totalTrades: number;
  activeTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  winRate: number;
  avgR: number;
  maxDrawdown: number;
  sharpe: number;
  profitFactor: number;
}

class BacktestingService {
  private initialCapital = 10000;
  private positionSize = 0.1; // 10% of capital per trade
  private stopLossPercent = 0.02; // 2% stop loss
  private takeProfitPercent = 0.06; // 6% take profit (3R)
  private monitoringInterval: NodeJS.Timeout | null = null;

  async initialize() {
    console.log("[Backtest] Initializing backtesting service");
    // Create table if it doesn't exist
    try {
      await db.select().from(backtestTrades).limit(1);
    } catch (error) {
      console.log("[Backtest] Creating backtest_trades table");
    }
  }

  async processSignals(signals: Signal[]) {
    console.log(`[Backtest] Processing ${signals.length} signals`);

    for (const signal of signals) {
      // Check if we already have an active trade for this symbol
      const activeTrade = await this.getActiveTradeForSymbol(signal.symbol);

      if (activeTrade) {
        // Check if we should close the trade
        await this.checkTradeExit(activeTrade, signal.price);
      } else if (this.shouldEnterTrade(signal)) {
        // Enter new trade
        await this.enterTrade(signal);
      }
    }
  }

  private shouldEnterTrade(signal: Signal): boolean {
    // Entry criteria: strong momentum
    return Math.abs(signal.momentum) >= 1.5;
  }

  private async getActiveTradeForSymbol(symbol: string): Promise<Trade | null> {
    try {
      const trades = await db
        .select()
        .from(backtestTrades)
        .where(eq(backtestTrades.symbol, symbol))
        .where(eq(backtestTrades.status, "ACTIVE"))
        .limit(1);

      return (trades[0] as Trade) || null;
    } catch (error) {
      return null;
    }
  }

  private async enterTrade(signal: Signal) {
    const trade: Trade = {
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.price,
      entryTime: signal.timestamp || new Date(),
      status: "ACTIVE",
    };

    try {
      await db.insert(backtestTrades).values({
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        entryTime: trade.entryTime,
        status: trade.status,
      });

      console.log(
        `[Backtest] Entered ${trade.direction} trade for ${trade.symbol} at $${trade.entryPrice}`,
      );
    } catch (error) {
      console.error("[Backtest] Error entering trade:", error);
    }
  }

  private async checkTradeExit(trade: Trade, currentPrice: number) {
    if (!trade.id) return;

    const priceChange = (currentPrice - trade.entryPrice) / trade.entryPrice;
    const effectiveChange =
      trade.direction === "LONG" ? priceChange : -priceChange;

    let shouldExit = false;
    let exitReason = "";

    // Check stop loss
    if (effectiveChange <= -this.stopLossPercent) {
      shouldExit = true;
      exitReason = "Stop Loss";
    }

    // Check take profit
    if (effectiveChange >= this.takeProfitPercent) {
      shouldExit = true;
      exitReason = "Take Profit";
    }

    if (shouldExit) {
      await this.exitTrade(trade.id, currentPrice, exitReason);
    }
  }

  private async exitTrade(tradeId: number, exitPrice: number, reason: string) {
    try {
      const trades = await db
        .select()
        .from(backtestTrades)
        .where(eq(backtestTrades.id, tradeId));

      const trade = trades[0];
      if (!trade) return;

      const priceChange = (exitPrice - trade.entryPrice) / trade.entryPrice;
      const effectiveChange =
        trade.direction === "LONG" ? priceChange : -priceChange;
      const pnlPercent = effectiveChange * 100;
      const positionValue = this.initialCapital * this.positionSize;
      const pnl = positionValue * effectiveChange;
      const riskRewardRatio = effectiveChange / this.stopLossPercent;

      await db
        .update(backtestTrades)
        .set({
          exitPrice,
          exitTime: new Date(),
          status: "CLOSED",
          pnl,
          pnlPercent,
          riskRewardRatio,
        })
        .where(eq(backtestTrades.id, tradeId));

      console.log(
        `[Backtest] Closed ${trade.direction} trade for ${trade.symbol} | ${reason} | PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
      );
    } catch (error) {
      console.error("[Backtest] Error exiting trade:", error);
    }
  }

  async getTrades(): Promise<Trade[]> {
    try {
      const trades = await db
        .select()
        .from(backtestTrades)
        .orderBy(desc(backtestTrades.entryTime))
        .limit(100);

      return trades as Trade[];
    } catch (error) {
      return [];
    }
  }

  async getSignalHistory(): Promise<any[]> {
    const trades = await this.getTrades();
    return trades.map((t) => ({
      symbol: t.symbol,
      direction: t.direction,
      entryPrice: t.entryPrice,
      entryTime: t.entryTime,
      status: t.status,
    }));
  }

  async getDailyReport(): Promise<{
    trades: Trade[];
    summary: PerformanceMetrics;
  }> {
    const trades = await this.getTrades();
    const summary = await this.calculateMetrics();
    return { trades, summary };
  }

  async calculateMetrics(): Promise<PerformanceMetrics> {
    const trades = await this.getTrades();
    const closedTrades = trades.filter((t) => t.status === "CLOSED");
    const activeTrades = trades.filter((t) => t.status === "ACTIVE");

    const winningTrades = closedTrades.filter((t) => (t.pnl || 0) > 0);
    const losingTrades = closedTrades.filter((t) => (t.pnl || 0) < 0);

    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate =
      closedTrades.length > 0
        ? (winningTrades.length / closedTrades.length) * 100
        : 0;

    const avgR =
      closedTrades.length > 0
        ? closedTrades.reduce((sum, t) => sum + (t.riskRewardRatio || 0), 0) /
          closedTrades.length
        : 0;

    // Calculate max drawdown
    let peak = this.initialCapital;
    let maxDrawdown = 0;
    let runningCapital = this.initialCapital;

    for (const trade of closedTrades) {
      runningCapital += trade.pnl || 0;
      if (runningCapital > peak) {
        peak = runningCapital;
      }
      const drawdown = ((peak - runningCapital) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // Calculate profit factor
    const totalWins = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalLosses = Math.abs(
      losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0),
    );
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;

    // Calculate Sharpe ratio (simplified)
    const returns = closedTrades.map((t) => (t.pnlPercent || 0) / 100);
    const avgReturn =
      returns.length > 0
        ? returns.reduce((a, b) => a + b, 0) / returns.length
        : 0;
    const stdDev =
      returns.length > 1
        ? Math.sqrt(
            returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
              (returns.length - 1),
          )
        : 0;
    const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized

    return {
      totalTrades: closedTrades.length,
      activeTrades: activeTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      totalPnl,
      winRate,
      avgR,
      maxDrawdown,
      sharpe,
      profitFactor,
    };
  }

  async getEquityCurve(): Promise<Array<{ timestamp: Date; equity: number }>> {
    const trades = await this.getTrades();
    const closedTrades = trades
      .filter((t) => t.status === "CLOSED" && t.exitTime)
      .sort((a, b) => a.exitTime!.getTime() - b.exitTime!.getTime());

    const curve = [];
    let equity = this.initialCapital;

    curve.push({
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      equity,
    });

    for (const trade of closedTrades) {
      equity += trade.pnl || 0;
      curve.push({ timestamp: trade.exitTime!, equity });
    }

    return curve;
  }

  startMonitoring(interval: number = 60000) {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    console.log(`[Backtest] Starting monitoring with ${interval}ms interval`);

    this.monitoringInterval = setInterval(async () => {
      // This would be called by the main signal detection system
      // For now, it's a placeholder
    }, interval);
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log("[Backtest] Stopped monitoring");
    }
  }
}

const backtestingService = new BacktestingService();

export {
  backtestingService,
  BacktestingService,
  type Trade,
  type Signal,
  type PerformanceMetrics,
};

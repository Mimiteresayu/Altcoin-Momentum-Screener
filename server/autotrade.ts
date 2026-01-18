import { binanceService, Position, OrderResult } from "./binance";
import { db } from "./db";
import { autotradeSettings, autotradeTrades } from "../shared/schema";
import { eq, desc } from "drizzle-orm";

interface AutotradeConfig {
  enabled: boolean;
  maxPositions: number;
  riskPerTrade: number;
  leverage: number;
  minSignalStrength: number;
  allowedSymbols: string[];
  blockedSymbols: string[];
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  useTrailingStop: boolean;
  onlyHotSignals: boolean;
}

interface TradeSignal {
  symbol: string;
  side: "LONG" | "SHORT";
  price: number;
  stopLoss: number;
  takeProfit: number;
  signalStrength: number;
  category: string;
  rsi: number;
  volumeSpike: number;
  fundingRate?: number;
}

interface ActiveTrade {
  id: number;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  status: string;
  pnl?: number;
  entryTime: Date;
}

const DEFAULT_CONFIG: AutotradeConfig = {
  enabled: false,
  maxPositions: 3,
  riskPerTrade: 1,
  leverage: 5,
  minSignalStrength: 4,
  allowedSymbols: [],
  blockedSymbols: ["BTCUSDT", "ETHUSDT"],
  stopLossPercent: 2,
  takeProfitPercent: 6,
  trailingStopPercent: 1.5,
  useTrailingStop: true,
  onlyHotSignals: true,
};

class AutotradeService {
  private config: AutotradeConfig = DEFAULT_CONFIG;
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  async initialize() {
    console.log("[AUTOTRADE] Initializing autotrade service");
    
    const binanceReady = binanceService.initialize();
    if (!binanceReady) {
      console.log("[AUTOTRADE] Binance not configured - service disabled");
      return false;
    }

    await this.loadConfig();
    console.log("[AUTOTRADE] Service initialized, enabled:", this.config.enabled);
    return true;
  }

  async loadConfig() {
    try {
      const settings = await db.select().from(autotradeSettings).limit(1);
      if (settings.length > 0) {
        const s = settings[0];
        this.config = {
          enabled: s.enabled,
          maxPositions: s.maxPositions,
          riskPerTrade: s.riskPerTrade,
          leverage: s.leverage,
          minSignalStrength: s.minSignalStrength,
          allowedSymbols: s.allowedSymbols || [],
          blockedSymbols: s.blockedSymbols || [],
          stopLossPercent: s.stopLossPercent,
          takeProfitPercent: s.takeProfitPercent,
          trailingStopPercent: s.trailingStopPercent,
          useTrailingStop: s.useTrailingStop,
          onlyHotSignals: s.onlyHotSignals,
        };
      }
    } catch (error) {
      console.log("[AUTOTRADE] Using default config");
    }
  }

  async saveConfig(newConfig: Partial<AutotradeConfig>) {
    this.config = { ...this.config, ...newConfig };
    
    try {
      const existing = await db.select().from(autotradeSettings).limit(1);
      
      if (existing.length > 0) {
        await db.update(autotradeSettings)
          .set({
            enabled: this.config.enabled,
            maxPositions: this.config.maxPositions,
            riskPerTrade: this.config.riskPerTrade,
            leverage: this.config.leverage,
            minSignalStrength: this.config.minSignalStrength,
            allowedSymbols: this.config.allowedSymbols,
            blockedSymbols: this.config.blockedSymbols,
            stopLossPercent: this.config.stopLossPercent,
            takeProfitPercent: this.config.takeProfitPercent,
            trailingStopPercent: this.config.trailingStopPercent,
            useTrailingStop: this.config.useTrailingStop,
            onlyHotSignals: this.config.onlyHotSignals,
            updatedAt: new Date(),
          })
          .where(eq(autotradeSettings.id, existing[0].id));
      } else {
        await db.insert(autotradeSettings).values({
          enabled: this.config.enabled,
          maxPositions: this.config.maxPositions,
          riskPerTrade: this.config.riskPerTrade,
          leverage: this.config.leverage,
          minSignalStrength: this.config.minSignalStrength,
          allowedSymbols: this.config.allowedSymbols,
          blockedSymbols: this.config.blockedSymbols,
          stopLossPercent: this.config.stopLossPercent,
          takeProfitPercent: this.config.takeProfitPercent,
          trailingStopPercent: this.config.trailingStopPercent,
          useTrailingStop: this.config.useTrailingStop,
          onlyHotSignals: this.config.onlyHotSignals,
        });
      }
      
      console.log("[AUTOTRADE] Config saved");
    } catch (error) {
      console.error("[AUTOTRADE] Error saving config:", error);
    }
  }

  getConfig(): AutotradeConfig {
    return { ...this.config };
  }

  isEnabled(): boolean {
    return this.config.enabled && binanceService.isConfigured();
  }

  async enable() {
    if (!binanceService.isConfigured()) {
      throw new Error("Binance API credentials not configured");
    }
    await this.saveConfig({ enabled: true });
    console.log("[AUTOTRADE] Enabled");
  }

  async disable() {
    await this.saveConfig({ enabled: false });
    console.log("[AUTOTRADE] Disabled");
  }

  async processSignal(signal: TradeSignal): Promise<{ action: string; details?: any }> {
    if (!this.isEnabled()) {
      return { action: "SKIP", details: "Autotrade disabled" };
    }

    if (!this.validateSignal(signal)) {
      return { action: "SKIP", details: "Signal does not meet criteria" };
    }

    const positions = await binanceService.getOpenPositions();
    const existingPosition = positions.find(p => p.symbol === signal.symbol);

    if (existingPosition) {
      return { action: "SKIP", details: "Position already exists for symbol" };
    }

    if (positions.length >= this.config.maxPositions) {
      return { action: "SKIP", details: `Max positions (${this.config.maxPositions}) reached` };
    }

    try {
      const result = await this.executeTrade(signal);
      return { action: "EXECUTED", details: result };
    } catch (error: any) {
      console.error("[AUTOTRADE] Trade execution failed:", error);
      return { action: "ERROR", details: error.message };
    }
  }

  private validateSignal(signal: TradeSignal): boolean {
    if (signal.signalStrength < this.config.minSignalStrength) {
      return false;
    }

    if (this.config.onlyHotSignals && signal.category !== "HOT") {
      return false;
    }

    if (this.config.blockedSymbols.includes(signal.symbol)) {
      return false;
    }

    if (this.config.allowedSymbols.length > 0 && 
        !this.config.allowedSymbols.includes(signal.symbol)) {
      return false;
    }

    return true;
  }

  private async executeTrade(signal: TradeSignal): Promise<any> {
    const account = await binanceService.getAccountInfo();
    const availableBalance = account.availableBalance;

    await binanceService.setLeverage(signal.symbol, this.config.leverage);
    await binanceService.setMarginType(signal.symbol, "ISOLATED");

    const quantity = binanceService.calculateQuantity(
      availableBalance,
      this.config.riskPerTrade,
      signal.price,
      signal.stopLoss,
      this.config.leverage
    );

    if (quantity <= 0) {
      throw new Error("Calculated quantity is too small");
    }

    const side = signal.side === "LONG" ? "BUY" : "SELL";
    const oppositeSide = signal.side === "LONG" ? "SELL" : "BUY";

    console.log(`[AUTOTRADE] Executing ${signal.side} on ${signal.symbol}`);
    console.log(`[AUTOTRADE] Quantity: ${quantity}, Entry: ${signal.price}`);
    console.log(`[AUTOTRADE] SL: ${signal.stopLoss}, TP: ${signal.takeProfit}`);

    const entryOrder = await binanceService.placeMarketOrder(
      signal.symbol,
      side,
      quantity
    );

    await binanceService.placeStopLoss(
      signal.symbol,
      oppositeSide,
      signal.stopLoss
    );

    await binanceService.placeTakeProfit(
      signal.symbol,
      oppositeSide,
      signal.takeProfit
    );

    await this.recordTrade({
      symbol: signal.symbol,
      side: signal.side,
      entryPrice: parseFloat(entryOrder.avgPrice) || signal.price,
      quantity,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      orderId: entryOrder.orderId,
      signalStrength: signal.signalStrength,
      category: signal.category,
    });

    return {
      orderId: entryOrder.orderId,
      symbol: signal.symbol,
      side: signal.side,
      quantity,
      entryPrice: entryOrder.avgPrice,
    };
  }

  private async recordTrade(trade: {
    symbol: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    quantity: number;
    stopLoss: number;
    takeProfit: number;
    orderId: number;
    signalStrength: number;
    category: string;
  }) {
    try {
      await db.insert(autotradeTrades).values({
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        quantity: trade.quantity,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        binanceOrderId: String(trade.orderId),
        signalStrength: trade.signalStrength,
        signalCategory: trade.category,
        status: "OPEN",
        entryTime: new Date(),
      });
    } catch (error) {
      console.error("[AUTOTRADE] Error recording trade:", error);
    }
  }

  async getActiveTrades(): Promise<ActiveTrade[]> {
    try {
      const trades = await db
        .select()
        .from(autotradeTrades)
        .where(eq(autotradeTrades.status, "OPEN"))
        .orderBy(desc(autotradeTrades.entryTime));

      return trades.map(t => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side as "LONG" | "SHORT",
        entryPrice: t.entryPrice,
        quantity: t.quantity,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        status: t.status,
        pnl: t.pnl || undefined,
        entryTime: t.entryTime,
      }));
    } catch (error) {
      return [];
    }
  }

  async getTradeHistory(limit: number = 50): Promise<any[]> {
    try {
      const trades = await db
        .select()
        .from(autotradeTrades)
        .orderBy(desc(autotradeTrades.entryTime))
        .limit(limit);

      return trades;
    } catch (error) {
      return [];
    }
  }

  async closePosition(symbol: string): Promise<any> {
    if (!binanceService.isConfigured()) {
      throw new Error("Binance not configured");
    }

    const positions = await binanceService.getOpenPositions();
    const position = positions.find(p => p.symbol === symbol);

    if (!position) {
      throw new Error("No open position for symbol");
    }

    await binanceService.cancelAllOrders(symbol);

    const side = position.positionAmt > 0 ? "SELL" : "BUY";
    const quantity = Math.abs(position.positionAmt);

    const result = await binanceService.placeMarketOrder(symbol, side, quantity);

    await db
      .update(autotradeTrades)
      .set({
        status: "CLOSED",
        exitPrice: parseFloat(result.avgPrice),
        exitTime: new Date(),
        pnl: position.unrealizedProfit,
      })
      .where(eq(autotradeTrades.symbol, symbol))
      .where(eq(autotradeTrades.status, "OPEN"));

    return result;
  }

  async emergencyCloseAll(): Promise<any[]> {
    if (!binanceService.isConfigured()) {
      throw new Error("Binance not configured");
    }

    const positions = await binanceService.getOpenPositions();
    const results = [];

    for (const position of positions) {
      try {
        const result = await this.closePosition(position.symbol);
        results.push({ symbol: position.symbol, success: true, result });
      } catch (error: any) {
        results.push({ symbol: position.symbol, success: false, error: error.message });
      }
    }

    await this.disable();
    return results;
  }

  async syncPositions(): Promise<void> {
    if (!binanceService.isConfigured()) return;

    try {
      const positions = await binanceService.getOpenPositions();
      const dbTrades = await this.getActiveTrades();

      for (const dbTrade of dbTrades) {
        const position = positions.find(p => p.symbol === dbTrade.symbol);
        
        if (!position) {
          await db
            .update(autotradeTrades)
            .set({ status: "CLOSED", exitTime: new Date() })
            .where(eq(autotradeTrades.id, dbTrade.id));
        }
      }
    } catch (error) {
      console.error("[AUTOTRADE] Sync error:", error);
    }
  }

  async getStats(): Promise<{
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    activePositions: number;
  }> {
    try {
      const allTrades = await db.select().from(autotradeTrades);
      const closedTrades = allTrades.filter(t => t.status === "CLOSED");
      const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
      const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const activePositions = allTrades.filter(t => t.status === "OPEN").length;

      return {
        totalTrades: closedTrades.length,
        winRate: closedTrades.length > 0 
          ? (winningTrades.length / closedTrades.length) * 100 
          : 0,
        totalPnl,
        activePositions,
      };
    } catch (error) {
      return { totalTrades: 0, winRate: 0, totalPnl: 0, activePositions: 0 };
    }
  }
}

export const autotradeService = new AutotradeService();
export type { AutotradeConfig, TradeSignal, ActiveTrade };

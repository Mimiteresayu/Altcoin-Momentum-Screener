import { db } from "./db";
import {
  watchlistItems,
  signalSnapshots,
  backtestTrades,
  tradeEvents,
  equityCurve,
  backtestStats,
  type WatchlistItem,
  type InsertWatchlistItem,
  type SignalSnapshot,
  type InsertSignalSnapshot,
  type BacktestTrade,
  type InsertBacktestTrade,
  type TradeEvent,
  type InsertTradeEvent,
  type EquityCurvePoint,
  type InsertEquityCurve,
  type BacktestStats,
  type InsertBacktestStats,
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";

export interface IStorage {
  // Watchlist
  getWatchlist(): Promise<WatchlistItem[]>;
  addToWatchlist(item: InsertWatchlistItem): Promise<WatchlistItem>;
  removeFromWatchlist(id: number): Promise<void>;
  
  // Signal Snapshots
  saveSignalSnapshot(snapshot: InsertSignalSnapshot): Promise<SignalSnapshot>;
  getSignalSnapshots(symbol?: string, limit?: number): Promise<SignalSnapshot[]>;
  
  // Backtest Trades
  createTrade(trade: InsertBacktestTrade): Promise<BacktestTrade>;
  getTrade(tradeId: string): Promise<BacktestTrade | null>;
  getActiveTrades(): Promise<BacktestTrade[]>;
  getAllTrades(limit?: number): Promise<BacktestTrade[]>;
  updateTrade(tradeId: string, updates: Partial<BacktestTrade>): Promise<BacktestTrade | null>;
  getTradesByDateRange(start: Date, end: Date): Promise<BacktestTrade[]>;
  
  // Trade Events
  addTradeEvent(event: InsertTradeEvent): Promise<TradeEvent>;
  getTradeEvents(tradeId: string): Promise<TradeEvent[]>;
  
  // Equity Curve
  addEquityPoint(point: InsertEquityCurve): Promise<EquityCurvePoint>;
  getEquityCurve(limit?: number): Promise<EquityCurvePoint[]>;
  getLatestEquity(): Promise<EquityCurvePoint | null>;
  
  // Stats
  saveStats(stats: InsertBacktestStats): Promise<BacktestStats>;
  getLatestStats(periodType: string): Promise<BacktestStats | null>;
  getStatsByDateRange(periodType: string, start: Date, end: Date): Promise<BacktestStats[]>;
}

export class DatabaseStorage implements IStorage {
  // ============================================
  // WATCHLIST
  // ============================================
  async getWatchlist(): Promise<WatchlistItem[]> {
    return await db.select().from(watchlistItems);
  }

  async addToWatchlist(item: InsertWatchlistItem): Promise<WatchlistItem> {
    const [newItem] = await db
      .insert(watchlistItems)
      .values(item)
      .returning();
    return newItem;
  }

  async removeFromWatchlist(id: number): Promise<void> {
    await db.delete(watchlistItems).where(eq(watchlistItems.id, id));
  }

  // ============================================
  // SIGNAL SNAPSHOTS
  // ============================================
  async saveSignalSnapshot(snapshot: InsertSignalSnapshot): Promise<SignalSnapshot> {
    const [saved] = await db
      .insert(signalSnapshots)
      .values(snapshot)
      .returning();
    return saved;
  }

  async getSignalSnapshots(symbol?: string, limit: number = 100): Promise<SignalSnapshot[]> {
    if (symbol) {
      return await db
        .select()
        .from(signalSnapshots)
        .where(eq(signalSnapshots.symbol, symbol))
        .orderBy(desc(signalSnapshots.collectedAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(signalSnapshots)
      .orderBy(desc(signalSnapshots.collectedAt))
      .limit(limit);
  }

  // ============================================
  // BACKTEST TRADES
  // ============================================
  async createTrade(trade: InsertBacktestTrade): Promise<BacktestTrade> {
    const [created] = await db
      .insert(backtestTrades)
      .values(trade)
      .returning();
    return created;
  }

  async getTrade(tradeId: string): Promise<BacktestTrade | null> {
    const [trade] = await db
      .select()
      .from(backtestTrades)
      .where(eq(backtestTrades.tradeId, tradeId))
      .limit(1);
    return trade || null;
  }

  async getActiveTrades(): Promise<BacktestTrade[]> {
    return await db
      .select()
      .from(backtestTrades)
      .where(eq(backtestTrades.status, "active"));
  }

  async getAllTrades(limit: number = 100): Promise<BacktestTrade[]> {
    return await db
      .select()
      .from(backtestTrades)
      .orderBy(desc(backtestTrades.createdAt))
      .limit(limit);
  }

  async updateTrade(tradeId: string, updates: Partial<BacktestTrade>): Promise<BacktestTrade | null> {
    const [updated] = await db
      .update(backtestTrades)
      .set(updates)
      .where(eq(backtestTrades.tradeId, tradeId))
      .returning();
    return updated || null;
  }

  async getTradesByDateRange(start: Date, end: Date): Promise<BacktestTrade[]> {
    return await db
      .select()
      .from(backtestTrades)
      .where(
        and(
          gte(backtestTrades.signalTimestamp, start),
          lte(backtestTrades.signalTimestamp, end)
        )
      )
      .orderBy(desc(backtestTrades.signalTimestamp));
  }

  // ============================================
  // TRADE EVENTS
  // ============================================
  async addTradeEvent(event: InsertTradeEvent): Promise<TradeEvent> {
    const [created] = await db
      .insert(tradeEvents)
      .values(event)
      .returning();
    return created;
  }

  async getTradeEvents(tradeId: string): Promise<TradeEvent[]> {
    return await db
      .select()
      .from(tradeEvents)
      .where(eq(tradeEvents.tradeId, tradeId))
      .orderBy(tradeEvents.timestamp);
  }

  // ============================================
  // EQUITY CURVE
  // ============================================
  async addEquityPoint(point: InsertEquityCurve): Promise<EquityCurvePoint> {
    const [created] = await db
      .insert(equityCurve)
      .values(point)
      .returning();
    return created;
  }

  async getEquityCurve(limit: number = 100): Promise<EquityCurvePoint[]> {
    return await db
      .select()
      .from(equityCurve)
      .orderBy(desc(equityCurve.timestamp))
      .limit(limit);
  }

  async getLatestEquity(): Promise<EquityCurvePoint | null> {
    const [latest] = await db
      .select()
      .from(equityCurve)
      .orderBy(desc(equityCurve.timestamp))
      .limit(1);
    return latest || null;
  }

  // ============================================
  // STATS
  // ============================================
  async saveStats(stats: InsertBacktestStats): Promise<BacktestStats> {
    const [saved] = await db
      .insert(backtestStats)
      .values(stats)
      .returning();
    return saved;
  }

  async getLatestStats(periodType: string): Promise<BacktestStats | null> {
    const [latest] = await db
      .select()
      .from(backtestStats)
      .where(eq(backtestStats.periodType, periodType))
      .orderBy(desc(backtestStats.createdAt))
      .limit(1);
    return latest || null;
  }

  async getStatsByDateRange(periodType: string, start: Date, end: Date): Promise<BacktestStats[]> {
    return await db
      .select()
      .from(backtestStats)
      .where(
        and(
          eq(backtestStats.periodType, periodType),
          gte(backtestStats.periodStart, start),
          lte(backtestStats.periodEnd, end)
        )
      )
      .orderBy(desc(backtestStats.periodEnd));
  }
}

export const storage = new DatabaseStorage();

import { db, isDatabaseAvailable } from "./db";
import {
  watchlistItems,
  signalSnapshots,
  backtestTrades,
  tradeEvents,
  equityCurve,
  backtestStats,
  comments,
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
  type Comment,
  type InsertComment,
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";

export interface IStorage {
  getWatchlist(): Promise<WatchlistItem[]>;
  addToWatchlist(item: InsertWatchlistItem): Promise<WatchlistItem>;
  removeFromWatchlist(id: number): Promise<void>;
  saveSignalSnapshot(snapshot: InsertSignalSnapshot): Promise<SignalSnapshot>;
  getSignalSnapshots(symbol?: string, limit?: number): Promise<SignalSnapshot[]>;
  createTrade(trade: InsertBacktestTrade): Promise<BacktestTrade>;
  getTrade(tradeId: string): Promise<BacktestTrade | null>;
  getActiveTrades(): Promise<BacktestTrade[]>;
  getAllTrades(limit?: number): Promise<BacktestTrade[]>;
  updateTrade(tradeId: string, updates: Partial<BacktestTrade>): Promise<BacktestTrade | null>;
  getTradesByDateRange(start: Date, end: Date): Promise<BacktestTrade[]>;
  addTradeEvent(event: InsertTradeEvent): Promise<TradeEvent>;
  getTradeEvents(tradeId: string): Promise<TradeEvent[]>;
  addEquityPoint(point: InsertEquityCurve): Promise<EquityCurvePoint>;
  getEquityCurve(limit?: number): Promise<EquityCurvePoint[]>;
  getLatestEquity(): Promise<EquityCurvePoint | null>;
  saveStats(stats: InsertBacktestStats): Promise<BacktestStats>;
  getLatestStats(periodType: string): Promise<BacktestStats | null>;
  getStatsByDateRange(periodType: string, start: Date, end: Date): Promise<BacktestStats[]>;
  addComment(comment: InsertComment): Promise<Comment>;
  getComments(limit?: number): Promise<Comment[]>;
  deleteComment(id: number): Promise<void>;
  isAvailable(): boolean;
}

export class MemoryStorage implements IStorage {
  private watchlist: WatchlistItem[] = [];
  private snapshots: SignalSnapshot[] = [];
  private trades: BacktestTrade[] = [];
  private events: TradeEvent[] = [];
  private equity: EquityCurvePoint[] = [];
  private stats: BacktestStats[] = [];
  private commentsList: Comment[] = [];
  private nextId = 1;

  isAvailable(): boolean {
    return true;
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    return this.watchlist;
  }

  async addToWatchlist(item: InsertWatchlistItem): Promise<WatchlistItem> {
    const newItem: WatchlistItem = { 
      id: this.nextId++, 
      symbol: item.symbol,
      notes: item.notes ?? null,
      createdAt: new Date()
    };
    this.watchlist.push(newItem);
    return newItem;
  }

  async removeFromWatchlist(id: number): Promise<void> {
    this.watchlist = this.watchlist.filter(w => w.id !== id);
  }

  async saveSignalSnapshot(snapshot: InsertSignalSnapshot): Promise<SignalSnapshot> {
    const saved: SignalSnapshot = { 
      id: this.nextId++, 
      symbol: snapshot.symbol,
      collectedAt: new Date(),
      entryPrice: snapshot.entryPrice,
      slPrice: snapshot.slPrice,
      tp1Price: snapshot.tp1Price,
      tp2Price: snapshot.tp2Price,
      tp3Price: snapshot.tp3Price,
      rsi: snapshot.rsi ?? null,
      volumeSpike: snapshot.volumeSpike ?? null,
      signalStrength: snapshot.signalStrength ?? null,
      metadata: snapshot.metadata ?? null,
      priceLocation: snapshot.priceLocation ?? null,
      preSpikeScore: snapshot.preSpikeScore ?? null,
      oiTrend: snapshot.oiTrend ?? null,
      marketPhase: snapshot.marketPhase ?? null,
    };
    this.snapshots.push(saved);
    if (this.snapshots.length > 1000) this.snapshots.shift();
    return saved;
  }

  async getSignalSnapshots(symbol?: string, limit: number = 100): Promise<SignalSnapshot[]> {
    let result = symbol ? this.snapshots.filter(s => s.symbol === symbol) : this.snapshots;
    return result.slice(-limit).reverse();
  }

  async createTrade(trade: InsertBacktestTrade): Promise<BacktestTrade> {
    const created: BacktestTrade = { 
      id: this.nextId++, 
      tradeId: trade.tradeId,
      symbol: trade.symbol,
      signalTimestamp: trade.signalTimestamp,
      entryTimestamp: trade.entryTimestamp ?? null,
      entryPrice: trade.entryPrice,
      currentSlPrice: trade.currentSlPrice,
      originalSlPrice: trade.originalSlPrice,
      tp1Price: trade.tp1Price,
      tp2Price: trade.tp2Price,
      tp3Price: trade.tp3Price,
      positionSize: trade.positionSize,
      capitalUsed: trade.capitalUsed,
      status: trade.status ?? "pending",
      tp1Hit: trade.tp1Hit ?? false,
      tp2Hit: trade.tp2Hit ?? false,
      tp3Hit: trade.tp3Hit ?? false,
      slHit: trade.slHit ?? false,
      exitTimestamp: trade.exitTimestamp ?? null,
      finalPnl: trade.finalPnl ?? null,
      rMultiple: trade.rMultiple ?? null,
      createdAt: new Date(),
    };
    this.trades.push(created);
    return created;
  }

  async getTrade(tradeId: string): Promise<BacktestTrade | null> {
    return this.trades.find(t => t.tradeId === tradeId) || null;
  }

  async getActiveTrades(): Promise<BacktestTrade[]> {
    return this.trades.filter(t => t.status === "active");
  }

  async getAllTrades(limit: number = 100): Promise<BacktestTrade[]> {
    return this.trades.slice(-limit).reverse();
  }

  async updateTrade(tradeId: string, updates: Partial<BacktestTrade>): Promise<BacktestTrade | null> {
    const idx = this.trades.findIndex(t => t.tradeId === tradeId);
    if (idx === -1) return null;
    this.trades[idx] = { ...this.trades[idx], ...updates };
    return this.trades[idx];
  }

  async getTradesByDateRange(start: Date, end: Date): Promise<BacktestTrade[]> {
    return this.trades.filter(t => t.signalTimestamp >= start && t.signalTimestamp <= end);
  }

  async addTradeEvent(event: InsertTradeEvent): Promise<TradeEvent> {
    const created: TradeEvent = { 
      id: this.nextId++,
      tradeId: event.tradeId,
      eventType: event.eventType,
      price: event.price,
      size: event.size ?? null,
      pnlDelta: event.pnlDelta ?? null,
      timestamp: new Date(),
    };
    this.events.push(created);
    return created;
  }

  async getTradeEvents(tradeId: string): Promise<TradeEvent[]> {
    return this.events.filter(e => e.tradeId === tradeId);
  }

  async addEquityPoint(point: InsertEquityCurve): Promise<EquityCurvePoint> {
    const created: EquityCurvePoint = { 
      id: this.nextId++,
      timestamp: new Date(),
      equity: point.equity,
      drawdown: point.drawdown,
      dailyPnl: point.dailyPnl ?? null,
    };
    this.equity.push(created);
    if (this.equity.length > 500) this.equity.shift();
    return created;
  }

  async getEquityCurve(limit: number = 100): Promise<EquityCurvePoint[]> {
    return this.equity.slice(-limit).reverse();
  }

  async getLatestEquity(): Promise<EquityCurvePoint | null> {
    return this.equity[this.equity.length - 1] || null;
  }

  async saveStats(statsData: InsertBacktestStats): Promise<BacktestStats> {
    const saved: BacktestStats = { 
      id: this.nextId++, 
      periodType: statsData.periodType,
      periodStart: statsData.periodStart,
      periodEnd: statsData.periodEnd,
      totalTrades: statsData.totalTrades,
      winningTrades: statsData.winningTrades,
      losingTrades: statsData.losingTrades,
      winRate: statsData.winRate,
      totalPnl: statsData.totalPnl,
      avgRMultiple: statsData.avgRMultiple ?? null,
      maxDrawdown: statsData.maxDrawdown ?? null,
      sharpeRatio: statsData.sharpeRatio ?? null,
      profitFactor: statsData.profitFactor ?? null,
      createdAt: new Date(),
    };
    this.stats.push(saved);
    return saved;
  }

  async getLatestStats(periodType: string): Promise<BacktestStats | null> {
    const filtered = this.stats.filter(s => s.periodType === periodType);
    return filtered[filtered.length - 1] || null;
  }

  async getStatsByDateRange(periodType: string, start: Date, end: Date): Promise<BacktestStats[]> {
    return this.stats.filter(s => 
      s.periodType === periodType && s.periodStart >= start && s.periodEnd <= end
    );
  }

  async addComment(comment: InsertComment): Promise<Comment> {
    const created: Comment = { 
      id: this.nextId++, 
      author: comment.author,
      content: comment.content,
      symbol: comment.symbol ?? null,
      createdAt: new Date(),
    };
    this.commentsList.push(created);
    if (this.commentsList.length > 200) this.commentsList.shift();
    return created;
  }

  async getComments(limit: number = 50): Promise<Comment[]> {
    return this.commentsList.slice(-limit).reverse();
  }

  async deleteComment(id: number): Promise<void> {
    this.commentsList = this.commentsList.filter(c => c.id !== id);
  }
}

export class DatabaseStorage implements IStorage {
  isAvailable(): boolean {
    return isDatabaseAvailable();
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    if (!db) return [];
    try {
      return await db.select().from(watchlistItems);
    } catch (err) {
      console.error('[DB] getWatchlist error:', err);
      return [];
    }
  }

  async addToWatchlist(item: InsertWatchlistItem): Promise<WatchlistItem> {
    if (!db) throw new Error('Database not available');
    const [newItem] = await db.insert(watchlistItems).values(item).returning();
    return newItem;
  }

  async removeFromWatchlist(id: number): Promise<void> {
    if (!db) return;
    await db.delete(watchlistItems).where(eq(watchlistItems.id, id));
  }

  async saveSignalSnapshot(snapshot: InsertSignalSnapshot): Promise<SignalSnapshot> {
    if (!db) throw new Error('Database not available');
    const [saved] = await db.insert(signalSnapshots).values(snapshot).returning();
    return saved;
  }

  async getSignalSnapshots(symbol?: string, limit: number = 100): Promise<SignalSnapshot[]> {
    if (!db) return [];
    try {
      if (symbol) {
        return await db.select().from(signalSnapshots)
          .where(eq(signalSnapshots.symbol, symbol))
          .orderBy(desc(signalSnapshots.collectedAt)).limit(limit);
      }
      return await db.select().from(signalSnapshots)
        .orderBy(desc(signalSnapshots.collectedAt)).limit(limit);
    } catch (err) {
      console.error('[DB] getSignalSnapshots error:', err);
      return [];
    }
  }

  async createTrade(trade: InsertBacktestTrade): Promise<BacktestTrade> {
    if (!db) throw new Error('Database not available');
    const [created] = await db.insert(backtestTrades).values(trade).returning();
    return created;
  }

  async getTrade(tradeId: string): Promise<BacktestTrade | null> {
    if (!db) return null;
    try {
      const [trade] = await db.select().from(backtestTrades)
        .where(eq(backtestTrades.tradeId, tradeId)).limit(1);
      return trade || null;
    } catch (err) {
      console.error('[DB] getTrade error:', err);
      return null;
    }
  }

  async getActiveTrades(): Promise<BacktestTrade[]> {
    if (!db) return [];
    try {
      return await db.select().from(backtestTrades).where(eq(backtestTrades.status, "active"));
    } catch (err) {
      console.error('[DB] getActiveTrades error:', err);
      return [];
    }
  }

  async getAllTrades(limit: number = 100): Promise<BacktestTrade[]> {
    if (!db) return [];
    try {
      return await db.select().from(backtestTrades)
        .orderBy(desc(backtestTrades.createdAt)).limit(limit);
    } catch (err) {
      console.error('[DB] getAllTrades error:', err);
      return [];
    }
  }

  async updateTrade(tradeId: string, updates: Partial<BacktestTrade>): Promise<BacktestTrade | null> {
    if (!db) return null;
    try {
      const [updated] = await db.update(backtestTrades).set(updates)
        .where(eq(backtestTrades.tradeId, tradeId)).returning();
      return updated || null;
    } catch (err) {
      console.error('[DB] updateTrade error:', err);
      return null;
    }
  }

  async getTradesByDateRange(start: Date, end: Date): Promise<BacktestTrade[]> {
    if (!db) return [];
    try {
      return await db.select().from(backtestTrades).where(
        and(gte(backtestTrades.signalTimestamp, start), lte(backtestTrades.signalTimestamp, end))
      ).orderBy(desc(backtestTrades.signalTimestamp));
    } catch (err) {
      console.error('[DB] getTradesByDateRange error:', err);
      return [];
    }
  }

  async addTradeEvent(event: InsertTradeEvent): Promise<TradeEvent> {
    if (!db) throw new Error('Database not available');
    const [created] = await db.insert(tradeEvents).values(event).returning();
    return created;
  }

  async getTradeEvents(tradeId: string): Promise<TradeEvent[]> {
    if (!db) return [];
    try {
      return await db.select().from(tradeEvents)
        .where(eq(tradeEvents.tradeId, tradeId)).orderBy(tradeEvents.timestamp);
    } catch (err) {
      console.error('[DB] getTradeEvents error:', err);
      return [];
    }
  }

  async addEquityPoint(point: InsertEquityCurve): Promise<EquityCurvePoint> {
    if (!db) throw new Error('Database not available');
    const [created] = await db.insert(equityCurve).values(point).returning();
    return created;
  }

  async getEquityCurve(limit: number = 100): Promise<EquityCurvePoint[]> {
    if (!db) return [];
    try {
      return await db.select().from(equityCurve)
        .orderBy(desc(equityCurve.timestamp)).limit(limit);
    } catch (err) {
      console.error('[DB] getEquityCurve error:', err);
      return [];
    }
  }

  async getLatestEquity(): Promise<EquityCurvePoint | null> {
    if (!db) return null;
    try {
      const [latest] = await db.select().from(equityCurve)
        .orderBy(desc(equityCurve.timestamp)).limit(1);
      return latest || null;
    } catch (err) {
      console.error('[DB] getLatestEquity error:', err);
      return null;
    }
  }

  async saveStats(stats: InsertBacktestStats): Promise<BacktestStats> {
    if (!db) throw new Error('Database not available');
    const [saved] = await db.insert(backtestStats).values(stats).returning();
    return saved;
  }

  async getLatestStats(periodType: string): Promise<BacktestStats | null> {
    if (!db) return null;
    try {
      const [latest] = await db.select().from(backtestStats)
        .where(eq(backtestStats.periodType, periodType))
        .orderBy(desc(backtestStats.createdAt)).limit(1);
      return latest || null;
    } catch (err) {
      console.error('[DB] getLatestStats error:', err);
      return null;
    }
  }

  async getStatsByDateRange(periodType: string, start: Date, end: Date): Promise<BacktestStats[]> {
    if (!db) return [];
    try {
      return await db.select().from(backtestStats).where(
        and(eq(backtestStats.periodType, periodType),
          gte(backtestStats.periodStart, start), lte(backtestStats.periodEnd, end))
      ).orderBy(desc(backtestStats.periodEnd));
    } catch (err) {
      console.error('[DB] getStatsByDateRange error:', err);
      return [];
    }
  }

  async addComment(comment: InsertComment): Promise<Comment> {
    if (!db) throw new Error('Database not available');
    const [created] = await db.insert(comments).values(comment).returning();
    return created;
  }

  async getComments(limit: number = 50): Promise<Comment[]> {
    if (!db) return [];
    try {
      return await db.select().from(comments)
        .orderBy(desc(comments.createdAt)).limit(limit);
    } catch (err) {
      console.error('[DB] getComments error:', err);
      return [];
    }
  }

  async deleteComment(id: number): Promise<void> {
    if (!db) return;
    await db.delete(comments).where(eq(comments.id, id));
  }
}

const dbStorage = new DatabaseStorage();
const memStorage = new MemoryStorage();

export function getStorage(): IStorage {
  return isDatabaseAvailable() ? dbStorage : memStorage;
}

export const storage = dbStorage;

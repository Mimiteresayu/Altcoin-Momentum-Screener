import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================
// WATCHLIST TABLE
// ============================================
export const watchlistItems = pgTable("watchlist_items", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWatchlistItemSchema = createInsertSchema(
  watchlistItems,
).omit({ id: true, createdAt: true });
export type InsertWatchlistItem = z.infer<typeof insertWatchlistItemSchema>;
export type WatchlistItem = typeof watchlistItems.$inferSelect;

// ============================================
// SIGNAL SNAPSHOTS TABLE (For backtesting)
// ============================================
export const signalSnapshots = pgTable("signal_snapshots", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  collectedAt: timestamp("collected_at").defaultNow(),
  entryPrice: real("entry_price").notNull(),
  slPrice: real("sl_price").notNull(),
  tp1Price: real("tp1_price").notNull(),
  tp2Price: real("tp2_price").notNull(),
  tp3Price: real("tp3_price").notNull(),
  rsi: real("rsi"),
  volumeSpike: real("volume_spike"),
  signalStrength: integer("signal_strength"),
  metadata: jsonb("metadata"),
  // New fields for enhanced signal analysis
  priceLocation: text("price_location"), // DISCOUNT, NEUTRAL, PREMIUM
  preSpikeScore: integer("pre_spike_score"), // 0-5 score
  oiTrend: text("oi_trend"), // RISING, FLAT, FALLING
  marketPhase: text("market_phase"), // ACCUMULATION, TREND, DISTRIBUTION, EXHAUST, NEUTRAL
});

export const insertSignalSnapshotSchema = createInsertSchema(
  signalSnapshots,
).omit({ id: true, collectedAt: true });
export type InsertSignalSnapshot = z.infer<typeof insertSignalSnapshotSchema>;
export type SignalSnapshot = typeof signalSnapshots.$inferSelect;

// ============================================
// BACKTEST TRADES TABLE
// ============================================
export const backtestTrades = pgTable("backtest_trades", {
  id: serial("id").primaryKey(),
  tradeId: text("trade_id").notNull().unique(),
  symbol: text("symbol").notNull(),
  signalTimestamp: timestamp("signal_timestamp").notNull(),
  entryTimestamp: timestamp("entry_timestamp"),
  entryPrice: real("entry_price").notNull(),
  currentSlPrice: real("current_sl_price").notNull(),
  originalSlPrice: real("original_sl_price").notNull(),
  tp1Price: real("tp1_price").notNull(),
  tp2Price: real("tp2_price").notNull(),
  tp3Price: real("tp3_price").notNull(),
  positionSize: real("position_size").notNull(),
  capitalUsed: real("capital_used").notNull(),
  status: text("status").notNull().default("pending"),
  tp1Hit: boolean("tp1_hit").default(false),
  tp2Hit: boolean("tp2_hit").default(false),
  tp3Hit: boolean("tp3_hit").default(false),
  slHit: boolean("sl_hit").default(false),
  exitTimestamp: timestamp("exit_timestamp"),
  finalPnl: real("final_pnl"),
  rMultiple: real("r_multiple"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBacktestTradeSchema = createInsertSchema(
  backtestTrades,
).omit({ id: true, createdAt: true });
export type InsertBacktestTrade = z.infer<typeof insertBacktestTradeSchema>;
export type BacktestTrade = typeof backtestTrades.$inferSelect;

// ============================================
// TRADE EVENTS TABLE
// ============================================
export const tradeEvents = pgTable("trade_events", {
  id: serial("id").primaryKey(),
  tradeId: text("trade_id").notNull(),
  eventType: text("event_type").notNull(),
  price: real("price").notNull(),
  size: real("size"),
  pnlDelta: real("pnl_delta"),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const insertTradeEventSchema = createInsertSchema(tradeEvents).omit({
  id: true,
  timestamp: true,
});
export type InsertTradeEvent = z.infer<typeof insertTradeEventSchema>;
export type TradeEvent = typeof tradeEvents.$inferSelect;

// ============================================
// EQUITY CURVE TABLE
// ============================================
export const equityCurve = pgTable("equity_curve", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp").defaultNow(),
  equity: real("equity").notNull(),
  drawdown: real("drawdown").notNull(),
  dailyPnl: real("daily_pnl"),
});

export const insertEquityCurveSchema = createInsertSchema(equityCurve).omit({
  id: true,
  timestamp: true,
});
export type InsertEquityCurve = z.infer<typeof insertEquityCurveSchema>;
export type EquityCurvePoint = typeof equityCurve.$inferSelect;

// ============================================
// BACKTEST STATS TABLE
// ============================================
export const backtestStats = pgTable("backtest_stats", {
  id: serial("id").primaryKey(),
  periodType: text("period_type").notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  totalTrades: integer("total_trades").notNull(),
  winningTrades: integer("winning_trades").notNull(),
  losingTrades: integer("losing_trades").notNull(),
  winRate: real("win_rate").notNull(),
  totalPnl: real("total_pnl").notNull(),
  avgRMultiple: real("avg_r_multiple"),
  maxDrawdown: real("max_drawdown"),
  sharpeRatio: real("sharpe_ratio"),
  profitFactor: real("profit_factor"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBacktestStatsSchema = createInsertSchema(backtestStats).omit(
  { id: true, createdAt: true },
);
export type InsertBacktestStats = z.infer<typeof insertBacktestStatsSchema>;
export type BacktestStats = typeof backtestStats.$inferSelect;

// ============================================
// SIGNAL TYPES (for real-time display)
// ============================================
export const leadingIndicatorsSchema = z.object({
  orderBookImbalance: z.number(),
  bidAskRatio: z.number(),
  hasFVG: z.boolean(),
  fvgLevel: z.number().nullable(),
  fvgType: z.enum(["bullish", "bearish"]).nullable(),
  hasOrderBlock: z.boolean(),
  obLevel: z.number().nullable(),
  obType: z.enum(["bullish", "bearish"]).nullable(),
  hasLiquidityZone: z.boolean(),
  liquidityLevel: z.number().nullable(),
  liquidityStrength: z.number(),
});

export type LeadingIndicators = z.infer<typeof leadingIndicatorsSchema>;

export const timeframeDataSchema = z.object({
  timeframe: z.string(),
  rsi: z.number(),
  volumeSpike: z.number(),
  priceChange: z.number(),
  confirmed: z.boolean(),
  swingLow: z.number(),
  swingHigh: z.number(),
});

export type TimeframeData = z.infer<typeof timeframeDataSchema>;

export const tpLevelSchema = z.object({
  label: z.string(),
  price: z.number(),
  pct: z.number(),
  reason: z.string(),
});

export type TPLevel = z.infer<typeof tpLevelSchema>;

export const signalSchema = z.object({
  symbol: z.string(),
  side: z.enum(["LONG", "SHORT"]), // Trade direction based on trend analysis
  currentPrice: z.number(),
  priceChange24h: z.number(),
  volumeSpikeRatio: z.number(),
  volAccel: z.number().optional(), // Volume acceleration: current1H / avg4H
  isAccelerating: z.boolean().optional(), // True if volAccel >= 2.0x
  oiChange24h: z.number().optional(), // Open Interest 24H change %
  hasVolAlert: z.boolean().optional(), // True if volume > 2.0x
  signalType: z.enum(["HOT", "ACTIVE", "PRE", "MAJOR"]).optional(), // Signal category (HOT = top priority)
  rsi: z.number(),
  entryPrice: z.number(),
  slPrice: z.number(),
  slDistancePct: z.number(),
  slReason: z.string(),
  tpLevels: z.array(tpLevelSchema),
  riskReward: z.number(),
  signalStrength: z.number(),
  strengthBreakdown: z.object({
    priceInRange: z.boolean(),
    volumeInRange: z.boolean(),
    rsiInRange: z.boolean(),
    rrInRange: z.boolean(),
    hasLeadingIndicators: z.boolean(),
  }),
  leadingIndicators: leadingIndicatorsSchema,
  timeframes: z.array(timeframeDataSchema),
  confirmedTimeframes: z.array(z.string()),
  isMajor: z.boolean(),
  firstSeenAt: z.string().optional(),
  timeOnListMinutes: z.number().optional(),
  spikeReadiness: z.enum(["warming", "primed", "hot", "overdue"]).optional(),
  liquidationLevels: z
    .array(
      z.object({
        price: z.number(),
        volume: z.number(),
        direction: z.string(),
      }),
    )
    .optional(),
  
  // Enhanced Screener Fields
  priceLocation: z.enum(["DISCOUNT", "NEUTRAL", "PREMIUM"]).optional(),
  marketPhase: z.enum(["ACCUMULATION", "DISTRIBUTION", "BREAKOUT", "EXHAUST", "UNKNOWN"]).optional(),
  preSpikeScore: z.number().min(0).max(5).optional(), // 0-5 composite score
  
  // Coinglass Data
  fundingRate: z.number().optional(),
  fundingBias: z.enum(["bullish", "bearish", "neutral"]).optional(),
  longShortRatio: z.number().optional(),
  lsrBias: z.enum(["long_dominant", "short_dominant", "balanced"]).optional(),
  
  // Price Levels
  fvgLevels: z.array(z.object({
    price: z.number(),
    type: z.enum(["bullish", "bearish"]),
    strength: z.number(),
  })).optional(),
  obLevels: z.array(z.object({
    price: z.number(),
    type: z.enum(["bullish", "bearish"]),
    strength: z.number(),
  })).optional(),
  
  // Liquidation Zones
  liquidationZones: z.object({
    nearestLongLiq: z.number().optional(),
    nearestShortLiq: z.number().optional(),
    longLiqDistance: z.number().optional(), // % distance from current price
    shortLiqDistance: z.number().optional(),
  }).optional(),
  
  // Storytelling
  storytelling: z.object({
    summary: z.string(),
    interpretation: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    actionSuggestion: z.string(),
  }).optional(),
});

export type Signal = z.infer<typeof signalSchema>;

export const signalResponseSchema = z.object({
  signals: z.array(signalSchema),
  lastUpdated: z.string(),
  nextUpdate: z.string(),
  updateFrequencyMinutes: z.number(),
});

export type SignalResponse = z.infer<typeof signalResponseSchema>;

// ============================================
// BACKTEST RESPONSE TYPES
// ============================================
export const backtestSummarySchema = z.object({
  totalCapital: z.number(),
  availableCapital: z.number(),
  totalTrades: z.number(),
  activeTrades: z.number(),
  closedTrades: z.number(),
  winningTrades: z.number(),
  losingTrades: z.number(),
  winRate: z.number(),
  totalPnl: z.number(),
  totalPnlPct: z.number(),
  avgRMultiple: z.number(),
  maxDrawdown: z.number(),
  sharpeRatio: z.number(),
  profitFactor: z.number(),
});

export type BacktestSummary = z.infer<typeof backtestSummarySchema>;

export const exitSchema = z.object({
  type: z.string(),
  price: z.number(),
  size: z.number(),
  pnl: z.number(),
  timestamp: z.string(),
});

export type Exit = z.infer<typeof exitSchema>;

export const tradeDisplaySchema = z.object({
  id: z.number(),
  tradeId: z.string(),
  symbol: z.string(),
  side: z.enum(["LONG", "SHORT"]).optional(), // Trade direction
  signalTimestamp: z.string(),
  entryTimestamp: z.string().nullable(),
  exitTimestamp: z.string().nullable(), // When trade was closed
  holdingTimeMinutes: z.number().nullable(), // Duration in minutes
  entryPrice: z.number(),
  currentSlPrice: z.number(),
  tp1Price: z.number(),
  tp2Price: z.number(),
  tp3Price: z.number(),
  positionSize: z.number(),
  capitalUsed: z.number(),
  status: z.string(),
  tp1Hit: z.boolean(),
  tp2Hit: z.boolean(),
  tp3Hit: z.boolean(),
  slHit: z.boolean(),
  finalPnl: z.number().nullable(),
  rMultiple: z.number().nullable(),
  exits: z.array(exitSchema),
  currentPrice: z.number().optional(),
  unrealizedPnl: z.number().optional(),
});

export type TradeDisplay = z.infer<typeof tradeDisplaySchema>;

// ============================================
// COMMENTS TABLE (For real-time discussion)
// ============================================
export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  author: text("author").notNull(),
  content: text("content").notNull(),
  symbol: text("symbol"), // Optional: tag a specific symbol
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCommentSchema = createInsertSchema(comments).omit({
  id: true,
  createdAt: true,
});
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type Comment = typeof comments.$inferSelect;

export const commentDisplaySchema = z.object({
  id: z.number(),
  author: z.string(),
  content: z.string(),
  symbol: z.string().nullable(),
  createdAt: z.string(),
});

export type CommentDisplay = z.infer<typeof commentDisplaySchema>;

// ============================================
// AUTOTRADE SETTINGS TABLE
// ============================================
export const autotradeSettings = pgTable("autotrade_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  maxPositions: integer("max_positions").notNull().default(3),
  riskPerTrade: real("risk_per_trade").notNull().default(1),
  leverage: integer("leverage").notNull().default(5),
  minSignalStrength: integer("min_signal_strength").notNull().default(4),
  allowedSymbols: text("allowed_symbols").array().default([]),
  blockedSymbols: text("blocked_symbols").array().default([]),
  stopLossPercent: real("stop_loss_percent").notNull().default(2),
  takeProfitPercent: real("take_profit_percent").notNull().default(6),
  trailingStopPercent: real("trailing_stop_percent").notNull().default(1.5),
  useTrailingStop: boolean("use_trailing_stop").notNull().default(true),
  onlyHotSignals: boolean("only_hot_signals").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAutotradeSettingsSchema = createInsertSchema(autotradeSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAutotradeSettings = z.infer<typeof insertAutotradeSettingsSchema>;
export type AutotradeSettings = typeof autotradeSettings.$inferSelect;

// ============================================
// AUTOTRADE TRADES TABLE
// ============================================
export const autotradeTrades = pgTable("autotrade_trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  quantity: real("quantity").notNull(),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),
  binanceOrderId: text("binance_order_id"),
  signalStrength: integer("signal_strength"),
  signalCategory: text("signal_category"),
  status: text("status").notNull().default("OPEN"),
  pnl: real("pnl"),
  pnlPercent: real("pnl_percent"),
  entryTime: timestamp("entry_time").notNull().defaultNow(),
  exitTime: timestamp("exit_time"),
  exitReason: text("exit_reason"),
});

export const insertAutotradeTradeSchema = createInsertSchema(autotradeTrades).omit({
  id: true,
});
export type InsertAutotradeTrade = z.infer<typeof insertAutotradeTradeSchema>;
export type AutotradeTrade = typeof autotradeTrades.$inferSelect;

import { pgTable, text, serial, integer, real, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const watchlistItems = pgTable("watchlist_items", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWatchlistItemSchema = createInsertSchema(watchlistItems).omit({ id: true, createdAt: true });
export type InsertWatchlistItem = z.infer<typeof insertWatchlistItemSchema>;
export type WatchlistItem = typeof watchlistItems.$inferSelect;

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
  currentPrice: z.number(),
  priceChange24h: z.number(),
  volumeSpikeRatio: z.number(),
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
});

export type Signal = z.infer<typeof signalSchema>;

export const signalResponseSchema = z.object({
  signals: z.array(signalSchema),
  lastUpdated: z.string(),
  nextUpdate: z.string(),
  updateFrequencyMinutes: z.number(),
});

export type SignalResponse = z.infer<typeof signalResponseSchema>;

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
  tpPrice: z.number(),
  tpDistancePct: z.number(),
  tpReason: z.string(),
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
});

export type Signal = z.infer<typeof signalSchema>;

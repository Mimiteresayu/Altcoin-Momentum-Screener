import { pgTable, text, serial, timestamp, doublePrecision, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===
export const watchlistItems = pgTable("watchlist_items", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWatchlistItemSchema = createInsertSchema(watchlistItems).omit({ 
  id: true, 
  createdAt: true 
});

// === EXPLICIT API CONTRACT TYPES ===

export const signalSchema = z.object({
  symbol: z.string(),
  currentPrice: z.number(),
  priceChange24h: z.number(),
  volumeSpikeRatio: z.number(),
  rsi: z.number(),
  entryPrice: z.number(),
  slPrice: z.number(),
  slDistancePct: z.number(),
  tpPrice: z.number(),
  tpDistancePct: z.number(),
  riskReward: z.number(),
  signalStrength: z.number(),
  timeframe: z.string(),
});

export type Signal = z.infer<typeof signalSchema>;
export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type InsertWatchlistItem = z.infer<typeof insertWatchlistItemSchema>;

export type SignalResponse = Signal[];

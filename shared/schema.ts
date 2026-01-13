import { pgTable, text, serial, timestamp, doublePrecision } from "drizzle-orm/pg-core";
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

export const tickerSchema = z.object({
  symbol: z.string(),
  lastPrice: z.number(),
  rsi: z.number(),
  volumeSpike: z.number(),
  priceChange: z.number(),
  high: z.number(),
  low: z.number(),
  volume: z.number(),
});

export type Ticker = z.infer<typeof tickerSchema>;
export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type InsertWatchlistItem = z.infer<typeof insertWatchlistItemSchema>;

export type TickerResponse = Ticker[];

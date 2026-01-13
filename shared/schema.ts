import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===
// We'll store simple watchlist items for now (optional feature)
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

// 1. Bitunix Ticker Data (External API shape)
export const tickerSchema = z.object({
  symbol: z.string(),
  markPrice: z.string(),
  lastPrice: z.string(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  baseVol: z.string(),
  quoteVol: z.string(),
});

export type Ticker = z.infer<typeof tickerSchema>;

// 2. Watchlist Types
export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type InsertWatchlistItem = z.infer<typeof insertWatchlistItemSchema>;

// Request types
export type CreateWatchlistItemRequest = InsertWatchlistItem;

// Response types
export type WatchlistResponse = WatchlistItem[];
export type TickerResponse = Ticker[];

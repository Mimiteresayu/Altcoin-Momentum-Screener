import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Proxy to Bitunix API
  app.get(api.tickers.list.path, async (req, res) => {
    try {
      // Fetching Futures Tickers
      const response = await fetch("https://fapi.bitunix.com/api/v1/futures/market/tickers");
      
      if (!response.ok) {
        throw new Error(`Bitunix API error: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.code === 0 && Array.isArray(data.data)) {
        res.json(data.data);
      } else {
        console.error("Invalid Bitunix response format:", data);
        res.status(500).json({ message: "Invalid response from exchange" });
      }
    } catch (error) {
      console.error("Failed to fetch tickers:", error);
      res.status(500).json({ message: "Failed to fetch market data" });
    }
  });

  // Watchlist Routes
  app.get(api.watchlist.list.path, async (req, res) => {
    const items = await storage.getWatchlist();
    res.json(items);
  });

  app.post(api.watchlist.create.path, async (req, res) => {
    try {
      const input = api.watchlist.create.input.parse(req.body);
      const item = await storage.addToWatchlist(input);
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.delete(api.watchlist.delete.path, async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid ID" });
    }
    await storage.removeFromWatchlist(id);
    res.status(204).send();
  });

  // Seed default watchlist if empty
  const watchlist = await storage.getWatchlist();
  if (watchlist.length === 0) {
    await storage.addToWatchlist({ symbol: "BTCUSDT", notes: "Bitcoin" });
    await storage.addToWatchlist({ symbol: "ETHUSDT", notes: "Ethereum" });
    await storage.addToWatchlist({ symbol: "SOLUSDT", notes: "Solana" });
  }

  return httpServer;
}

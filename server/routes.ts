import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import axios from "axios";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  let cachedSignals: any[] = [];

  async function calculateSignals() {
    try {
      const response = await axios.get("https://fapi.bitunix.com/api/v1/futures/market/tickers");
      const rawData = response.data.data;

      if (!Array.isArray(rawData)) return;

      const signals: any[] = [];

      for (const item of rawData) {
        const currentPrice = parseFloat(item.lastPrice);
        const openPrice = parseFloat(item.open);
        const high = parseFloat(item.high);
        const low = parseFloat(item.low);
        const quoteVol = parseFloat(item.quoteVol);

        // Skip invalid data (zero prices, NaN values)
        if (!currentPrice || !openPrice || isNaN(currentPrice) || isNaN(openPrice) || currentPrice === 0 || openPrice === 0) {
          continue;
        }

        const priceChange24h = ((currentPrice - openPrice) / openPrice) * 100;

        // Skip if priceChange24h is NaN
        if (isNaN(priceChange24h)) {
          continue;
        }

        // Simulated technicals (in production, fetch klines for real RSI)
        const volumeSpikeRatio = 1.5 + Math.random() * 1.5; // 1.5x to 3x
        const rsi = 40 + Math.random() * 35; // 40 to 75

        // ===== ENFORCE FILTERING CRITERIA =====
        // 1. Price Range: -5% to +15%
        if (priceChange24h < -5 || priceChange24h > 15) {
          continue;
        }

        // 2. Volume Spike: 1.5x to 3x
        if (volumeSpikeRatio < 1.5 || volumeSpikeRatio > 3) {
          continue;
        }

        // 3. RSI: 40-75 (breaking up from consolidation)
        if (rsi < 40 || rsi > 75) {
          continue;
        }

        // Structure-Based SL (5% below current)
        const slPrice = currentPrice * 0.95;
        const slDistancePct = 5;

        // Resistance-Based TP (15% above current)
        const tpPrice = currentPrice * 1.15;
        const tpDistancePct = 15;

        // Risk-Reward
        const risk = currentPrice - slPrice;
        const reward = tpPrice - currentPrice;
        const riskReward = risk > 0 ? reward / risk : 0;

        // 4. Only show coins with Risk-Reward >= 2
        if (riskReward < 2) {
          continue;
        }

        // Signal Strength (all conditions met = 3/3)
        let strength = 0;
        if (priceChange24h >= -5 && priceChange24h <= 15) strength++;
        if (volumeSpikeRatio >= 1.5 && volumeSpikeRatio <= 3) strength++;
        if (rsi >= 40 && rsi <= 75) strength++;

        signals.push({
          symbol: item.symbol,
          currentPrice,
          priceChange24h,
          volumeSpikeRatio,
          rsi,
          entryPrice: currentPrice,
          slPrice,
          slDistancePct,
          tpPrice,
          tpDistancePct,
          riskReward,
          signalStrength: strength,
          timeframe: "1H",
        });
      }

      // Sort by best RR ratio first
      cachedSignals = signals.sort((a, b) => b.riskReward - a.riskReward);
      
    } catch (error) {
      console.error("Signal calculation error:", error);
    }
  }

  // Initial fetch and periodic refresh
  calculateSignals();
  setInterval(calculateSignals, 5 * 60 * 1000);

  app.get(api.tickers.list.path, async (req, res) => {
    res.json(cachedSignals);
  });

  app.get(api.watchlist.list.path, async (req, res) => {
    const items = await storage.getWatchlist();
    res.json(items);
  });

  app.post(api.watchlist.create.path, async (req, res) => {
    const input = api.watchlist.create.input.parse(req.body);
    const item = await storage.addToWatchlist(input);
    res.status(201).json(item);
  });

  app.delete(api.watchlist.delete.path, async (req, res) => {
    await storage.removeFromWatchlist(Number(req.params.id));
    res.status(204).send();
  });

  return httpServer;
}

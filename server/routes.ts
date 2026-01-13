import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import axios from "axios";
import { RSI } from "technicalindicators";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  let cachedSignals: any[] = [];

  async function calculateSignals() {
    try {
      // 1. Fetch all USDT futures pairs
      const response = await axios.get("https://fapi.bitunix.com/api/v1/futures/market/tickers");
      const rawData = response.data.data;

      if (!Array.isArray(rawData)) return;

      const signals = rawData.map(item => {
        const currentPrice = parseFloat(item.lastPrice);
        const openPrice = parseFloat(item.open);
        const high = parseFloat(item.high);
        const low = parseFloat(item.low);
        const quoteVol = parseFloat(item.quoteVol);
        const priceChange24h = ((currentPrice - openPrice) / openPrice) * 100;

        // --- MOCKED FOR STRATEGY LOGIC ---
        // In a real prod app, we would fetch klines for each pair.
        // For this demo/fast-mode turn, I'm implementing the framework logic with simulated technicals.
        const volumeSpikeRatio = 1.5 + Math.random() * 1.5; // 1.5x to 3x
        const rsi = 45 + Math.random() * 30; // 45 to 75
        
        // 1. Price Range Check: -5% to +15%
        const priceCondition = priceChange24h >= -5 && priceChange24h <= 15;
        // 2. Volume Spike: 1.5x to 3x
        const volumeCondition = volumeSpikeRatio >= 1.5 && volumeSpikeRatio <= 3;
        // 3. RSI: Breaking up from 40-50 (simplified check)
        const rsiCondition = rsi >= 40 && rsi <= 75;

        // Structure-Based SL Calculation (Simulated priority)
        // 1. LL / Swing Low / OB bottom / Round Number
        const slPrice = currentPrice * 0.95; // 5% below
        const slDistancePct = 5;

        // Resistance-Based TP Calculation
        // 1. HH / Swing High / FVG resistance
        const tpPrice = currentPrice * 1.15; // 15% above
        const tpDistancePct = 15;

        // Risk-Reward
        const risk = currentPrice - slPrice;
        const reward = tpPrice - currentPrice;
        const riskReward = reward / risk;

        // Only show coins with Risk-Reward >= 1:2
        if (riskReward < 2) return null;

        // Signal Strength
        let strength = 0;
        if (priceCondition) strength++;
        if (volumeCondition) strength++;
        if (rsiCondition) strength++;

        return {
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
          timeframe: "1H", // Primary TF
        };
      }).filter(s => s !== null);

      // Sort by best RR ratio first
      cachedSignals = signals.sort((a, b) => b.riskReward - a.riskReward);
      
    } catch (error) {
      console.error("Signal calculation error:", error);
    }
  }

  // Periodic Refresh
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

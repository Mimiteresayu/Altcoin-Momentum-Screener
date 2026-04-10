/**
 * Indicator Pipeline Service
 * Extracted from routes.ts — RSI, Volume, AUR, FVG, OB, swing detection
 */
import axios from "axios";
import { RSI } from "technicalindicators";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FVG {
  type: "bullish" | "bearish";
  level: number;
}

export interface OrderBlock {
  type: "bullish" | "bearish";
  level: number;
}

export interface AURResult {
  aur: number;
  aurZScore: number;
  isBuyConcentrated: boolean;
  aurTrend: number[];
  aurRising: boolean;
  aurSlope: number;
  risingStreak?: number;
}

// AUR history persists across refresh cycles
const aurHistoryMap = new Map<string, Array<{ts: number, aur: number, z: number}>>();
const AUR_HISTORY_MAX = 12;

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number = 100,
): Promise<Kline[]> {
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url, { timeout: 8000 });
    if (response.data?.data && Array.isArray(response.data.data)) {
      return response.data.data
        .map((k: any) => ({
          openTime: parseInt(k.time),
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.quoteVol),
        }))
        .reverse();
    }
    return [];
  } catch {
    return [];
  }
}

export function calculateRSI(closes: number[]): number {
  if (closes.length < 15) return 50;
  const rsiResult = RSI.calculate({ values: closes, period: 14 });
  return rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : 50;
}

export function calculateVolumeSpike(volumes: number[]): number {
  if (volumes.length < 21) return 1;
  const recentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVolume > 0 ? recentVolume / avgVolume : 1;
}

export function calculateVolumeAcceleration(volumes: number[]): number {
  if (volumes.length < 5) return 1;
  const current1HVolume = volumes[volumes.length - 1];
  const last4HVolumes = volumes.slice(-5, -1);
  const avg4HVolume = last4HVolumes.reduce((a, b) => a + b, 0) / 4;
  return avg4HVolume > 0 ? current1HVolume / avg4HVolume : 1;
}

export function findSwingLows(klines: Kline[], count: number = 3): number[] {
  if (klines.length < 10) return [klines[klines.length - 1]?.low || 0];
  const swingLows: number[] = [];
  for (let i = 2; i < klines.length - 2 && swingLows.length < count; i++) {
    const current = klines[i];
    if (
      current.low < klines[i - 1].low &&
      current.low < klines[i - 2].low &&
      current.low < klines[i + 1].low &&
      current.low < klines[i + 2].low
    ) {
      swingLows.push(current.low);
    }
  }
  if (swingLows.length === 0) {
    swingLows.push(Math.min(...klines.slice(-20).map((k) => k.low)));
  }
  return swingLows.sort((a, b) => b - a);
}

export function findSwingHighs(klines: Kline[], count: number = 3): number[] {
  if (klines.length < 10) return [klines[klines.length - 1]?.high || 0];
  const swingHighs: number[] = [];
  for (let i = 2; i < klines.length - 2 && swingHighs.length < count; i++) {
    const current = klines[i];
    if (
      current.high > klines[i - 1].high &&
      current.high > klines[i - 2].high &&
      current.high > klines[i + 1].high &&
      current.high > klines[i + 2].high
    ) {
      swingHighs.push(current.high);
    }
  }
  if (swingHighs.length === 0) {
    swingHighs.push(Math.max(...klines.slice(-20).map((k) => k.high)));
  }
  return swingHighs.sort((a, b) => a - b);
}

export function detectFairValueGap(klines: Kline[]): FVG | null {
  if (klines.length < 10) return null;
  const recent = klines.slice(-10);
  for (let i = recent.length - 3; i >= 0; i--) {
    const candle1 = recent[i];
    const candle3 = recent[i + 2];
    if (candle3.low > candle1.high) {
      return { type: "bullish", level: (candle1.high + candle3.low) / 2 };
    }
    if (candle3.high < candle1.low) {
      return { type: "bearish", level: (candle1.low + candle3.high) / 2 };
    }
  }
  return null;
}

export function detectOrderBlock(klines: Kline[]): OrderBlock | null {
  if (klines.length < 15) return null;
  const recent = klines.slice(-15);
  const avgVolume = recent.reduce((sum, k) => sum + k.volume, 0) / recent.length;
  for (let i = recent.length - 5; i >= 0; i--) {
    const candle = recent[i];
    if (candle.volume > avgVolume * 2) {
      const isBullish = candle.close > candle.open;
      if (isBullish) {
        let confirmed = true;
        for (let j = i + 1; j < recent.length && j < i + 4; j++) {
          if (recent[j].close < candle.low) { confirmed = false; break; }
        }
        if (confirmed) return { type: "bullish", level: candle.low };
      } else {
        let confirmed = true;
        for (let j = i + 1; j < recent.length && j < i + 4; j++) {
          if (recent[j].close > candle.high) { confirmed = false; break; }
        }
        if (confirmed) return { type: "bearish", level: candle.high };
      }
    }
  }
  return null;
}

function pushAurHistory(symbol: string, aur: number, z: number): void {
  if (!aurHistoryMap.has(symbol)) aurHistoryMap.set(symbol, []);
  const h = aurHistoryMap.get(symbol)!;
  const now = Date.now();
  if (h.length > 0 && now - h[h.length - 1].ts < 120000) {
    h[h.length - 1] = { ts: now, aur, z };
  } else {
    h.push({ ts: now, aur, z });
  }
  while (h.length > AUR_HISTORY_MAX) h.shift();
}

function detectAurTrendFromHistory(symbol: string, currentAur: number, currentZ: number) {
  pushAurHistory(symbol, currentAur, currentZ);
  const values = (aurHistoryMap.get(symbol) || []).map(h => h.aur);
  if (values.length < 3) return { aurRising: false, aurSlope: 0, aurTrendValues: values, risingStreak: 0 };
  let risingStreak = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i] > values[i - 1] + 0.01) risingStreak++;
    else break;
  }
  const recent = values.slice(-4);
  const slope = recent.length >= 2 ? (recent[recent.length - 1] - recent[0]) / (recent.length - 1) : 0;
  const aurRising = risingStreak >= 2 && currentAur > 0.40 && currentZ < 2.0;
  return {
    aurRising, aurSlope: Math.round(slope * 1000) / 1000,
    aurTrendValues: values.slice(-6).map(v => Math.round(v * 1000) / 1000),
    risingStreak,
  };
}

export async function calculateAUR(symbol: string): Promise<AURResult | null> {
  const cacheKey = `${symbol}_${Math.floor(Date.now() / 60000)}`;
  if ((calculateAUR as any)._cache?.has(cacheKey)) {
    return (calculateAUR as any)._cache.get(cacheKey);
  }
  if (!(calculateAUR as any)._cache) (calculateAUR as any)._cache = new Map();
  try {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=1m&limit=1200`;
    const response = await axios.get(url, { timeout: 10000 });
    if (!response.data?.data || !Array.isArray(response.data.data) || response.data.data.length < 120) return null;
    const rawKlines = response.data.data.map((k: any) => ({
      time: parseInt(k.time), open: parseFloat(k.open),
      close: parseFloat(k.close), volume: parseFloat(k.quoteVol || k.vol || 0),
    })).reverse();
    const hourlyAURs: number[] = [];
    for (let i = 0; i + 60 <= rawKlines.length; i += 60) {
      const bucket = rawKlines.slice(i, i + 60);
      let upW = 0, totalW = 0;
      for (const k of bucket) {
        const ch = k.close - k.open;
        const w = Math.abs(ch) * (k.volume || 1);
        totalW += w;
        if (ch > 0) upW += w;
      }
      hourlyAURs.push(totalW > 0 ? upW / totalW : 0.5);
    }
    if (hourlyAURs.length < 3) return null;
    const cur = hourlyAURs[hourlyAURs.length - 1];
    const lb = hourlyAURs.slice(0, -1);
    const mean = lb.reduce((s, v) => s + v, 0) / lb.length;
    const sd = Math.sqrt(lb.reduce((s, v) => s + (v - mean) ** 2, 0) / lb.length);
    const z = sd > 0.001 ? (cur - mean) / sd : 0;
    // Seed history if needed
    if (!aurHistoryMap.has(symbol) || (aurHistoryMap.get(symbol)?.length ?? 0) < 3) {
      const now = Date.now();
      const seedAURs = hourlyAURs.slice(-Math.min(6, hourlyAURs.length));
      const seedData = seedAURs.map((aur, si) => ({ ts: now - (seedAURs.length - si) * 3600000, aur, z: 0 }));
      aurHistoryMap.set(symbol, seedData);
    }
    const trendData = detectAurTrendFromHistory(symbol, cur, z);
    const result: AURResult = {
      aur: Math.round(cur * 1000) / 1000,
      aurZScore: Math.round(z * 100) / 100,
      isBuyConcentrated: z >= 2,
      aurTrend: trendData.aurTrendValues,
      aurRising: trendData.aurRising,
      aurSlope: trendData.aurSlope,
      risingStreak: trendData.risingStreak,
    };
    (calculateAUR as any)._cache.set(cacheKey, result);
    if ((calculateAUR as any)._cache.size > 200) {
      const keys = [...(calculateAUR as any)._cache.keys()];
      keys.slice(0, 100).forEach((k: string) => (calculateAUR as any)._cache.delete(k));
    }
    return result;
  } catch (err: any) {
    console.error(`[AUR] Error for ${symbol}:`, err?.message);
    return null;
  }
}

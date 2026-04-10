/**
 * Open Interest Service
 * Extracted from routes.ts — OI fetching with CoinGlass V4 primary + Binance fallback
 */
import axios from "axios";

let oiDataCache: Map<string, number> = new Map();
let binanceOiHistory: Map<string, number> = new Map();
let oiLastFetched: Date | null = null;
let oiDataSource: "coinglass" | "binance" | null = null;
const OI_CACHE_DURATION_MS = 5 * 60 * 1000;

async function fetchBinanceOpenInterest(symbol: string): Promise<number | null> {
  try {
    const binanceSymbol = symbol.replace("USDC", "USDT");
    const response = await axios.get(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${binanceSymbol}`,
      { timeout: 5000 }
    );
    if (response.data?.openInterest) return parseFloat(response.data.openInterest);
    return null;
  } catch { return null; }
}

async function fetchCoinglassV4OpenInterest(symbols: string[]): Promise<Map<string, number>> {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) return new Map();
  const result = new Map<string, number>();
  const baseSymbols = [...new Set(
    symbols.filter(s => s.endsWith('USDT')).map(s => s.replace('USDT', '').toUpperCase())
  )].slice(0, 40);
  const BATCH_SIZE = 5;
  for (let i = 0; i < baseSymbols.length; i += BATCH_SIZE) {
    const batch = baseSymbols.slice(i, i + BATCH_SIZE);
    const requests = batch.map(async (base) => {
      try {
        const response = await axios.get(
          'https://open-api-v4.coinglass.com/api/futures/open-interest/exchange-list',
          { params: { symbol: base }, headers: { 'CG-API-KEY': apiKey }, timeout: 10000 }
        );
        if (String(response.data?.code) === '0' && Array.isArray(response.data?.data)) {
          const allRow = response.data.data.find((r: any) => r.exchange === 'All');
          if (allRow?.open_interest_change_percent_24h !== undefined) {
            const oiChange = parseFloat(allRow.open_interest_change_percent_24h);
            if (!isNaN(oiChange)) result.set(base + 'USDT', oiChange);
          }
        }
      } catch { /* skip */ }
    });
    await Promise.all(requests);
    if (i + BATCH_SIZE < baseSymbols.length) await new Promise(r => setTimeout(r, 400));
  }
  if (result.size > 0) console.log(`[OI] CoinGlass V4: ${result.size}/${baseSymbols.length} symbols`);
  return result;
}

export async function fetchOpenInterestWithBinanceFallback(
  symbols: string[]
): Promise<Map<string, number>> {
  // Return cached if fresh
  if (oiLastFetched && Date.now() - oiLastFetched.getTime() < OI_CACHE_DURATION_MS && oiDataCache.size > 0) {
    return oiDataCache;
  }

  // PRIORITY 1: CoinGlass V4
  if (process.env.COINGLASS_API_KEY) {
    try {
      const v4Data = await fetchCoinglassV4OpenInterest(symbols);
      if (v4Data.size > 0) {
        oiDataCache = v4Data;
        oiLastFetched = new Date();
        oiDataSource = "coinglass";
        return v4Data;
      }
    } catch (error: any) {
      console.log(`[OI] CoinGlass V4 failed: ${error?.message}`);
    }
  }

  // FALLBACK: Binance free API
  const isFirstFetch = binanceOiHistory.size === 0;
  const newCache = new Map<string, number>(oiDataCache);
  const prioritySymbols = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
    "BNBUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  ];
  const allSyms = [...prioritySymbols, ...symbols.filter(s => s.endsWith("USDT"))];
  const symbolsToFetch = Array.from(new Set(allSyms)).slice(0, 30);
  let fetchedCount = 0, deltaCount = 0;

  for (const symbol of symbolsToFetch) {
    try {
      const currentOI = await fetchBinanceOpenInterest(symbol);
      if (currentOI !== null) {
        fetchedCount++;
        const prevOI = binanceOiHistory.get(symbol);
        if (prevOI !== undefined && prevOI > 0) {
          newCache.set(symbol, ((currentOI - prevOI) / prevOI) * 100);
          deltaCount++;
        } else if (!isFirstFetch) {
          newCache.set(symbol, 0);
        }
        binanceOiHistory.set(symbol, currentOI);
      }
      await new Promise(r => setTimeout(r, 80));
    } catch { /* skip */ }
  }

  if (fetchedCount > 0) {
    oiDataCache = newCache;
    oiLastFetched = new Date();
    oiDataSource = "binance";
    console.log(`[OI] Binance: ${deltaCount}/${fetchedCount} symbols with OI delta`);
  }
  return oiDataCache;
}

export function getOiDataSource(): string | null {
  return oiDataSource;
}

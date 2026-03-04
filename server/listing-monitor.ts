/**
 * listing-monitor.ts — Dynamic new listing detection for Binance Futures + Upbit Korea
 * 
 * Replaces hardcoded KNOWN_LISTING_DATES with dynamic detection.
 * Polls APIs and caches results. New listings auto-included in universe for 7 days.
 */

// Cache structure: symbol -> first-seen timestamp
const binanceListingCache: Map<string, number> = new Map();
const upbitListingCache: Map<string, number> = new Map();

// Known symbols cache (for diff detection)
let lastKnownBinanceSymbols: Set<string> = new Set();
let lastKnownUpbitMarkets: Set<string> = new Set();

// Fetch timestamps
let lastBinanceFetch = 0;
let lastUpbitFetch = 0;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes between API calls
const NEW_LISTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Fetches current Binance USDⓈ-M futures symbols from exchangeInfo.
 * Compares to cached list to detect newly appeared symbols.
 * Returns a Set of symbols that are < 7 days old.
 */
export async function getNewFuturesListings(): Promise<Set<string>> {
  const now = Date.now();
  
  // Rate limit: don't fetch more than once per 5 minutes
  if (now - lastBinanceFetch < CACHE_TTL_MS && lastKnownBinanceSymbols.size > 0) {
    return getRecentFromCache(binanceListingCache);
  }

  try {
    const resp = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', {
      headers: { 'User-Agent': 'Giiq-Screener/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!resp.ok) {
      console.warn(`[LISTING-MONITOR] Binance exchangeInfo returned ${resp.status}`);
      return getRecentFromCache(binanceListingCache);
    }

    const data = await resp.json() as { symbols: Array<{ symbol: string; status: string; onboardDate?: number }> };
    const currentSymbols = new Set<string>();

    for (const sym of data.symbols) {
      if (!sym.symbol.endsWith('USDT')) continue;
      if (sym.status !== 'TRADING') continue;
      currentSymbols.add(sym.symbol);

      // If symbol has onboardDate, use it directly
      if (sym.onboardDate && !binanceListingCache.has(sym.symbol)) {
        binanceListingCache.set(sym.symbol, sym.onboardDate);
      }

      // Diff detection: if symbol is new (not in our last known set)
      if (lastKnownBinanceSymbols.size > 0 && !lastKnownBinanceSymbols.has(sym.symbol)) {
        if (!binanceListingCache.has(sym.symbol)) {
          binanceListingCache.set(sym.symbol, now);
          console.log(`[LISTING-MONITOR] NEW Binance futures detected: ${sym.symbol}`);
        }
      }
    }

    lastKnownBinanceSymbols = currentSymbols;
    lastBinanceFetch = now;

    return getRecentFromCache(binanceListingCache);
  } catch (err) {
    console.warn('[LISTING-MONITOR] Binance exchangeInfo fetch failed:', (err as Error).message);
    return getRecentFromCache(binanceListingCache);
  }
}

/**
 * Fetches all Upbit markets and detects new KRW listings.
 * Cross-references with Binance futures to find tradeable pairs.
 * Returns Set of "XYZUSDT" symbols that are new on Korea exchanges.
 */
export async function getUpbitNewListings(): Promise<Set<string>> {
  const now = Date.now();

  if (now - lastUpbitFetch < CACHE_TTL_MS && lastKnownUpbitMarkets.size > 0) {
    return getRecentFromCache(upbitListingCache);
  }

  try {
    const resp = await fetch('https://api.upbit.com/v1/market/all?is_details=true', {
      headers: { 'User-Agent': 'Giiq-Screener/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.warn(`[LISTING-MONITOR] Upbit market/all returned ${resp.status}`);
      return getRecentFromCache(upbitListingCache);
    }

    const markets = await resp.json() as Array<{
      market: string;
      korean_name: string;
      english_name: string;
      market_event?: {
        warning: boolean;
        caution?: { TRADING_VOLUME_SOARING?: boolean; GLOBAL_PRICE_DIFFERENCES?: boolean; DEPOSIT_AMOUNT_SOARING?: boolean };
      };
    }>;

    const currentUpbitKRW = new Set<string>();
    
    for (const m of markets) {
      if (!m.market.startsWith('KRW-')) continue;
      currentUpbitKRW.add(m.market);
      
      // Diff detection: new KRW listing
      if (lastKnownUpbitMarkets.size > 0 && !lastKnownUpbitMarkets.has(m.market)) {
        // Convert KRW-XYZ to XYZUSDT format
        const base = m.market.replace('KRW-', '');
        const usdtSymbol = `${base}USDT`;
        
        if (!upbitListingCache.has(usdtSymbol)) {
          upbitListingCache.set(usdtSymbol, now);
          console.log(`[LISTING-MONITOR] NEW Korea listing detected: ${m.market} → ${usdtSymbol}`);
          
          // Log if volume soaring or kimchi premium
          if (m.market_event?.caution?.TRADING_VOLUME_SOARING) {
            console.log(`[LISTING-MONITOR] 🔥 ${usdtSymbol} has TRADING_VOLUME_SOARING on Upbit`);
          }
          if (m.market_event?.caution?.GLOBAL_PRICE_DIFFERENCES) {
            console.log(`[LISTING-MONITOR] 🇰🇷 ${usdtSymbol} has KIMCHI PREMIUM on Upbit`);
          }
        }
      }
    }

    lastKnownUpbitMarkets = currentUpbitKRW;
    lastUpbitFetch = now;

    return getRecentFromCache(upbitListingCache);
  } catch (err) {
    console.warn('[LISTING-MONITOR] Upbit fetch failed:', (err as Error).message);
    return getRecentFromCache(upbitListingCache);
  }
}

/**
 * Helper: get symbols from cache that are less than 7 days old
 */
function getRecentFromCache(cache: Map<string, number>): Set<string> {
  const now = Date.now();
  const recent = new Set<string>();
  
  for (const [symbol, firstSeen] of cache) {
    if (now - firstSeen < NEW_LISTING_WINDOW_MS) {
      recent.add(symbol);
    }
  }
  
  return recent;
}

/**
 * Get all new listings (Binance + Upbit combined) with metadata
 */
export async function getAllNewListings(): Promise<Map<string, { source: string; firstSeen: number; daysSinceListing: number }>> {
  const result = new Map<string, { source: string; firstSeen: number; daysSinceListing: number }>();
  const now = Date.now();

  for (const [symbol, firstSeen] of binanceListingCache) {
    if (now - firstSeen < NEW_LISTING_WINDOW_MS) {
      result.set(symbol, {
        source: 'BINANCE_NEW',
        firstSeen,
        daysSinceListing: Math.floor((now - firstSeen) / (24 * 60 * 60 * 1000)),
      });
    }
  }

  for (const [symbol, firstSeen] of upbitListingCache) {
    if (now - firstSeen < NEW_LISTING_WINDOW_MS) {
      if (!result.has(symbol)) {
        result.set(symbol, {
          source: 'KOREA_NEW',
          firstSeen,
          daysSinceListing: Math.floor((now - firstSeen) / (24 * 60 * 60 * 1000)),
        });
      }
    }
  }

  return result;
}

/**
 * Get dynamic listing age for a symbol (replaces hardcoded KNOWN_LISTING_DATES)
 */
export function getDynamicListingAge(symbol: string): number | undefined {
  const now = Date.now();
  
  // Check Binance cache first
  const binanceDate = binanceListingCache.get(symbol);
  if (binanceDate) {
    return Math.floor((now - binanceDate) / (24 * 60 * 60 * 1000));
  }

  // Check Upbit cache
  const upbitDate = upbitListingCache.get(symbol);
  if (upbitDate) {
    return Math.floor((now - upbitDate) / (24 * 60 * 60 * 1000));
  }

  return undefined;
}

/**
 * listing-monitor.ts — Dynamic new listing detection for Binance Futures + Upbit Korea
 *
 * Replaces hardcoded KNOWN_LISTING_DATES with dynamic detection.
 * - Binance: uses onboardDate from exchangeInfo (persistent across restarts)
 * - Upbit:   fetches KRW market list with caution flags (kimchi premium, volume soaring, etc.)
 * - New listings auto-included in universe for 7 days.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface KoreaAlphaData {
  isKoreaListed: boolean;
  volumeSoaring: boolean;
  kimchiPremium: boolean;    // GLOBAL_PRICE_DIFFERENCES flag
  depositSoaring: boolean;
  hasWarning: boolean;       // market_event.warning (general trading risk flag)
}

// ── Caches ───────────────────────────────────────────────────────────────────

/** symbol → onboardDate timestamp (ms). Persists across calls. */
const binanceListingCache: Map<string, number> = new Map();

/** symbol → first-seen timestamp (ms). Used only for Upbit new-listing tracking. */
const upbitListingCache: Map<string, number> = new Map();

/** Full Upbit Korea alpha data map. Refreshed on TTL. */
let upbitKoreaAlphaCache: Map<string, KoreaAlphaData> = new Map();

/** Full set of active Binance USDT perp symbols. Refreshed on TTL. */
let binanceFuturesSymbolsCache: Set<string> = new Set();

// ── Fetch timestamps ─────────────────────────────────────────────────────────

let lastBinanceFetch = 0;
let lastUpbitFetch = 0;
let lastBinanceSymbolsFetch = 0;

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;              // 5 minutes between API calls
const NEW_LISTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day new listing window

// ── Binance exchangeInfo type ─────────────────────────────────────────────────

interface BinanceExchangeSymbol {
  symbol: string;
  status: string;
  onboardDate?: number; // Unix timestamp in ms
}

interface BinanceExchangeInfo {
  symbols: BinanceExchangeSymbol[];
}

// ── Upbit market type ────────────────────────────────────────────────────────

interface UpbitMarket {
  market: string;
  korean_name: string;
  english_name: string;
  market_event?: {
    warning: boolean;
    caution?: {
      TRADING_VOLUME_SOARING?: boolean;
      GLOBAL_PRICE_DIFFERENCES?: boolean;
      DEPOSIT_AMOUNT_SOARING?: boolean;
    };
  };
}

// ── Binance: new futures listings via onboardDate ────────────────────────────

/**
 * Fetches current Binance USDⓈ-M futures symbols from exchangeInfo.
 * Uses `onboardDate` field directly — this is persistent and doesn't reset
 * on server restart, unlike diff-based detection.
 *
 * Returns a Set of XYZUSDT symbols whose onboardDate is within the last 7 days.
 */
export async function getNewFuturesListings(): Promise<Set<string>> {
  const now = Date.now();

  // Rate limit: don't fetch more than once per 5 minutes
  if (now - lastBinanceFetch < CACHE_TTL_MS && binanceFuturesSymbolsCache.size > 0) {
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

    const data = await resp.json() as BinanceExchangeInfo;
    const activeSymbols = new Set<string>();

    for (const sym of data.symbols) {
      if (!sym.symbol.endsWith('USDT')) continue;
      if (sym.status !== 'TRADING') continue;

      activeSymbols.add(sym.symbol);

      // PRIMARY: use onboardDate when present — survives restarts
      if (sym.onboardDate && sym.onboardDate > 0) {
        // Only store if not already cached, or if onboardDate is more precise
        if (!binanceListingCache.has(sym.symbol)) {
          binanceListingCache.set(sym.symbol, sym.onboardDate);
        }
      } else if (!binanceListingCache.has(sym.symbol)) {
        // Fallback: if no onboardDate available and symbol is brand new, record now
        // (Should be rare — Binance sets onboardDate on all modern listings)
        binanceListingCache.set(sym.symbol, now);
      }
    }

    // Log any symbols that appear new (onboardDate within last 24 hours)
    for (const sym of data.symbols) {
      if (!sym.symbol.endsWith('USDT') || sym.status !== 'TRADING') continue;
      const onboard = sym.onboardDate;
      if (onboard && now - onboard < 24 * 60 * 60 * 1000) {
        console.log(`[LISTING-MONITOR] NEW Binance futures (onboardDate ${new Date(onboard).toISOString()}): ${sym.symbol}`);
      }
    }

    binanceFuturesSymbolsCache = activeSymbols;
    lastBinanceFetch = now;

    return getRecentFromCache(binanceListingCache);
  } catch (err) {
    console.warn('[LISTING-MONITOR] Binance exchangeInfo fetch failed:', (err as Error).message);
    return getRecentFromCache(binanceListingCache);
  }
}

// ── Binance: full symbol set ─────────────────────────────────────────────────

/**
 * Returns a Set<string> of all active USDT perpetual symbols on Binance Futures.
 * Used by the routes layer (Priority 7) to find coins listed on Binance but not yet
 * on Bitunix.
 *
 * Cached with 5-minute TTL, shares the exchangeInfo fetch with getNewFuturesListings.
 */
export async function getBinanceFuturesSymbols(): Promise<Set<string>> {
  const now = Date.now();

  // If we fetched recently and have data, return cached set
  if (now - lastBinanceFetch < CACHE_TTL_MS && binanceFuturesSymbolsCache.size > 0) {
    return binanceFuturesSymbolsCache;
  }

  // Trigger a full refresh (this also populates binanceFuturesSymbolsCache)
  await getNewFuturesListings();
  return binanceFuturesSymbolsCache;
}

// ── Upbit: new KRW listings (diff-based, kept for backward compatibility) ────

/**
 * Fetches all Upbit markets and detects new KRW listings via diff detection.
 * Cross-references with Binance futures to find tradeable pairs.
 *
 * Returns Set of "XYZUSDT" symbols that are new on Upbit Korea (< 7 days).
 *
 * NOTE: For richer Korea signal data (kimchi premium, volume soaring flags), use
 * `getUpbitKoreaAlpha()` instead. This function is retained for backward compatibility.
 */
export async function getUpbitNewListings(): Promise<Set<string>> {
  const now = Date.now();

  if (now - lastUpbitFetch < CACHE_TTL_MS && upbitKoreaAlphaCache.size > 0) {
    return getRecentFromCache(upbitListingCache);
  }

  // Trigger a full refresh (populates upbitKoreaAlphaCache and upbitListingCache)
  await getUpbitKoreaAlpha();
  return getRecentFromCache(upbitListingCache);
}

// ── Upbit: Korea alpha data with caution flags ────────────────────────────────

/**
 * Fetches all Upbit KRW markets with market_event caution flags.
 * Returns a Map<string, KoreaAlphaData> keyed by XYZUSDT symbol.
 *
 * Flags detected:
 *   - volumeSoaring:   TRADING_VOLUME_SOARING caution
 *   - kimchiPremium:   GLOBAL_PRICE_DIFFERENCES caution (price divergence from global)
 *   - depositSoaring:  DEPOSIT_AMOUNT_SOARING caution
 *   - hasWarning:      market_event.warning (general risk flag)
 *
 * Results are cached for 5 minutes.
 */
export async function getUpbitKoreaAlpha(): Promise<Map<string, KoreaAlphaData>> {
  const now = Date.now();

  if (now - lastUpbitFetch < CACHE_TTL_MS && upbitKoreaAlphaCache.size > 0) {
    return upbitKoreaAlphaCache;
  }

  try {
    const resp = await fetch('https://api.upbit.com/v1/market/all?is_details=true', {
      headers: { 'User-Agent': 'Giiq-Screener/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.warn(`[LISTING-MONITOR] Upbit market/all returned ${resp.status}`);
      return upbitKoreaAlphaCache; // return stale cache
    }

    const markets = await resp.json() as UpbitMarket[];
    const newAlphaMap = new Map<string, KoreaAlphaData>();
    const currentKRWMarkets = new Set<string>();

    for (const m of markets) {
      if (!m.market.startsWith('KRW-')) continue;

      currentKRWMarkets.add(m.market);

      // Convert KRW-XYZ → XYZUSDT
      const base = m.market.replace('KRW-', '');
      const usdtSymbol = `${base}USDT`;

      const volumeSoaring = m.market_event?.caution?.TRADING_VOLUME_SOARING === true;
      const kimchiPremium = m.market_event?.caution?.GLOBAL_PRICE_DIFFERENCES === true;
      const depositSoaring = m.market_event?.caution?.DEPOSIT_AMOUNT_SOARING === true;
      const hasWarning = m.market_event?.warning === true;

      newAlphaMap.set(usdtSymbol, {
        isKoreaListed: true,
        volumeSoaring,
        kimchiPremium,
        depositSoaring,
        hasWarning,
      });

      // Track listing time for new KRW markets (diff vs last known set)
      if (upbitKoreaAlphaCache.size > 0 && !upbitKoreaAlphaCache.has(usdtSymbol)) {
        // Brand new Korea listing
        upbitListingCache.set(usdtSymbol, now);
        console.log(`[LISTING-MONITOR] NEW Korea listing detected: ${m.market} → ${usdtSymbol}`);

        if (kimchiPremium) {
          console.log(`[LISTING-MONITOR] 🇰🇷 ${usdtSymbol} has KIMCHI PREMIUM on Upbit`);
        }
        if (volumeSoaring) {
          console.log(`[LISTING-MONITOR] 🔥 ${usdtSymbol} has TRADING_VOLUME_SOARING on Upbit`);
        }
      }

      // Log active caution flags for known symbols too
      if (kimchiPremium || volumeSoaring || depositSoaring) {
        console.log(
          `[LISTING-MONITOR] ⚠️  ${usdtSymbol} Korea flags: ` +
          [kimchiPremium && 'KIMCHI_PREMIUM', volumeSoaring && 'VOL_SOARING', depositSoaring && 'DEPOSIT_SOARING']
            .filter(Boolean)
            .join(' | ')
        );
      }
    }

    upbitKoreaAlphaCache = newAlphaMap;
    lastUpbitFetch = now;

    return upbitKoreaAlphaCache;
  } catch (err) {
    console.warn('[LISTING-MONITOR] Upbit fetch failed:', (err as Error).message);
    return upbitKoreaAlphaCache; // return stale cache on error
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns symbols from a timestamp cache that are within the 7-day new listing window.
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

// ── Combined new listings (backward compat) ──────────────────────────────────

/**
 * Get all new listings (Binance + Upbit combined) with metadata.
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
 * Get dynamic listing age for a symbol (replaces hardcoded KNOWN_LISTING_DATES).
 * Checks Binance onboardDate cache first, then Upbit listing cache.
 */
export function getDynamicListingAge(symbol: string): number | undefined {
  const now = Date.now();

  // Check Binance onboardDate cache first
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

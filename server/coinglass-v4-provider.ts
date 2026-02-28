/**
 * coinglass-v4-provider.ts
 * CoinGlass V4 Data Provider for Giiq Trading Platform
 *
 * Replaces the broken V3 implementation with verified V4 endpoints.
 * Handles rate limiting (80 req/min), smart caching, retries with
 * exponential backoff, and full symbol mapping utilities.
 *
 * @module coinglass-v4-provider
 */

// Using native Node.js fetch (Node 18+)
type FetchResponse = Response;

// ─── Constants ──────────────────────────────────────────────────────────────

const COINGLASS_BASE_URL = 'https://open-api-v4.coinglass.com';
const API_KEY = process.env.COINGLASS_API_KEY ?? 'd4fc92ce5a584faaa1d4d7fa9f3cbdf3';

/** Max requests per minute per Startup plan */
const MAX_REQ_PER_MIN = 80;
/** Min delay between requests in ms (80/min ≈ 750ms) */
const MIN_REQ_INTERVAL_MS = Math.ceil(60_000 / MAX_REQ_PER_MIN);

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface ExchangeFundingRate {
  exchange: string;
  /** Funding rate as decimal, e.g. -0.004397 = -0.4397% */
  funding_rate: number;
  /** Interval in hours (1, 4, 8) */
  funding_rate_interval: number;
  /** Unix timestamp ms of next funding event */
  next_funding_time: number;
}

export interface FundingRateData {
  symbol: string;
  stablecoin_margin_list: ExchangeFundingRate[];
  /** Binance spot rate, convenience field */
  binanceFundingRate?: number;
  nextFundingTimeMs?: number;
  cachedAt: number;
}

export interface OIExchangeRow {
  exchange: string;
  open_interest_usd: number;
  open_interest_change_percent_5m: number;
  open_interest_change_percent_15m: number;
  open_interest_change_percent_30m: number;
  open_interest_change_percent_1h: number;
  open_interest_change_percent_4h: number;
  open_interest_change_percent_24h: number;
}

export interface OpenInterestData {
  symbol: string;
  /** Aggregate row (exchange === "All") */
  total: OIExchangeRow;
  exchanges: OIExchangeRow[];
  cachedAt: number;
}

export interface LiquidationCandle {
  time: number;
  aggregated_long_liquidation_usd: number;
  aggregated_short_liquidation_usd: number;
}

export interface LiquidationsData {
  symbol: string;
  latest: LiquidationCandle;
  cachedAt: number;
}

export interface LongShortRatioCandle {
  time: number;
  global_account_long_percent: number;
  global_account_short_percent: number;
  global_account_long_short_ratio: number;
}

export interface LongShortRatioData {
  symbol: string;
  latest: LongShortRatioCandle;
  cachedAt: number;
}

export interface TopTraderRatioCandle {
  time: number;
  top_account_long_percent: number;
  top_account_short_percent: number;
  top_account_long_short_ratio: number;
}

export interface TopTraderRatioData {
  symbol: string;
  latest: TopTraderRatioCandle;
  cachedAt: number;
}

export interface TakerVolumeCandle {
  time: number;
  taker_buy_volume_usd: number;
  taker_sell_volume_usd: number;
}

export interface TakerVolumeData {
  symbol: string;
  latest: TakerVolumeCandle;
  cachedAt: number;
}

/** Unified interface consumed by the screener */
export interface DataProvider {
  getFundingRate(symbol: string): Promise<FundingRateData | null>;
  getOpenInterest(symbol: string): Promise<OpenInterestData | null>;
  getLongShortRatio(symbol: string): Promise<LongShortRatioData | null>;
  getTopTraderRatio(symbol: string): Promise<TopTraderRatioData | null>;
  getLiquidations(symbol: string): Promise<LiquidationsData | null>;
  getTakerVolume(symbol: string): Promise<TakerVolumeData | null>;
}

interface CoinGlassResponse<T> {
  code: number | string;
  msg?: string;
  data: T;
}

// ─── Symbol Mapping Utilities ────────────────────────────────────────────────

/**
 * Convert a Bitunix pair (e.g. "BTCUSDT") to a CoinGlass base symbol (e.g. "BTC").
 * Used for: Open Interest, Funding Rate lookups.
 */
export function bitunixToBase(symbol: string): string {
  // Remove common quote currencies
  return symbol
    .replace(/USDT$/, '')
    .replace(/USDC$/, '')
    .replace(/BUSD$/, '')
    .replace(/USD$/, '');
}

/**
 * Convert a Bitunix pair (e.g. "BTCUSDT") to a CoinGlass pair format.
 * Used for: Long/Short Ratio, Top Trader Ratio, Taker Volume endpoints.
 * CoinGlass expects "BTCUSDT" (already correct for most Bitunix pairs).
 */
export function bitunixToCoinglassPair(symbol: string): string {
  // Ensure USDT suffix for CoinGlass pair format
  if (!symbol.endsWith('USDT') && !symbol.endsWith('USDC')) {
    return symbol + 'USDT';
  }
  return symbol;
}

/**
 * Dual mapping utility: returns both base and pair representations.
 */
export function bitunixToCoinglass(symbol: string): { base: string; pair: string } {
  const pair = bitunixToCoinglassPair(symbol);
  const base = bitunixToBase(pair);
  return { base, pair };
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter {
  private queue: Array<() => void> = [];
  private lastRequestTime = 0;
  private requestsThisMinute = 0;
  private minuteWindowStart = Date.now();
  private processing = false;

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const next = () => {
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }

      const now = Date.now();

      // Reset minute window
      if (now - this.minuteWindowStart >= 60_000) {
        this.requestsThisMinute = 0;
        this.minuteWindowStart = now;
      }

      // Hard cap per minute
      if (this.requestsThisMinute >= MAX_REQ_PER_MIN) {
        const waitUntilNextWindow = 60_000 - (now - this.minuteWindowStart) + 100;
        setTimeout(next, waitUntilNextWindow);
        return;
      }

      // Minimum spacing between requests
      const elapsed = now - this.lastRequestTime;
      const delay = Math.max(0, MIN_REQ_INTERVAL_MS - elapsed);

      setTimeout(() => {
        const resolver = this.queue.shift();
        if (resolver) {
          this.lastRequestTime = Date.now();
          this.requestsThisMinute++;
          resolver();
        }
        next();
      }, delay);
    };

    next();
  }
}

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class SimpleCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  set(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.log(`[CoinGlassV4] [INFO] ${new Date().toISOString()} ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[CoinGlassV4] [WARN] ${new Date().toISOString()} ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[CoinGlassV4] [ERROR] ${new Date().toISOString()} ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.DEBUG_COINGLASS === 'true') {
      console.debug(`[CoinGlassV4] [DEBUG] ${new Date().toISOString()} ${msg}`, ...args);
    }
  },
};

// ─── Main Provider Class ──────────────────────────────────────────────────────

/**
 * CoinGlass V4 Data Provider
 *
 * Usage:
 * ```ts
 * const provider = CoinGlassV4Provider.getInstance();
 * const funding = await provider.getFundingRate('BTCUSDT');
 * const oi = await provider.getOpenInterest('BTCUSDT');
 * ```
 */
export class CoinGlassV4Provider implements DataProvider {
  private static instance: CoinGlassV4Provider;
  private rateLimiter = new RateLimiter();

  // Cache TTLs
  private readonly FUNDING_CACHE_TTL = 5 * 60 * 1_000;   // 5 min — one call gets ALL coins
  private readonly OI_CACHE_TTL = 2 * 60 * 1_000;         // 2 min
  private readonly LS_CACHE_TTL = 2 * 60 * 1_000;         // 2 min
  private readonly LIQ_CACHE_TTL = 5 * 60 * 1_000;        // 5 min
  private readonly TAKER_CACHE_TTL = 2 * 60 * 1_000;      // 2 min

  private fundingCache = new SimpleCache<Map<string, FundingRateData>>();
  private oiCache = new SimpleCache<OpenInterestData>();
  private lsCache = new SimpleCache<LongShortRatioData>();
  private topTraderCache = new SimpleCache<TopTraderRatioData>();
  private liqCache = new SimpleCache<LiquidationsData>();
  private takerCache = new SimpleCache<TakerVolumeData>();

  /** Track in-flight funding rate fetch to avoid stampede */
  private fundingFetchPromise: Promise<Map<string, FundingRateData> | null> | null = null;

  private stats = {
    totalRequests: 0,
    cacheHits: 0,
    errors: 0,
    retries: 0,
  };

  private constructor() {}

  /** Singleton accessor */
  static getInstance(): CoinGlassV4Provider {
    if (!CoinGlassV4Provider.instance) {
      CoinGlassV4Provider.instance = new CoinGlassV4Provider();
    }
    return CoinGlassV4Provider.instance;
  }

  /** Returns a snapshot of request statistics */
  getStats() {
    return { ...this.stats };
  }

  // ─── Core HTTP Utility ────────────────────────────────────────────────────

  /**
   * Makes a rate-limited GET request to the CoinGlass V4 API.
   * Retries on 429 with exponential backoff (up to 3 retries).
   */
  private async cgFetch<T>(
    path: string,
    params?: Record<string, string | number>
  ): Promise<CoinGlassResponse<T>> {
    const url = new URL(`${COINGLASS_BASE_URL}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    }

    const endpoint = url.toString();
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.rateLimiter.acquire();
      this.stats.totalRequests++;

      try {
        logger.debug(`GET ${endpoint} (attempt ${attempt + 1})`);
        const res: FetchResponse = await fetch(endpoint, {
          headers: {
            'CG-API-KEY': API_KEY,
            'Content-Type': 'application/json',
          },
          // 10 second timeout
          signal: AbortSignal.timeout(10_000),
        });

        if (res.status === 429) {
          const retryAfterHeader = res.headers.get('Retry-After');
          const backoffMs = retryAfterHeader
            ? parseInt(retryAfterHeader, 10) * 1000
            : Math.pow(2, attempt) * 1000 + Math.random() * 500;

          logger.warn(`Rate limited on ${path}. Backing off ${backoffMs}ms (attempt ${attempt + 1})`);
          this.stats.retries++;
          await sleep(backoffMs);
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} for ${endpoint}`);
        }

        const json = (await res.json()) as CoinGlassResponse<T>;

        if (String(json.code) !== '0') {
          throw new Error(`CoinGlass API error code ${json.code}: ${json.msg ?? 'unknown'}`);
        }

        return json;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 500 + Math.random() * 300;
          logger.warn(
            `Request failed for ${path} (attempt ${attempt + 1}): ${lastError.message}. Retrying in ${backoffMs}ms`
          );
          this.stats.retries++;
          await sleep(backoffMs);
        }
      }
    }

    this.stats.errors++;
    logger.error(`All ${maxRetries + 1} attempts failed for ${path}: ${lastError?.message}`);
    throw lastError ?? new Error(`Failed to fetch ${path}`);
  }

  // ─── Funding Rate ─────────────────────────────────────────────────────────

  /**
   * Fetches all funding rates in ONE API call, caches the full map.
   * Returns the FundingRateData for the requested symbol.
   *
   * @param symbol - Bitunix pair (e.g. "BTCUSDT") or base (e.g. "BTC")
   */
  async getFundingRate(symbol: string): Promise<FundingRateData | null> {
    const base = bitunixToBase(symbol).toUpperCase();
    const CACHE_KEY = '__all_funding__';

    // Check if we have a valid cached map
    const cached = this.fundingCache.get(CACHE_KEY);
    if (cached) {
      this.stats.cacheHits++;
      return cached.get(base) ?? null;
    }

    // Prevent concurrent fetches (stampede protection)
    if (!this.fundingFetchPromise) {
      this.fundingFetchPromise = this.fetchAllFundingRates().finally(() => {
        this.fundingFetchPromise = null;
      });
    }

    const map = await this.fundingFetchPromise;
    if (!map) return null;

    return map.get(base) ?? null;
  }

  private async fetchAllFundingRates(): Promise<Map<string, FundingRateData> | null> {
    try {
      logger.info('Fetching ALL funding rates (single batch call)');
      type FRItem = { symbol: string; stablecoin_margin_list: ExchangeFundingRate[] };
      const res = await this.cgFetch<FRItem[]>(
        '/api/futures/funding-rate/exchange-list'
      );

      const map = new Map<string, FundingRateData>();
      const now = Date.now();

      for (const item of res.data) {
        const binanceRow = item.stablecoin_margin_list?.find(
          (e) => e.exchange.toLowerCase() === 'binance'
        );
        map.set(item.symbol.toUpperCase(), {
          symbol: item.symbol,
          stablecoin_margin_list: item.stablecoin_margin_list ?? [],
          binanceFundingRate: binanceRow?.funding_rate,
          nextFundingTimeMs: binanceRow?.next_funding_time,
          cachedAt: now,
        });
      }

      logger.info(`Funding rate cache populated with ${map.size} symbols`);
      this.fundingCache.set('__all_funding__', map, this.FUNDING_CACHE_TTL);
      return map;
    } catch (err) {
      logger.error('Failed to fetch all funding rates:', err);
      return null;
    }
  }

  // ─── Open Interest ────────────────────────────────────────────────────────

  /**
   * Get open interest for a symbol from CoinGlass.
   * Returns the aggregate "All" row plus per-exchange breakdown.
   *
   * @param symbol - Bitunix pair (BTCUSDT) or base (BTC)
   */
  async getOpenInterest(symbol: string): Promise<OpenInterestData | null> {
    const base = bitunixToBase(symbol).toUpperCase();
    const cacheKey = `oi:${base}`;

    const cached = this.oiCache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    try {
      const res = await this.cgFetch<OIExchangeRow[]>(
        '/api/futures/open-interest/exchange-list',
        { symbol: base }
      );

      const allRow = res.data.find((r) => r.exchange === 'All');
      if (!allRow) {
        logger.warn(`No "All" aggregate row in OI response for ${base}`);
        return null;
      }

      const data: OpenInterestData = {
        symbol: base,
        total: allRow,
        exchanges: res.data.filter((r) => r.exchange !== 'All'),
        cachedAt: Date.now(),
      };

      this.oiCache.set(cacheKey, data, this.OI_CACHE_TTL);
      return data;
    } catch (err) {
      logger.error(`Failed to fetch OI for ${base}:`, err);
      return null;
    }
  }

  // ─── Liquidations ─────────────────────────────────────────────────────────

  /**
   * Get latest 1h liquidation candle for a symbol.
   * Requires exchange_list=Binance per API spec.
   *
   * @param symbol - Bitunix pair (BTCUSDT) or base (BTC)
   */
  async getLiquidations(symbol: string): Promise<LiquidationsData | null> {
    const base = bitunixToBase(symbol).toUpperCase();
    const cacheKey = `liq:${base}`;

    const cached = this.liqCache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    try {
      const res = await this.cgFetch<LiquidationCandle[]>(
        '/api/futures/liquidation/aggregated-history',
        {
          symbol: base,
          interval: 'h1',
          limit: 1,
          exchange_list: 'Binance',
        }
      );

      if (!res.data || res.data.length === 0) {
        logger.warn(`No liquidation data for ${base}`);
        return null;
      }

      const data: LiquidationsData = {
        symbol: base,
        latest: res.data[0],
        cachedAt: Date.now(),
      };

      this.liqCache.set(cacheKey, data, this.LIQ_CACHE_TTL);
      return data;
    } catch (err) {
      logger.error(`Failed to fetch liquidations for ${base}:`, err);
      return null;
    }
  }

  // ─── Global Long/Short Ratio ──────────────────────────────────────────────

  /**
   * Get global long/short account ratio for a symbol.
   * IMPORTANT: CoinGlass requires PAIR format (BTCUSDT), NOT base (BTC).
   *
   * @param symbol - Bitunix pair (BTCUSDT) — will be converted to pair if needed
   */
  async getLongShortRatio(symbol: string): Promise<LongShortRatioData | null> {
    const pair = bitunixToCoinglassPair(symbol).toUpperCase();
    const cacheKey = `ls:${pair}`;

    const cached = this.lsCache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    try {
      const res = await this.cgFetch<LongShortRatioCandle[]>(
        '/api/futures/global-long-short-account-ratio/history',
        {
          exchange: 'Binance',
          symbol: pair,
          interval: 'h1',
          limit: 1,
        }
      );

      if (!res.data || res.data.length === 0) {
        logger.warn(`No L/S ratio data for ${pair}`);
        return null;
      }

      const data: LongShortRatioData = {
        symbol: pair,
        latest: res.data[0],
        cachedAt: Date.now(),
      };

      this.lsCache.set(cacheKey, data, this.LS_CACHE_TTL);
      return data;
    } catch (err) {
      logger.error(`Failed to fetch L/S ratio for ${pair}:`, err);
      return null;
    }
  }

  // ─── Top Trader L/S Ratio ─────────────────────────────────────────────────

  /**
   * Get top trader long/short account ratio.
   * Symbol must be PAIR format (BTCUSDT).
   *
   * @param symbol - Bitunix pair (BTCUSDT)
   */
  async getTopTraderRatio(symbol: string): Promise<TopTraderRatioData | null> {
    const pair = bitunixToCoinglassPair(symbol).toUpperCase();
    const cacheKey = `top:${pair}`;

    const cached = this.topTraderCache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    try {
      const res = await this.cgFetch<TopTraderRatioCandle[]>(
        '/api/futures/top-long-short-account-ratio/history',
        {
          exchange: 'Binance',
          symbol: pair,
          interval: 'h1',
          limit: 1,
        }
      );

      if (!res.data || res.data.length === 0) {
        logger.warn(`No top trader ratio data for ${pair}`);
        return null;
      }

      const data: TopTraderRatioData = {
        symbol: pair,
        latest: res.data[0],
        cachedAt: Date.now(),
      };

      this.topTraderCache.set(cacheKey, data, this.LS_CACHE_TTL);
      return data;
    } catch (err) {
      logger.error(`Failed to fetch top trader ratio for ${pair}:`, err);
      return null;
    }
  }

  // ─── Taker Buy/Sell Volume ────────────────────────────────────────────────

  /**
   * Get taker buy/sell volume for a symbol.
   * Symbol must be PAIR format (BTCUSDT).
   *
   * @param symbol - Bitunix pair (BTCUSDT)
   */
  async getTakerVolume(symbol: string): Promise<TakerVolumeData | null> {
    const pair = bitunixToCoinglassPair(symbol).toUpperCase();
    const cacheKey = `taker:${pair}`;

    const cached = this.takerCache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    try {
      const res = await this.cgFetch<TakerVolumeCandle[]>(
        '/api/futures/v2/taker-buy-sell-volume/history',
        {
          exchange: 'Binance',
          symbol: pair,
          interval: 'h1',
          limit: 1,
        }
      );

      if (!res.data || res.data.length === 0) {
        logger.warn(`No taker volume data for ${pair}`);
        return null;
      }

      const data: TakerVolumeData = {
        symbol: pair,
        latest: res.data[0],
        cachedAt: Date.now(),
      };

      this.takerCache.set(cacheKey, data, this.TAKER_CACHE_TTL);
      return data;
    } catch (err) {
      logger.error(`Failed to fetch taker volume for ${pair}:`, err);
      return null;
    }
  }

  // ─── Batch Fetcher ────────────────────────────────────────────────────────

  /**
   * Fetch all data types for a list of symbols concurrently (within rate limits).
   * Useful for the screener refresh cycle.
   *
   * @param symbols - Array of Bitunix pairs (e.g. ["BTCUSDT", "ETHUSDT"])
   */
  async batchFetchAll(symbols: string[]): Promise<
    Map<string, {
      funding: FundingRateData | null;
      oi: OpenInterestData | null;
      ls: LongShortRatioData | null;
      topTrader: TopTraderRatioData | null;
      liquidations: LiquidationsData | null;
      taker: TakerVolumeData | null;
    }>
  > {
    const results = new Map<string, {
      funding: FundingRateData | null;
      oi: OpenInterestData | null;
      ls: LongShortRatioData | null;
      topTrader: TopTraderRatioData | null;
      liquidations: LiquidationsData | null;
      taker: TakerVolumeData | null;
    }>();

    // Fetch funding rate for all in one call first
    await this.getFundingRate(symbols[0] ?? 'BTCUSDT');

    // Then fetch per-symbol data (rate limiter queues automatically)
    for (const sym of symbols) {
      const [oi, ls, topTrader, liquidations, taker, funding] = await Promise.all([
        this.getOpenInterest(sym),
        this.getLongShortRatio(sym),
        this.getTopTraderRatio(sym),
        this.getLiquidations(sym),
        this.getTakerVolume(sym),
        this.getFundingRate(sym),
      ]);

      results.set(sym, { funding, oi, ls, topTrader, liquidations, taker });
    }

    logger.info(
      `Batch fetch complete for ${symbols.length} symbols. Stats: ${JSON.stringify(this.getStats())}`
    );

    return results;
  }

  /** Flush all caches (useful for testing or forced refresh) */
  flushCaches(): void {
    this.fundingCache.clear();
    this.oiCache.clear();
    this.lsCache.clear();
    this.topTraderCache.clear();
    this.liqCache.clear();
    this.takerCache.clear();
    logger.info('All caches flushed');
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Default Export ───────────────────────────────────────────────────────────

export default CoinGlassV4Provider;

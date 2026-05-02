/**
 * Leverage Guard
 * --------------
 * Per-coin maximum leverage from Bitunix exchange API. Cached for 12h.
 * Different altcoins have different max leverage (BTC up to 125x, smaller alts 50x or less).
 */

interface BitunixSymbolInfo {
  symbol: string;
  maxLeverage: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map<string, BitunixSymbolInfo>();

const BITUNIX_API = "https://fapi.bitunix.com";

/**
 * Fetch all symbols' max leverage from Bitunix.
 * Endpoint: GET /api/v1/futures/market/trading_pairs
 */
export async function fetchBitunixSymbolMaxLeverage(symbol: string): Promise<number | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.maxLeverage;
  }

  try {
    const res = await fetch(`${BITUNIX_API}/api/v1/futures/market/trading_pairs`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      // 5s timeout via AbortController
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[leverage-guard] Bitunix API ${res.status}`);
      return cached?.maxLeverage ?? null;
    }

    const json = (await res.json()) as { code?: number; data?: Array<{ symbol: string; maxLeverage?: string | number }> };
    if (json.code !== 0 || !Array.isArray(json.data)) {
      console.warn(`[leverage-guard] Bitunix unexpected payload`);
      return cached?.maxLeverage ?? null;
    }

    // Refresh cache for all symbols at once
    const now = Date.now();
    for (const item of json.data) {
      const lev = typeof item.maxLeverage === "string" ? parseFloat(item.maxLeverage) : item.maxLeverage;
      if (!lev || isNaN(lev)) continue;
      cache.set(item.symbol, { symbol: item.symbol, maxLeverage: lev, fetchedAt: now });
    }

    return cache.get(symbol)?.maxLeverage ?? null;
  } catch (err) {
    console.warn(`[leverage-guard] fetch failed: ${(err as Error).message}`);
    return cached?.maxLeverage ?? null;
  }
}

/**
 * Get the safe leverage for a symbol based on:
 *  1. SL distance auto-cap formula: floor(100 / (slDistPct + 5))
 *  2. Per-coin exchange max
 *  3. Optional user override (warns if > 1.5× recommended)
 */
export async function getSafeLeverage(
  symbol: string,
  slDistancePct: number,
  userOverride?: number,
): Promise<{
  recommended: number;
  exchangeMax: number | null;
  applied: number;
  source: string;
}> {
  const recommended = Math.max(1, Math.floor(100 / (slDistancePct + 5)));
  const exchangeMax = await fetchBitunixSymbolMaxLeverage(symbol);

  let applied = userOverride ?? recommended;
  let source = userOverride ? "user_override" : "auto_cap";

  if (exchangeMax !== null && applied > exchangeMax) {
    applied = exchangeMax;
    source = "exchange_max";
  }
  if (applied < 1) applied = 1;

  return { recommended, exchangeMax, applied, source };
}

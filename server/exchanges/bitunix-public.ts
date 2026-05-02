/**
 * Bitunix public market data — no API key required.
 * --------------------------------------------------
 * Used by the cockpit pipeline (L3 funnel) so we don't depend on
 * Binance (geo-blocked from US-based servers like Railway) or
 * CoinGlass V4 (paid tier).
 *
 * Rate limit: 10 req/sec/ip per Bitunix open API doc.
 */

const BASE = "https://fapi.bitunix.com";

export interface BitunixFundingRate {
  symbol: string;
  fundingRate: number;       // decimal, e.g. -0.001445 = -0.1445%
  fundingInterval: number;   // hours
  nextFundingTime: number;   // unix ms
  markPrice: number;
  lastPrice: number;
}

/**
 * Get current funding rate for a Bitunix USDT-margined perpetual.
 * Returns null if the pair doesn't exist on Bitunix.
 */
export async function getBitunixFundingRate(symbol: string): Promise<BitunixFundingRate | null> {
  // Normalise: strip stray suffixes, ensure USDT
  const sym = symbol.toUpperCase().replace(/\.P$/, "").replace(/_/g, "");
  const pair = sym.endsWith("USDT") ? sym : `${sym}USDT`;
  try {
    const r = await fetch(`${BASE}/api/v1/futures/market/funding_rate?symbol=${pair}`, {
      headers: { "User-Agent": "altcoin-cockpit/1.0" },
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (j?.code !== 0 || !j?.data) return null;
    const d = j.data;
    return {
      symbol: d.symbol,
      fundingRate: parseFloat(d.fundingRate),
      fundingInterval: parseInt(d.fundingInterval, 10),
      nextFundingTime: parseInt(d.nextFundingTime, 10),
      markPrice: parseFloat(d.markPrice),
      lastPrice: parseFloat(d.lastPrice),
    };
  } catch {
    return null;
  }
}

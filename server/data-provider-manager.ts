/**
 * data-provider-manager.ts
 * 3-Tier Data Provider Chain: CoinGlass V4 → Coinalyze → Binance Free
 *
 * All OI, funding rate, and L/S ratio data for the screener flows through
 * this single manager. No direct CoinGlass / Binance calls elsewhere.
 *
 * Circuit breaker: after 5 consecutive failures on a provider, skip it for 5 min.
 */

import CoinGlassV4Provider from "./coinglass-v4-provider";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProviderData {
  fundingRate: number | null;
  openInterest: number | null;
  oiChange24h: number | null;
  longShortRatio: number | null;
  source: string; // which tier answered
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

interface CircuitBreaker {
  consecutiveFailures: number;
  openUntil: number; // unix ms — skip provider until this time
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

function isCircuitOpen(cb: CircuitBreaker): boolean {
  if (cb.consecutiveFailures < FAILURE_THRESHOLD) return false;
  return Date.now() < cb.openUntil;
}

function recordSuccess(cb: CircuitBreaker): void {
  cb.consecutiveFailures = 0;
}

function recordFailure(cb: CircuitBreaker): void {
  cb.consecutiveFailures++;
  if (cb.consecutiveFailures >= FAILURE_THRESHOLD) {
    cb.openUntil = Date.now() + OPEN_DURATION_MS;
    console.log(`[DataProvider] Circuit breaker OPEN — skipping provider for ${OPEN_DURATION_MS / 1000}s`);
  }
}

// ─── Tier 1: CoinGlass V4 ───────────────────────────────────────────────────

const cgV4Breaker: CircuitBreaker = { consecutiveFailures: 0, openUntil: 0 };

async function fetchFromCoinGlassV4(symbol: string): Promise<ProviderData | null> {
  if (!process.env.COINGLASS_API_KEY) return null;
  if (isCircuitOpen(cgV4Breaker)) return null;

  try {
    const provider = CoinGlassV4Provider.getInstance();
    const base = symbol.replace(/USDT$/, "").toUpperCase();

    const [frData, oiData, lsData] = await Promise.all([
      provider.getFundingRate(symbol).catch(() => null),
      provider.getOpenInterest(base).catch(() => null),
      provider.getLongShortRatio(symbol).catch(() => null),
    ]);

    // Require at least one data point
    const hasFunding = frData?.binanceFundingRate !== undefined;
    const hasOI = oiData?.total?.open_interest_usd !== undefined;
    const hasLS = lsData?.latest?.global_account_long_short_ratio !== undefined;

    if (!hasFunding && !hasOI && !hasLS) {
      recordFailure(cgV4Breaker);
      return null;
    }

    recordSuccess(cgV4Breaker);

    return {
      fundingRate: frData?.binanceFundingRate ?? null,
      openInterest: oiData?.total?.open_interest_usd ?? null,
      oiChange24h: oiData?.total?.open_interest_change_percent_24h ?? null,
      longShortRatio: lsData?.latest?.global_account_long_short_ratio ?? null,
      source: "coinglass-v4",
    };
  } catch (err) {
    recordFailure(cgV4Breaker);
    console.log(`[DataProvider] CoinGlass V4 failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

// ─── Tier 2: Coinalyze (free endpoints) ──────────────────────────────────────

const coinalyzeBreaker: CircuitBreaker = { consecutiveFailures: 0, openUntil: 0 };

async function fetchFromCoinalyze(symbol: string): Promise<ProviderData | null> {
  if (isCircuitOpen(coinalyzeBreaker)) return null;

  try {
    const pair = symbol.replace(/USDT$/, "").toUpperCase();
    // Coinalyze free API endpoints
    const baseUrl = "https://api.coinalyze.net/v1";

    const oiResp = await fetch(
      `${baseUrl}/open-interest?symbols=${pair}_USDT.A&convert_to_usd=true`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!oiResp.ok) {
      recordFailure(coinalyzeBreaker);
      return null;
    }

    const oiJson = (await oiResp.json()) as any[];
    if (!oiJson || oiJson.length === 0) {
      recordFailure(coinalyzeBreaker);
      return null;
    }

    recordSuccess(coinalyzeBreaker);

    const oiEntry = oiJson[0];
    return {
      fundingRate: null, // Coinalyze free doesn't provide funding
      openInterest: oiEntry?.value ?? null,
      oiChange24h: null, // Would need history to compute
      longShortRatio: null,
      source: "coinalyze",
    };
  } catch (err) {
    recordFailure(coinalyzeBreaker);
    console.log(`[DataProvider] Coinalyze failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

// ─── Tier 3: Binance Free ────────────────────────────────────────────────────

const binanceBreaker: CircuitBreaker = { consecutiveFailures: 0, openUntil: 0 };

async function fetchFromBinanceFree(symbol: string): Promise<ProviderData | null> {
  if (isCircuitOpen(binanceBreaker)) return null;

  try {
    const pair = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;

    const [frResp, oiResp, lsResp] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1`, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => null),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => null),
      fetch(
        `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=1h&limit=1`,
        { signal: AbortSignal.timeout(8000) }
      ).catch(() => null),
    ]);

    let fundingRate: number | null = null;
    let openInterest: number | null = null;
    let longShortRatio: number | null = null;

    if (frResp?.ok) {
      const frJson = (await frResp.json()) as any[];
      if (frJson && frJson.length > 0) {
        fundingRate = parseFloat(frJson[0].fundingRate);
        if (isNaN(fundingRate)) fundingRate = null;
      }
    }

    if (oiResp?.ok) {
      const oiJson = (await oiResp.json()) as any;
      if (oiJson?.openInterest) {
        openInterest = parseFloat(oiJson.openInterest);
        if (isNaN(openInterest)) openInterest = null;
      }
    }

    if (lsResp?.ok) {
      const lsJson = (await lsResp.json()) as any[];
      if (lsJson && lsJson.length > 0) {
        longShortRatio = parseFloat(lsJson[0].longShortRatio);
        if (isNaN(longShortRatio)) longShortRatio = null;
      }
    }

    if (fundingRate === null && openInterest === null && longShortRatio === null) {
      recordFailure(binanceBreaker);
      return null;
    }

    recordSuccess(binanceBreaker);

    return {
      fundingRate,
      openInterest,
      oiChange24h: null, // Binance free OI endpoint doesn't give change %
      longShortRatio,
      source: "binance-free",
    };
  } catch (err) {
    recordFailure(binanceBreaker);
    console.log(`[DataProvider] Binance free failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

// ─── DataProviderManager ─────────────────────────────────────────────────────

export class DataProviderManager {
  private static instance: DataProviderManager;

  private constructor() {}

  static getInstance(): DataProviderManager {
    if (!DataProviderManager.instance) {
      DataProviderManager.instance = new DataProviderManager();
    }
    return DataProviderManager.instance;
  }

  /**
   * Fetch OI, funding rate, and L/S ratio for a symbol.
   * Tries providers in order: CoinGlass V4 → Coinalyze → Binance Free.
   * Returns the first successful response.
   */
  async getData(symbol: string): Promise<ProviderData> {
    // Tier 1: CoinGlass V4
    const cgData = await fetchFromCoinGlassV4(symbol);
    if (cgData) return cgData;

    // Tier 2: Coinalyze
    const caData = await fetchFromCoinalyze(symbol);
    if (caData) return caData;

    // Tier 3: Binance Free
    const bnData = await fetchFromBinanceFree(symbol);
    if (bnData) return bnData;

    // All tiers failed — return empty
    return {
      fundingRate: null,
      openInterest: null,
      oiChange24h: null,
      longShortRatio: null,
      source: "none",
    };
  }

  /** Get circuit breaker status for diagnostics */
  getStatus(): {
    coinglass: { failures: number; open: boolean };
    coinalyze: { failures: number; open: boolean };
    binance: { failures: number; open: boolean };
  } {
    return {
      coinglass: {
        failures: cgV4Breaker.consecutiveFailures,
        open: isCircuitOpen(cgV4Breaker),
      },
      coinalyze: {
        failures: coinalyzeBreaker.consecutiveFailures,
        open: isCircuitOpen(coinalyzeBreaker),
      },
      binance: {
        failures: binanceBreaker.consecutiveFailures,
        open: isCircuitOpen(binanceBreaker),
      },
    };
  }
}

export default DataProviderManager;

import axios from "axios";
import * as crypto from "crypto";

const FUTURES_BASE_URL = "https://fapi.binance.com";

// Cache for symbol listing dates (symbol -> timestamp in ms)
const listingDateCache: Map<string, number> = new Map();

// Hardcoded listing dates for popular coins (timestamp in ms)
// These are approximate futures listing dates on major exchanges
const KNOWN_LISTING_DATES: Record<string, number> = {
  // Major coins (very old)
  "BTCUSDT": new Date("2017-08-17").getTime(),
  "ETHUSDT": new Date("2017-08-17").getTime(),
  // Established altcoins (2019-2020)
  "BNBUSDT": new Date("2019-09-06").getTime(),
  "XRPUSDT": new Date("2020-01-31").getTime(),
  "ADAUSDT": new Date("2020-03-16").getTime(),
  "DOGEUSDT": new Date("2021-04-15").getTime(),
  "SOLUSDT": new Date("2021-08-18").getTime(),
  "DOTUSDT": new Date("2020-08-18").getTime(),
  "LINKUSDT": new Date("2019-08-22").getTime(),
  "LTCUSDT": new Date("2019-06-28").getTime(),
  "BCHUSDT": new Date("2019-06-28").getTime(),
  "AVAXUSDT": new Date("2020-12-22").getTime(),
  "UNIUSDT": new Date("2020-09-17").getTime(),
  "FILUSDT": new Date("2020-10-15").getTime(),
  "AXSUSDT": new Date("2021-07-29").getTime(),
  "AAVEUSDT": new Date("2020-10-06").getTime(),
  "ICPUSDT": new Date("2021-05-10").getTime(),
  "NEARUSDT": new Date("2021-08-04").getTime(),
  "CHZUSDT": new Date("2021-07-08").getTime(),
  "CRVUSDT": new Date("2020-08-14").getTime(),
  "HBARUSDT": new Date("2021-03-23").getTime(),
  "SUIUSDT": new Date("2023-05-03").getTime(),
  "ENAUSDT": new Date("2024-04-02").getTime(),
  "WIFUSDT": new Date("2024-03-05").getTime(),
  "PEPEUSDT": new Date("2023-05-05").getTime(),
  "1000PEPEUSDT": new Date("2023-05-05").getTime(),
  "SHIBUSDT": new Date("2021-05-10").getTime(),
  "1000SHIBUSDT": new Date("2021-05-10").getTime(),
  "TAOUSDT": new Date("2024-04-08").getTime(),
  "ROSEUSDT": new Date("2021-08-31").getTime(),
  "PENDLEUSDT": new Date("2023-07-03").getTime(),
  "PENGUUSDT": new Date("2024-12-17").getTime(),
  "VIRTUALUSDT": new Date("2024-12-02").getTime(),
  "WLDUSDT": new Date("2023-07-24").getTime(),
  "ONDOUSDT": new Date("2024-01-18").getTime(),
  "ARBUSDT": new Date("2023-03-23").getTime(),
  "RENDERUSDT": new Date("2023-06-28").getTime(),
  "XVSUSDT": new Date("2021-01-27").getTime(),
  "AMBUSDT": new Date("2022-11-14").getTime(),
  "ARPAUSDT": new Date("2020-08-21").getTime(),
  // Additional coins from screener
  "XLMUSDT": new Date("2019-10-11").getTime(),
  "ATOMUSDT": new Date("2019-09-25").getTime(),
  "MATICUSDT": new Date("2020-10-22").getTime(),
  "SANDUSDT": new Date("2021-08-05").getTime(),
  "MANAUSDT": new Date("2021-08-05").getTime(),
  "GALAUSDT": new Date("2021-11-22").getTime(),
  "APTUSDT": new Date("2022-10-19").getTime(),
  "OPUSDT": new Date("2022-06-01").getTime(),
  "INJUSDT": new Date("2020-10-19").getTime(),
  "LDOUSDT": new Date("2022-08-17").getTime(),
  "STXUSDT": new Date("2021-10-06").getTime(),
  "IMXUSDT": new Date("2021-11-05").getTime(),
  "RUNEUSDT": new Date("2021-04-13").getTime(),
  "FLOKIUSDT": new Date("2023-03-08").getTime(),
  "FETUSDT": new Date("2019-04-08").getTime(),
  "AGIXUSDT": new Date("2023-04-12").getTime(),
  "OCEANUSDT": new Date("2020-07-09").getTime(),
  "GRTUSDT": new Date("2020-12-17").getTime(),
  "THETAUSDT": new Date("2019-05-28").getTime(),
  "EGLDUSDT": new Date("2020-09-03").getTime(),
  "FLOWUSDT": new Date("2021-03-25").getTime(),
  "ALGOUSDT": new Date("2020-08-19").getTime(),
  "XTZUSDT": new Date("2020-03-13").getTime(),
  "EOSUSDT": new Date("2019-04-25").getTime(),
  "MKRUSDT": new Date("2020-11-02").getTime(),
  "SNXUSDT": new Date("2020-08-10").getTime(),
  "COMPUSDT": new Date("2020-08-05").getTime(),
  "YFIUSDT": new Date("2020-09-14").getTime(),
  "SUSHIUSDT": new Date("2020-09-11").getTime(),
  "ZRXUSDT": new Date("2020-09-23").getTime(),
  "BATUSDT": new Date("2020-09-23").getTime(),
  "ENJUSDT": new Date("2020-10-22").getTime(),
  "ANKRUSDT": new Date("2020-12-01").getTime(),
  "COTIUSDT": new Date("2021-02-19").getTime(),
  "IOTAUSDT": new Date("2020-09-08").getTime(),
  "VETUSDT": new Date("2020-09-07").getTime(),
  "ZILUSDT": new Date("2020-07-30").getTime(),
  "KAVAUSDT": new Date("2020-09-03").getTime(),
  "KSMUSDT": new Date("2021-02-03").getTime(),
  "CELOUSDT": new Date("2021-04-07").getTime(),
  "ONEUSDT": new Date("2021-01-25").getTime(),
  "HOTUSDT": new Date("2021-02-05").getTime(),
  "IOTXUSDT": new Date("2021-07-01").getTime(),
  "SKLUSDT": new Date("2021-01-13").getTime(),
  "SCUSDT": new Date("2021-04-08").getTime(),
  "STORJUSDT": new Date("2021-01-27").getTime(),
  "CTSIUSDT": new Date("2021-01-21").getTime(),
  "SFPUSDT": new Date("2021-01-29").getTime(),
  "RVNUSDT": new Date("2021-04-29").getTime(),
  "DGBUSDT": new Date("2021-05-11").getTime(),
  "OMGUSDT": new Date("2020-09-07").getTime(),
  "WOOUSDT": new Date("2021-10-08").getTime(),
  "GMTUSDT": new Date("2022-03-09").getTime(),
  "APEUSDT": new Date("2022-03-17").getTime(),
  "JASMYUSDT": new Date("2022-04-27").getTime(),
  "MAGICUSDT": new Date("2023-01-18").getTime(),
  "BLURUSDT": new Date("2023-02-14").getTime(),
  "IDUSDT": new Date("2023-03-23").getTime(),
  "RADUSDT": new Date("2022-11-29").getTime(),
  "ORDIUSDT": new Date("2023-11-07").getTime(),
  "TIAUSDT": new Date("2023-10-31").getTime(),
  "JUPUSDT": new Date("2024-01-31").getTime(),
  "PYTHUSDT": new Date("2023-11-20").getTime(),
  "STRKUSDT": new Date("2024-02-20").getTime(),
  "PIXELUSDT": new Date("2024-02-19").getTime(),
  "DYMUSDT": new Date("2024-02-06").getTime(),
  "MANTAUSDT": new Date("2024-01-18").getTime(),
  "ALTUSDT": new Date("2024-01-17").getTime(),
  "XAIUSDT": new Date("2024-01-09").getTime(),
  "ACEUSDT": new Date("2023-12-14").getTime(),
  "NFPUSDT": new Date("2023-12-27").getTime(),
  "AIUSDT": new Date("2024-01-11").getTime(),
  "MEMEUSDT": new Date("2023-11-03").getTime(),
  "TOKENUSDT": new Date("2023-11-16").getTime(),
  "BONKUSDT": new Date("2023-12-07").getTime(),
  "1000BONKUSDT": new Date("2023-12-07").getTime(),
  "BOMEUSDT": new Date("2024-03-16").getTime(),
  "NOTUSDT": new Date("2024-05-16").getTime(),
  "IOUSDT": new Date("2024-06-11").getTime(),
  "ZKUSDT": new Date("2024-06-17").getTime(),
  "LISTAUSDT": new Date("2024-06-20").getTime(),
  "ZROUSDT": new Date("2024-06-20").getTime(),
  "BBUSDT": new Date("2024-06-21").getTime(),
  "POPCATUSDT": new Date("2024-09-04").getTime(),
  "SUNUSDT": new Date("2021-05-10").getTime(),
  "PEOPLEUSDT": new Date("2021-12-23").getTime(),
  "LQTYUSDT": new Date("2023-04-20").getTime(),
  "TRUUSDT": new Date("2021-05-18").getTime(),
  "RIFUSDT": new Date("2021-05-06").getTime(),
  "PORTALUSDT": new Date("2024-02-29").getTime(),
  "TONUSDT": new Date("2024-04-04").getTime(),
  "EIGENUSDT": new Date("2024-10-01").getTime(),
  "SCRUSDT": new Date("2024-10-09").getTime(),
  "HMSTRUSDT": new Date("2024-09-26").getTime(),
  "CATIUSDT": new Date("2024-09-20").getTime(),
  "NEIROETHUSDT": new Date("2024-09-06").getTime(),
  "NEIROUSDT": new Date("2024-09-16").getTime(),
  "TURBO": new Date("2024-09-10").getTime(),
  "TURBOUSDT": new Date("2024-09-10").getTime(),
  "GOATUSDT": new Date("2024-10-24").getTime(),
  "ACTUSDT": new Date("2024-11-11").getTime(),
  "PABORUSDT": new Date("2024-11-15").getTime(),
  "MOVEMENTUSDT": new Date("2024-12-09").getTime(),
  "MOVEUSDT": new Date("2024-12-09").getTime(),
  "MEUSDT": new Date("2024-12-10").getTime(),
  "VELODROMUSDT": new Date("2024-12-13").getTime(),
  "USUALUSDT": new Date("2024-12-18").getTime(),
  "BIOUSDT": new Date("2025-01-03").getTime(),
  "FARTCOINUSDT": new Date("2024-12-20").getTime(),
  "AI16ZUSDT": new Date("2025-01-07").getTime(),
  "HYPERUSDT": new Date("2024-12-16").getTime(),
  "HYPEUSDT": new Date("2024-11-29").getTime(),
  "GRIFFAINUSDT": new Date("2025-01-08").getTime(),
  "ORCAUSDT": new Date("2025-01-09").getTime(),
  "SWARMSUSDT": new Date("2025-01-10").getTime(),
  "ARCUSDT": new Date("2025-01-14").getTime(),
  "SONICUSDT": new Date("2025-01-07").getTime(),
  "PIPPINUSDT": new Date("2025-01-14").getTime(),
  "TRUMPUSDT": new Date("2025-01-18").getTime(),
  "MELANIAUSDT": new Date("2025-01-19").getTime(),
  "VINEUSDT": new Date("2025-01-20").getTime(),
  "ASTERUSDT": new Date("2025-01-23").getTime(),
  // New/meme coins (estimated recent)
  "CLANKERUSDT": new Date("2024-12-01").getTime(),
  "RVVUSDT": new Date("2024-12-15").getTime(),
  "BLUAIUSDT": new Date("2025-01-10").getTime(),
  "SOMIUSDT": new Date("2025-01-15").getTime(),
  "EDENUSDT": new Date("2025-01-10").getTime(),
};

/**
 * Get the first listing date for a symbol
 * Uses hardcoded known dates for popular coins as Binance API is geo-blocked
 * Results are cached to avoid repeated lookups
 */
export async function getSymbolListingDate(symbol: string): Promise<number | null> {
  // Check cache first
  const cachedDate = listingDateCache.get(symbol);
  if (cachedDate !== undefined) {
    return cachedDate;
  }

  // Check hardcoded known dates
  const knownDate = KNOWN_LISTING_DATES[symbol];
  if (knownDate) {
    listingDateCache.set(symbol, knownDate);
    const ageDays = Math.floor((Date.now() - knownDate) / (1000 * 60 * 60 * 24));
    console.log(`[LISTING] ${symbol}: ${ageDays} days old (from known dates)`);
    return knownDate;
  }

  // For unknown symbols, try fetching earliest kline from Bitunix
  try {
    const resp = await axios.get(
      `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=1d&limit=1000`,
      { timeout: 8000 }
    );
    if (resp.data?.data && Array.isArray(resp.data.data) && resp.data.data.length > 0) {
      const klines = resp.data.data;
      const oldestKline = klines[klines.length - 1];
      const ts = parseInt(oldestKline.time);
      const oldestTs = ts > 1e12 ? ts : ts * 1000;
      if (oldestTs > 0 && oldestTs < Date.now()) {
        listingDateCache.set(symbol, oldestTs);
        const ageDays = Math.floor((Date.now() - oldestTs) / (1000 * 60 * 60 * 24));
        console.log(`[LISTING] ${symbol}: ${ageDays} days old (from Bitunix kline)`);
        return oldestTs;
      }
    }
  } catch {
    console.log(`[LISTING] ${symbol}: Bitunix kline fetch failed`);
  }
  // Return null for unknown age instead of fake 180-day default
  listingDateCache.set(symbol, null);
  console.log(`[LISTING] ${symbol}: age unknown`);
  return null;
}

/**
 * Calculate the age in days since listing
 */
export function calculateAgeDays(listingTimestamp: number): number {
  return Math.floor((Date.now() - listingTimestamp) / (1000 * 60 * 60 * 24));
}

interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
}

interface OrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity?: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  closePosition?: boolean;
  positionSide?: "LONG" | "SHORT" | "BOTH";
}

interface Position {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: string;
  positionSide: "LONG" | "SHORT" | "BOTH";
}

interface AccountInfo {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
  positions: Position[];
}

interface OrderResult {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  type: string;
  side: string;
}

class BinanceService {
  private config: BinanceConfig | null = null;
  private baseUrl: string = FUTURES_BASE_URL;

  initialize() {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;

    if (!apiKey || !apiSecret) {
      console.log(
        "[BINANCE] API credentials not configured - autotrade disabled",
      );
      return false;
    }

    this.config = { apiKey, apiSecret };
    console.log("[BINANCE] Service initialized with API credentials");
    return true;
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  private getSignature(queryString: string): string {
    if (!this.config) throw new Error("Binance not configured");
    return crypto
      .createHmac("sha256", this.config.apiSecret)
      .update(queryString)
      .digest("hex");
  }

  private async signedRequest<T>(
    endpoint: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    if (!this.config) throw new Error("Binance not configured");

    const timestamp = Date.now();
    const allParams = { ...params, timestamp };

    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");

    const signature = this.getSignature(queryString);
    const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;

    console.log(`[BINANCE] ${method} ${endpoint}`);

    const response = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.config.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[BINANCE] Error: ${data.msg || JSON.stringify(data)}`);
      throw new Error(data.msg || "Binance API error");
    }

    return data as T;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const data = await this.signedRequest<any>("/fapi/v2/account");

    const positions = (data.positions || [])
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedProfit: parseFloat(p.unrealizedProfit),
        liquidationPrice: parseFloat(p.liquidationPrice),
        leverage: parseInt(p.leverage),
        marginType: p.marginType,
        positionSide: p.positionSide,
      }));

    return {
      totalWalletBalance: parseFloat(data.totalWalletBalance),
      totalUnrealizedProfit: parseFloat(data.totalUnrealizedProfit),
      totalMarginBalance: parseFloat(data.totalMarginBalance),
      availableBalance: parseFloat(data.availableBalance),
      positions,
    };
  }

  async getOpenPositions(): Promise<Position[]> {
    const data = await this.signedRequest<any[]>("/fapi/v2/positionRisk");

    return data
      .filter((p) => parseFloat(p.positionAmt) !== 0)
      .map((p) => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedProfit: parseFloat(p.unrealizedProfit),
        liquidationPrice: parseFloat(p.liquidationPrice),
        leverage: parseInt(p.leverage),
        marginType: p.marginType,
        positionSide: p.positionSide,
      }));
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const orderParams: Record<string, string | number | boolean> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
    };

    if (params.quantity) orderParams.quantity = params.quantity;
    if (params.price) orderParams.price = params.price;
    if (params.stopPrice) orderParams.stopPrice = params.stopPrice;
    if (params.reduceOnly) orderParams.reduceOnly = "true";
    if (params.closePosition) orderParams.closePosition = "true";
    if (params.positionSide) orderParams.positionSide = params.positionSide;

    return this.signedRequest<OrderResult>(
      "/fapi/v1/order",
      "POST",
      orderParams,
    );
  }

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
  ): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side,
      type: "MARKET",
      quantity,
    });
  }

  async placeStopLoss(
    symbol: string,
    side: "BUY" | "SELL",
    stopPrice: number,
  ): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side,
      type: "STOP_MARKET",
      stopPrice,
      closePosition: true,
    });
  }

  async placeTakeProfit(
    symbol: string,
    side: "BUY" | "SELL",
    stopPrice: number,
  ): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      stopPrice,
      closePosition: true,
    });
  }

  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    return this.signedRequest("/fapi/v1/order", "DELETE", {
      symbol,
      orderId,
    });
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    return this.signedRequest("/fapi/v1/allOpenOrders", "DELETE", { symbol });
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.signedRequest("/fapi/v1/openOrders", "GET", params);
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    return this.signedRequest("/fapi/v1/leverage", "POST", {
      symbol,
      leverage,
    });
  }

  async setMarginType(
    symbol: string,
    marginType: "ISOLATED" | "CROSSED",
  ): Promise<any> {
    try {
      return await this.signedRequest("/fapi/v1/marginType", "POST", {
        symbol,
        marginType,
      });
    } catch (error: any) {
      if (error.message?.includes("No need to change margin type")) {
        return { msg: "Margin type already set" };
      }
      throw error;
    }
  }

  async getSymbolPrice(symbol: string): Promise<number> {
    const response = await fetch(
      `${this.baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`,
    );
    const data = await response.json();
    return parseFloat(data.price);
  }

  async getExchangeInfo(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/fapi/v1/exchangeInfo`);
    return response.json();
  }

  async getSymbolInfo(symbol: string): Promise<any> {
    const info = await this.getExchangeInfo();
    return info.symbols?.find((s: any) => s.symbol === symbol);
  }

  calculateQuantity(
    balance: number,
    riskPercent: number,
    entryPrice: number,
    stopLossPrice: number,
    leverage: number = 1,
  ): number {
    const riskAmount = balance * (riskPercent / 100);
    const stopDistance = Math.abs(entryPrice - stopLossPrice) / entryPrice;
    const positionSize = riskAmount / stopDistance;
    const leveragedSize = positionSize * leverage;
    const quantity = leveragedSize / entryPrice;
    return Math.floor(quantity * 1000) / 1000;
  }
}

export const binanceService = new BinanceService();
export type { Position, AccountInfo, OrderResult, OrderParams };

// ============================================
// FREE Binance Futures Public API (No Auth Required)
// Priority: Use these FIRST before Coinglass
// ============================================

const BINANCE_FUTURES_PUBLIC = "https://fapi.binance.com";

export interface BinanceOIData {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface BinanceLongShortRatio {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

export interface BinanceFundingRate {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

// Get current Open Interest (FREE)
export async function getBinanceOpenInterest(
  symbol: string,
): Promise<BinanceOIData | null> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/fapi/v1/openInterest?symbol=${symbol}USDT`,
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Get Open Interest History (FREE - last 30 days)
export async function getBinanceOIHistory(
  symbol: string,
  period:
    | "5m"
    | "15m"
    | "30m"
    | "1h"
    | "2h"
    | "4h"
    | "6h"
    | "12h"
    | "1d" = "1h",
  limit: number = 30,
): Promise<any[]> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/futures/data/openInterestHist?symbol=${symbol}USDT&period=${period}&limit=${limit}`,
    );
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

// Get Long/Short Ratio (FREE)
export async function getBinanceLongShortRatio(
  symbol: string,
  period:
    | "5m"
    | "15m"
    | "30m"
    | "1h"
    | "2h"
    | "4h"
    | "6h"
    | "12h"
    | "1d" = "1h",
  limit: number = 30,
): Promise<BinanceLongShortRatio[]> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/futures/data/globalLongShortAccountRatio?symbol=${symbol}USDT&period=${period}&limit=${limit}`,
    );
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

// Get Top Trader Long/Short Ratio (FREE)
export async function getBinanceTopTraderRatio(
  symbol: string,
  period:
    | "5m"
    | "15m"
    | "30m"
    | "1h"
    | "2h"
    | "4h"
    | "6h"
    | "12h"
    | "1d" = "1h",
  limit: number = 30,
): Promise<any[]> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/futures/data/topLongShortPositionRatio?symbol=${symbol}USDT&period=${period}&limit=${limit}`,
    );
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

// Get Funding Rate (FREE)
export async function getBinanceFundingRate(
  symbol: string,
): Promise<
  
  
  BinanceFundingRate[]> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/fapi/v1/fundingRate?symbol=${symbol}USDT&limit=1`,
    );
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

// Get Taker Buy/Sell Volume (FREE)
export async function getBinanceTakerVolume(
  symbol: string,
  period:
    | "5m"
    | "15m"
    | "30m"
    | "1h"
    | "2h"
    | "4h"
    | "6h"
    | "12h"
    | "1d" = "1h",
  limit: number = 30,
): Promise<any[]> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/futures/data/takerlongshortRatio?symbol=${symbol}USDT&period=${period}&limit=${limit}`,
    );
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

// Combined function: Get all FREE market data for a symbol
export async function getBinanceFuturesData(symbol: string) {
  const [oi, oiHistory, lsRatio, topTrader, funding, takerVol] =
    await Promise.all([
      getBinanceOpenInterest(symbol),
      getBinanceOIHistory(symbol, "1h", 24),
      getBinanceLongShortRatio(symbol, "1h", 24),
      getBinanceTopTraderRatio(symbol, "1h", 24),
      getBinanceFundingRate(symbol),
      getBinanceTakerVolume(symbol, "1h", 24),
    ]);

  // Calculate OI change
  let oiChange24h = 0;
  if (oiHistory.length >= 2) {
    const latest = parseFloat(
      oiHistory[oiHistory.length - 1]?.sumOpenInterest || "0",
    );
    const oldest = parseFloat(oiHistory[0]?.sumOpenInterest || "0");
    oiChange24h = oldest > 0 ? ((latest - oldest) / oldest) * 100 : 0;
  }

  // Get latest L/S ratio
  const latestLS = lsRatio[lsRatio.length - 1];
  const longShortRatio = latestLS ? parseFloat(latestLS.longShortRatio) : 1;
  const longRate = latestLS ? parseFloat(latestLS.longAccount) * 100 : 50;
  const shortRate = latestLS ? parseFloat(latestLS.shortAccount) * 100 : 50;

  // Get funding rate
  const fundingRate = funding[0] ? parseFloat(funding[0].fundingRate) * 100 : 0;

  return {
    openInterest: oi ? parseFloat(oi.openInterest) : 0,
    oiChange24h,
    longShortRatio,
    longRate,
    shortRate,
    fundingRate,
    topTraderRatio: topTrader,
    takerVolume: takerVol,
    source: "binance-free" as const,
  };
}

// Get Klines/Candlestick data (FREE)
export interface BinanceKline {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  openTime: number;
  closeTime: number;
}

export async function getBinanceKlines(
  symbol: string,
  interval: string = "4h",
  limit: number = 100
): Promise<BinanceKline[]> {
  try {
    const response = await fetch(
      `${BINANCE_FUTURES_PUBLIC}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`
    );
    if (!response.ok) {
      console.log(`[BINANCE] Klines fetch failed for ${symbol}: ${response.status}`);
      return [];
    }
    const data = await response.json();
    return data.map((k: any[]) => ({
      openTime: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: k[5],
      closeTime: k[6]
    }));
  } catch (error) {
    console.log(`[BINANCE] Klines error for ${symbol}:`, error);
    return [];
  }
}

// ============================================
// VOLUME PROFILE (VPVR) - FREE Alternative to Liquidity Heatmap
// Calculates volume distribution across price levels
// ============================================

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  percentage: number; // % of total volume at this level
}

export interface VolumeProfileData {
  symbol: string;
  timeframe: string;
  levels: VolumeProfileLevel[];
  poc: number; // Point of Control (highest volume price)
  valueAreaHigh: number; // Upper bound of 70% volume area
  valueAreaLow: number; // Lower bound of 70% volume area
  highVolumeLevels: number[]; // Key support/resistance levels
  currentPrice: number;
  priceRelativeToPOC: 'above' | 'below' | 'at';
}

export async function getVolumeProfile(
  symbol: string,
  interval: string = '1h',
  lookbackCandles: number = 200,
  numLevels: number = 50
): Promise<VolumeProfileData | null> {
  try {
    // Get historical klines from Binance FREE API
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${lookbackCandles}`
    );

    if (!response.ok) return null;

    const klines = await response.json();
    if (!klines || klines.length === 0) return null;

    // Find price range
    let highPrice = 0;
    let lowPrice = Infinity;
    let totalVolume = 0;

    for (const k of klines) {
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const volume = parseFloat(k[5]);

      if (high > highPrice) highPrice = high;
      if (low < lowPrice) lowPrice = low;
      totalVolume += volume;
    }

    // Create price levels
    const priceRange = highPrice - lowPrice;
    const levelSize = priceRange / numLevels;
    const levels: VolumeProfileLevel[] = [];

    // Initialize levels
    for (let i = 0; i < numLevels; i++) {
      levels.push({
        price: lowPrice + (i + 0.5) * levelSize,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        percentage: 0
      });
    }

    // Distribute volume across levels
    for (const k of klines) {
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const volume = parseFloat(k[5]);
      const isBullish = close > open;

      // Distribute candle volume proportionally across its range
      for (let i = 0; i < numLevels; i++) {
        const levelLow = lowPrice + i * levelSize;
        const levelHigh = levelLow + levelSize;

        // Check if candle overlaps this level
        if (high >= levelLow && low <= levelHigh) {
          // Calculate overlap ratio
          const overlapLow = Math.max(low, levelLow);
          const overlapHigh = Math.min(high, levelHigh);
          const candleRange = high - low || 0.0001;
          const overlapRatio = (overlapHigh - overlapLow) / candleRange;

          const volumeAtLevel = volume * overlapRatio;
          levels[i].volume += volumeAtLevel;

          if (isBullish) {
            levels[i].buyVolume += volumeAtLevel;
          } else {
            levels[i].sellVolume += volumeAtLevel;
          }
        }
      }
    }

    // Calculate percentages and find POC
    let maxVolume = 0;
    let pocIndex = 0;

    for (let i = 0; i < levels.length; i++) {
      levels[i].percentage = (levels[i].volume / totalVolume) * 100;
      if (levels[i].volume > maxVolume) {
        maxVolume = levels[i].volume;
        pocIndex = i;
      }
    }

    const poc = levels[pocIndex].price;

    // Calculate Value Area (70% of volume)
    const valueAreaVolume = totalVolume * 0.7;
    let vaVolume = levels[pocIndex].volume;
    let vaLowIndex = pocIndex;
    let vaHighIndex = pocIndex;

    while (vaVolume < valueAreaVolume) {
      const expandLow = vaLowIndex > 0 ? levels[vaLowIndex - 1].volume : 0;
      const expandHigh = vaHighIndex < levels.length - 1 ? levels[vaHighIndex + 1].volume : 0;

      if (expandLow >= expandHigh && vaLowIndex > 0) {
        vaLowIndex--;
        vaVolume += levels[vaLowIndex].volume;
      } else if (vaHighIndex < levels.length - 1) {
        vaHighIndex++;
        vaVolume += levels[vaHighIndex].volume;
      } else {
        break;
      }
    }

    const valueAreaLow = levels[vaLowIndex].price;
    const valueAreaHigh = levels[vaHighIndex].price;

    // Find high volume nodes (potential S/R levels)
    const avgVolume = totalVolume / numLevels;
    const highVolumeLevels = levels
      .filter(l => l.volume > avgVolume * 1.5)
      .map(l => l.price)
      .sort((a, b) => a - b);

    // Get current price
    const currentPrice = parseFloat(klines[klines.length - 1][4]);

    return {
      symbol,
      timeframe: interval,
      levels,
      poc,
      valueAreaHigh,
      valueAreaLow,
      highVolumeLevels,
      currentPrice,
      priceRelativeToPOC: currentPrice > poc * 1.005 ? 'above' : 
                          currentPrice < poc * 0.995 ? 'below' : 'at'
    };

  } catch (error) {
    console.error(`Error calculating volume profile for ${symbol}:`, error);
    return null;
  }
}

// Get liquidity zones from volume profile (alternative to Coinglass heatmap)
export function getLiquidityZonesFromVP(vp: VolumeProfileData): {
  resistanceZones: number[];
  supportZones: number[];
  strongestLevel: number;
  bias: 'bullish' | 'bearish' | 'neutral';
} {
  const { currentPrice, highVolumeLevels, poc, valueAreaHigh, valueAreaLow } = vp;

  // Zones above current price = resistance (potential short squeeze targets)
  const resistanceZones = highVolumeLevels.filter(p => p > currentPrice);

  // Zones below current price = support (potential long liquidation zones)
  const supportZones = highVolumeLevels.filter(p => p < currentPrice);

  // Strongest level is POC
  const strongestLevel = poc;

  // Bias based on price position relative to value area
  let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (currentPrice > valueAreaHigh) {
    bias = 'bullish'; // Price accepted above value area
  } else if (currentPrice < valueAreaLow) {
    bias = 'bearish'; // Price rejected below value area
  }

  return { resistanceZones, supportZones, strongestLevel, bias };
}

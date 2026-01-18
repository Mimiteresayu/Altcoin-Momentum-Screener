import crypto from "crypto";

const FUTURES_BASE_URL = "https://fapi.binance.com";

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
      console.log("[BINANCE] API credentials not configured - autotrade disabled");
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
    params: Record<string, string | number | boolean> = {}
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

    return this.signedRequest<OrderResult>("/fapi/v1/order", "POST", orderParams);
  }

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number
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
    stopPrice: number
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
    stopPrice: number
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

  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<any> {
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
    const response = await fetch(`${this.baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
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
    leverage: number = 1
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

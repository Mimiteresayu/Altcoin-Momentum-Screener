import crypto from "crypto";
import axios from "axios";

const BASE_URL = "https://fapi.bitunix.com/api/v1/futures";

interface BitunixConfig {
  apiKey: string;
  secretKey: string;
}

interface OrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  qty: string;
  price?: string;
  tradeSide: "OPEN" | "CLOSE";
  effect?: "GTC" | "IOC" | "FOK";
  clientId?: string;
}

interface OrderResult {
  orderId: string;
  clientId?: string;
  symbol: string;
  side: string;
  qty: string;
  price?: string;
  status: string;
  createTime: number;
}

interface Position {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: number;
  marginType: string;
}

interface AccountInfo {
  totalBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginBalance: number;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function generateSignature(
  nonce: string,
  timestamp: string,
  apiKey: string,
  secretKey: string,
  queryParams: string = "",
  body: string = ""
): string {
  const digestInput = nonce + timestamp + apiKey + queryParams + body;
  const digest = sha256Hex(digestInput);
  const signInput = digest + secretKey;
  return sha256Hex(signInput);
}

function generateNonce(): string {
  return Math.random().toString(36).substring(2, 10);
}

class BitunixTradeService {
  private config: BitunixConfig | null = null;

  initialize(): boolean {
    const apiKey = process.env.BITUNIX_API_KEY;
    const secretKey = process.env.BITUNIX_SECRET_KEY;

    if (!apiKey || !secretKey) {
      console.log("[BITUNIX] API credentials not configured");
      return false;
    }

    this.config = { apiKey, secretKey };
    console.log("[BITUNIX] Trading service initialized");
    return true;
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  private getHeaders(queryParams: string = "", body: string = ""): Record<string, string> {
    if (!this.config) throw new Error("Bitunix not configured");

    const nonce = generateNonce();
    const timestamp = Date.now().toString();
    const sign = generateSignature(
      nonce,
      timestamp,
      this.config.apiKey,
      this.config.secretKey,
      queryParams,
      body
    );

    return {
      "api-key": this.config.apiKey,
      sign,
      nonce,
      timestamp,
      language: "en-US",
      "Content-Type": "application/json",
    };
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (!this.config) throw new Error("Bitunix not configured");

    const body = JSON.stringify({
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      qty: params.qty,
      price: params.price,
      tradeSide: params.tradeSide,
      effect: params.effect || "GTC",
      clientId: params.clientId || `bt_${Date.now()}`,
    });

    const headers = this.getHeaders("", body);

    try {
      const response = await axios.post(`${BASE_URL}/trade/place_order`, JSON.parse(body), {
        headers,
        timeout: 10000,
      });

      if (response.data.code !== 0) {
        throw new Error(response.data.msg || "Order failed");
      }

      return response.data.data;
    } catch (error: any) {
      console.error("[BITUNIX] Order error:", error.message);
      throw error;
    }
  }

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    qty: string,
    tradeSide: "OPEN" | "CLOSE" = "OPEN"
  ): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side,
      orderType: "MARKET",
      qty,
      tradeSide,
    });
  }

  async placeLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    qty: string,
    price: string,
    tradeSide: "OPEN" | "CLOSE" = "OPEN"
  ): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side,
      orderType: "LIMIT",
      qty,
      price,
      tradeSide,
    });
  }

  async cancelOrder(symbol: string, orderId: string): Promise<any> {
    if (!this.config) throw new Error("Bitunix not configured");

    const body = JSON.stringify({ symbol, orderId });
    const headers = this.getHeaders("", body);

    try {
      const response = await axios.post(`${BASE_URL}/trade/cancel_order`, JSON.parse(body), {
        headers,
        timeout: 10000,
      });

      return response.data;
    } catch (error: any) {
      console.error("[BITUNIX] Cancel order error:", error.message);
      throw error;
    }
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    if (!this.config) throw new Error("Bitunix not configured");

    const body = JSON.stringify({ symbol });
    const headers = this.getHeaders("", body);

    try {
      const response = await axios.post(`${BASE_URL}/trade/cancel_all_orders`, JSON.parse(body), {
        headers,
        timeout: 10000,
      });

      return response.data;
    } catch (error: any) {
      console.error("[BITUNIX] Cancel all orders error:", error.message);
      throw error;
    }
  }

  async getOpenPositions(): Promise<Position[]> {
    if (!this.config) throw new Error("Bitunix not configured");

    const queryParams = "";
    const headers = this.getHeaders(queryParams, "");

    try {
      const response = await axios.get(`${BASE_URL}/account/positions`, {
        headers,
        timeout: 10000,
      });

      if (response.data.code !== 0) {
        throw new Error(response.data.msg || "Failed to get positions");
      }

      return response.data.data?.positionList || [];
    } catch (error: any) {
      console.error("[BITUNIX] Get positions error:", error.message);
      return [];
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    if (!this.config) throw new Error("Bitunix not configured");

    const headers = this.getHeaders("", "");

    try {
      const response = await axios.get(`${BASE_URL}/account/info`, {
        headers,
        timeout: 10000,
      });

      if (response.data.code !== 0) {
        throw new Error(response.data.msg || "Failed to get account");
      }

      const data = response.data.data;
      return {
        totalBalance: parseFloat(data.totalBalance || "0"),
        availableBalance: parseFloat(data.availableBalance || "0"),
        unrealizedPnl: parseFloat(data.unrealizedPnl || "0"),
        marginBalance: parseFloat(data.marginBalance || "0"),
      };
    } catch (error: any) {
      console.error("[BITUNIX] Get account error:", error.message);
      return {
        totalBalance: 0,
        availableBalance: 0,
        unrealizedPnl: 0,
        marginBalance: 0,
      };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    if (!this.config) throw new Error("Bitunix not configured");

    const body = JSON.stringify({ symbol, leverage: leverage.toString() });
    const headers = this.getHeaders("", body);

    try {
      const response = await axios.post(`${BASE_URL}/account/set_leverage`, JSON.parse(body), {
        headers,
        timeout: 10000,
      });

      return response.data.code === 0;
    } catch (error: any) {
      console.error("[BITUNIX] Set leverage error:", error.message);
      return false;
    }
  }

  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSS"): Promise<boolean> {
    if (!this.config) throw new Error("Bitunix not configured");

    const body = JSON.stringify({ symbol, marginType });
    const headers = this.getHeaders("", body);

    try {
      const response = await axios.post(`${BASE_URL}/account/set_margin_type`, JSON.parse(body), {
        headers,
        timeout: 10000,
      });

      return response.data.code === 0;
    } catch (error: any) {
      console.error("[BITUNIX] Set margin type error:", error.message);
      return false;
    }
  }

  async closePosition(symbol: string, position: Position): Promise<OrderResult | null> {
    const side = position.side === "LONG" ? "SELL" : "BUY";
    const qty = Math.abs(parseFloat(position.qty)).toString();

    try {
      return await this.placeMarketOrder(symbol, side, qty, "CLOSE");
    } catch (error) {
      console.error("[BITUNIX] Close position error:", error);
      return null;
    }
  }

  calculateQuantity(
    balance: number,
    riskPercent: number,
    entryPrice: number,
    stopLoss: number,
    leverage: number
  ): number {
    const riskAmount = balance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entryPrice - stopLoss);

    if (riskPerUnit <= 0) return 0;

    const quantity = (riskAmount * leverage) / riskPerUnit / entryPrice;
    return this.normalizeQuantity(quantity);
  }

  normalizeQuantity(qty: number, precision: number = 3): number {
    const factor = Math.pow(10, precision);
    return Math.floor(qty * factor) / factor;
  }

  formatQuantity(qty: number, precision: number = 3): string {
    return this.normalizeQuantity(qty, precision).toFixed(precision);
  }
}

export const bitunixTradeService = new BitunixTradeService();
export type { OrderParams, OrderResult, Position, AccountInfo };

import crypto from "crypto";

/** Convert Bitunix interval string to milliseconds. */
function parseIntervalMs(interval: string): number {
  const m = interval.match(/^(\d+)([smhdwM])$/);
  if (!m) return 60_000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    case "w": return n * 604_800_000;
    case "M": return n * 30 * 86_400_000;
    default: return 60_000;
  }
}

// ============= INTERFACES =============

export interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
  takerBuyBaseVolume: string;
  takerBuyQuoteVolume: string;
}

export interface Position {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  price: number;
  quantity: number;
  status: string;
}

// Fair Value Gap interface
export interface FVG {
  type: "bullish" | "bearish";
  top: number;
  bottom: number;
  timestamp: number;
  filled: boolean;
}

// Order Block interface
export interface OrderBlock {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  timestamp: number;
  volume: number;
}

// ============= BITUNIX API SERVICE =============

export class BitunixTradeService {
  private apiKey: string = "";
  private apiSecret: string = "";
  private baseUrl: string = "https://api.bitunix.com";
  private initialized: boolean = false;

  initialize(): boolean {
    this.apiKey = process.env.BITUNIX_API_KEY || "";
    this.apiSecret = process.env.BITUNIX_API_SECRET || "";

    if (!this.apiKey || !this.apiSecret) {
      console.log("[BITUNIX] API credentials not configured");
      return false;
    }

    this.initialized = true;
    console.log("[BITUNIX] Trade service initialized");
    return true;
  }

    isConfigured(): boolean {
    return this.initialized;
  }

  private generateSignature(params: string, timestamp: string): string {
    const message = `${timestamp}${params}`;
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("hex");
  }

  /**
   * Get Kline/Candlestick data from Bitunix
   * @param symbol - Trading pair (e.g., 'BTCUSDT')
   * @param interval - Time interval (1m, 5m, 15m, 1h, 4h, 1d)
   * @param limit - Number of candles to fetch (default: 100)
   */
  async getKlines(
    symbol: string,
    interval: string,
    limit: number = 100,
  ): Promise<Kline[]> {
    try {
      // Bitunix futures klines live on fapi.bitunix.com — NOT api.bitunix.com.
      // Public, no key, no geo-block. Returns array-of-objects newest-first.
      const endpoint = "https://fapi.bitunix.com/api/v1/futures/market/kline";
      const params = new URLSearchParams({
        symbol,
        interval,
        limit: limit.toString(),
      });

      const response = await fetch(`${endpoint}?${params.toString()}`);
      if (!response.ok) {
        console.error(`[BITUNIX] Kline fetch failed for ${symbol}: ${response.status}`);
        return [];
      }

      const data = await response.json();
      if (data?.code !== 0 || !Array.isArray(data?.data)) {
        console.error(`[BITUNIX] Kline non-zero code for ${symbol}: ${data?.code} ${data?.msg}`);
        return [];
      }

      // Bitunix returns NEWEST FIRST — reverse so callers see chronological order
      // (klines[length-1] = most recent candle, which is what SMC / detectors expect).
      const intervalMs = parseIntervalMs(interval);
      const candles: Kline[] = data.data.map((k: any) => {
        const openTime = Number(k.time);
        return {
          openTime,
          open: String(k.open),
          high: String(k.high),
          low: String(k.low),
          close: String(k.close),
          volume: String(k.baseVol),
          closeTime: openTime + intervalMs - 1,
          quoteVolume: String(k.quoteVol),
          trades: 0,
          takerBuyBaseVolume: "0",
          takerBuyQuoteVolume: "0",
        } as Kline;
      });
      return candles.reverse();
    } catch (error) {
      console.error("[BITUNIX] Error fetching klines:", error);
      return [];
    }
  }

  /**
   * Detect Fair Value Gaps (FVG) in kline data
   * FVG occurs when there's a gap between candles indicating imbalance
   */
  detectFVG(klines: Kline[]): FVG[] {
    const fvgs: FVG[] = [];

    for (let i = 2; i < klines.length; i++) {
      const prev = klines[i - 2];
      const curr = klines[i - 1];
      const next = klines[i];

      const prevHigh = parseFloat(prev.high);
      const prevLow = parseFloat(prev.low);
      const currHigh = parseFloat(curr.high);
      const currLow = parseFloat(curr.low);
      const nextHigh = parseFloat(next.high);
      const nextLow = parseFloat(next.low);

      // Bullish FVG: gap between prev.high and next.low
      if (nextLow > prevHigh && currLow > prevHigh) {
        fvgs.push({
          type: "bullish",
          top: nextLow,
          bottom: prevHigh,
          timestamp: curr.openTime,
          filled: false,
        });
      }

      // Bearish FVG: gap between prev.low and next.high
      if (nextHigh < prevLow && currHigh < prevLow) {
        fvgs.push({
          type: "bearish",
          top: prevLow,
          bottom: nextHigh,
          timestamp: curr.openTime,
          filled: false,
        });
      }
    }

    return fvgs;
  }

  /**
   * Detect Order Blocks (OB) - High volume candles that preceded strong moves
   */
  detectOrderBlocks(klines: Kline[]): OrderBlock[] {
    const obs: OrderBlock[] = [];

    if (klines.length < 10) return obs;

    // Calculate average volume
    const avgVolume =
      klines.reduce((sum, k) => sum + parseFloat(k.volume), 0) / klines.length;

    for (let i = 5; i < klines.length - 3; i++) {
      const curr = klines[i];
      const currVolume = parseFloat(curr.volume);
      const currClose = parseFloat(curr.close);
      const currOpen = parseFloat(curr.open);

      // Check if this candle has above-average volume
      if (currVolume < avgVolume * 1.5) continue;

      // Check for bullish move after (3 candles)
      const next3Close = parseFloat(klines[i + 3].close);
      const bullishMove = next3Close > currClose * 1.02; // 2% move up

      // Check for bearish move after (3 candles)
      const bearishMove = next3Close < currClose * 0.98; // 2% move down

      if (bullishMove && currClose > currOpen) {
        obs.push({
          type: "bullish",
          high: parseFloat(curr.high),
          low: parseFloat(curr.low),
          timestamp: curr.openTime,
          volume: currVolume,
        });
      } else if (bearishMove && currClose < currOpen) {
        obs.push({
          type: "bearish",
          high: parseFloat(curr.high),
          low: parseFloat(curr.low),
          timestamp: curr.openTime,
          volume: currVolume,
        });
      }
    }

    return obs;
  }

  /**
   * Determine ICT/Smart Money location context
   * Returns: 'premium', 'equilibrium', 'discount'
   */
  getICTLocation(klines: Kline[]): { location: string; percentage: number } {
    if (klines.length === 0) {
      return { location: "unknown", percentage: 50 };
    }

    // Get range high and low from recent swing
    const recent = klines.slice(-50); // Last 50 candles
    const high = Math.max(...recent.map((k) => parseFloat(k.high)));
    const low = Math.min(...recent.map((k) => parseFloat(k.low)));
    const current = parseFloat(klines[klines.length - 1].close);

    const range = high - low;
    const positionInRange = current - low;
    const percentage = (positionInRange / range) * 100;

    let location: string;
    if (percentage > 70) {
      location = "premium"; // Upper 30% - potential sell zone
    } else if (percentage < 30) {
      location = "discount"; // Lower 30% - potential buy zone
    } else {
      location = "equilibrium"; // Middle 40% - neutral zone
    }

    return { location, percentage };
  }

  // ============= TRADING METHODS =============

  async getPositions(): Promise<Position[]> {
    if (!this.initialized) {
      console.log("[BITUNIX] Service not initialized");
      return [];
    }

    try {
      const endpoint = "/api/v1/private/position";
      const timestamp = Date.now().toString();
      const signature = this.generateSignature("", timestamp);

      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          "X-BX-APIKEY": this.apiKey,
          "X-BX-TIMESTAMP": timestamp,
          "X-BX-SIGNATURE": signature,
        },
      });

      if (!response.ok) return [];

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error("[BITUNIX] Error getting positions:", error);
      return [];
    }
  }

  async placeOrder(
    symbol: string,
    side: "BUY" | "SELL",
    type: "LIMIT" | "MARKET",
    quantity: number,
    price?: number,
  ): Promise<OrderResult | null> {
    if (!this.initialized) {
      console.log("[BITUNIX] Service not initialized");
      return null;
    }

    try {
      const endpoint = "/api/v1/private/order";
      const timestamp = Date.now().toString();

      const orderParams: any = {
        symbol,
        side,
        type,
        quantity,
      };

      if (type === "LIMIT" && price) {
        orderParams.price = price;
      }

      const paramsString = JSON.stringify(orderParams);
      const signature = this.generateSignature(paramsString, timestamp);

      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BX-APIKEY": this.apiKey,
          "X-BX-TIMESTAMP": timestamp,
          "X-BX-SIGNATURE": signature,
        },
        body: paramsString,
      });

      if (!response.ok) return null;

      const data = await response.json();
      return data.data || null;
    } catch (error) {
      console.error("[BITUNIX] Error placing order:", error);
      return null;
    }
  }

    async getOpenPositions(): Promise<Position[]> {
    return this.getPositions();
  }

  async getAccountInfo(): Promise<{ balance: number; equity: number; margin: number } | null> {
    if (!this.initialized) {
      console.log("[BITUNIX] Service not initialized");
      return null;
    }
    try {
      const endpoint = "/api/v1/private/account";
      const timestamp = Date.now().toString();
      const signature = this.generateSignature("", timestamp);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          "X-BX-APIKEY": this.apiKey,
          "X-BX-TIMESTAMP": timestamp,
          "X-BX-SIGNATURE": signature,
        },
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data || null;
    } catch (error) {
      console.error("[BITUNIX] Error getting account info:", error);
      return null;
    }
  }
}

// Export singleton instance
export const bitunixTradeService = new BitunixTradeService();

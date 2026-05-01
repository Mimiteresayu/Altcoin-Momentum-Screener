/**
 * Pionex Exchange Adapter
 * ------------------------
 * - REST + signed requests (HMAC-SHA256, header-based)
 * - Used for: (1) market data & depth, (2) demo paper trading validation,
 *   (3) live fallback if Bitunix down.
 * - Auth header: PIONEX-KEY, PIONEX-SIGNATURE, PIONEX-TIMESTAMP
 * - Docs: https://pionex-doc.gitbook.io/apidocs
 *
 * IMPORTANT: Pionex internal mark-price diverged from global during
 * Oct 10 2025 crash (BitBull/Trademania community reports). Keep position
 * sizes small here; treat as untrusted during high volatility.
 */
import crypto from "crypto";

export interface PionexBalance {
  coin: string;
  free: string;
  frozen: string;
}

export interface PionexOrderResult {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  price: number;
  quantity: number;
  status: string;
}

export interface PionexDepth {
  bids: [string, string][]; // [price, qty]
  asks: [string, string][];
  timestamp: number;
}

export class PionexService {
  private apiKey = "";
  private apiSecret = "";
  private baseUrl = "https://api.pionex.com";
  private initialized = false;
  private paperMode = true;

  initialize(): boolean {
    this.apiKey = process.env.PIONEX_API_KEY || "";
    this.apiSecret = process.env.PIONEX_API_SECRET || "";
    this.paperMode = (process.env.PIONEX_PAPER_MODE ?? "true") === "true";

    if (!this.apiKey || !this.apiSecret) {
      console.log("[PIONEX] No credentials — running in market-data-only mode");
      this.initialized = false;
      return false;
    }
    this.initialized = true;
    console.log(`[PIONEX] initialized (paper=${this.paperMode})`);
    return true;
  }

  isConfigured(): boolean {
    return this.initialized;
  }

  isPaper(): boolean {
    return this.paperMode;
  }

  /** Sign per Pionex spec: timestamp + method + path + sortedQuery + body */
  private sign(method: string, path: string, params: Record<string, string> = {}, body = ""): {
    timestamp: string;
    signature: string;
    query: string;
  } {
    const timestamp = Date.now().toString();
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    const query = sorted ? `?${sorted}` : "";
    const payload = `${timestamp}${method}${path}${query}${body}`;
    const signature = crypto
      .createHmac("sha256", this.apiSecret)
      .update(payload)
      .digest("hex");
    return { timestamp, signature, query };
  }

  /** Public market depth — no auth needed */
  async getDepth(symbol: string, limit = 20): Promise<PionexDepth | null> {
    try {
      const url = `${this.baseUrl}/api/v1/market/depth?symbol=${symbol}&limit=${limit}`;
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) return null;
      const j: any = await r.json();
      return {
        bids: j.data?.bids || [],
        asks: j.data?.asks || [],
        timestamp: Date.now(),
      };
    } catch (e) {
      console.error("[PIONEX] depth error", e);
      return null;
    }
  }

  /** Spread + top-of-book depth in USD — used by execution gate */
  async getSpreadAndDepth(symbol: string): Promise<{ spreadBps: number; depthUsd: number } | null> {
    const depth = await this.getDepth(symbol, 5);
    if (!depth || !depth.bids.length || !depth.asks.length) return null;
    const bestBid = parseFloat(depth.bids[0][0]);
    const bestAsk = parseFloat(depth.asks[0][0]);
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / mid) * 10000;
    // sum top 5 levels notional
    const depthUsd = depth.bids
      .slice(0, 5)
      .reduce((s, [p, q]) => s + parseFloat(p) * parseFloat(q), 0);
    return { spreadBps, depthUsd };
  }

  async getBalances(): Promise<PionexBalance[]> {
    if (!this.initialized) return [];
    const path = "/api/v1/account/balances";
    const { timestamp, signature, query } = this.sign("GET", path);
    const r = await fetch(`${this.baseUrl}${path}${query}`, {
      method: "GET",
      headers: {
        "PIONEX-KEY": this.apiKey,
        "PIONEX-SIGNATURE": signature,
        "PIONEX-TIMESTAMP": timestamp,
      },
    });
    if (!r.ok) {
      console.error("[PIONEX] balances", r.status, await r.text());
      return [];
    }
    const j: any = await r.json();
    return j.data?.balances || [];
  }

  /**
   * Place order. In paper mode, simulates fill at mid price.
   * Maker-first: pass clientOrderId + price for LIMIT.
   */
  async placeOrder(args: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    quantity: number;
    price?: number;
    clientOrderId?: string;
  }): Promise<PionexOrderResult | null> {
    // Paper sim
    if (this.paperMode) {
      const depth = await this.getDepth(args.symbol);
      const fillPx =
        args.price ??
        (depth ? (parseFloat(depth.bids[0][0]) + parseFloat(depth.asks[0][0])) / 2 : 0);
      console.log(
        `[PIONEX-PAPER] ${args.side} ${args.quantity} ${args.symbol} @ ${fillPx} (${args.type})`
      );
      return {
        orderId: `paper-${Date.now()}`,
        symbol: args.symbol,
        side: args.side,
        type: args.type,
        price: fillPx,
        quantity: args.quantity,
        status: "FILLED",
      };
    }

    // Live order
    const path = "/api/v1/trade/order";
    const body = JSON.stringify({
      symbol: args.symbol,
      side: args.side,
      type: args.type,
      size: args.quantity.toString(),
      ...(args.price ? { price: args.price.toString() } : {}),
      ...(args.clientOrderId ? { clientOrderId: args.clientOrderId } : {}),
    });
    const { timestamp, signature } = this.sign("POST", path, {}, body);
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "PIONEX-KEY": this.apiKey,
        "PIONEX-SIGNATURE": signature,
        "PIONEX-TIMESTAMP": timestamp,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!r.ok) {
      console.error("[PIONEX] placeOrder", r.status, await r.text());
      return null;
    }
    const j: any = await r.json();
    return j.data;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    if (this.paperMode) return true;
    const path = "/api/v1/trade/order";
    const params = { symbol, orderId };
    const { timestamp, signature, query } = this.sign("DELETE", path, params);
    const r = await fetch(`${this.baseUrl}${path}${query}`, {
      method: "DELETE",
      headers: {
        "PIONEX-KEY": this.apiKey,
        "PIONEX-SIGNATURE": signature,
        "PIONEX-TIMESTAMP": timestamp,
      },
    });
    return r.ok;
  }
}

export const pionexService = new PionexService();

/**
 * Binance Spot — RUNNER hold only.
 * Used to park RUNNER child after taking profit on Bitunix perp,
 * so user can hold multi-day without funding decay or liquidation risk.
 * Requires VPN access from HK.
 */
import crypto from "crypto";

export class BinanceSpotService {
  private apiKey = "";
  private apiSecret = "";
  private baseUrl = "https://api.binance.com";
  private enabled = false;

  initialize(): boolean {
    this.apiKey = process.env.BINANCE_API_KEY || "";
    this.apiSecret = process.env.BINANCE_API_SECRET || "";
    this.enabled = (process.env.BINANCE_SPOT_ENABLED ?? "false") === "true";
    if (!this.enabled || !this.apiKey || !this.apiSecret) {
      console.log("[BINANCE-SPOT] disabled or no credentials");
      return false;
    }
    console.log("[BINANCE-SPOT] initialized for RUNNER hold");
    return true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  /**
   * Buy spot at market — used to convert closed RUNNER profits into
   * the underlying token for hold.
   */
  async buyMarket(symbol: string, quoteAmount: number): Promise<any | null> {
    if (!this.enabled) return null;
    const ts = Date.now();
    const params = `symbol=${symbol}&side=BUY&type=MARKET&quoteOrderQty=${quoteAmount}&timestamp=${ts}`;
    const sig = this.sign(params);
    const url = `${this.baseUrl}/api/v3/order?${params}&signature=${sig}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    if (!r.ok) {
      console.error("[BINANCE-SPOT] buyMarket", r.status, await r.text());
      return null;
    }
    return r.json();
  }
}

export const binanceSpotService = new BinanceSpotService();

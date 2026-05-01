/**
 * Pre-trade spread + depth gate.
 * Rejects entries on illiquid symbols where slippage > acceptable.
 */
import { pionexService } from "../exchanges/pionex";

export interface SpreadCheck {
  ok: boolean;
  spreadBps: number;
  depthUsd: number;
  reason?: string;
}

export async function checkSpreadAndDepth(symbol: string): Promise<SpreadCheck> {
  const maxSpread = parseFloat(process.env.SPREAD_MAX_BPS || "30");
  const minDepth = parseFloat(process.env.DEPTH_MIN_USD || "20000");
  const r = await pionexService.getSpreadAndDepth(symbol);
  if (!r) {
    return { ok: false, spreadBps: 0, depthUsd: 0, reason: "depth fetch failed" };
  }
  if (r.spreadBps > maxSpread) {
    return {
      ok: false,
      spreadBps: r.spreadBps,
      depthUsd: r.depthUsd,
      reason: `spread ${r.spreadBps.toFixed(1)}bps > ${maxSpread}bps`,
    };
  }
  if (r.depthUsd < minDepth) {
    return {
      ok: false,
      spreadBps: r.spreadBps,
      depthUsd: r.depthUsd,
      reason: `depth $${r.depthUsd.toFixed(0)} < $${minDepth}`,
    };
  }
  return { ok: true, spreadBps: r.spreadBps, depthUsd: r.depthUsd };
}

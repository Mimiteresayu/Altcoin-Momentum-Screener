/**
 * Risk-Adjusted Trade Planner
 * ----------------------------
 * Yuth method: 1 parent setup → 4 children with asymmetric RR ladder.
 *
 *   SCALPER  RR 1.5 (was 1.2 in Yuth's deck — bumped to cover fees+slippage)
 *   SNIPER   RR 2
 *   SWING    RR 4
 *   RUNNER   RR 8  (skipped if Fire Dog long_score < 70)
 *
 * Risk distribution (1% equity at risk total):
 *   SCALPER 0.30%   SNIPER 0.30%   SWING 0.25%   RUNNER 0.15%
 *
 * Stop = entry - (range * 0.25)  (Yuth's ENSO trade had SL 25% from entry)
 */

export type ChildName = "SCALPER" | "SNIPER" | "SWING" | "RUNNER";

export interface TradePlan {
  symbol: string;
  side: "LONG" | "SHORT";
  parentRiskPct: number;       // 1% default
  entry: number;
  stop: number;
  leverage: number;
  children: Array<{
    name: ChildName;
    rr: number;
    riskPct: number;            // share of 1%
    qty: number;                 // contracts
    target: number;
  }>;
  totalQty: number;
  paper: boolean;
  reasons: string[];
}

export function buildTradePlan(args: {
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  equityUsd: number;
  childPlan: { SCALPER: boolean; SNIPER: boolean; SWING: boolean; RUNNER: boolean };
  paper?: boolean;
}): TradePlan {
  const RR = {
    SCALPER: parseFloat(process.env.SCALPER_RR || "1.5"),
    SNIPER: parseFloat(process.env.SNIPER_RR || "2"),
    SWING: parseFloat(process.env.SWING_RR || "4"),
    RUNNER: parseFloat(process.env.RUNNER_RR || "8"),
  };
  const RISK_SPLIT: Record<ChildName, number> = {
    SCALPER: 0.30,
    SNIPER: 0.30,
    SWING: 0.25,
    RUNNER: 0.15,
  };
  const parentRiskPct = parseFloat(process.env.RISK_PCT_PER_PARENT || "1");
  const leverage = parseFloat(process.env.MAX_LEVERAGE || "10");
  const dist = Math.abs(args.entry - args.stop);
  if (dist <= 0) throw new Error("Invalid stop distance");

  const totalRisk = (args.equityUsd * parentRiskPct) / 100;
  const children: TradePlan["children"] = [];
  let totalQty = 0;
  const reasons: string[] = [];

  (["SCALPER", "SNIPER", "SWING", "RUNNER"] as ChildName[]).forEach((c) => {
    if (!args.childPlan[c]) {
      reasons.push(`${c} skipped`);
      return;
    }
    const childRisk = totalRisk * RISK_SPLIT[c];
    const qty = childRisk / dist; // size by stop distance
    const target =
      args.side === "LONG"
        ? args.entry + dist * RR[c]
        : args.entry - dist * RR[c];
    children.push({
      name: c,
      rr: RR[c],
      riskPct: parentRiskPct * RISK_SPLIT[c],
      qty,
      target,
    });
    totalQty += qty;
  });

  return {
    symbol: args.symbol,
    side: args.side,
    parentRiskPct,
    entry: args.entry,
    stop: args.stop,
    leverage,
    children,
    totalQty,
    paper: args.paper ?? (process.env.PAPER_MODE_DEFAULT ?? "true") === "true",
    reasons,
  };
}

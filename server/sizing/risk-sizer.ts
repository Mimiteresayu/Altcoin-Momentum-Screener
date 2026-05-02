/**
 * Risk-Based Position Sizer
 * --------------------------
 * Implements the locked 7-point methodology:
 *
 *   notional   = (riskPct × equity) / slDistancePct
 *   quantity   = notional / entry
 *   leverage   = floor(100 / (slDistPct + 5))   (capped by per-coin exchange max)
 *   liqBuffer  = liqDist - slDist  (must be >= LIQ_SAFETY_BUFFER)
 *
 * Cross margin only — tight SL = no need for isolated.
 * Maximum 10 concurrent setups, total portfolio risk = 10%.
 */

export interface RiskSizerInput {
  equityUsd: number;
  riskPct?: number;          // default 0.01 (1%)
  entry: number;             // entry price
  slPrice: number;           // dynamic SL from SMC structure invalidation
  side: "LONG" | "SHORT";
  symbolMaxLeverage?: number; // per-coin exchange max (Bitunix API)
  userLeverageOverride?: number;
  liqSafetyBufferPct?: number; // default 5%
}

export interface RiskSizerOutput {
  notionalUsd: number;
  quantity: number;
  slDistancePct: number;
  recommendedLeverage: number;
  appliedLeverage: number;
  marginUsedUsd: number;
  marginPctOfEquity: number;
  liqPrice: number;
  liqDistancePct: number;
  slToLiqBufferPct: number;
  isLiqSafe: boolean;
  warnings: string[];
}

const MIN_LEVERAGE = 1;

/** Calculate liquidation price for cross margin perp */
function calcLiqPrice(
  entry: number,
  leverage: number,
  side: "LONG" | "SHORT",
  maintenanceMarginPct = 0.005, // 0.5% Bitunix typical
): number {
  // Simplified cross margin liquidation formula
  // long:  liq = entry × (1 - 1/lev + mmr)
  // short: liq = entry × (1 + 1/lev - mmr)
  if (side === "LONG") {
    return entry * (1 - 1 / leverage + maintenanceMarginPct);
  } else {
    return entry * (1 + 1 / leverage - maintenanceMarginPct);
  }
}

export function calculateRiskSize(input: RiskSizerInput): RiskSizerOutput {
  const warnings: string[] = [];
  const riskPct = input.riskPct ?? 0.01;
  const liqSafetyBufferPct = input.liqSafetyBufferPct ?? 0.05;

  // 1. SL distance as percentage of entry
  const slDistRaw = Math.abs(input.entry - input.slPrice) / input.entry;
  const slDistancePct = slDistRaw * 100;

  if (slDistancePct < 0.5) {
    warnings.push(`SL distance ${slDistancePct.toFixed(2)}% is dangerously tight — re-verify SMC structure`);
  }
  if (slDistancePct > 30) {
    warnings.push(`SL distance ${slDistancePct.toFixed(1)}% exceeds 30% — consider half-size or skip`);
  }

  // 2. Notional from fixed-risk equation
  const riskAmountUsd = riskPct * input.equityUsd;
  const notionalUsd = riskAmountUsd / slDistRaw;
  const quantity = notionalUsd / input.entry;

  // 3. Leverage auto-cap = 100 / (SL_dist% + 5), bounded by exchange max
  const recommendedLeverage = Math.max(
    MIN_LEVERAGE,
    Math.floor(100 / (slDistancePct + 5)),
  );

  let appliedLeverage = input.userLeverageOverride ?? recommendedLeverage;

  if (input.symbolMaxLeverage && appliedLeverage > input.symbolMaxLeverage) {
    warnings.push(
      `Leverage capped to exchange max ${input.symbolMaxLeverage}× (was ${appliedLeverage}×)`,
    );
    appliedLeverage = input.symbolMaxLeverage;
  }
  if (appliedLeverage < MIN_LEVERAGE) appliedLeverage = MIN_LEVERAGE;

  if (input.userLeverageOverride && input.userLeverageOverride > recommendedLeverage * 1.5) {
    warnings.push(
      `User leverage ${input.userLeverageOverride}× is ${(input.userLeverageOverride / recommendedLeverage).toFixed(1)}× the recommended ${recommendedLeverage}× — liq risk elevated`,
    );
  }

  // 4. Margin usage
  const marginUsedUsd = notionalUsd / appliedLeverage;
  const marginPctOfEquity = (marginUsedUsd / input.equityUsd) * 100;

  // 5. Liquidation distance & safety buffer
  const liqPrice = calcLiqPrice(input.entry, appliedLeverage, input.side);
  const liqDistRaw = Math.abs(input.entry - liqPrice) / input.entry;
  const liqDistancePct = liqDistRaw * 100;
  const slToLiqBufferPct = liqDistancePct - slDistancePct;
  const isLiqSafe = slToLiqBufferPct >= liqSafetyBufferPct * 100;

  if (!isLiqSafe) {
    warnings.push(
      `SL→Liq buffer ${slToLiqBufferPct.toFixed(1)}% < safety threshold ${(liqSafetyBufferPct * 100).toFixed(0)}% — reduce leverage`,
    );
  }

  return {
    notionalUsd: round2(notionalUsd),
    quantity: round6(quantity),
    slDistancePct: round2(slDistancePct),
    recommendedLeverage,
    appliedLeverage,
    marginUsedUsd: round2(marginUsedUsd),
    marginPctOfEquity: round2(marginPctOfEquity),
    liqPrice: round6(liqPrice),
    liqDistancePct: round2(liqDistancePct),
    slToLiqBufferPct: round2(slToLiqBufferPct),
    isLiqSafe,
    warnings,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

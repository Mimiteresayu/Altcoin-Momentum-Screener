/**
 * 5-Layer Funnel Filter
 * ----------------------
 * Pure binary pass/skip filtering. NOT scoring. Funnel only narrows the
 * universe — quality grade comes from the 6-factor scorer downstream.
 *
 *   L1 Universe         → on Bitunix perp list (binary: tradeable?)
 *   L2 Altcoin 篩選     → Fire Dog short_score ≥ minShort
 *   L3 資金費率擠壓      → SQUEEZE_FUEL signal (funding ≤ -0.01% / negative)
 *   L4 SMC 結構         → at least one unfilled FVG + valid CHoCH or BOS
 *   L5 奇門吉門 + 位置   → 用神 in 生/開/休/景門 AND ICT location aligned
 *
 * Each layer: { passed: boolean, reason: string }.
 * If any layer fails → setup is filtered out (no scoring, no execution).
 *
 * IMPORTANT (per user instructions):
 *   - Setup type (LONG/SHORT, 圓底/squeeze/etc.) is INFO only — NOT a filter.
 *   - The funnel does not penalise for setup direction.
 */

import type { SmcFeatures } from "../smc/features";
import type { QimenPan } from "../qimen/sidecar";

/** Lightweight altcoin universe row from the in-house screener. */
export interface ScreenerCoin {
  symbol: string;
  signalStrength: number;       // 0-5 from in-house screener
  signalType?: string;          // HOT | MAJOR | ACTIVE | PRE | COIL
  side?: "LONG" | "SHORT";
}

// 八門 classification (locked architecture)
const JI_DOORS = ["生", "開", "休", "景"] as const;       // 吉門
const ZHONG_DOORS = ["杜", "傷"] as const;                  // 中性
const XIONG_DOORS = ["死", "驚"] as const;                  // 凶門 (絕命 = 死宮在某些派系, treat 死 as 凶)

export type DoorClass = "吉" | "中性" | "凶";

export function classifyDoor(door: string): DoorClass {
  if (JI_DOORS.includes(door as any)) return "吉";
  if (XIONG_DOORS.includes(door as any)) return "凶";
  return "中性";
}

// ---------- types ----------

export interface FunnelInput {
  symbol: string;
  bitunixTradeable: boolean;     // L1
  /** In-house screener row (replaces Fire Dog as the L2 universe gate). */
  screener?: ScreenerCoin | null;  // L2
  fundingSignal?: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL"; // L3
  fundingRate?: number;
  smc?: SmcFeatures | null;      // L4
  qimen?: QimenPan | null;       // L5
  side: "LONG" | "SHORT";        // descriptive, used for location alignment
  thresholds?: {
    minSignalStrength?: number;  // default 2 (out of 5)
    fundingMaxRate?: number;     // default -0.0001 (i.e. negative funding)
    requireSmcFvg?: boolean;     // default true
    requireSmcStructure?: boolean; // default true
    qimenAllowMidIfDoorJi?: boolean; // default true
  };
}

export interface FunnelLayer {
  layer: "L1" | "L2" | "L3" | "L4" | "L5";
  name: string;
  passed: boolean;
  reason: string;
  data?: Record<string, unknown>;
}

export interface FunnelResult {
  symbol: string;
  passed: boolean;                // all 5 must pass
  layers: FunnelLayer[];
  failedAt?: FunnelLayer;
}

// ---------- helpers ----------

function locationAlignedWithSide(
  loc: SmcFeatures["ictLocation"] | undefined,
  side: "LONG" | "SHORT"
): boolean {
  if (!loc || loc === "unknown") return false;
  // LONG buys at discount (or equilibrium acceptable)
  // SHORT sells at premium (or equilibrium acceptable)
  if (side === "LONG") return loc === "discount" || loc === "equilibrium";
  return loc === "premium" || loc === "equilibrium";
}

function hasValidStructure(smc: SmcFeatures): boolean {
  // any unfilled FVG within ±15% of price counts
  const nearFvg = smc.unfilledFvgs.some((f) => Math.abs(f.distancePct) <= 15);
  const shift = smc.lastStructureShift;
  return nearFvg && shift !== null && (shift.type === "BOS" || shift.type === "CHoCH");
}

// ---------- main ----------

export function runFunnel(input: FunnelInput): FunnelResult {
  const t = input.thresholds ?? {};
  const minStrength = t.minSignalStrength ?? 2;
  const fundingMax = t.fundingMaxRate ?? -0.0001;
  const requireFvg = t.requireSmcFvg ?? true;
  const requireStruct = t.requireSmcStructure ?? true;

  const layers: FunnelLayer[] = [];

  // L1 Universe — tradeable on Bitunix
  layers.push({
    layer: "L1",
    name: "Universe",
    passed: input.bitunixTradeable,
    reason: input.bitunixTradeable ? "在 Bitunix 永續名單" : "未上 Bitunix 永續",
  });

  // L2 Altcoin 篩選 — in-house screener strength >= minStrength
  const sc = input.screener;
  const l2Passed = !!sc && sc.signalStrength >= minStrength;
  layers.push({
    layer: "L2",
    name: "Altcoin 篩選",
    passed: l2Passed,
    reason: !sc
      ? "無 screener 數據"
      : l2Passed
      ? `${sc.signalType ?? "signal"} 強度 ${sc.signalStrength}/5 ≥ ${minStrength}`
      : `強度 ${sc.signalStrength}/5 < ${minStrength}`,
    data: sc ? { signalStrength: sc.signalStrength, signalType: sc.signalType } : undefined,
  });

  // L3 資金費率擠壓
  const fr = input.fundingRate ?? 0;
  const l3Passed =
    input.fundingSignal === "SQUEEZE_FUEL" || fr <= fundingMax;
  layers.push({
    layer: "L3",
    name: "資金費率擠壓",
    passed: l3Passed,
    reason: l3Passed
      ? `funding=${(fr * 100).toFixed(4)}% (SQUEEZE_FUEL)`
      : `funding=${(fr * 100).toFixed(4)}% 未進入擠壓區`,
    data: { fundingRate: fr, fundingSignal: input.fundingSignal },
  });

  // L4 SMC 結構 — FVG + valid CHoCH/BOS
  const smc = input.smc;
  let l4Passed = false;
  let l4Reason = "無 SMC 數據";
  if (smc) {
    const fvgOk = !requireFvg || smc.unfilledFvgs.length > 0;
    const structOk = !requireStruct || hasValidStructure(smc);
    l4Passed = fvgOk && structOk;
    if (l4Passed) {
      l4Reason = `FVG×${smc.unfilledFvgs.length} + ${smc.lastStructureShift?.type ?? "?"} ${smc.lastStructureShift?.side ?? ""}`;
    } else if (!fvgOk) {
      l4Reason = "無未填補 FVG";
    } else {
      l4Reason = "無有效 CHoCH/BOS";
    }
  }
  layers.push({
    layer: "L4",
    name: "SMC 結構",
    passed: l4Passed,
    reason: l4Reason,
    data: smc
      ? {
          fvgCount: smc.unfilledFvgs.length,
          lastShift: smc.lastStructureShift,
          location: smc.ictLocation,
        }
      : undefined,
  });

  // L5 奇門吉門 + 位置
  const qm = input.qimen;
  let l5Passed = false;
  let l5Reason = "無奇門盤";
  if (qm) {
    const door = qm.yongshen_cell.door;
    const cls = classifyDoor(door);
    const doorOk = cls === "吉";
    const locOk = locationAlignedWithSide(smc?.ictLocation, input.side);
    l5Passed = doorOk && locOk;
    if (l5Passed) {
      l5Reason = `用神在${door}門 + 位置=${smc?.ictLocation} 與 ${input.side} 一致`;
    } else if (!doorOk) {
      l5Reason = `用神在${door}門 (${cls})，非吉門`;
    } else {
      l5Reason = `位置=${smc?.ictLocation ?? "?"} 與 ${input.side} 不符`;
    }
  }
  layers.push({
    layer: "L5",
    name: "奇門吉門+位置",
    passed: l5Passed,
    reason: l5Reason,
    data: qm
      ? {
          door: qm.yongshen_cell.door,
          doorClass: classifyDoor(qm.yongshen_cell.door),
          palace: qm.yongshen_palace,
        }
      : undefined,
  });

  const failedAt = layers.find((l) => !l.passed);
  return {
    symbol: input.symbol,
    passed: !failedAt,
    layers,
    failedAt,
  };
}

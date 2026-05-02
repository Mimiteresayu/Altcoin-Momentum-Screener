/**
 * Qimen-aware Trailing Stop
 * --------------------------
 * Recomputes trailing stop band each shichen (~2h) based on the live Qimen
 * pan's 用神門. Locked architecture:
 *
 *   吉門 (生 / 開 / 景)        → peak ×(1 - 0.08) = -8%   (loose, let it run)
 *   中性 (休 / 杜 / 傷)         → peak ×(1 - 0.05) = -5%   (default)
 *   凶門 (死 / 驚)              → peak ×(1 - 0.02) = -2%   (tight) + immediate exit signal
 *
 * For SHORT positions the trail is computed against the trough (lowest
 * price seen) with the same percentages flipped: trough × (1 + x%).
 *
 * Output: { trailStopPrice, doorClass, action, peakOrTrough }.
 *   action ∈ "HOLD" | "TIGHTEN" | "EXIT_NOW"
 *
 * The orchestrator calls this on every 2-hour cron tick (matching Qimen 換盤)
 * AND every kline close (to update peak/trough). Only the trailStopPrice is
 * pushed to the exchange as a stop-market order.
 */

import type { QimenPan } from "../qimen/sidecar";
import { classifyDoor, type DoorClass } from "../funnel/funnel-filter";

export interface TrailState {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  initialSl: number;
  peak: number;        // highest seen since entry (LONG)
  trough: number;      // lowest seen since entry (SHORT)
  lastTrailStop: number | null;
  lastDoor: string | null;
  lastDoorClass: DoorClass | null;
  lastUpdated: number;
}

export interface TrailUpdateInput {
  state: TrailState;
  currentPrice: number;
  qimen: QimenPan | null;
}

export interface TrailUpdateResult {
  newState: TrailState;
  trailStopPrice: number;
  doorClass: DoorClass | "unknown";
  action: "HOLD" | "TIGHTEN" | "EXIT_NOW";
  reason: string;
}

const TRAIL_PCT_BY_CLASS: Record<DoorClass, number> = {
  吉: 0.08,    // -8% loose
  中性: 0.05,   // -5% default
  凶: 0.02,    // -2% tight
};

export function initTrailState(args: {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  initialSl: number;
}): TrailState {
  return {
    tradeId: args.tradeId,
    symbol: args.symbol,
    side: args.side,
    entry: args.entry,
    initialSl: args.initialSl,
    peak: args.entry,
    trough: args.entry,
    lastTrailStop: null,
    lastDoor: null,
    lastDoorClass: null,
    lastUpdated: Date.now(),
  };
}

/**
 * Compute the next trailing stop price + action.
 * Called on every kline tick + every Qimen 換盤 (2h).
 */
export function updateTrail(input: TrailUpdateInput): TrailUpdateResult {
  const { state, currentPrice, qimen } = input;

  // 1. update peak / trough
  const newPeak = Math.max(state.peak, currentPrice);
  const newTrough = Math.min(state.trough, currentPrice);

  // 2. classify door
  const door = qimen?.yongshen_cell.door ?? null;
  const doorClass: DoorClass | "unknown" = door ? classifyDoor(door) : "unknown";
  const pct =
    doorClass === "unknown"
      ? TRAIL_PCT_BY_CLASS["中性"]
      : TRAIL_PCT_BY_CLASS[doorClass];

  // 3. compute trail stop
  let trailStopPrice: number;
  if (state.side === "LONG") {
    trailStopPrice = newPeak * (1 - pct);
    // never loosen below initial SL OR previous trail
    const floor = Math.max(state.initialSl, state.lastTrailStop ?? -Infinity);
    if (trailStopPrice < floor) trailStopPrice = floor;
  } else {
    trailStopPrice = newTrough * (1 + pct);
    const ceiling = Math.min(state.initialSl, state.lastTrailStop ?? Infinity);
    if (trailStopPrice > ceiling) trailStopPrice = ceiling;
  }

  // 4. action: did door class flip to 凶? then EXIT_NOW.
  let action: TrailUpdateResult["action"] = "HOLD";
  let reason = `${doorClass}門 (${door ?? "?"}), trail=${pct * 100}%`;
  if (doorClass === "凶" && state.lastDoorClass !== "凶") {
    action = "EXIT_NOW";
    reason = `用神轉${door}門 (凶) → 立即離場`;
  } else if (doorClass !== state.lastDoorClass && state.lastDoorClass !== null) {
    action = "TIGHTEN";
    reason = `用神由 ${state.lastDoor}→${door}, trail 改為 ${pct * 100}%`;
  }

  // 5. SL hit?
  const slHit =
    state.side === "LONG" ? currentPrice <= trailStopPrice : currentPrice >= trailStopPrice;
  if (slHit) {
    action = "EXIT_NOW";
    reason = `價格觸發 trail SL (${trailStopPrice.toFixed(6)})`;
  }

  const newState: TrailState = {
    ...state,
    peak: newPeak,
    trough: newTrough,
    lastTrailStop: trailStopPrice,
    lastDoor: door,
    lastDoorClass: doorClass === "unknown" ? state.lastDoorClass : doorClass,
    lastUpdated: Date.now(),
  };

  return {
    newState,
    trailStopPrice,
    doorClass,
    action,
    reason,
  };
}

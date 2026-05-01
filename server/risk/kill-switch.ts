/**
 * Kill Switch — daily P&L + concurrent position guards.
 * Auto-flips KILL_SWITCH=true when triggered. Operator must manually clear.
 */

interface Snapshot {
  startEquity: number;
  currentEquity: number;
  dayKey: string;
  killed: boolean;
  killReason?: string;
}

const state: Snapshot = {
  startEquity: 0,
  currentEquity: 0,
  dayKey: todayKey(),
  killed: false,
};

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export function setStartEquity(usd: number) {
  if (state.dayKey !== todayKey()) {
    state.dayKey = todayKey();
    state.killed = false;
    state.killReason = undefined;
  }
  state.startEquity = usd;
  state.currentEquity = usd;
}

export function updateEquity(usd: number) {
  if (state.dayKey !== todayKey()) {
    state.dayKey = todayKey();
    state.startEquity = usd;
    state.killed = false;
    state.killReason = undefined;
  }
  state.currentEquity = usd;
  const limitPct = parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || "3");
  const drawdown = ((state.startEquity - usd) / state.startEquity) * 100;
  if (drawdown >= limitPct && !state.killed) {
    state.killed = true;
    state.killReason = `Daily DD ${drawdown.toFixed(2)}% >= ${limitPct}%`;
    console.error(`[KILL] ${state.killReason}`);
  }
}

let openCount = 0;
export function recordOpen() {
  openCount++;
}
export function recordClose() {
  openCount = Math.max(0, openCount - 1);
}

export function canOpenTrade(): { ok: boolean; reason?: string } {
  if ((process.env.TRADING_ENABLED ?? "false") !== "true") {
    return { ok: false, reason: "TRADING_ENABLED=false" };
  }
  if ((process.env.KILL_SWITCH ?? "false") === "true") {
    return { ok: false, reason: "KILL_SWITCH=true" };
  }
  if (state.killed) return { ok: false, reason: state.killReason };
  const max = parseInt(process.env.MAX_CONCURRENT_TRADES || "10", 10);
  if (openCount >= max) return { ok: false, reason: `max ${max} concurrent` };
  return { ok: true };
}

export function getKillSwitchState() {
  return { ...state, openCount };
}

export function manualClear() {
  state.killed = false;
  state.killReason = undefined;
  console.log("[KILL] manually cleared");
}

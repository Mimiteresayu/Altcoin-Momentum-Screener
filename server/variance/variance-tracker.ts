/**
 * Variance Tracker
 * -----------------
 * Compares AI-suggested trade plan vs the actual filled / exited trade and
 * stores a per-trade variance record + monthly aggregate.
 *
 * Rationale (Yung methodology, real money):
 *   - Each setup the cockpit emits an AI plan: entry, SL, TP, qty, leverage,
 *     grade, qimen verdict, expected RR.
 *   - When the trade is closed we compare plan vs realised (slippage, SL hit
 *     vs TP, time-to-resolution, P/L vs expected R-multiple).
 *   - Monthly we aggregate to detect AI drift (e.g. grade A trades ending up
 *     50% win-rate suggests Qimen + SMC scoring needs recalibration).
 *
 * Storage: plain JSON file under ./data/variance/<YYYY-MM>.jsonl
 * (one record per line, append-only). Cockpit reads aggregate via API.
 *
 * No external deps — fs/promises only. DB backing can be added later by
 * implementing the same interface against storage.ts.
 */

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data", "variance");

export type TradeSide = "LONG" | "SHORT";
export type TradeOutcome = "TP_HIT" | "SL_HIT" | "MANUAL_CLOSE" | "TRAIL_STOP" | "QIMEN_EXIT" | "EXPIRED" | "OPEN";

export interface AiPlan {
  tradeId: string;            // unique id (uuid or symbol+timestamp)
  symbol: string;
  side: TradeSide;
  setupGrade: "A+" | "A" | "B" | "C";
  setupType: string;          // e.g. "圓底突破", "Sweep 反彈"
  qimenVerdict: string;       // short verbatim verdict text
  qimenGate: "吉" | "中性" | "凶";
  plannedEntry: number;
  plannedSl: number;
  plannedTp: number;
  plannedQty: number;
  plannedLeverage: number;
  plannedNotionalUsd: number;
  plannedRiskUsd: number;
  expectedR: number;          // (TP-Entry)/(Entry-SL) for LONG, abs
  createdAt: string;          // ISO
}

export interface ActualResult {
  tradeId: string;
  filledEntry: number | null;     // null if never filled
  filledQty: number;
  exitPrice: number | null;
  exitedAt: string | null;
  outcome: TradeOutcome;
  realisedPnlUsd: number;         // signed
  realisedR: number;              // signed multiple of risk
  durationMinutes: number | null;
  notes?: string;
}

export interface VarianceRecord {
  tradeId: string;
  symbol: string;
  side: TradeSide;
  setupGrade: AiPlan["setupGrade"];
  qimenGate: AiPlan["qimenGate"];
  expectedR: number;
  realisedR: number;
  rDelta: number;                 // realised - expected
  entrySlippagePct: number | null; // (filled - planned) / planned * 100, signed
  outcome: TradeOutcome;
  createdAt: string;
  exitedAt: string | null;
  // raw refs for audit
  plan: AiPlan;
  actual: ActualResult;
}

export interface MonthlyAggregate {
  yearMonth: string;              // YYYY-MM
  totalTrades: number;
  closed: number;
  open: number;
  winRate: number;                // closed only
  avgRealisedR: number;
  avgExpectedR: number;
  avgRDelta: number;
  avgEntrySlippagePct: number;
  totalRealisedUsd: number;
  byGrade: Record<string, { count: number; winRate: number; avgR: number }>;
  byQimenGate: Record<string, { count: number; winRate: number; avgR: number }>;
  bySetupType: Record<string, { count: number; winRate: number; avgR: number }>;
}

// ---------- internal helpers ----------

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function fileForMonth(yearMonth: string): string {
  return path.join(DATA_DIR, `${yearMonth}.jsonl`);
}

function ymOf(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const txt = await fs.readFile(file, "utf-8");
    return txt
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await fs.appendFile(file, JSON.stringify(obj) + "\n", "utf-8");
}

// ---------- public API ----------

/** Record an AI plan at the moment the cockpit dispatches a setup. */
export async function recordPlan(plan: AiPlan): Promise<void> {
  await ensureDir();
  const ym = ymOf(plan.createdAt);
  const file = fileForMonth(`plans-${ym}`);
  await appendJsonl(file, plan);
}

/** Record the actual result when the trade closes (or is killed). */
export async function recordActual(actual: ActualResult): Promise<VarianceRecord | null> {
  await ensureDir();

  // find plan across the last 3 months
  const now = new Date();
  const ymCandidates: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    ymCandidates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  let plan: AiPlan | null = null;
  for (const ym of ymCandidates) {
    const plans = await readJsonl<AiPlan>(fileForMonth(`plans-${ym}`));
    const found = plans.find((p) => p.tradeId === actual.tradeId);
    if (found) {
      plan = found;
      break;
    }
  }

  if (!plan) {
    console.warn(`[variance] no plan found for tradeId=${actual.tradeId}, cannot compute variance`);
    return null;
  }

  const entrySlippagePct =
    actual.filledEntry !== null && plan.plannedEntry > 0
      ? ((actual.filledEntry - plan.plannedEntry) / plan.plannedEntry) * 100
      : null;

  const record: VarianceRecord = {
    tradeId: actual.tradeId,
    symbol: plan.symbol,
    side: plan.side,
    setupGrade: plan.setupGrade,
    qimenGate: plan.qimenGate,
    expectedR: plan.expectedR,
    realisedR: actual.realisedR,
    rDelta: actual.realisedR - plan.expectedR,
    entrySlippagePct,
    outcome: actual.outcome,
    createdAt: plan.createdAt,
    exitedAt: actual.exitedAt,
    plan,
    actual,
  };

  const ym = ymOf(plan.createdAt);
  await appendJsonl(fileForMonth(ym), record);
  return record;
}

/** Read all variance records for a given month (YYYY-MM). */
export async function readMonth(yearMonth: string): Promise<VarianceRecord[]> {
  await ensureDir();
  return readJsonl<VarianceRecord>(fileForMonth(yearMonth));
}

/** Aggregate a month into win-rate / avg-R buckets. */
export async function aggregateMonth(yearMonth: string): Promise<MonthlyAggregate> {
  const records = await readMonth(yearMonth);

  const closed = records.filter((r) => r.outcome !== "OPEN");
  const wins = closed.filter((r) => r.realisedR > 0).length;

  const byGrade: MonthlyAggregate["byGrade"] = {};
  const byGate: MonthlyAggregate["byQimenGate"] = {};
  const bySetup: MonthlyAggregate["bySetupType"] = {};

  const tally = (
    bucket: Record<string, { count: number; winRate: number; avgR: number }>,
    key: string,
    r: VarianceRecord
  ) => {
    if (!bucket[key]) bucket[key] = { count: 0, winRate: 0, avgR: 0 };
    const b = bucket[key];
    const isClosed = r.outcome !== "OPEN";
    if (!isClosed) return;
    const newCount = b.count + 1;
    b.avgR = (b.avgR * b.count + r.realisedR) / newCount;
    b.winRate =
      (b.winRate * b.count + (r.realisedR > 0 ? 1 : 0)) / newCount;
    b.count = newCount;
  };

  for (const r of records) {
    tally(byGrade, r.setupGrade, r);
    tally(byGate, r.qimenGate, r);
    tally(bySetup, r.plan.setupType, r);
  }

  const sumR = closed.reduce((s, r) => s + r.realisedR, 0);
  const sumExpR = closed.reduce((s, r) => s + r.expectedR, 0);
  const sumDelta = closed.reduce((s, r) => s + r.rDelta, 0);
  const slipVals = closed
    .map((r) => r.entrySlippagePct)
    .filter((v): v is number => v !== null);
  const sumSlip = slipVals.reduce((s, v) => s + v, 0);
  const sumPnl = closed.reduce(
    (s, r) => s + (r.actual.realisedPnlUsd ?? 0),
    0
  );

  return {
    yearMonth,
    totalTrades: records.length,
    closed: closed.length,
    open: records.length - closed.length,
    winRate: closed.length > 0 ? wins / closed.length : 0,
    avgRealisedR: closed.length > 0 ? sumR / closed.length : 0,
    avgExpectedR: closed.length > 0 ? sumExpR / closed.length : 0,
    avgRDelta: closed.length > 0 ? sumDelta / closed.length : 0,
    avgEntrySlippagePct: slipVals.length > 0 ? sumSlip / slipVals.length : 0,
    totalRealisedUsd: sumPnl,
    byGrade,
    byQimenGate: byGate,
    bySetupType: bySetup,
  };
}

/** Convenience: aggregate the current month. */
export async function aggregateCurrentMonth(): Promise<MonthlyAggregate> {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return aggregateMonth(ym);
}

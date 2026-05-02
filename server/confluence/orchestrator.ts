/**
 * Confluence Orchestrator (v2 — Funnel + Grader + LLM Verdict)
 * -------------------------------------------------------------
 * Top-level entry point for the auto-trade pipeline.
 *
 * Pipeline (locked architecture):
 *   1. Read in-house pre-spike screener snapshot — universe of altcoins.
 *   2. For each symbol:
 *        a. Run 5-layer FUNNEL (binary pass/skip).
 *        b. Detect 6-factor altcoin setup (5 patterns + Qimen 三吉).
 *        c. Grade via 6-factor scorer → A+/A/B/C → size multiplier.
 *        d. Hybrid gate: REJECT below C, half-size on B, full on A/A+.
 *        e. Run risk sizer (notional from SL distance) + leverage guard.
 *        f. Spread + depth gate.
 *        g. Hand off to LLM analyst for verdict text (qimen-smc-analyst).
 *        h. Record AI plan to variance tracker.
 *        i. Execute via callback.
 *
 * Runs on 15-minute cron (matches Fire Dog refresh).
 *
 * NOTE: This orchestrator returns rich per-symbol decisions for the cockpit;
 * the executor is provided by the caller as ctx.executeTrade.
 */
import { getSignals } from "../screener/signal-store";
import { canOpenTrade, recordOpen } from "../risk/kill-switch";
import { checkSpreadAndDepth } from "../execution/spread-check";
import { extractSmcFeatures } from "../smc/features";
import { getQimenPan } from "../qimen/sidecar";
import { detectAltcoinSetup } from "../altcoin-setup/setup-detector";
import { gradeAltcoinSetup, type AltcoinGradeResult } from "./score";
import { runFunnel, type FunnelResult } from "../funnel/funnel-filter";
import { calculateRiskSize } from "../sizing/risk-sizer";
import { fetchBitunixSymbolMaxLeverage } from "../sizing/leverage-guard";
import { recordPlan } from "../variance/variance-tracker";
import { BitunixTradeService } from "../bitunix-trade";

const bitunix = new BitunixTradeService();
bitunix.initialize();

export interface OrchestratorContext {
  /** Bridge to your existing screener; returns 0..100 fuel score */
  getFuelScore: (symbol: string) => Promise<number>;
  /** Daily bottom + breakout score 0..100 */
  getDailyScore: (symbol: string) => Promise<number>;
  /** Funding rate latest (decimal: -0.001 = -0.1%) */
  getFundingRate: (symbol: string) => Promise<{ rate: number; signal: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL" }>;
  /** Current equity in USD */
  getEquityUsd: () => Promise<number>;
  /** Build entry/stop from latest candle data */
  buildEntryStop: (
    symbol: string,
    side: "LONG" | "SHORT"
  ) => Promise<{ entry: number; stop: number; takeProfit: number } | null>;
  /** Whether this symbol is currently tradeable on Bitunix perp */
  isBitunixTradeable: (symbol: string) => Promise<boolean>;
  /** Hook to your existing executor — receives final plan */
  executeTrade: (decision: SymbolDecision) => Promise<void>;
  /** Optional LLM verdict generator (qimen-smc-analyst) */
  getLlmVerdict?: (input: {
    symbol: string;
    side: "LONG" | "SHORT";
    grade: AltcoinGradeResult;
    funnel: FunnelResult;
  }) => Promise<{ verdict: string; gate: "吉" | "中性" | "凶" } | null>;
}

export interface SymbolDecision {
  symbol: string;
  side: "LONG" | "SHORT";
  decision: "EXECUTE" | "HALF_SIZE" | "REJECT_FUNNEL" | "REJECT_GRADE" | "REJECT_LIQUIDITY" | "REJECT_NO_PLAN";
  funnel: FunnelResult;
  grade?: AltcoinGradeResult;
  sizing?: ReturnType<typeof calculateRiskSize>;
  entry?: number;
  sl?: number;
  tp?: number;
  llmVerdict?: { verdict: string; gate: "吉" | "中性" | "凶" } | null;
  reasons: string[];
}

export interface OrchestratorRunResult {
  fetchedAt: number;
  candidates: number;
  passedFunnel: number;
  executed: number;
  decisions: SymbolDecision[];
}

export async function runOrchestrator(ctx: OrchestratorContext): Promise<OrchestratorRunResult> {
  const screenerSignals = getSignals();
  // Top altcoins from in-house screener (already pre-ranked by signalStrength + type).
  const universe = [...screenerSignals]
    .sort((a, b) => (b.signalStrength ?? 0) - (a.signalStrength ?? 0))
    .slice(0, 30);
  const decisions: SymbolDecision[] = [];
  let executed = 0;

  for (const coin of universe) {
    const reasons: string[] = [];

    // kill-switch
    const gate = canOpenTrade();
    if (!gate.ok) {
      decisions.push({
        symbol: coin.symbol,
        side: "LONG",
        decision: "REJECT_NO_PLAN",
        funnel: { symbol: coin.symbol, passed: false, layers: [] },
        reasons: [gate.reason || "kill-switch blocked"],
      });
      continue;
    }

    // gather inputs in parallel
    const [tradeable, smc, qimen, funding] = await Promise.all([
      ctx.isBitunixTradeable(coin.symbol),
      extractSmcFeatures(coin.symbol, "1d", 120).catch(() => null),
      getQimenPan(coin.symbol).catch(() => null),
      ctx.getFundingRate(coin.symbol).catch(() => ({ rate: 0, signal: "NEUTRAL" as const })),
    ]);

    // detect setup (need klines)
    const klines = await bitunix.getKlines(coin.symbol, "1d", 120).catch(() => []);
    const setup = klines.length >= 30 ? await detectAltcoinSetup(coin.symbol, klines, "1d") : null;
    // Use screener side as primary (pre-spike screener already classified).
    const side: "LONG" | "SHORT" = coin.side ?? setup?.side ?? "LONG";

    // run funnel
    const funnel = runFunnel({
      symbol: coin.symbol,
      bitunixTradeable: tradeable,
      screener: {
        symbol: coin.symbol,
        signalStrength: coin.signalStrength,
        signalType: coin.signalType,
        side: coin.side,
      },
      fundingSignal: funding.signal,
      fundingRate: funding.rate,
      smc,
      qimen,
      side,
    });

    if (!funnel.passed) {
      decisions.push({
        symbol: coin.symbol,
        side,
        decision: "REJECT_FUNNEL",
        funnel,
        reasons: [`funnel failed at ${funnel.failedAt?.layer}: ${funnel.failedAt?.reason}`],
      });
      continue;
    }

    // grade
    if (!setup) {
      decisions.push({
        symbol: coin.symbol,
        side,
        decision: "REJECT_NO_PLAN",
        funnel,
        reasons: ["setup detector returned null (insufficient data)"],
      });
      continue;
    }
    const grade = gradeAltcoinSetup({ setup, qimen });
    if (!grade.passed) {
      decisions.push({
        symbol: coin.symbol,
        side,
        decision: "REJECT_GRADE",
        funnel,
        grade,
        reasons: grade.reasons,
      });
      continue;
    }

    // entry / stop / TP
    const es = await ctx.buildEntryStop(coin.symbol, side);
    if (!es) {
      decisions.push({
        symbol: coin.symbol,
        side,
        decision: "REJECT_NO_PLAN",
        funnel,
        grade,
        reasons: ["no entry/stop derivable"],
      });
      continue;
    }

    // spread / depth
    const sd = await checkSpreadAndDepth(coin.symbol);
    if (!sd.ok) {
      decisions.push({
        symbol: coin.symbol,
        side,
        decision: "REJECT_LIQUIDITY",
        funnel,
        grade,
        reasons: [`liquidity: ${sd.reason}`],
      });
      continue;
    }

    // sizing
    const equity = await ctx.getEquityUsd();
    const symbolMaxLevRaw = await fetchBitunixSymbolMaxLeverage(coin.symbol).catch(() => null);
    const symbolMaxLev = symbolMaxLevRaw ?? undefined;
    const baseRiskPct = 0.01 * grade.sizeMultiplier; // size multiplier (1.0 / 0.7 / 0.5)
    const sizing = calculateRiskSize({
      equityUsd: equity,
      riskPct: baseRiskPct,
      entry: es.entry,
      slPrice: es.stop,
      side,
      symbolMaxLeverage: symbolMaxLev,
    });

    // optional LLM verdict
    let llmVerdict: SymbolDecision["llmVerdict"] = null;
    if (ctx.getLlmVerdict) {
      try {
        llmVerdict = await ctx.getLlmVerdict({ symbol: coin.symbol, side, grade, funnel });
      } catch (err) {
        console.warn(`[orchestrator] LLM verdict failed for ${coin.symbol}:`, (err as Error).message);
      }
    }

    const decision: SymbolDecision["decision"] =
      grade.grade === "B" ? "HALF_SIZE" : "EXECUTE";

    const dec: SymbolDecision = {
      symbol: coin.symbol,
      side,
      decision,
      funnel,
      grade,
      sizing,
      entry: es.entry,
      sl: es.stop,
      tp: es.takeProfit,
      llmVerdict,
      reasons: [...grade.reasons, `decision=${decision}`],
    };
    decisions.push(dec);

    // record AI plan for variance tracking BEFORE execution
    try {
      const expectedR = Math.abs((es.takeProfit - es.entry) / (es.entry - es.stop));
      await recordPlan({
        tradeId: `${coin.symbol}-${Date.now()}`,
        symbol: coin.symbol,
        side,
        setupGrade: grade.grade as "A+" | "A" | "B" | "C",
        setupType: grade.setupType,
        qimenVerdict: llmVerdict?.verdict ?? "(no LLM verdict)",
        qimenGate: llmVerdict?.gate ?? "中性",
        plannedEntry: es.entry,
        plannedSl: es.stop,
        plannedTp: es.takeProfit,
        plannedQty: sizing.quantity,
        plannedLeverage: sizing.appliedLeverage,
        plannedNotionalUsd: sizing.notionalUsd,
        plannedRiskUsd: equity * baseRiskPct,
        expectedR,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[orchestrator] variance recordPlan failed:`, (err as Error).message);
    }

    await ctx.executeTrade(dec);
    recordOpen();
    executed++;
  }

  return {
    fetchedAt: Date.now(),
    candidates: screenerSignals.length,
    passedFunnel: decisions.filter((d) => d.funnel.passed).length,
    executed,
    decisions,
  };
}

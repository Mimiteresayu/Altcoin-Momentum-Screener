/**
 * Confluence Orchestrator
 * ------------------------
 * Top-level entry point for the auto-trade pipeline.
 *
 *   1. fetch Fire Dog snapshot
 *   2. for each symbol passing universe gate:
 *        a. fetch your existing FUEL + daily + SMC scores
 *        b. compute confluence
 *        c. if passes, build trade plan
 *        d. spread/depth gate → maker-first execute on Bitunix
 *        e. mirror to Pionex paper for parallel validation
 *   3. log everything to DB for backtest replay
 *
 * Runs on a 15-minute cron (matches Fire Dog refresh).
 */
import { getFireDogRankings, filterUniverse } from "../scrapers/firedog";
import { scoreConfluence } from "./score";
import { buildTradePlan } from "../risk/planner";
import { canOpenTrade, recordOpen } from "../risk/kill-switch";
import { checkSpreadAndDepth } from "../execution/spread-check";

export interface OrchestratorContext {
  /** Bridge to your existing screener; returns 0..100 */
  getFuelScore: (symbol: string) => Promise<number>;
  /** Daily bottom + breakout score 0..100 */
  getDailyScore: (symbol: string) => Promise<number>;
  /** SMC structure count (FVG/OB/BOS) */
  getSmcScore: (symbol: string) => Promise<number>;
  /** Current equity in USD */
  getEquityUsd: () => Promise<number>;
  /** Build entry/stop from latest candle data */
  buildEntryStop: (
    symbol: string
  ) => Promise<{ entry: number; stop: number; side: "LONG" | "SHORT" } | null>;
  /** Hook to your existing executor — receives final plan */
  executeTrade: (plan: any) => Promise<void>;
}

export interface OrchestratorRunResult {
  fetchedAt: number;
  candidates: number;
  passed: number;
  executed: number;
  rejected: Array<{ symbol: string; reason: string }>;
}

export async function runOrchestrator(ctx: OrchestratorContext): Promise<OrchestratorRunResult> {
  const fd = await getFireDogRankings();
  const universe = filterUniverse(fd.coins);
  const rejected: Array<{ symbol: string; reason: string }> = [];
  let executed = 0;

  for (const coin of universe) {
    const gate = canOpenTrade();
    if (!gate.ok) {
      rejected.push({ symbol: coin.symbol, reason: gate.reason || "blocked" });
      continue;
    }
    const [fuel, daily, smc] = await Promise.all([
      ctx.getFuelScore(coin.symbol),
      ctx.getDailyScore(coin.symbol),
      ctx.getSmcScore(coin.symbol),
    ]);
    const conf = await scoreConfluence({
      symbol: coin.symbol,
      firedog: coin,
      fuelScore: fuel,
      dailyBottomScore: daily,
      smcScore: smc,
    });
    if (!conf.passes) {
      rejected.push({ symbol: coin.symbol, reason: conf.reasons.join("; ") });
      continue;
    }
    // Spread / depth gate
    const sd = await checkSpreadAndDepth(coin.symbol);
    if (!sd.ok) {
      rejected.push({ symbol: coin.symbol, reason: `liquidity: ${sd.reason}` });
      continue;
    }
    const es = await ctx.buildEntryStop(coin.symbol);
    if (!es) {
      rejected.push({ symbol: coin.symbol, reason: "no entry/stop" });
      continue;
    }
    const equity = await ctx.getEquityUsd();
    const plan = buildTradePlan({
      symbol: coin.symbol,
      side: es.side,
      entry: es.entry,
      stop: es.stop,
      equityUsd: equity,
      childPlan: conf.childPlan,
    });
    await ctx.executeTrade({ plan, confluence: conf, liquidity: sd, firedog: coin });
    recordOpen();
    executed++;
  }

  return {
    fetchedAt: fd.fetchedAt,
    candidates: fd.coins.length,
    passed: universe.length,
    executed,
    rejected,
  };
}

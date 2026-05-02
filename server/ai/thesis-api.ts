/**
 * /api/ai/thesis?symbol=XXXUSDT  (rewritten v2)
 * ----------------------------------------------
 * Returns a single payload the cockpit needs to render the QimenSmcCard:
 *
 *   {
 *     symbol, side,
 *     funnel:   FunnelResult,         // 5-layer pass/skip
 *     grade:    AltcoinGradeResult,   // 6-factor grade + size multiplier
 *     verdict:  QimenSmcVerdict,      // LLM holistic analysis (Yung-style)
 *     sizing:   RiskSizerOutput,      // notional / qty / leverage / liq buffer
 *     entry, sl, tp,                  // execution parameters
 *     setupType, decision
 *   }
 *
 * Old endpoint returned a plain `thesis` (text) — replaced because cockpit
 * now needs structured data for funnel rail, factor grid, sizing chip, and
 * Bitunix TradingView overlay.
 */
import type { Request, Response } from "express";
import { getSignalBySymbol } from "../screener/signal-store";
import { getBitunixFundingRate } from "../exchanges/bitunix-public";
import { getOKXFundingRate } from "../okx";
import { calculateFundingAnomaly } from "../screener-enrichment";
import { getQimenPan } from "../qimen/sidecar";
import { extractSmcFeatures } from "../smc/features";
import { detectAltcoinSetup } from "../altcoin-setup/setup-detector";
import { gradeAltcoinSetup } from "../confluence/score";
import { runFunnel } from "../funnel/funnel-filter";
import { calculateRiskSize } from "../sizing/risk-sizer";
import { fetchBitunixSymbolMaxLeverage } from "../sizing/leverage-guard";
import { analyzeQimenSmc } from "./qimen-smc-analyst";
import { BitunixTradeService } from "../bitunix-trade";

const bitunix = new BitunixTradeService();
bitunix.initialize();

// Convenience derivation of entry/SL/TP from SMC features.
// Real production logic lives in risk/planner — this is the API-side default
// when the orchestrator hasn't provided one.
function deriveEntryStop(
  side: "LONG" | "SHORT",
  currentPrice: number,
  smc: { unfilledFvgs: Array<{ top: number; bottom: number; distancePct: number }>; range90d: { high: number; low: number } } | null
): { entry: number; stop: number; takeProfit: number } | null {
  if (!smc) return null;
  // pick nearest unfilled FVG as entry zone midpoint
  const fvgs = smc.unfilledFvgs.filter((f) => Math.abs(f.distancePct) <= 15);
  let entry = currentPrice;
  if (fvgs.length > 0) {
    fvgs.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
    entry = (fvgs[0].top + fvgs[0].bottom) / 2;
  }
  // SL: opposite range edge minus 1% buffer
  const stop = side === "LONG"
    ? smc.range90d.low * 0.99
    : smc.range90d.high * 1.01;
  // TP: 3R default (RR=3)
  const takeProfit = side === "LONG"
    ? entry + (entry - stop) * 3
    : entry - (stop - entry) * 3;
  return { entry, stop, takeProfit };
}

export async function getThesis(req: Request, res: Response) {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    if (!symbol) {
      res.status(400).json({ error: "symbol required" });
      return;
    }

    const coin = getSignalBySymbol(symbol);
    if (!coin) {
      res.status(404).json({
        error: `symbol ${symbol} not in current screener universe`,
      });
      return;
    }

    // gather inputs in parallel
    const [smc, qimen, klines] = await Promise.all([
      extractSmcFeatures(symbol, "1d", 120).catch(() => null),
      getQimenPan(symbol).catch(() => null),
      bitunix.getKlines(symbol, "1d", 120).catch(() => []),
    ]);

    // Funding: prefer enriched screener row (from OKX),
    // then OKX direct, then Bitunix public. All free, no CoinGlass.
    let fundingRate: number = 0;
    if (typeof (coin as any).fundingRate === "number") {
      fundingRate = (coin as any).fundingRate as number;
    } else {
      const base = symbol.replace(/USDT$/i, "");
      const okxRate = await getOKXFundingRate(base).catch(() => null);
      if (typeof okxRate === "number" && !Number.isNaN(okxRate)) {
        fundingRate = okxRate;
      } else {
        const fr = await getBitunixFundingRate(symbol).catch(() => null);
        fundingRate = fr?.fundingRate ?? 0;
      }
    }
    const fundingSignal = calculateFundingAnomaly(fundingRate).fundingSignal;

    const setup = klines.length >= 30
      ? await detectAltcoinSetup(symbol, klines, "1d")
      : null;
    // Prefer screener side; fall back to setup detector.
    const side: "LONG" | "SHORT" = (coin.side as "LONG" | "SHORT") ?? setup?.side ?? "LONG";

    // funnel
    const funnel = runFunnel({
      symbol,
      bitunixTradeable: true, // already in screener universe by construction
      screener: {
        symbol,
        signalStrength: coin.signalStrength,
        signalType: coin.signalType,
        side: coin.side as "LONG" | "SHORT" | undefined,
      },
      fundingSignal,
      fundingRate,
      smc,
      qimen,
      side,
    });

    // grade (only meaningful if funnel passed AND setup detected)
    const grade = setup ? gradeAltcoinSetup({ setup, qimen }) : null;

    // entry / sl / tp
    const es = smc
      ? deriveEntryStop(side, smc.currentPrice, smc)
      : null;

    // sizing (default $3,768.81 equity if not provided)
    const equity = parseFloat(process.env.DEFAULT_EQUITY_USD || "3768.81");
    const symbolMaxLevRaw = await fetchBitunixSymbolMaxLeverage(symbol).catch(() => null);
    const sizing = es
      ? calculateRiskSize({
          equityUsd: equity,
          riskPct: 0.01 * (grade?.sizeMultiplier ?? 1),
          entry: es.entry,
          slPrice: es.stop,
          side,
          symbolMaxLeverage: symbolMaxLevRaw ?? undefined,
        })
      : null;

    // LLM verdict
    let verdict = null;
    if (qimen && smc) {
      verdict = await analyzeQimenSmc({
        symbol,
        pan: qimen,
        smc,
        screenerContext: {
          firedogShort: coin.signalStrength * 20, // back-compat: rough mapping
          firedogLong: coin.signalStrength * 20,
          fuel: typeof coin.volumeSpikeRatio === "number" ? Math.min(100, coin.volumeSpikeRatio * 10) : 0,
          daily: typeof coin.priceChange24h === "number" ? Math.min(100, coin.priceChange24h) : 0,
          smcCount: smc.unfilledFvgs.length + smc.recentOrderBlocks.length,
          confluenceTotal: grade ? grade.factorCount * 16.6 : 0,
        },
        side,
      }).catch(() => null);
    }

    const decision = !funnel.passed
      ? "REJECT_FUNNEL"
      : !grade?.passed
      ? "REJECT_GRADE"
      : grade.grade === "B"
      ? "HALF_SIZE"
      : "EXECUTE";

    res.json({
      symbol,
      side,
      decision,
      funnel,
      grade,
      verdict,
      sizing,
      entry: es?.entry ?? null,
      sl: es?.stop ?? null,
      tp: es?.takeProfit ?? null,
      setupType: setup?.setupType ?? null,
      currentPrice: smc?.currentPrice ?? null,
      ictLocation: smc?.ictLocation ?? null,
      generatedAt: Date.now(),
    });
  } catch (e: any) {
    console.error("[thesis-api]", e);
    res.status(500).json({ error: e.message });
  }
}

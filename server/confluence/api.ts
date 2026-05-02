/**
 * Express route handlers for the confluence dashboard (v2).
 * ----------------------------------------------------------
 * /api/confluence/latest now returns the v2 schema:
 *   - funnel result (5-layer pass/skip)
 *   - grade (6-factor altcoin scoring)
 *   - sizing (notional / qty / leverage)
 *
 * Legacy fields (firedog/fuel/daily/qimen scores) are kept for backward
 * compat with existing dashboards but are derived from the new pipeline.
 */
import type { Request, Response } from "express";
import { getFireDogRankings, filterUniverse } from "../scrapers/firedog";
import { getKillSwitchState, manualClear } from "../risk/kill-switch";
import { extractSmcFeatures } from "../smc/features";
import { getQimenPan } from "../qimen/sidecar";
import { detectAltcoinSetup } from "../altcoin-setup/setup-detector";
import { gradeAltcoinSetup } from "./score";
import { runFunnel } from "../funnel/funnel-filter";
import { BitunixTradeService } from "../bitunix-trade";
import { getFundingRate as fetchFunding } from "../coinglass";
import { calculateFundingAnomaly } from "../screener-enrichment";

/** Pull funding rate from CoinGlass (V4) → Binance fallback, return rate + signal. */
async function getFundingForSymbol(symbol: string): Promise<{ rate: number; signal: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL" }> {
  try {
    const base = symbol.replace(/USDT$/i, "");
    const arr = await fetchFunding(base);
    if (!arr || arr.length === 0) return { rate: 0, signal: "NEUTRAL" };
    // pick Binance row first, otherwise first entry
    const row = arr.find((x) => x.exchange?.toLowerCase() === "binance") ?? arr[0];
    const rate = row.fundingRate ?? 0;
    const cls = calculateFundingAnomaly(rate);
    return { rate, signal: cls.fundingSignal };
  } catch {
    return { rate: 0, signal: "NEUTRAL" };
  }
}

const bitunix = new BitunixTradeService();
bitunix.initialize();

// In-memory cache for child-trade ledger; replace with DB.
const childLedger: any[] = [];

export async function getLatestConfluence(_req: Request, res: Response) {
  try {
    const fd = await getFireDogRankings();
    const universe = filterUniverse(fd.coins).slice(0, 20); // cap for perf
    const rows: any[] = [];

    for (const c of universe) {
      try {
        const [smc, qimen, klines, funding] = await Promise.all([
          extractSmcFeatures(c.symbol, "1d", 120).catch(() => null),
          getQimenPan(c.symbol).catch(() => null),
          bitunix.getKlines(c.symbol, "1d", 120).catch(() => []),
          getFundingForSymbol(c.symbol),
        ]);
        const setup = klines.length >= 30
          ? await detectAltcoinSetup(c.symbol, klines, "1d")
          : null;
        const side = setup?.side ?? "LONG";

        const funnel = runFunnel({
          symbol: c.symbol,
          bitunixTradeable: true,
          firedog: c,
          fundingSignal: funding.signal,
          fundingRate: funding.rate,
          smc,
          qimen,
          side,
        });

        const grade = setup ? gradeAltcoinSetup({ setup, qimen }) : null;

        rows.push({
          symbol: c.symbol,
          side,
          firedogShort: c.shortScore,
          firedogLong: c.longScore,
          funnelPassed: funnel.passed,
          failedAt: funnel.failedAt?.layer,
          factorCount: grade?.factorCount ?? 0,
          gradeLetter: grade?.grade ?? "—",
          sizeMultiplier: grade?.sizeMultiplier ?? 0,
          setupType: grade?.setupType ?? "—",
          ictLocation: smc?.ictLocation ?? "unknown",
          currentPrice: smc?.currentPrice ?? null,
          qimenDoor: qimen?.yongshen_cell.door ?? null,
        });
      } catch (err: any) {
        rows.push({
          symbol: c.symbol,
          error: err.message,
          firedogShort: c.shortScore,
          firedogLong: c.longScore,
          funnelPassed: false,
        });
      }
    }
    res.json({ rows, fetchedAt: fd.fetchedAt, stale: fd.stale });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export function getKillState(_req: Request, res: Response) {
  const s = getKillSwitchState();
  res.json({
    ...s,
    tradingEnabled: (process.env.TRADING_ENABLED ?? "false") === "true",
  });
}

export function clearKill(_req: Request, res: Response) {
  manualClear();
  res.json({ ok: true });
}

export function getChildTrades(_req: Request, res: Response) {
  res.json({ rows: childLedger });
}

export function pushChild(child: any) {
  childLedger.unshift(child);
  if (childLedger.length > 200) childLedger.pop();
}

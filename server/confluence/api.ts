/**
 * Express route handlers for the cockpit confluence dashboard (v3).
 * -----------------------------------------------------------------
 * Universe is now sourced from the **in-house pre-spike screener**
 * (`server/screener/signal-store.ts`). Fire Dog has been retired —
 * one screener for the whole system.
 *
 * Pipeline per coin:
 *   1. screener row    (signalStrength, side)
 *   2. funding rate    (CoinGlass V4 → Binance fallback)
 *   3. SMC features    (FVG / structure / ICT location)
 *   4. Qimen pan       (kinqimen sidecar @ port 8765)
 *   5. setup detector  (cup / squeeze / vol / sweep / breakout)
 *   6. funnel filter   (binary L1-L5)
 *   7. 6-factor grade  (A+/A/B/C/REJECT)
 */
import type { Request, Response } from "express";
import { getKillSwitchState, manualClear } from "../risk/kill-switch";
import { extractSmcFeatures } from "../smc/features";
import { getQimenPan } from "../qimen/sidecar";
import { detectAltcoinSetup } from "../altcoin-setup/setup-detector";
import { gradeAltcoinSetup } from "./score";
import { runFunnel } from "../funnel/funnel-filter";
import { BitunixTradeService } from "../bitunix-trade";
import { getFundingRate as fetchFunding } from "../coinglass";
import { calculateFundingAnomaly } from "../screener-enrichment";
import { getSignals, getSignalsUpdatedAt } from "../screener/signal-store";

/** Pull funding rate from CoinGlass (V4) → Binance fallback, return rate + signal. */
async function getFundingForSymbol(symbol: string): Promise<{
  rate: number;
  signal: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL";
}> {
  try {
    const base = symbol.replace(/USDT$/i, "");
    const arr = await fetchFunding(base);
    if (!arr || arr.length === 0) return { rate: 0, signal: "NEUTRAL" };
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

/** In-memory cache for child-trade ledger; replace with DB. */
const childLedger: any[] = [];

export async function getLatestConfluence(_req: Request, res: Response) {
  try {
    const screenerSignals = getSignals();
    if (screenerSignals.length === 0) {
      return res.json({
        rows: [],
        fetchedAt: null,
        stale: true,
        note: "Screener has not produced any signals yet. Wait for the next refresh.",
      });
    }

    // Cap at top 20 strongest for cockpit perf.
    const universe = [...screenerSignals]
      .sort((a, b) => (b.signalStrength ?? 0) - (a.signalStrength ?? 0))
      .slice(0, 20);

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
        // Use screener side as primary; setup-detector side is informational.
        const side: "LONG" | "SHORT" = c.side ?? setup?.side ?? "LONG";

        const funnel = runFunnel({
          symbol: c.symbol,
          bitunixTradeable: true,
          screener: {
            symbol: c.symbol,
            signalStrength: c.signalStrength,
            signalType: c.signalType,
            side: c.side,
          },
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
          signalType: c.signalType,
          signalStrength: c.signalStrength,
          funnelPassed: funnel.passed,
          failedAt: funnel.failedAt?.layer,
          factorCount: grade?.factorCount ?? 0,
          gradeLetter: grade?.grade ?? "—",
          sizeMultiplier: grade?.sizeMultiplier ?? 0,
          setupType: grade?.setupType ?? "—",
          ictLocation: smc?.ictLocation ?? "unknown",
          currentPrice: smc?.currentPrice ?? c.currentPrice ?? null,
          qimenDoor: qimen?.yongshen_cell.door ?? null,
        });
      } catch (err: any) {
        rows.push({
          symbol: c.symbol,
          error: err.message,
          signalType: c.signalType,
          signalStrength: c.signalStrength,
          funnelPassed: false,
        });
      }
    }
    res.json({
      rows,
      fetchedAt: getSignalsUpdatedAt()?.toISOString() ?? null,
      stale: false,
    });
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

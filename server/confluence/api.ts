/**
 * Express route handlers for the confluence dashboard.
 * Wire these into routes.ts.
 */
import type { Request, Response } from "express";
import { getFireDogRankings, filterUniverse } from "../scrapers/firedog";
import { scoreConfluence } from "./score";
import { getKillSwitchState, manualClear } from "../risk/kill-switch";

// In-memory cache for child-trade ledger; replace with DB.
const childLedger: any[] = [];

export async function getLatestConfluence(_req: Request, res: Response) {
  try {
    const fd = await getFireDogRankings();
    const universe = filterUniverse(fd.coins).slice(0, 40);
    const rows: any[] = [];
    for (const c of universe) {
      // Stub external scores — replace with real calls into your screener
      const fuel = Math.min(100, c.shortScore + Math.random() * 10);
      const daily = Math.min(100, c.shortScore - 5 + Math.random() * 15);
      const smc = Math.floor(Math.random() * 4) + 1; // 1..4
      const conf = await scoreConfluence({
        symbol: c.symbol,
        firedog: c,
        fuelScore: fuel,
        dailyBottomScore: daily,
        smcScore: smc,
      });
      rows.push({
        symbol: c.symbol,
        firedogShort: c.shortScore,
        firedogLong: c.longScore,
        fuel,
        daily,
        smc,
        qimen: conf.components.qimen,
        total: conf.total,
        childPlan: conf.childPlan,
      });
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

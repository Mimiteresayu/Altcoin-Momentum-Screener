/**
 * /api/ai/thesis?symbol=XXXUSDT
 * --------------------------------
 * Reuses the same Fire Dog + confluence pipeline as /api/confluence/latest
 * to fetch the row for a given symbol, then runs generateThesis().
 *
 * Cached at the thesis-generator level (30min, keyed by score bucket).
 */
import type { Request, Response } from "express";
import { getFireDogRankings, filterUniverse } from "../scrapers/firedog";
import { scoreConfluence } from "../confluence/score";
import { generateThesis } from "./thesis-generator";

export async function getThesis(req: Request, res: Response) {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    if (!symbol) {
      res.status(400).json({ error: "symbol required" });
      return;
    }

    const fd = await getFireDogRankings();
    const universe = filterUniverse(fd.coins);
    const c = universe.find((x) => x.symbol.toUpperCase() === symbol);
    if (!c) {
      res.status(404).json({ error: `symbol ${symbol} not in universe (second-screener short_score >= 80 gate)` });
      return;
    }

    // Mirror api.ts stub: replace with real fuel/daily/smc when wired
    const fuel = Math.min(100, c.shortScore + Math.random() * 10);
    const daily = Math.min(100, c.shortScore - 5 + Math.random() * 15);
    const smc = Math.floor(Math.random() * 4) + 1;

    const conf = await scoreConfluence({
      symbol: c.symbol,
      firedog: c,
      fuelScore: fuel,
      dailyBottomScore: daily,
      smcScore: smc,
    });

    const thesis = await generateThesis({
      symbol: c.symbol,
      firedogShort: c.shortScore,
      firedogLong: c.longScore,
      fuel,
      daily,
      smc,
      total: conf.total,
      childPlan: conf.childPlan,
    });

    if (!thesis) {
      res.status(503).json({ error: "thesis generation failed (LLM unavailable)" });
      return;
    }
    res.json(thesis);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

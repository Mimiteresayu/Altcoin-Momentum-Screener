/**
 * Trade Thesis Generator
 * -----------------------
 * Combines:
 *   - Confluence breakdown (Fire Dog short/long, FUEL, Daily, SMC)
 *   - Qimen explanation (from qimen-explainer)
 *   - Recent 24h news (Sonar)
 *   - Setup classification (Gemini Flash-Lite, free)
 * → DeepSeek V4-Flash → structured trade thesis JSON.
 *
 * Caching: 30min unless score change > 5%.
 */
import { callDeepSeek } from "./deepseek";
import { callGemini } from "./gemini";
import { searchSonar } from "./sonar";
import { explainQimen } from "./qimen-explainer";
import { cacheGet, cacheSet } from "./cache";

export interface ThesisInput {
  symbol: string;
  firedogShort: number;
  firedogLong: number;
  fuel: number;
  daily: number;
  smc: number;
  total: number;
  childPlan: { SCALPER: boolean; SNIPER: boolean; SWING: boolean; RUNNER: boolean };
  entry?: number;
  stop?: number;
  side?: "LONG" | "SHORT";
}

export interface TradeThesis {
  symbol: string;
  setupType: string;          // breakout / reversal / continuation
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;          // 0..100
  rationale: string;           // 2-3 sentences
  qimen: {
    pan: string;
    yongshen: string;
    explanation: string;
    direction: string;
    confidence: number;
  };
  news: {
    summary: string;
    citations: string[];
  };
  risks: string[];
  generatedAt: number;
  cacheKey: string;
}

async function classifySetup(input: ThesisInput): Promise<string> {
  // Use FREE Gemini for cheap classification
  const r = await callGemini({
    prompt: `Symbol: ${input.symbol}
FUEL: ${input.fuel} | Daily: ${input.daily} | SMC: ${input.smc} | Fire Dog short: ${input.firedogShort}

Classify the most likely setup type in ONE WORD: "breakout" / "reversal" / "continuation" / "ranging". Reply with only the word.`,
    temperature: 0.1,
    maxTokens: 20,
    cacheKey: `setup:${input.symbol}:${Math.round(input.total / 5) * 5}`,
    cacheTtlMs: 30 * 60 * 1000,
  });
  return r?.text.trim().toLowerCase().split(/\s+/)[0] || "breakout";
}

async function fetchNews(symbol: string): Promise<{ summary: string; citations: string[] }> {
  const tokenName = symbol.replace(/USDT$|USDC$|BUSD$/i, "");
  const r = await searchSonar({
    query: `Latest 24-hour news, catalysts, or significant events for ${tokenName} crypto token. Focus on price-moving news only. 2-3 sentences max.`,
    cacheKey: `news:${tokenName}`,
    cacheTtlMs: 60 * 60 * 1000,
  });
  if (!r) return { summary: "No recent news available.", citations: [] };
  return { summary: r.text, citations: r.citations };
}

export async function generateThesis(input: ThesisInput): Promise<TradeThesis | null> {
  const cacheKey = `thesis:${input.symbol}:${Math.round(input.total / 5) * 5}`;
  const hit = cacheGet<TradeThesis>(cacheKey);
  if (hit) return hit;

  const [setupType, qimen, news] = await Promise.all([
    classifySetup(input),
    explainQimen(input.symbol),
    fetchNews(input.symbol),
  ]);

  const SYSTEM = `You are a crypto futures trading analyst. Output ONLY valid JSON, no other text.
Schema:
{
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": 0-100,
  "rationale": "2-3 sentences in mixed Cantonese/English explaining WHY this trade",
  "risks": ["risk1", "risk2"]
}`;

  const userMsg = `Token: ${input.symbol}
Setup: ${setupType}
Confluence breakdown:
- Fire Dog short_score: ${input.firedogShort} (gate >= 80)
- Fire Dog long_score: ${input.firedogLong}
- Altcoin Screener FUEL: ${input.fuel}
- Daily bottom + vol: ${input.daily}
- SMC structures: ${input.smc}
- Total: ${input.total}/100

Qimen 奇門:
- 局: ${qimen?.rawPan || "n/a"}
- 用神: ${qimen?.rawYongshen || "n/a"}
- 解: ${qimen?.explanation || "n/a"}
- direction: ${qimen?.direction || "NEUTRAL"} (conf ${(qimen?.confidence ?? 0).toFixed(2)})

24h News:
${news.summary}

Active children: ${Object.entries(input.childPlan).filter(([_, v]) => v).map(([k]) => k).join(", ")}
${input.entry ? `Entry: ${input.entry} | Stop: ${input.stop} | Side: ${input.side}` : ""}

Generate the trade thesis JSON.`;

  const r = await callDeepSeek({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg },
    ],
    temperature: 0.4,
    maxTokens: 500,
    jsonMode: true,
  });

  if (!r) return null;

  let parsed: any = {};
  try {
    parsed = JSON.parse(r.text);
  } catch {
    parsed = { bias: "NEUTRAL", confidence: 50, rationale: r.text.slice(0, 300), risks: [] };
  }

  const thesis: TradeThesis = {
    symbol: input.symbol,
    setupType,
    bias: (parsed.bias || "NEUTRAL").toUpperCase(),
    confidence: Math.max(0, Math.min(100, parseFloat(parsed.confidence) || 50)),
    rationale: parsed.rationale || "",
    qimen: {
      pan: qimen?.rawPan || "",
      yongshen: qimen?.rawYongshen || "",
      explanation: qimen?.explanation || "",
      direction: qimen?.direction || "NEUTRAL",
      confidence: qimen?.confidence ?? 0.5,
    },
    news,
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    generatedAt: Date.now(),
    cacheKey,
  };

  cacheSet(cacheKey, thesis, 30 * 60 * 1000);
  return thesis;
}

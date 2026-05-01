/**
 * Qimen 奇門遁甲 explainer (DeepSeek V4-Pro for deep analysis OR V4-Flash if cost gating).
 *
 * Pulls the raw 局/yongshen from sidecar.py, then asks DeepSeek to:
 *   - 解釋當前局 (1-2 sentences, 中文)
 *   - 結合 symbol 名 (e.g. ZEREBROUSDT) 判斷 LONG/SHORT 優勢
 *   - 給出 0..1 confidence
 *
 * Cached 2hr (Qimen 局 changes per shichen ~2hr).
 */
import { callDeepSeek } from "./deepseek";
import { getQimenScore } from "../qimen/sidecar";

export interface QimenExplanation {
  rawScore: number;
  rawPan: string;
  rawYongshen: string;
  explanation: string;       // 1-2 sentence Chinese
  direction: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;        // 0..1
  cached: boolean;
}

const SYSTEM = `你係專業奇門遁甲分析師, 同時熟悉加密貨幣交易。
任務: 根據當前奇門局 + 用神 + symbol 給出 1-2 句中文解釋, 然後判斷做多 (LONG) 或做空 (SHORT) 嘅優勢。
輸出必須係 JSON 格式:
{
  "explanation": "1-2 句中文, 解釋當前局對呢個 symbol 嘅 implication",
  "direction": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": 0.0-1.0
}
唔好包含其他文字。`;

export async function explainQimen(symbol: string): Promise<QimenExplanation | null> {
  const raw = await getQimenScore(symbol);
  if (!raw) return null;

  const userMsg = `Symbol: ${symbol}
當前局: ${raw.pan}
用神: ${raw.yongshen}
原始評分: ${raw.score.toFixed(2)} (favorable=${raw.favorable})

請根據呢個局解釋對 ${symbol} 嘅交易意義, 並判斷 LONG/SHORT/NEUTRAL。`;

  const r = await callDeepSeek({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg },
    ],
    temperature: 0.3,
    maxTokens: 250,
    jsonMode: true,
    usePro: true, // Qimen quality matters → use V4-Pro if enabled
    cacheKey: `qimen:${symbol}:${raw.pan}`,
    cacheTtlMs: 2 * 60 * 60 * 1000, // 2hr
  });

  if (!r) {
    // Fallback to raw sidecar score with no LLM
    return {
      rawScore: raw.score,
      rawPan: raw.pan,
      rawYongshen: raw.yongshen,
      explanation: `局: ${raw.pan}, 用神: ${raw.yongshen} (LLM unavailable)`,
      direction: raw.favorable ? "LONG" : "NEUTRAL",
      confidence: raw.score,
      cached: false,
    };
  }

  try {
    const parsed = JSON.parse(r.text);
    return {
      rawScore: raw.score,
      rawPan: raw.pan,
      rawYongshen: raw.yongshen,
      explanation: parsed.explanation || "",
      direction: (parsed.direction || "NEUTRAL").toUpperCase(),
      confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || raw.score)),
      cached: r.cached,
    };
  } catch (e) {
    return {
      rawScore: raw.score,
      rawPan: raw.pan,
      rawYongshen: raw.yongshen,
      explanation: r.text.slice(0, 200),
      direction: raw.favorable ? "LONG" : "NEUTRAL",
      confidence: raw.score,
      cached: r.cached,
    };
  }
}

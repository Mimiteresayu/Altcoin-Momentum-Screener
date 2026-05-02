/**
 * DeepSeek V4-Flash client (cheap, fast).
 * V4-Pro reserved for Qimen if DEEPSEEK_PRO_FOR_QIMEN=true.
 *
 * Pricing (May 2026):
 *   V4-Flash: $0.14 input / $0.28 output per 1M tok
 *   V4-Pro:   $0.435 / $0.87 per 1M tok (75% off through May 31)
 *
 * Endpoint: https://api.deepseek.com/v1/chat/completions (OpenAI-compatible)
 */
import { cacheGet, cacheSet } from "./cache";

const BASE = "https://api.deepseek.com/v1";
const FLASH = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";
const PRO_FOR_QIMEN = (process.env.DEEPSEEK_PRO_FOR_QIMEN_ONLY ?? "false") === "true";

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekCallOpts {
  messages: DeepSeekMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  usePro?: boolean;       // override to use V4-Pro
  cacheKey?: string;
  cacheTtlMs?: number;
}

export interface DeepSeekResponse {
  text: string;
  usage?: { promptTokens: number; completionTokens: number };
  model: string;
  cached: boolean;
}

export async function callDeepSeek(opts: DeepSeekCallOpts): Promise<DeepSeekResponse | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.warn("[DEEPSEEK] no API key, skipping");
    return null;
  }

  // Cache check
  if (opts.cacheKey) {
    const hit = cacheGet<DeepSeekResponse>(opts.cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const model = opts.usePro && PRO_FOR_QIMEN ? PRO : FLASH;
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 800,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[DEEPSEEK]", r.status, t.slice(0, 200));
      return null;
    }
    const j: any = await r.json();
    const text: string = j.choices?.[0]?.message?.content || "";
    const result: DeepSeekResponse = {
      text,
      usage: j.usage
        ? { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens }
        : undefined,
      model,
      cached: false,
    };
    if (opts.cacheKey && opts.cacheTtlMs) {
      cacheSet(opts.cacheKey, result, opts.cacheTtlMs);
    }
    return result;
  } catch (e) {
    console.error("[DEEPSEEK] fetch error", e);
    return null;
  }
}

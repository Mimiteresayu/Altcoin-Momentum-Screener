/**
 * Gemini 2.5 Flash-Lite — free fallback (15 RPM, 1000 RPD).
 * Use for: setup classification, primary fallback when DeepSeek fails.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */
import { cacheGet, cacheSet } from "./cache";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-2.5-flash-lite";

export interface GeminiOpts {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  cacheKey?: string;
  cacheTtlMs?: number;
}

export interface GeminiResponse {
  text: string;
  cached: boolean;
}

export async function callGemini(opts: GeminiOpts): Promise<GeminiResponse | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  if (opts.cacheKey) {
    const hit = cacheGet<GeminiResponse>(opts.cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  try {
    const r = await fetch(`${BASE}/models/${MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
        ...(opts.systemInstruction
          ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } }
          : {}),
        generationConfig: {
          temperature: opts.temperature ?? 0.4,
          maxOutputTokens: opts.maxTokens ?? 600,
        },
      }),
    });
    if (!r.ok) {
      console.warn("[GEMINI]", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const j: any = await r.json();
    const text: string = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const result: GeminiResponse = { text, cached: false };
    if (opts.cacheKey && opts.cacheTtlMs) cacheSet(opts.cacheKey, result, opts.cacheTtlMs);
    return result;
  } catch (e) {
    console.error("[GEMINI]", e);
    return null;
  }
}

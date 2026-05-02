/**
 * Perplexity Sonar — news + sentiment with citations.
 *
 * Two modes:
 *   1. USE_BUILTIN_SONAR=true → use Perplexity API key supplied by Computer
 *      (set in env as PPLX_BUILTIN_KEY by deployment).
 *   2. USE_BUILTIN_SONAR=false → user supplies own PPLX_API_KEY.
 *
 * Used only for: 24h news headlines for top 3-5 selected coins. Heavily cached (1hr).
 */
import { cacheGet, cacheSet } from "./cache";

const BASE = "https://api.perplexity.ai";
const MODEL = "sonar"; // base sonar = cheapest tier

export interface SonarSearchOpts {
  query: string;
  systemPrompt?: string;
  cacheKey?: string;
  cacheTtlMs?: number;
}

export interface SonarResponse {
  text: string;
  citations: string[];
  cached: boolean;
}

export async function searchSonar(opts: SonarSearchOpts): Promise<SonarResponse | null> {
  const apiKey =
    (process.env.USE_BUILTIN_SONAR === "true" ? process.env.PPLX_BUILTIN_KEY : null) ||
    process.env.PPLX_API_KEY;
  if (!apiKey) return null;

  if (opts.cacheKey) {
    const hit = cacheGet<SonarResponse>(opts.cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
          { role: "user", content: opts.query },
        ],
        temperature: 0.2,
        return_citations: true,
        search_recency_filter: "day",
      }),
    });
    if (!r.ok) {
      console.warn("[SONAR]", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const j: any = await r.json();
    const text = j.choices?.[0]?.message?.content || "";
    const citations: string[] = j.citations || [];
    const result: SonarResponse = { text, citations, cached: false };
    if (opts.cacheKey && opts.cacheTtlMs) cacheSet(opts.cacheKey, result, opts.cacheTtlMs);
    return result;
  } catch (e) {
    console.error("[SONAR]", e);
    return null;
  }
}

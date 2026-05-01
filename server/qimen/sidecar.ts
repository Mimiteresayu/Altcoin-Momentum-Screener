/**
 * Qimen Sidecar Client
 * ---------------------
 * Wraps the Python kinqimen notebook (qmdj.ipynb) as an HTTP service.
 * Run sidecar with: `python server/qimen/sidecar.py`  (port 8765)
 *
 * Returns 0–1 normalized score. NEVER a veto — only a confluence weight.
 * Rationale: no academic backing for QMDJ; treat as feature, not filter.
 */

const URL = process.env.QIMEN_SIDECAR_URL || "http://localhost:8765";
const ENABLED = (process.env.QIMEN_ENABLED ?? "true") === "true";

export interface QimenScore {
  score: number;          // 0..1
  pan: string;            // 局號
  yongshen: string;       // 用神
  favorable: boolean;
  details?: Record<string, any>;
}

const cache = new Map<string, { score: QimenScore; at: number }>();
const TTL_MS = 60 * 60 * 1000; // 1h — Qimen 局 changes per shichen (~2h)

export async function getQimenScore(symbol: string): Promise<QimenScore | null> {
  if (!ENABLED) return { score: 0.5, pan: "disabled", yongshen: "-", favorable: true };
  const now = Date.now();
  const k = symbol;
  const c = cache.get(k);
  if (c && now - c.at < TTL_MS) return c.score;

  try {
    const r = await fetch(`${URL}/score?symbol=${encodeURIComponent(symbol)}`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) {
      console.warn("[QIMEN] sidecar status", r.status);
      return { score: 0.5, pan: "fallback", yongshen: "-", favorable: true };
    }
    const j = (await r.json()) as QimenScore;
    cache.set(k, { score: j, at: now });
    return j;
  } catch (e) {
    console.warn("[QIMEN] unreachable, using neutral 0.5");
    return { score: 0.5, pan: "offline", yongshen: "-", favorable: true };
  }
}

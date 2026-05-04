/**
 * Qimen Sidecar Client (RAW PAN — LLM owns judgment)
 * ---------------------------------------------------
 * Talks to the FastAPI sidecar deployed as a separate Railway service.
 *
 * Sidecar endpoints (qimen_deploy.py):
 *   GET /health   → {kinqimen_loaded, lon, ...}
 *   GET /pan/now  → full structured pan + patterns at "now" UTC
 *   GET /pan?year=&month=&day=&hour=&minute=
 *
 * Env:
 *   QIMEN_URL          — preferred (e.g. https://qimen-sidecar.up.railway.app)
 *   QIMEN_SIDECAR_URL  — legacy fallback
 *
 * The pan applies to a 時辰 (~2 hours), so ALL symbols share the same pan.
 * That means we cache ONCE globally per TTL window, not per symbol.
 *
 * Hard fallback when sidecar unreachable: return null. The funnel still
 * functions on numeric gates; LLM thesis simply gets a "no qimen reading"
 * note instead of a real pan.
 */

const URL =
  process.env.QIMEN_URL ||
  process.env.QIMEN_SIDECAR_URL ||
  "http://localhost:8765";
const ENABLED = (process.env.QIMEN_ENABLED ?? "true") === "true";
const TIMEOUT_MS = Number(process.env.QIMEN_TIMEOUT_MS || 3000);

export interface QimenPalaceCell {
  palace_num: number;
  door: string;       // 八門 — 開/休/生/傷/杜/景/死/驚
  star: string;       // 九星 — 蓬/任/沖/輔/英/芮/禽/柱/心
  god: string;        // 八神 — 符/蛇/陰/合/勾/雀/地/天
  tianpan: string;    // 天盤干
  dipan: string;      // 地盤干
}

export interface QimenPattern {
  trigram: string;
  palace_num: number;
  door: string;
  star: string;
  god: string;
  good_count: number;
  is_triple: boolean;       // 三吉同宮
  has_maxing: boolean;      // 馬星落宮
  is_shikong: boolean;      // 旬空落宮
  tags: string[];           // 中文 labels
}

export interface QimenPan {
  kinqimen_loaded: boolean;
  utc: string;
  tst: string;
  lon: number;
  ganzhi: string;           // 干支 — 八字四柱
  xunshou: string;          // 旬首
  paiju: string;            // 排局 — e.g. "陽遁五局上元"
  jieqi: string;            // 節氣
  palace: Record<string, QimenPalaceCell>;
  shikong: string[];        // 旬空地支 list
  maxing: string;           // 驛馬地支
  patterns: QimenPattern[]; // sorted by good_count desc
  error?: string;

  // ---- Legacy compatibility shim (synthesised client-side from the top
  // pattern). Old callers expect yongshen_palace / yongshen_cell / pan_raw.
  yongshen_palace?: string;
  yongshen_cell?: {
    trigram: string;
    palace_num: number;
    door: string;
    star: string;
    god: string;
    tian_gan: string;
    di_gan: string;
  };
  pan_raw?: any;
}

// Single global cache — pan is time-based, same for every symbol
let panCache: { pan: QimenPan; at: number } | null = null;
const TTL_MS = 30 * 60 * 1000; // 30min — refresh well before 2h shichen

export async function getQimenPan(_symbol?: string): Promise<QimenPan | null> {
  if (!ENABLED) return null;
  const now = Date.now();
  if (panCache && now - panCache.at < TTL_MS) return panCache.pan;

  try {
    const r = await fetch(`${URL}/pan/now`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn("[QIMEN] sidecar status", r.status);
      return null;
    }
    const j = (await r.json()) as QimenPan;
    if (!j.kinqimen_loaded) {
      console.warn("[QIMEN] sidecar reports kinqimen not loaded:", j.error);
      return null;
    }
    // Legacy shim — synthesise yongshen_* from top pattern so older callers
    // (funnel, score, trailing) keep working without per-symbol pans.
    const top = j.patterns?.[0];
    if (top) {
      const cell = j.palace?.[top.trigram];
      j.yongshen_palace = top.trigram;
      j.yongshen_cell = {
        trigram: top.trigram,
        palace_num: top.palace_num,
        door: top.door,
        star: top.star,
        god: top.god,
        tian_gan: cell?.tianpan ?? "",
        di_gan: cell?.dipan ?? "",
      };
    }
    j.pan_raw = {
      干支: j.ganzhi,
      旬首: j.xunshou,
      排局: j.paiju,
      節氣: j.jieqi,
      旬空: j.shikong,
      馬星: j.maxing,
      宮: j.palace,
      格局: j.patterns,
    };
    panCache = { pan: j, at: now };
    return j;
  } catch (e) {
    console.warn("[QIMEN] sidecar unreachable:", (e as Error).message);
    return null;
  }
}

/** Pick the strongest palace by good_count + maxing + not-shikong. */
export function topPattern(pan: QimenPan | null): QimenPattern | null {
  if (!pan?.patterns?.length) return null;
  return pan.patterns[0]; // already sorted in sidecar
}

/** Top palace's door (or null) — used as a quick UI hint. */
export function topDoor(pan: QimenPan | null): string | null {
  const t = topPattern(pan);
  return t?.door || null;
}

/**
 * Format pan for LLM consumption — Python-dict-repr style matching how Yung
 * pastes pans into Gemini/DeepSeek. Reformatting degrades interpretation
 * quality on calibrated models.
 */
export function formatPanForLLM(pan: QimenPan): string {
  // Build the dict the way kinqimen pretty-prints it
  const compact = {
    干支: pan.ganzhi,
    旬首: pan.xunshou,
    排局: pan.paiju,
    節氣: pan.jieqi,
    旬空: pan.shikong,
    馬星: pan.maxing,
    宮: pan.palace,
    格局: pan.patterns.filter((p) => p.tags.length).map((p) => ({
      宮: p.trigram,
      標籤: p.tags,
      門星神: `${p.door}|${p.star}|${p.god}`,
    })),
  };
  const json = JSON.stringify(compact, null, 1);
  return json.replace(/"/g, "'");
}

/** Legacy alias — kept for older callers. */
export function summarizePan(pan: QimenPan): string {
  return formatPanForLLM(pan);
}

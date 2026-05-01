/**
 * Qimen Sidecar Client (RAW PAN — LLM owns judgment)
 * ---------------------------------------------------
 * Wraps Yuth's CTC_KinQimen logic via Python sidecar (sidecar.py, port 8765).
 *
 * NEW ARCHITECTURE (post-2026-05-01 pivot):
 *   - No numeric score. Sidecar returns the full raw 9-palace pan.
 *   - LLM (DeepSeek/Gemini) consumes pan + SMC features and produces
 *     holistic judgment in Yung's interpretive style.
 *
 * Hard fallback when sidecar unreachable: return null. Caller treats null
 * as "no qimen reading available" — confluence engine can still trade on
 * numeric gates alone if QIMEN_LLM_MODE != gate.
 */

const URL = process.env.QIMEN_SIDECAR_URL || "http://localhost:8765";
const ENABLED = (process.env.QIMEN_ENABLED ?? "true") === "true";

export interface YongshenCell {
  trigram: string;
  palace_num: number;
  door: string;       // 八門 — 開/休/生/傷/杜/景/死/驚
  god: string;        // 八神 — 符/蛇/陰/合/勾/雀/地/天
  star: string;       // 九星 — 蓬/任/沖/輔/英/芮/禽/柱/心
  tian_gan: string;   // 天盤干
  di_gan: string;     // 地盤干
  changsheng: Record<string, string>;  // {gan: 長生狀態}
}

export interface QimenPan {
  symbol: string;
  yongshen_palace: string;            // trigram name (e.g. "離")
  yongshen_cell: YongshenCell;
  pailu: string;                      // 排局 — e.g. "陽遁五局中元"
  ganzhi: string;                     // 干支
  jieqi: string;                      // 節氣
  zhifuzhishi: any;                   // 值符值使
  tianyi: string;                     // 天乙
  mash: any;                          // 馬星
  xunshou: string;                    // 旬首
  xunkong: any;                       // 旬空
  pan_raw: any;                       // full 9-palace dict for LLM
  meta: { tst: string; lon: number };
}

const cache = new Map<string, { pan: QimenPan; at: number }>();
const TTL_MS = 60 * 60 * 1000; // 1h — Qimen 局 changes per shichen (~2h)

export async function getQimenPan(symbol: string): Promise<QimenPan | null> {
  if (!ENABLED) return null;
  const now = Date.now();
  const c = cache.get(symbol);
  if (c && now - c.at < TTL_MS) return c.pan;

  try {
    const r = await fetch(`${URL}/score?symbol=${encodeURIComponent(symbol)}`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.warn("[QIMEN] sidecar status", r.status);
      return null;
    }
    const j = (await r.json()) as QimenPan;
    cache.set(symbol, { pan: j, at: now });
    return j;
  } catch (e) {
    console.warn("[QIMEN] sidecar unreachable:", (e as Error).message);
    return null;
  }
}

/**
 * Format pan for LLM consumption — Python-dict-repr style, EXACTLY matching
 * how Yung pastes pans into Gemini/DeepSeek in his WhatsApp dialogues.
 *
 * Yung's verified format (from 5 reference dialogues):
 *   {'排盤方式': '拆補',
 *    '干支': '丙午年壬辰月戊辰日丙辰時',
 *    '旬首': '戊',
 *    '旬空': {'日空': '戌亥', '時空': '子丑'},
 *    '局日': '戊癸日',
 *    '排局': '陽遁五局上元',
 *    '節氣': '穀雨',
 *    ...
 *   }
 *
 * DO NOT reformat into markdown / table / condensed style — DeepSeek V4-Pro
 * and Gemini 2.5 are already calibrated on this exact Python pretty-print
 * format. Reformatting degrades interpretation quality.
 */
export function formatPanForLLM(pan: QimenPan): string {
  // pan_raw is the full dict returned by kinqimen.Qimen(...).pan(1)
  // Convert JSON.stringify output → Python dict repr (single quotes)
  const json = JSON.stringify(pan.pan_raw, null, 1);
  // Replace JSON double-quotes with Python single-quotes for keys + string values
  // (kinqimen output has no embedded apostrophes in CJK strings, so safe substitution)
  return json.replace(/"/g, "'");
}

/**
 * @deprecated Use formatPanForLLM. Kept for any legacy caller; will be removed.
 */
export function summarizePan(pan: QimenPan): string {
  return formatPanForLLM(pan);
}

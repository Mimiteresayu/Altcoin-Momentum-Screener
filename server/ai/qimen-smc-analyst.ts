/**
 * Qimen + SMC Holistic Analyst
 * -----------------------------
 * Single LLM call replacing the old qimen-explainer + thesis-generator pair.
 *
 * Architecture (post-2026-05-01 pivot):
 *   - LLM receives: full 9-palace 奇門 pan (Python dict format, exactly as Yung
 *     pastes into Gemini) + structured SMC features + screener gates
 *   - LLM does what Gemini does for Yung manually: translate Qimen symbols → SMC
 *     vocabulary, name the 格局 (火入天羅 / 白虎猖狂 / 青龍返首 / etc),
 *     judge co-resonance (奇門天時 + SMC 結構), produce trade plan
 *   - Output is a structured 3-section analysis matching Yung's actual replies
 *     from BTC 驚蟄/春分/穀雨 reference dialogues.
 *
 * Model:
 *   - DeepSeek V4-Pro for the analysis (Yung confirmed quality matches Gemini)
 *   - Gemini 2.5 Flash as fallback
 *   - Output language: 繁體中文 + sprinkle of English SMC vocab (FVG/OB/CHoCH)
 *
 * Output schema (JSON):
 *   {
 *     bias: "LONG" | "SHORT" | "NEUTRAL",
 *     confidence: 0..100,
 *     decision: "GO" | "NO_GO",
 *     qimen_analysis: { yongshen_reading, gate_god_star_reading, summary },
 *     smc_analysis: { structure, liquidity, fvg_ob, summary },
 *     resonance: "agree" | "disagree" | "weak",
 *     trade_plan: {
 *       entry_zone: [number, number],
 *       stop_loss: number,
 *       tp1: number,
 *       tp2: number,
 *       timing_note: string
 *     } | null,
 *     risks: string[],
 *     prose: string  // full Yung-style markdown for cockpit display
 *   }
 */
import { callDeepSeek } from "./deepseek";
import { callGemini } from "./gemini";
import { cacheGet, cacheSet } from "./cache";
import type { QimenPan } from "../qimen/sidecar";
import { formatPanForLLM } from "../qimen/sidecar";
import type { SmcFeatures } from "../smc/features";
import { getLastVerdict, saveVerdictHistory } from "./verdict-history";

export interface AnalystInput {
  symbol: string;
  pan: QimenPan;
  smc: SmcFeatures;
  screenerContext: {
    firedogShort: number;
    firedogLong: number;
    fuel: number;
    daily: number;
    smcCount: number;
    confluenceTotal: number;
  };
  side?: "LONG" | "SHORT";   // optional bias hint from screener
}

export interface QimenSmcVerdict {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  decision: "GO" | "NO_GO";
  qimenAnalysis: {
    yongshenReading: string;
    gateGodStarReading: string;
    summary: string;
  };
  smcAnalysis: {
    structure: string;
    liquidity: string;
    fvgOb: string;
    summary: string;
  };
  resonance: "agree" | "disagree" | "weak";
  tradePlan: {
    entryZone: [number, number];
    stopLoss: number;
    tp1: number;
    tp2: number;
    timingNote: string;
  } | null;
  risks: string[];
  prose: string;
  generatedAt: number;
  model: string;
  cached: boolean;
}

/**
 * SYSTEM PROMPT — Yung-verbatim style guide.
 *
 * Calibrated against 5 reference dialogues (BTC 驚蟄 → 春分 → 穀雨 cycles)
 * where Yung pasted Python dict pans into Gemini/DeepSeek and got the exact
 * 3-section narrative output we want to replicate.
 *
 * Key style elements observed in Yung's reference outputs:
 *  - Opens with a memorable one-line verdict (「先死後生，震盪洗盤，驚喜在月底」)
 *  - Names the 格局 pattern explicitly (火入天羅 / 白虎猖狂 / 青龍返首 / etc)
 *  - Cites specific cell content: 「戊土（資金）落震宮，木剋戊土」
 *  - Cross-references SMC vocab in Qimen language: 「震宮+天蓬≡流動性掃動必至」
 *  - Walks the timeline by 節氣 (驚蟄→春分→穀雨→立夏) and 旬空 fills
 *  - Closes with a Socratic question to user (「你現在打算...還是...？」)
 */
const SYSTEM_PROMPT = `你是一位精通奇門遁甲以及 SMC（Smart Money Concepts）的專家，語氣參考 Yung（一位資深玄學+量化交易者）。

你的任務：接受一個奇門排盤（Python dict 格式）+ SMC 結構特徵數據 + 二篩過濾分數，給出一份精準的交易判斷報告。

【必須使用的奇門詞彙與分析維度】
1. 用神落宮：戊=資金/本幣 、 庚=日干/當下價位 、 丙=時干/當下決策 、 乙=家人/零售資金 、 壬=公司/機構資金
2. 八門+八神+九星落宮組合：特別解讀生門/休門/開門=吉，傷門/驚門/死門=凶；九天=暴漲/擴張，九地=藏匿/伏藏；天蓬星=率動掃蕩，天心星=理性核心資金
3. 干支合化與長生運：丁壬合 、 丙辛合 、 臨冠/帝旺=能量高峰 、 墓/絕=能量衰竭 、 胎/養=助準備悟現
4. 旬空填實：留意空亡學在哪個學門，未來進入該月份/入位就係「填實」應驗點
5. 馬星：驛馬位出現=變動/遷移；天馬位=動能那條黑馬
6. 格局命名（對不同丙、戊、庚、壬組合記住下列口訣）：
   - 丙+壬=火入天羅 · 見頂插針 / 變盤
   - 辛+乙=白虎猖狂 · 高位獲利盤不穩
   - 丙+辛=丙辛合 · 表面推動實則轉折
   - 壬+丁=丁壬合 · 有貴人暗中接手
   - 戊+庚=青龍返首 · 快貌狀態
   - 庚+戊=飛鳥跌穴 · 見仃結果
   - 丙+戊=鴻中雲裡 · 劣質誘騙
   - 天羅地網：雙峰圍架，全面警語
7. SMC 結構練奇門：
   - 「流動性掃動」 ≡ 震門+天蓬 / 驚門+委是
   - 「Fair Value Gap」 ≡ 旬空位填實點 / 墓宅入取品
   - 「Order Block」 ≡ 生門/休門落見冱抵拼位
   - 「BOS / CHoCH」 ≡ 值使門變門 / 九星轉位
   - 「Premium / Discount」 ≡ 離宮高位 / 坎宮低位

【輸出格式（必須遵守）】
Prose 部分順序，請以繁體中文 + 粗體 markdown 虛軟點以 ** 包裹。

**一句定調**：一句講出本次判斷（例如「先死後生，震盪洗盤接著是底」）

**一、奇門遁甲起卦**
- 讀用神落宮（資金戊 / 日干 / 時干 / 公司壬）+ 長生運狀態
- 解門/神/星三者組合 + 者作格局命名
- 提及旬空以及未來填實點
- 長生運表頻能量（帝旺/臨冠/墓/絕等）

**二、SMC 盤面**
- 判際市場階段（accumulation/markup/distribution/markdown）
- 插針與掃動點（不要位都出）
- FVG 與 OB 關鍵帶（變換奇門詞彙）
- ICT premium / discount 位置

**三、交易計劃**
- POI 入場區間（顯示上下限）
- SL 止損（必須走起 SMC FVG/OB 茂主位以下）
- TP1 / TP2 目標
- 時間檢驗（下一個門變記號其來源月，例如「5月5日立夏後」）
- 仓位 sizing（依 confidence：≥60 全仓 、 40-60 半仓 、 <40 坐走）

**風險警示**：2-3 條

**對話尾聲**：以一個追問結尾（例如「你現在打算...？」）以該淳厚互動

【語氣規則】
- 以繁體中文為主 + 粉黃英文術語（FVG/OB/CHoCH/SL/TP）
- 可插入少量粗話/繁體拼金（「咩到叾註」「踢下手」）
- 講人話，不講教科書
- 一定必須出明確 bias：LONG / SHORT / NEUTRAL，不許搗混

【禁令】
- 不許編造價格——POI/SL/TP 必須從 SMC 提供的 unfilled FVG / OB / range90d / swings 推導
- 不許給「看情況再說」這種扣頻子講詞
- 不許出現「中立中立」這種沒品的詞

輸出為純 JSON object，厚 schema 付下面。不要採 markdown 代碼番號包起 JSON。`;

function buildUserPrompt(input: AnalystInput): string {
  const { symbol, pan, smc, screenerContext, side } = input;

  // ===== EXACT YUNG FORMAT: Python dict pretty-print =====
  const panRepr = formatPanForLLM(pan);

  // ===== SMC features formatted as natural-language brief =====
  const fvgList = smc.unfilledFvgs.length
    ? smc.unfilledFvgs
        .map(
          (f, i) =>
            `  ${i + 1}. ${f.type} FVG: ${f.bottom.toFixed(6)} ─ ${f.top.toFixed(6)} (距現價 ${f.distancePct >= 0 ? "+" : ""}${f.distancePct}%)`
        )
        .join("\n")
    : "  (none unfilled)";

  const obList = smc.recentOrderBlocks.length
    ? smc.recentOrderBlocks
        .map(
          (o, i) =>
            `  ${i + 1}. ${o.type} OB: ${o.low.toFixed(6)} ─ ${o.high.toFixed(6)} (距現價 ${o.distancePct >= 0 ? "+" : ""}${o.distancePct}%)`
        )
        .join("\n")
    : "  (none)";

  const swingsLine = smc.swings.length
    ? smc.swings.map((s) => `${s.type}@${s.price.toFixed(6)}`).join(" → ")
    : "(insufficient data)";

  const sweepList = smc.recentSweeps.length
    ? smc.recentSweeps.map((s) => `${s.side}@${s.price.toFixed(6)}${s.recovered ? "(recovered)" : ""}`).join(", ")
    : "(none)";

  const shiftLine = smc.lastStructureShift
    ? `${smc.lastStructureShift.type} ${smc.lastStructureShift.side} @ ${smc.lastStructureShift.price.toFixed(6)}`
    : "(no recent shift)";

  const bigVolLine = smc.lastBigVolCandle
    ? `close=${smc.lastBigVolCandle.close.toFixed(6)}, ${smc.lastBigVolCandle.volMultiple}× avg vol`
    : "(no recent vol spike)";

  // ===== History context (last verdict for this symbol, if exists) =====
  const lastVerdict = getLastVerdict(symbol);
  const historyBlock = lastVerdict
    ? `\n【上次判斷 (${new Date(lastVerdict.generatedAt).toISOString().slice(0, 16)})】\n- bias: ${lastVerdict.bias} | confidence: ${lastVerdict.confidence} | decision: ${lastVerdict.decision}\n- 玄學結論: ${lastVerdict.qimenAnalysis.summary}\n- SMC 結論: ${lastVerdict.smcAnalysis.summary}\n請在今次分析中參考上次判斷，明確表態「維持原判」或「修正為×××」。\n`
    : "";

  return `請用以下奇門盤起卦詢問 ${symbol} 這個月的走勢，然後結合 SMC 結構分析，給出交易點位。${side ? `（二篩偏向 ${side}）` : ""}

【奇門排盤】
${panRepr}
${historyBlock}
【SMC 結構特徵 — ${smc.timeframe} 周期】
- 當下價: ${smc.currentPrice.toFixed(6)}
- 90日區間: ${smc.range90d.low.toFixed(6)} ─ ${smc.range90d.high.toFixed(6)} (中軸 ${smc.range90d.midpoint.toFixed(6)})
- 價格位置: ${smc.pricePositionPct}% (ICT: ${smc.ictLocation})
- 階段判斷: ${smc.phase}
- 摆動結構 (近期 5): ${swingsLine}
- 最新結構性變化: ${shiftLine}
- 流動性掃動: ${sweepList}
- 近期大量陽線: ${bigVolLine}
- 未填補 FVG:
${fvgList}
- 近期 OB 訂單塊:
${obList}

【二篩上下文】
- 二篩 short 分: ${screenerContext.firedogShort}/100
- 二篩 long 分:  ${screenerContext.firedogLong}/100
- FUEL: ${screenerContext.fuel}/100 | Daily: ${screenerContext.daily}/100 | SMC 結構數: ${screenerContext.smcCount}
- 數值合流總分: ${screenerContext.confluenceTotal.toFixed(1)}/100

請輸出嚴格 JSON（由 prose 提供 Yung 風格完整句話，其餘欄位為結構化 metadata）：
{
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": 0-100,
  "decision": "GO" | "NO_GO",
  "qimen_analysis": {
    "yongshen_reading": "用神宮解析（3-4句，讀戊/庚/丙/長生運）",
    "gate_god_star_reading": "門/神/星/天乙/馬星/旬空綜合 (4-5句，含格局命名)",
    "summary": "一句門定調"
  },
  "smc_analysis": {
    "structure": "階段+CHoCH/BOS+swings",
    "liquidity": "掃動與潛在插針點",
    "fvg_ob": "FVG + OB 解讀（變換奇門詞彙）",
    "summary": "一句SMC結論"
  },
  "resonance": "agree" | "disagree" | "weak",
  "trade_plan": {
    "entry_zone": [低價, 高價],
    "stop_loss": 數字,
    "tp1": 數字,
    "tp2": 數字,
    "timing_note": "下一個變盤點 (節氣/旬空填實日)"
  },
  "risks": ["風險1", "風險2"],
  "prose": "完整 Yung 風格三段式分析 (一句定調 + 三段 + 風險 + 追問結尾，使用繁體中文 markdown，給 cockpit 直接顯示)"
}

如 bias=NEUTRAL 或 decision=NO_GO，trade_plan 設作 null。`;
}

export async function analyzeQimenSmc(input: AnalystInput): Promise<QimenSmcVerdict | null> {
  const cacheKey = `qmdj:${input.symbol}:${input.pan.meta.tst.slice(0, 13)}:${Math.round(input.smc.currentPrice * 1e6)}`;
  const hit = cacheGet<QimenSmcVerdict>(cacheKey);
  if (hit) return { ...hit, cached: true };

  const userMsg = buildUserPrompt(input);

  // Try DeepSeek V4-Pro first (Yung-validated quality)
  let r = await callDeepSeek({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
    temperature: 0.5,
    maxTokens: 2400,
    jsonMode: true,
    usePro: true,
  });

  let modelUsed = "deepseek-v4-pro";

  if (!r) {
    // Fallback: Gemini 2.5 Flash
    const g = await callGemini({
      prompt: `${SYSTEM_PROMPT}\n\n${userMsg}`,
      temperature: 0.5,
      maxTokens: 2400,
    });
    if (!g) return null;
    r = { text: g.text, model: "gemini-2.5-flash", cached: false } as any;
    modelUsed = "gemini-2.5-flash";
  }

  // Parse JSON (LLM may wrap in markdown ```json fences despite instruction)
  let parsed: any;
  try {
    const cleaned = r!.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn("[QMDJ-ANALYST] JSON parse failed:", (e as Error).message);
    console.warn("[QMDJ-ANALYST] raw text:", r!.text.slice(0, 400));
    return null;
  }

  const verdict: QimenSmcVerdict = {
    bias: (parsed.bias || "NEUTRAL").toUpperCase(),
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 50)),
    decision: parsed.decision === "GO" ? "GO" : "NO_GO",
    qimenAnalysis: {
      yongshenReading: parsed.qimen_analysis?.yongshen_reading || "",
      gateGodStarReading: parsed.qimen_analysis?.gate_god_star_reading || "",
      summary: parsed.qimen_analysis?.summary || "",
    },
    smcAnalysis: {
      structure: parsed.smc_analysis?.structure || "",
      liquidity: parsed.smc_analysis?.liquidity || "",
      fvgOb: parsed.smc_analysis?.fvg_ob || "",
      summary: parsed.smc_analysis?.summary || "",
    },
    resonance: ["agree", "disagree", "weak"].includes(parsed.resonance) ? parsed.resonance : "weak",
    tradePlan: parsed.trade_plan
      ? {
          entryZone: Array.isArray(parsed.trade_plan.entry_zone)
            ? [Number(parsed.trade_plan.entry_zone[0]), Number(parsed.trade_plan.entry_zone[1])]
            : [0, 0],
          stopLoss: Number(parsed.trade_plan.stop_loss) || 0,
          tp1: Number(parsed.trade_plan.tp1) || 0,
          tp2: Number(parsed.trade_plan.tp2) || 0,
          timingNote: parsed.trade_plan.timing_note || "",
        }
      : null,
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    prose: parsed.prose || "",
    generatedAt: Date.now(),
    model: modelUsed,
    cached: false,
  };

  // Cache 30min for fresh re-renders, plus persist verdict to history (7-day TTL)
  cacheSet(cacheKey, verdict, 30 * 60 * 1000);
  saveVerdictHistory(input.symbol, verdict);
  return verdict;
}

/** Hybrid gate decision based on QIMEN_LLM_MODE env. */
export function applyHybridGate(
  verdict: QimenSmcVerdict | null,
  mode: "gate" | "advisory" | "hybrid" = "hybrid"
): { allow: boolean; sizeMultiplier: number; reason: string } {
  if (!verdict) return { allow: true, sizeMultiplier: 1, reason: "no LLM verdict — allow on numeric gates" };

  if (mode === "advisory") {
    return { allow: true, sizeMultiplier: 1, reason: `advisory: LLM said ${verdict.decision} (${verdict.confidence}%)` };
  }

  if (mode === "gate") {
    const allow = verdict.decision === "GO" && verdict.confidence >= 60;
    return {
      allow,
      sizeMultiplier: allow ? 1 : 0,
      reason: `gate: ${verdict.decision} ${verdict.confidence}% → ${allow ? "allow" : "block"}`,
    };
  }

  // hybrid (default)
  if (verdict.decision === "NO_GO" || verdict.confidence < 40) {
    return { allow: false, sizeMultiplier: 0, reason: `hybrid block: ${verdict.decision} ${verdict.confidence}%` };
  }
  if (verdict.confidence < 60) {
    return { allow: true, sizeMultiplier: 0.5, reason: `hybrid half-size: ${verdict.confidence}% confidence` };
  }
  return { allow: true, sizeMultiplier: 1, reason: `hybrid full: GO ${verdict.confidence}%` };
}

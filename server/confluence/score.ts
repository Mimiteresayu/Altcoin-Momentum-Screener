/**
 * Altcoin A+ Confluence Scorer (6-factor)
 * ----------------------------------------
 * Replaces the legacy Fire Dog hard-gate weighted scorer.
 *
 * Architecture (locked):
 *   - The 5-layer FUNNEL is binary pass/skip (handled by funnel-filter.ts).
 *   - Once a setup passes the funnel, the GRADER counts how many of the
 *     6 A+ factors are present.
 *   - Grade → size multiplier:
 *        6/6 = A+ → 1.0×
 *        5/6 = A  → 1.0×
 *        4/6 = B  → 0.7×
 *        3/6 = C  → 0.5×
 *        <3   = REJECT
 *
 * Six factors:
 *   1. 圓底 / Cup formation       (from setup-detector)
 *   2. Squeeze 低量吸籌            (from setup-detector)
 *   3. Vol spike pre-pump         (from setup-detector)
 *   4. Liquidity sweep + reclaim  (from setup-detector)
 *   5. Breakout 確認               (from setup-detector)
 *   6. 奇門三吉同宮                (from qimen sidecar)
 *
 * Setup type label is descriptive only — NOT scored.
 */

import type { AltcoinSetupFeatures } from "../altcoin-setup/setup-detector";
import type { QimenPan } from "../qimen/sidecar";
import type { FireDogCoin } from "../scrapers/firedog";

// 三吉星 / 三吉神 (locked QMDJ classification)
const SAN_JI_STAR = ["心", "輔", "禽"] as const;          // 心 輔 禽
const SAN_JI_GOD = ["天", "符", "陰"] as const;           // 天乙 直符 太陰
const SAN_JI_DOOR = ["生", "開", "休", "景"] as const;    // 吉門

export type SetupGrade = "A+" | "A" | "B" | "C" | "REJECT";

export interface FactorResult {
  name: string;
  detected: boolean;
  detail: string;
  confidence?: number;
}

export interface AltcoinGradeInput {
  setup: AltcoinSetupFeatures;       // patterns 1-5
  qimen: QimenPan | null;            // pattern 6
}

export interface AltcoinGradeResult {
  grade: SetupGrade;
  passed: boolean;                    // grade !== REJECT
  factorCount: number;                // 0..6
  sizeMultiplier: number;             // 1.0 / 1.0 / 0.7 / 0.5 / 0
  factors: {
    cup: FactorResult;
    squeeze: FactorResult;
    volSpike: FactorResult;
    sweep: FactorResult;
    breakout: FactorResult;
    qimenSanJi: FactorResult;
  };
  setupType: string;                  // descriptive label, NOT used in scoring
  side: "LONG" | "SHORT";
  reasons: string[];
}

// ---------- 奇門三吉同宮 ----------

/**
 * 三吉同宮 = 用神所在宮位同時包含 三吉星 + 三吉神 + 吉門 中的至少兩類。
 * Strict: all three present in the same palace.
 * Default here: at least 2 of 3 present (configurable via env QIMEN_STRICT).
 */
function detectSanJi(pan: QimenPan): FactorResult {
  if (!pan?.yongshen_cell) {
    return { name: "奇門三吉同宮", detected: false, detail: "無奇門盤" };
  }
  const cell = pan.yongshen_cell;
  const starOk = SAN_JI_STAR.includes(cell.star as any);
  const godOk = SAN_JI_GOD.includes(cell.god as any);
  const doorOk = SAN_JI_DOOR.includes(cell.door as any);

  const matches = [starOk && cell.star, godOk && cell.god, doorOk && cell.door].filter(
    Boolean
  ) as string[];

  const strict = (process.env.QIMEN_STRICT ?? "false") === "true";
  const need = strict ? 3 : 2;
  const detected = matches.length >= need;

  const detail =
    matches.length === 0
      ? `用神宮：星=${cell.star} 神=${cell.god} 門=${cell.door}（無吉星吉神吉門）`
      : `用神宮：${matches.length === 3 ? "三吉同宮" : matches.length + "吉"} (${matches.join("/")})`;

  return {
    name: "奇門三吉同宮",
    detected,
    detail,
    confidence: matches.length / 3,
  };
}

// ---------- main grader ----------

export function gradeAltcoinSetup(input: AltcoinGradeInput): AltcoinGradeResult {
  const { setup, qimen } = input;
  const reasons: string[] = [];

  const cup: FactorResult = {
    name: "圓底",
    detected: setup.patterns.cup.detected,
    detail:
      setup.patterns.cup.detected
        ? `深度 ${setup.patterns.cup.details.depthPct}% U-shape 對稱`
        : "未形成圓底",
    confidence: setup.patterns.cup.confidence,
  };
  const squeeze: FactorResult = {
    name: "Squeeze 低量吸籌",
    detected: setup.patterns.squeeze.detected,
    detail: setup.patterns.squeeze.detected
      ? `BB 寬度=${setup.patterns.squeeze.details.widthRatio}× 5d`
      : "未進入 Squeeze",
    confidence: setup.patterns.squeeze.confidence,
  };
  const volSpike: FactorResult = {
    name: "Vol spike 預埋",
    detected: setup.patterns.volSpike.detected,
    detail: setup.patterns.volSpike.detected
      ? `量比 ${setup.patterns.volSpike.details.volRatio}× 價格平靜`
      : "無預拉量",
    confidence: setup.patterns.volSpike.confidence,
  };
  const sweep: FactorResult = {
    name: "Liquidity sweep",
    detected: setup.patterns.sweep.detected,
    detail: setup.patterns.sweep.detected
      ? `${setup.patterns.sweep.details.sweepSide} 掃流回收`
      : "無 sweep 回收",
    confidence: setup.patterns.sweep.confidence,
  };
  const breakout: FactorResult = {
    name: "Breakout 確認",
    detected: setup.patterns.breakout.detected,
    detail: setup.patterns.breakout.detected
      ? `突破 ${setup.patterns.breakout.details.beyondMarginPct}% + 量比 ${setup.patterns.breakout.details.volRatio}×`
      : "未確認突破",
    confidence: setup.patterns.breakout.confidence,
  };
  const qimenSanJi: FactorResult = qimen
    ? detectSanJi(qimen)
    : { name: "奇門三吉同宮", detected: false, detail: "奇門盤未取得" };

  const factors = { cup, squeeze, volSpike, sweep, breakout, qimenSanJi };
  const factorCount = Object.values(factors).filter((f) => f.detected).length;

  let grade: SetupGrade;
  let sizeMultiplier: number;
  if (factorCount === 6) {
    grade = "A+";
    sizeMultiplier = 1.0;
  } else if (factorCount === 5) {
    grade = "A";
    sizeMultiplier = 1.0;
  } else if (factorCount === 4) {
    grade = "B";
    sizeMultiplier = 0.7;
  } else if (factorCount === 3) {
    grade = "C";
    sizeMultiplier = 0.5;
  } else {
    grade = "REJECT";
    sizeMultiplier = 0;
  }

  reasons.push(
    `因子 ${factorCount}/6 → ${grade} → size×${sizeMultiplier.toFixed(2)}`
  );
  if (grade === "REJECT") {
    reasons.push("低於 3 項因子，不入場");
  }

  return {
    grade,
    passed: grade !== "REJECT",
    factorCount,
    sizeMultiplier,
    factors,
    setupType: setup.setupType,
    side: setup.side,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Back-compat shim — DEPRECATED
// ---------------------------------------------------------------------------
// The old `scoreConfluence` API is referenced by orchestrator.ts, api.ts, and
// thesis-api.ts. Those files are being rewritten, but until they are wired to
// the new funnel + grader pipeline this shim keeps the build green.
//
// Behaviour: returns a passing stub if firedog.shortScore >= 60 — so the
// legacy dashboards still work — but it does NOT reflect the real grade.
// New code MUST use `gradeAltcoinSetup` instead.
// ---------------------------------------------------------------------------

/** @deprecated Use gradeAltcoinSetup */
export interface ConfluenceInputs {
  firedog: FireDogCoin;
  fuelScore: number;
  dailyBottomScore: number;
  smcScore: number;
  symbol: string;
}

/** @deprecated Use AltcoinGradeResult */
export interface ConfluenceResult {
  total: number;
  passes: boolean;
  components: { firedog: number; fuel: number; daily: number; smc: number; qimen: number };
  childPlan: { SCALPER: boolean; SNIPER: boolean; SWING: boolean; RUNNER: boolean };
  reasons: string[];
}

/** @deprecated Use gradeAltcoinSetup. Kept for back-compat with legacy dashboards. */
export async function scoreConfluence(input: ConfluenceInputs): Promise<ConfluenceResult> {
  const minShort = parseFloat(process.env.FIREDOG_SHORT_MIN || "60");
  const passes = input.firedog.shortScore >= minShort;
  const total = passes
    ? Math.min(100, input.firedog.shortScore * 0.4 + input.fuelScore * 0.3 + input.dailyBottomScore * 0.3)
    : 0;
  return {
    total,
    passes,
    components: {
      firedog: input.firedog.shortScore,
      fuel: input.fuelScore,
      daily: input.dailyBottomScore,
      smc: Math.min(input.smcScore, 5) * 20,
      qimen: 50,
    },
    childPlan: {
      SCALPER: passes,
      SNIPER: passes && total >= 65,
      SWING: passes && total >= 70,
      RUNNER: passes && total >= 75,
    },
    reasons: [
      passes
        ? `[legacy shim] firedog=${input.firedog.shortScore} → ${total.toFixed(0)}`
        : `[legacy shim] firedog<${minShort}`,
    ],
  };
}

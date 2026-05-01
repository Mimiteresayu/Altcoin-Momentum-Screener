/**
 * Confluence Scoring Engine
 * --------------------------
 * Combines five signals into a 0..100 confluence score:
 *
 *   1. Fire Dog universe gate    (HARD: short_score >= 80, else reject)
 *   2. Altcoin Screener FUEL     (continuous, weight 0.25)
 *   3. Daily bottom + volume     (continuous, weight 0.25)
 *   4. SMC structure score       (continuous, weight 0.20, must be >= SMC_MIN_SCORE)
 *   5. Qimen score               (continuous, weight 0.15, never a veto)
 *
 * Plus 0.15 weight from short_score itself (already gated).
 *
 * Output drives:
 *   - which children to fire (RUNNER requires Fire Dog long_score >= 70)
 *   - position size scaling (high confluence = full 1% risk; medium = 0.5%)
 */
import { FireDogCoin, qualifiesForRunner } from "../scrapers/firedog";
import { getQimenScore } from "../qimen/sidecar";

export interface ConfluenceInputs {
  firedog: FireDogCoin;
  fuelScore: number;          // 0..100 from your Altcoin screener
  dailyBottomScore: number;   // 0..100  (proximity to range low + vol breakout)
  smcScore: number;           // count of valid FVG/OB/BOS structures
  symbol: string;
}

export interface ConfluenceResult {
  total: number;              // 0..100
  passes: boolean;
  components: {
    firedog: number;
    fuel: number;
    daily: number;
    smc: number;
    qimen: number;
  };
  childPlan: {
    SCALPER: boolean;
    SNIPER: boolean;
    SWING: boolean;
    RUNNER: boolean;
  };
  reasons: string[];
}

export async function scoreConfluence(input: ConfluenceInputs): Promise<ConfluenceResult> {
  const reasons: string[] = [];
  const minShort = parseFloat(process.env.FIREDOG_SHORT_MIN || "80");
  const minSmc = parseInt(process.env.SMC_MIN_SCORE || "2", 10);

  // Hard gate 1: Fire Dog short score
  if (input.firedog.shortScore < minShort) {
    reasons.push(`Fire Dog short<${minShort} (got ${input.firedog.shortScore})`);
    return {
      total: 0,
      passes: false,
      components: { firedog: 0, fuel: 0, daily: 0, smc: 0, qimen: 0 },
      childPlan: { SCALPER: false, SNIPER: false, SWING: false, RUNNER: false },
      reasons,
    };
  }
  // Hard gate 2: SMC minimum
  if (input.smcScore < minSmc) {
    reasons.push(`SMC<${minSmc} (got ${input.smcScore})`);
    return {
      total: 0,
      passes: false,
      components: { firedog: 0, fuel: 0, daily: 0, smc: 0, qimen: 0 },
      childPlan: { SCALPER: false, SNIPER: false, SWING: false, RUNNER: false },
      reasons,
    };
  }

  const qimen = await getQimenScore(input.symbol);
  const qimenScore = (qimen?.score ?? 0.5) * 100;

  const wFiredog = parseFloat(process.env.W_FIREDOG || "0.15");
  const wFuel = parseFloat(process.env.W_FUEL || "0.25");
  const wDaily = parseFloat(process.env.W_DAILY || "0.25");
  const wSmc = parseFloat(process.env.W_SMC || "0.20");
  const wQimen = parseFloat(process.env.QIMEN_WEIGHT || "0.15");

  // Normalize SMC count to 0..100 (cap at 5 structures)
  const smcNorm = Math.min(input.smcScore, 5) * 20;

  const components = {
    firedog: input.firedog.shortScore,
    fuel: input.fuelScore,
    daily: input.dailyBottomScore,
    smc: smcNorm,
    qimen: qimenScore,
  };

  const total =
    components.firedog * wFiredog +
    components.fuel * wFuel +
    components.daily * wDaily +
    components.smc * wSmc +
    components.qimen * wQimen;

  reasons.push(
    `firedog=${components.firedog} fuel=${components.fuel} daily=${components.daily} smc=${components.smc} qimen=${components.qimen.toFixed(0)}`
  );

  const runnerOK = qualifiesForRunner(input.firedog);
  if (!runnerOK) reasons.push(`RUNNER skipped (long<${process.env.FIREDOG_LONG_RUNNER_MIN || 70})`);

  return {
    total,
    passes: total >= 60,
    components,
    childPlan: {
      SCALPER: total >= 60,
      SNIPER: total >= 65,
      SWING: total >= 70,
      RUNNER: total >= 75 && runnerOK,
    },
    reasons,
  };
}

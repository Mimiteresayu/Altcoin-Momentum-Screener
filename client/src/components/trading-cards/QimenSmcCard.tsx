/**
 * QimenSmcCard — v2 Cockpit
 * --------------------------
 * Replaces the legacy AIAnalysisPanel.
 *
 * Sections (matches v5 mockup):
 *   1. Header chips: symbol · setup type · grade (A+/A/B/C) · decision
 *   2. Funnel rail: 5 binary steps (L1..L5) with pass/fail
 *   3. Factor grid: 6 cells (Cup, Squeeze, Vol Spike, Sweep, Breakout, Qimen 三吉)
 *   4. Sizing chip: notional, qty, leverage, liq buffer
 *   5. Verdict prose: 3-section LLM analysis (Yung-style)
 *
 * Consumes /api/ai/thesis?symbol=XXX (rewritten thesis-api).
 */
import { useEffect, useState } from "react";

// ---------- types ----------
interface FunnelLayer {
  layer: "L1" | "L2" | "L3" | "L4" | "L5";
  name: string;
  passed: boolean;
  reason: string;
}
interface FunnelResult {
  passed: boolean;
  layers: FunnelLayer[];
  failedAt?: FunnelLayer;
}
interface FactorResult {
  name: string;
  detected: boolean;
  detail: string;
  confidence?: number;
}
interface Grade {
  grade: "A+" | "A" | "B" | "C" | "REJECT";
  passed: boolean;
  factorCount: number;
  sizeMultiplier: number;
  factors: {
    cup: FactorResult;
    squeeze: FactorResult;
    volSpike: FactorResult;
    sweep: FactorResult;
    breakout: FactorResult;
    qimenSanJi: FactorResult;
  };
  setupType: string;
  side: "LONG" | "SHORT";
}
interface Sizing {
  notionalUsd: number;
  quantity: number;
  appliedLeverage: number;
  marginUsedUsd: number;
  liqDistancePct: number;
  slToLiqBufferPct: number;
  isLiqSafe: boolean;
}
interface Verdict {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  decision: "GO" | "NO_GO";
  confidence: number;
  qimenAnalysis: { yongshenReading: string; gateGodStarReading: string; summary: string };
  smcAnalysis: { structure: string; liquidity: string; fvgOb: string; summary: string };
  resonance: "agree" | "disagree" | "weak";
  prose: string;
}
interface ThesisData {
  symbol: string;
  side: "LONG" | "SHORT";
  decision: string;
  funnel: FunnelResult;
  grade: Grade | null;
  verdict: Verdict | null;
  sizing: Sizing | null;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  setupType: string | null;
  currentPrice: number | null;
  ictLocation: string | null;
}

// ---------- styles ----------
const css = `
.qsc-card { background:#0d0d12; border:1px solid #1f1f28; border-radius:12px; padding:16px; color:#e8e8ea; font-size:13px; line-height:1.5; }
.qsc-h { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
.qsc-symbol { font-size:18px; font-weight:600; }
.qsc-chip { padding:3px 8px; border-radius:6px; font-size:11px; border:1px solid #2a2a36; }
.qsc-chip.long { color:#10b981; border-color:#10b981; }
.qsc-chip.short { color:#ef4444; border-color:#ef4444; }
.qsc-chip.gold { color:#fbbf24; border-color:#fbbf24; background:rgba(251,191,36,0.08); font-weight:600; }
.qsc-chip.green { color:#10b981; border-color:#10b981; }
.qsc-chip.amber { color:#f59e0b; border-color:#f59e0b; }
.qsc-chip.red { color:#ef4444; border-color:#ef4444; }
.qsc-chip.muted { color:#71717a; border-color:#2a2a36; }

.qsc-funnel { display:flex; gap:6px; margin:12px 0; flex-wrap:nowrap; }
.qsc-step { flex:1; padding:8px 6px; border-radius:6px; border-left:3px solid #2a2a36; background:#15151b; min-width:0; }
.qsc-step.pass { border-left-color:#10b981; }
.qsc-step.fail { border-left-color:#ef4444; opacity:0.5; }
.qsc-step-label { font-size:10px; color:#71717a; text-transform:uppercase; letter-spacing:0.05em; }
.qsc-step-name { font-size:11px; font-weight:500; margin-top:2px; }
.qsc-step-reason { font-size:10px; color:#a1a1aa; margin-top:3px; line-height:1.3; overflow:hidden; text-overflow:ellipsis; }

.qsc-grade-row { display:flex; align-items:center; gap:12px; padding:12px; background:#15151b; border-radius:8px; margin:12px 0; }
.qsc-grade-letter { font-size:34px; font-weight:700; line-height:1; }
.qsc-grade-letter.gold { color:#fbbf24; }
.qsc-grade-letter.green { color:#10b981; }
.qsc-grade-letter.amber { color:#f59e0b; }
.qsc-grade-letter.red { color:#ef4444; }
.qsc-grade-meta { flex:1; }
.qsc-grade-count { font-size:14px; font-weight:500; }
.qsc-grade-sub { font-size:11px; color:#71717a; margin-top:2px; }

.qsc-factors { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.qsc-factor { padding:8px 10px; background:#15151b; border-radius:6px; border:1px solid #1f1f28; }
.qsc-factor.detected { border-color:#10b981; }
.qsc-factor.missing { opacity:0.5; }
.qsc-factor-name { font-size:11px; font-weight:500; }
.qsc-factor-detail { font-size:10px; color:#a1a1aa; margin-top:3px; line-height:1.3; }
.qsc-factor-mark { display:inline-block; width:14px; height:14px; border-radius:50%; margin-right:4px; vertical-align:middle; line-height:14px; text-align:center; font-size:10px; font-weight:700; }
.qsc-factor-mark.on { background:#10b981; color:#0d0d12; }
.qsc-factor-mark.off { background:#2a2a36; color:#71717a; }

.qsc-sizing { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; padding:10px 12px; background:#15151b; border-radius:8px; margin:12px 0; }
.qsc-sizing-cell { font-size:11px; }
.qsc-sizing-label { color:#71717a; text-transform:uppercase; letter-spacing:0.04em; font-size:9px; }
.qsc-sizing-value { font-size:13px; font-weight:600; margin-top:2px; }
.qsc-sizing-value.warn { color:#f59e0b; }
.qsc-sizing-value.bad { color:#ef4444; }

.qsc-verdict { padding:12px; background:#15151b; border-radius:8px; margin-top:12px; }
.qsc-verdict-h { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.qsc-verdict-h h4 { margin:0; font-size:13px; font-weight:600; }
.qsc-prose { white-space:pre-wrap; color:#d4d4d8; font-size:12px; line-height:1.6; }
.qsc-section { margin-top:8px; padding-top:8px; border-top:1px solid #1f1f28; }
.qsc-section-h { font-size:10px; color:#71717a; text-transform:uppercase; margin-bottom:4px; }

.qsc-loading { color:#71717a; padding:24px; text-align:center; }
.qsc-error { color:#ef4444; padding:12px; }
`;

// ---------- helpers ----------
function gradeColor(g: string): "gold" | "green" | "amber" | "red" {
  if (g === "A+") return "gold";
  if (g === "A") return "green";
  if (g === "B") return "amber";
  return "red";
}
function fmt(v: number | null | undefined, d = 4): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(d > 4 ? d : 4);
  return v.toFixed(6);
}

// ---------- component ----------
export function QimenSmcCard({ symbol }: { symbol: string | null }) {
  const [data, setData] = useState<ThesisData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setData(null);
      return;
    }
    let cancel = false;
    setLoading(true);
    setError(null);
    fetch(`/api/ai/thesis?symbol=${encodeURIComponent(symbol)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancel) setData(j);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [symbol]);

  if (!symbol) return null;
  if (loading) return (
    <div className="qsc-card"><style>{css}</style><div className="qsc-loading">載入中…</div></div>
  );
  if (error) return (
    <div className="qsc-card"><style>{css}</style><div className="qsc-error">錯誤: {error}</div></div>
  );
  if (!data) return null;

  const sideClass = data.side === "LONG" ? "long" : "short";
  const grade = data.grade;
  const factors = grade?.factors;

  return (
    <div className="qsc-card">
      <style>{css}</style>

      {/* HEADER */}
      <div className="qsc-h">
        <span className="qsc-symbol">{data.symbol}</span>
        <span className={`qsc-chip ${sideClass}`}>{data.side}</span>
        {data.setupType && <span className="qsc-chip muted">{data.setupType}</span>}
        {grade && (
          <span className={`qsc-chip ${gradeColor(grade.grade)}`}>
            {grade.grade} · {grade.factorCount}/6
          </span>
        )}
        <span className={`qsc-chip ${
          data.decision === "EXECUTE" ? "green" :
          data.decision === "HALF_SIZE" ? "amber" : "red"
        }`}>{data.decision}</span>
        {data.ictLocation && (
          <span className="qsc-chip muted">{data.ictLocation}</span>
        )}
      </div>

      {/* FUNNEL RAIL */}
      <div className="qsc-funnel">
        {data.funnel.layers.map((l) => (
          <div key={l.layer} className={`qsc-step ${l.passed ? "pass" : "fail"}`}>
            <div className="qsc-step-label">{l.layer}</div>
            <div className="qsc-step-name">{l.name}</div>
            <div className="qsc-step-reason">{l.reason}</div>
          </div>
        ))}
      </div>

      {/* GRADE + FACTORS */}
      {grade && (
        <>
          <div className="qsc-grade-row">
            <div className={`qsc-grade-letter ${gradeColor(grade.grade)}`}>{grade.grade}</div>
            <div className="qsc-grade-meta">
              <div className="qsc-grade-count">{grade.factorCount} / 6 因子達成</div>
              <div className="qsc-grade-sub">
                Size 倍數 {grade.sizeMultiplier.toFixed(2)}× · {grade.setupType}
              </div>
            </div>
          </div>
          {factors && (
            <div className="qsc-factors">
              {(["cup", "squeeze", "volSpike", "sweep", "breakout", "qimenSanJi"] as const).map((k) => {
                const f = factors[k];
                return (
                  <div key={k} className={`qsc-factor ${f.detected ? "detected" : "missing"}`}>
                    <div className="qsc-factor-name">
                      <span className={`qsc-factor-mark ${f.detected ? "on" : "off"}`}>
                        {f.detected ? "✓" : ""}
                      </span>
                      {f.name}
                    </div>
                    <div className="qsc-factor-detail">{f.detail}</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* SIZING */}
      {data.sizing && (
        <div className="qsc-sizing">
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">名義</div>
            <div className="qsc-sizing-value">${data.sizing.notionalUsd.toFixed(2)}</div>
          </div>
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">數量</div>
            <div className="qsc-sizing-value">{data.sizing.quantity.toFixed(4)}</div>
          </div>
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">槓桿</div>
            <div className="qsc-sizing-value">{data.sizing.appliedLeverage}×</div>
          </div>
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">爆倉緩衝</div>
            <div className={`qsc-sizing-value ${data.sizing.isLiqSafe ? "" : "bad"}`}>
              {data.sizing.slToLiqBufferPct.toFixed(2)}%
            </div>
          </div>
        </div>
      )}

      {/* ENTRY / SL / TP */}
      {data.entry !== null && (
        <div className="qsc-sizing">
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">入場</div>
            <div className="qsc-sizing-value">{fmt(data.entry)}</div>
          </div>
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">止損</div>
            <div className="qsc-sizing-value bad">{fmt(data.sl)}</div>
          </div>
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">止盈</div>
            <div className="qsc-sizing-value">{fmt(data.tp)}</div>
          </div>
          <div className="qsc-sizing-cell">
            <div className="qsc-sizing-label">現價</div>
            <div className="qsc-sizing-value">{fmt(data.currentPrice)}</div>
          </div>
        </div>
      )}

      {/* VERDICT */}
      {data.verdict && (
        <div className="qsc-verdict">
          <div className="qsc-verdict-h">
            <h4>奇門 + SMC 分析</h4>
            <span className={`qsc-chip ${
              data.verdict.resonance === "agree" ? "green" :
              data.verdict.resonance === "disagree" ? "red" : "amber"
            }`}>{data.verdict.resonance}</span>
            <span className="qsc-chip muted">{(data.verdict.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="qsc-section">
            <div className="qsc-section-h">奇門</div>
            <div>{data.verdict.qimenAnalysis.summary}</div>
          </div>
          <div className="qsc-section">
            <div className="qsc-section-h">SMC</div>
            <div>{data.verdict.smcAnalysis.summary}</div>
          </div>
          {data.verdict.prose && (
            <div className="qsc-section">
              <div className="qsc-section-h">綜合判斷</div>
              <div className="qsc-prose">{data.verdict.prose}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

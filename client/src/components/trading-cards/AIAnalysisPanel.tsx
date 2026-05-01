import { useEffect, useState } from "react";

interface Thesis {
  symbol: string;
  setupType: string;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  rationale: string;
  qimen: {
    pan: string;
    yongshen: string;
    explanation: string;
    direction: string;
    confidence: number;
  };
  news: { summary: string; citations: string[] };
  risks: string[];
  generatedAt: number;
}

export function AIAnalysisPanel({ symbol }: { symbol: string | null }) {
  const [thesis, setThesis] = useState<Thesis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setThesis(null);
      return;
    }
    let cancel = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/ai/thesis?symbol=${encodeURIComponent(symbol)}`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const data = await r.json();
        if (!cancel) setThesis(data);
      } catch (e: any) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    };
    load();
    return () => {
      cancel = true;
    };
  }, [symbol]);

  if (!symbol) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Select a coin from the table to see AI analysis
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">AI Analysis · {symbol}</h3>
        {thesis && (
          <div className="flex gap-2 items-center">
            <span
              className={
                "text-xs px-2 py-0.5 rounded font-medium " +
                (thesis.bias === "LONG"
                  ? "bg-emerald-500/20 text-emerald-500"
                  : thesis.bias === "SHORT"
                  ? "bg-red-500/20 text-red-500"
                  : "bg-muted text-muted-foreground")
              }
            >
              {thesis.bias}
            </span>
            <span className="text-xs text-muted-foreground">
              conf {thesis.confidence.toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      {loading && <div className="text-sm text-muted-foreground">Generating thesis…</div>}
      {error && <div className="text-sm text-red-500">Error: {error}</div>}

      {thesis && (
        <>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Setup</div>
            <div className="text-sm font-medium capitalize">{thesis.setupType}</div>
          </div>

          <div>
            <div className="text-xs text-muted-foreground mb-1">Rationale</div>
            <div className="text-sm leading-relaxed">{thesis.rationale}</div>
          </div>

          <div className="border-t pt-3">
            <div className="text-xs text-muted-foreground mb-1">奇門 Qimen</div>
            <div className="flex gap-3 text-xs mb-1">
              <span>局: <span className="font-medium">{thesis.qimen.pan}</span></span>
              <span>用神: <span className="font-medium">{thesis.qimen.yongshen}</span></span>
              <span>方向: <span className={
                thesis.qimen.direction === "LONG" ? "text-emerald-500" :
                thesis.qimen.direction === "SHORT" ? "text-red-500" : ""
              }>{thesis.qimen.direction}</span></span>
            </div>
            <div className="text-sm leading-relaxed">{thesis.qimen.explanation}</div>
          </div>

          <div className="border-t pt-3">
            <div className="text-xs text-muted-foreground mb-1">24h News</div>
            <div className="text-sm leading-relaxed">{thesis.news.summary}</div>
            {thesis.news.citations.length > 0 && (
              <div className="mt-1 text-xs space-x-2">
                {thesis.news.citations.slice(0, 3).map((c, i) => (
                  <a key={i} href={c} target="_blank" rel="noreferrer" className="underline text-blue-400">
                    src{i + 1}
                  </a>
                ))}
              </div>
            )}
          </div>

          {thesis.risks.length > 0 && (
            <div className="border-t pt-3">
              <div className="text-xs text-muted-foreground mb-1">Risks</div>
              <ul className="text-sm space-y-0.5 list-disc list-inside">
                {thesis.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-xs text-muted-foreground border-t pt-2">
            Generated {new Date(thesis.generatedAt).toLocaleTimeString("en-HK", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </>
      )}
    </div>
  );
}

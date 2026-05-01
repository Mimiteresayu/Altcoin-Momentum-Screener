import { useState, useEffect } from "react";
import { TradingViewChart } from "@/components/trading-cards/TradingViewChart";
import { QimenSmcCard } from "@/components/trading-cards/QimenSmcCard";
import { KillSwitchCard } from "@/components/trading-cards/KillSwitchCard";
import { ChildTradesCard } from "@/components/trading-cards/ChildTradesCard";

// v2 schema from /api/confluence/latest
interface ConfluenceRow {
  symbol: string;
  side: "LONG" | "SHORT";
  firedogShort: number;
  firedogLong: number;
  funnelPassed: boolean;
  failedAt?: string;
  factorCount: number;
  gradeLetter: "A+" | "A" | "B" | "C" | "REJECT" | "—";
  sizeMultiplier: number;
  setupType: string;
  ictLocation: string;
  currentPrice: number | null;
  qimenDoor: string | null;
  error?: string;
}

function gradeBadgeClass(g: string): string {
  if (g === "A+") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/40";
  if (g === "A") return "bg-emerald-500/20 text-emerald-400 border-emerald-500/40";
  if (g === "B") return "bg-amber-500/20 text-amber-400 border-amber-500/40";
  if (g === "C") return "bg-orange-500/20 text-orange-400 border-orange-500/40";
  return "bg-muted text-muted-foreground border-muted";
}

export default function TradingCockpit() {
  const [rows, setRows] = useState<ConfluenceRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch("/api/confluence/latest");
        if (!r.ok) return;
        const data = await r.json();
        if (!cancel) {
          // sort: passed funnel first, then by factor count desc
          const sorted = (data.rows || []).sort((a: ConfluenceRow, b: ConfluenceRow) => {
            if (a.funnelPassed !== b.funnelPassed) return a.funnelPassed ? -1 : 1;
            return b.factorCount - a.factorCount;
          });
          setRows(sorted);
          if (!selected && sorted[0]) setSelected(sorted[0].symbol);
        }
      } finally {
        if (!cancel) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 30 * 60 * 1000); // 30min refresh
    return () => {
      cancel = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passedCount = rows.filter((r) => r.funnelPassed).length;

  return (
    <div className="min-h-screen bg-background p-4 pb-24">
      <div className="max-w-[1800px] mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Trading Cockpit</h1>
            <p className="text-sm text-muted-foreground">
              Altcoin Momentum + 奇門遁甲 · 30-min refresh
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            {passedCount} / {rows.length} 通過漏斗
          </div>
        </div>

        {/* Top row: confluence table + chart */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Confluence table — left 5 cols */}
          <div className="lg:col-span-5 rounded-lg border bg-card p-4">
            <h3 className="text-base font-semibold mb-3">候選清單</h3>
            {loading ? (
              <div className="text-sm text-muted-foreground py-8 text-center">載入中…</div>
            ) : (
              <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <th className="text-left py-2">Symbol</th>
                      <th>方向</th>
                      <th>漏斗</th>
                      <th>因子</th>
                      <th>品級</th>
                      <th className="text-left">Setup</th>
                      <th>用神門</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.symbol}
                        className={
                          "border-t cursor-pointer transition-colors " +
                          (selected === r.symbol
                            ? "bg-primary/10"
                            : "hover:bg-muted/50")
                        }
                        onClick={() => setSelected(r.symbol)}
                      >
                        <td className="py-2 font-medium">{r.symbol}</td>
                        <td className="text-center">
                          <span className={r.side === "LONG" ? "text-emerald-500" : "text-red-500"}>
                            {r.side === "LONG" ? "多" : "空"}
                          </span>
                        </td>
                        <td className="text-center">
                          {r.funnelPassed ? (
                            <span className="text-emerald-500">✓</span>
                          ) : (
                            <span className="text-red-500" title={`failed at ${r.failedAt}`}>
                              {r.failedAt || "✗"}
                            </span>
                          )}
                        </td>
                        <td className="text-center">{r.factorCount}/6</td>
                        <td className="text-center">
                          <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${gradeBadgeClass(r.gradeLetter)}`}>
                            {r.gradeLetter}
                          </span>
                        </td>
                        <td className="text-[10px] truncate max-w-[120px]">{r.setupType}</td>
                        <td className="text-center">{r.qimenDoor || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Bitunix TradingView chart — right 7 cols */}
          <div className="lg:col-span-7 rounded-lg border bg-card p-4">
            <h3 className="text-base font-semibold mb-3">
              Bitunix Perp · {selected || "(請選擇)"}
            </h3>
            {selected && <TradingViewChart symbol={selected} exchange="BITUNIX" interval="60" height={440} />}
          </div>
        </div>

        {/* Middle row: 奇門 + SMC analysis card (full width) */}
        <QimenSmcCard symbol={selected} />

        {/* Bottom row: child trades + risk */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <ChildTradesCard />
          </div>
          <KillSwitchCard />
        </div>
      </div>
    </div>
  );
}

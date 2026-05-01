import { useState, useEffect } from "react";
import { TradingViewChart } from "@/components/trading-cards/TradingViewChart";
import { AIAnalysisPanel } from "@/components/trading-cards/AIAnalysisPanel";
import { KillSwitchCard } from "@/components/trading-cards/KillSwitchCard";
import { ChildTradesCard } from "@/components/trading-cards/ChildTradesCard";

interface ConfluenceRow {
  symbol: string;
  firedogShort: number;
  firedogLong: number;
  fuel: number;
  daily: number;
  smc: number;
  qimen: number;
  total: number;
  childPlan: { SCALPER: boolean; SNIPER: boolean; SWING: boolean; RUNNER: boolean };
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
          const sorted = (data.rows || []).sort((a: ConfluenceRow, b: ConfluenceRow) => b.total - a.total);
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

  return (
    <div className="min-h-screen bg-background p-4 pb-24">
      <div className="max-w-[1800px] mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Trading Cockpit</h1>
            <p className="text-sm text-muted-foreground">
              Altcoin Momentum + QMDJ · Private cockpit · 30-min refresh
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            {rows.length} candidates
          </div>
        </div>

        {/* Top row: confluence table + chart */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Confluence table — left 5 cols */}
          <div className="lg:col-span-5 rounded-lg border bg-card p-4">
            <h3 className="text-base font-semibold mb-3">Confluence Signals</h3>
            {loading ? (
              <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
            ) : (
              <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <th className="text-left py-2">Symbol</th>
                      <th>S2-S</th>
                      <th>S2-L</th>
                      <th>FUEL</th>
                      <th>Daily</th>
                      <th>SMC</th>
                      <th>Qi</th>
                      <th>Total</th>
                      <th className="text-left">Children</th>
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
                        <td className="text-center">{r.firedogShort}</td>
                        <td className="text-center">{r.firedogLong}</td>
                        <td className="text-center">{r.fuel.toFixed(0)}</td>
                        <td className="text-center">{r.daily.toFixed(0)}</td>
                        <td className="text-center">{r.smc}</td>
                        <td className="text-center">{r.qimen.toFixed(0)}</td>
                        <td className="text-center font-semibold">{r.total.toFixed(0)}</td>
                        <td className="space-x-0.5">
                          {(["SCALPER", "SNIPER", "SWING", "RUNNER"] as const).map((c) => (
                            <span
                              key={c}
                              className={
                                "inline-block px-1 rounded text-[9px] " +
                                (r.childPlan[c]
                                  ? "bg-emerald-500/20 text-emerald-500"
                                  : "bg-muted text-muted-foreground")
                              }
                              title={c}
                            >
                              {c[0]}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* TradingView chart — right 7 cols */}
          <div className="lg:col-span-7 rounded-lg border bg-card p-4">
            <h3 className="text-base font-semibold mb-3">
              Chart · {selected || "(select a coin)"}
            </h3>
            {selected && <TradingViewChart symbol={selected} interval="60" height={440} />}
          </div>
        </div>

        {/* Middle row: AI Analysis full width */}
        <AIAnalysisPanel symbol={selected} />

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

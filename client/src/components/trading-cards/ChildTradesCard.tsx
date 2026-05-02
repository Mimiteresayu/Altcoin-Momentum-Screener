import { useEffect, useState } from "react";

interface ChildRow {
  parentId: string;
  symbol: string;
  child: "SCALPER" | "SNIPER" | "SWING" | "RUNNER";
  side: "LONG" | "SHORT";
  qty: number;
  entry: number;
  stop: number;
  target: number;
  status: "PENDING" | "OPEN" | "TP" | "SL" | "CLOSED";
  pnlPct?: number;
  exchange: "BITUNIX" | "PIONEX" | "BINANCE_SPOT";
  paper: boolean;
}

export function ChildTradesCard() {
  const [rows, setRows] = useState<ChildRow[]>([]);

  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/trades/children");
      if (r.ok) {
        const data = await r.json();
        setRows(data.rows || []);
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Child Trades</h3>
        <span className="text-xs text-muted-foreground">{rows.length} active</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left py-2">Symbol</th>
              <th>Child</th>
              <th>Side</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Target</th>
              <th>P&L%</th>
              <th>Exch</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.parentId}-${r.child}`} className="border-t">
                <td className="py-2 font-medium">{r.symbol}</td>
                <td className="text-center">{r.child}</td>
                <td className={"text-center " + (r.side === "LONG" ? "text-emerald-500" : "text-red-500")}>
                  {r.side}
                </td>
                <td className="text-right">{r.entry.toFixed(4)}</td>
                <td className="text-right">{r.stop.toFixed(4)}</td>
                <td className="text-right">{r.target.toFixed(4)}</td>
                <td className={"text-right " + ((r.pnlPct ?? 0) >= 0 ? "text-emerald-500" : "text-red-500")}>
                  {(r.pnlPct ?? 0).toFixed(2)}%
                </td>
                <td className="text-center">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">
                    {r.exchange}{r.paper ? "·P" : ""}
                  </span>
                </td>
                <td className="text-center">{r.status}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-6 text-center text-muted-foreground">
                  No active child trades
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

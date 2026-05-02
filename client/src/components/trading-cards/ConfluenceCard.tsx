import { useEffect, useState } from "react";

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

export function ConfluenceCard() {
  const [rows, setRows] = useState<ConfluenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch("/api/confluence/latest");
        if (!r.ok) throw new Error(`status ${r.status}`);
        const data = await r.json();
        if (!cancel) setRows(data.rows || []);
      } catch (e: any) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, []);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">Loading confluence…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error: {error}</div>;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Confluence Signals</h3>
        <span className="text-xs text-muted-foreground">{rows.length} active</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left py-2">Symbol</th>
              <th>FD-S</th>
              <th>FD-L</th>
              <th>FUEL</th>
              <th>Daily</th>
              <th>SMC</th>
              <th>Qimen</th>
              <th>Total</th>
              <th className="text-left">Children</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t">
                <td className="py-2 font-medium">{r.symbol}</td>
                <td className="text-center">{r.firedogShort}</td>
                <td className="text-center">{r.firedogLong}</td>
                <td className="text-center">{r.fuel.toFixed(0)}</td>
                <td className="text-center">{r.daily.toFixed(0)}</td>
                <td className="text-center">{r.smc}</td>
                <td className="text-center">{r.qimen.toFixed(0)}</td>
                <td className="text-center font-semibold">{r.total.toFixed(0)}</td>
                <td className="space-x-1">
                  {(["SCALPER", "SNIPER", "SWING", "RUNNER"] as const).map((c) => (
                    <span
                      key={c}
                      className={
                        "inline-block px-1.5 py-0.5 rounded text-[10px] " +
                        (r.childPlan[c]
                          ? "bg-emerald-500/20 text-emerald-500"
                          : "bg-muted text-muted-foreground line-through")
                      }
                    >
                      {c}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";

interface KillState {
  startEquity: number;
  currentEquity: number;
  killed: boolean;
  killReason?: string;
  openCount: number;
  tradingEnabled: boolean;
}

export function KillSwitchCard() {
  const [state, setState] = useState<KillState | null>(null);

  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/risk/kill-state");
      if (r.ok) setState(await r.json());
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  if (!state) return null;
  const dd = state.startEquity
    ? ((state.startEquity - state.currentEquity) / state.startEquity) * 100
    : 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Risk Status</h3>
        <span
          className={
            "px-2 py-0.5 rounded text-xs " +
            (state.killed
              ? "bg-red-500/20 text-red-500"
              : state.tradingEnabled
              ? "bg-emerald-500/20 text-emerald-500"
              : "bg-yellow-500/20 text-yellow-500")
          }
        >
          {state.killed ? "KILLED" : state.tradingEnabled ? "LIVE" : "PAPER"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-muted-foreground text-xs">Start Equity</div>
          <div className="font-medium">${state.startEquity.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Current</div>
          <div className="font-medium">${state.currentEquity.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Day P&L</div>
          <div className={dd >= 0 ? "font-medium text-red-500" : "font-medium text-emerald-500"}>
            {dd > 0 ? "-" : "+"}{Math.abs(dd).toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Open Trades</div>
          <div className="font-medium">{state.openCount}</div>
        </div>
      </div>
      {state.killReason && (
        <div className="mt-3 text-xs text-red-500">{state.killReason}</div>
      )}
    </div>
  );
}

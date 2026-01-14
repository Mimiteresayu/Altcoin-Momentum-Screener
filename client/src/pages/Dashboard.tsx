import { useTickers } from "@/hooks/use-market-data";
import { SignalTable } from "@/components/SignalTable";
import { WatchlistSidebar } from "@/components/WatchlistSidebar";
import { MetricCard } from "@/components/MetricCard";
import { Activity, BarChart3, Target, Layers, TrendingUp, Zap } from "lucide-react";

export default function Dashboard() {
  const { data: signals, isLoading, isError } = useTickers();

  const metrics = signals && signals.length > 0 ? {
    activeSignals: signals.length,
    avgRR: (signals.reduce((acc, s) => acc + s.riskReward, 0) / signals.length).toFixed(1),
    strongSignals: signals.filter(s => s.signalStrength >= 4).length,
    multiTFConfirmed: signals.filter(s => s.confirmedTimeframes.length >= 2).length,
    withFVG: signals.filter(s => s.leadingIndicators.hasFVG).length,
    withOB: signals.filter(s => s.leadingIndicators.hasOrderBlock).length,
  } : null;

  if (isError) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background text-destructive">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">Connection Error</h2>
          <p className="text-muted-foreground">Unable to fetch market data from Bitunix.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-white/10 bg-card/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1920px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center text-white font-bold shadow-lg shadow-emerald-500/20">
              S
            </div>
            <div>
              <h1 className="text-lg font-bold font-display tracking-tight leading-none" data-testid="text-app-title">Signal Scanner</h1>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">Pre-Spike Detection</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Live Feed
            </span>
            <div className="h-4 w-px bg-white/10" />
            <span>UTC {new Date().toISOString().slice(11, 19)}</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-[1920px] mx-auto p-6 space-y-6">
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <MetricCard 
                label="Quality Signals" 
                value={metrics?.activeSignals.toString() || "0"} 
                icon={<Layers className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Avg Risk-Reward" 
                value={metrics ? `1:${metrics.avgRR}` : "--"}
                icon={<Target className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Strong (4+/5)" 
                value={metrics?.strongSignals.toString() || "0"}
                icon={<Zap className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Multi-TF Confirmed" 
                value={metrics?.multiTFConfirmed.toString() || "0"}
                icon={<Activity className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="With FVG" 
                value={metrics?.withFVG.toString() || "0"}
                icon={<BarChart3 className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="With Order Block" 
                value={metrics?.withOB.toString() || "0"}
                icon={<TrendingUp className="w-4 h-4" />}
                loading={isLoading}
              />
            </div>

            <div className="space-y-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-primary" />
                Pre-Spike Signals
                <span className="text-xs text-muted-foreground font-normal ml-2">
                  Sorted by Risk-Reward ratio
                </span>
              </h2>
              {isLoading ? (
                <div className="space-y-4 animate-pulse">
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="text-center text-muted-foreground py-8">
                    Analyzing 100+ coins across multiple timeframes...
                  </div>
                </div>
              ) : (
                <SignalTable signals={signals || []} />
              )}
            </div>
          </div>
        </div>

        <div className="hidden lg:block w-80 flex-shrink-0 bg-background/50 backdrop-blur-sm z-40">
          <WatchlistSidebar />
        </div>
      </main>
    </div>
  );
}

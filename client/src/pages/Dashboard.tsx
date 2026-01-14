import { useState, useEffect } from "react";
import { useTickers, useRefreshSignals } from "@/hooks/use-market-data";
import { SignalTable } from "@/components/SignalTable";
import { WatchlistSidebar } from "@/components/WatchlistSidebar";
import { MetricCard } from "@/components/MetricCard";
import { Activity, BarChart3, Target, Layers, Zap, RefreshCw, Clock, Waves, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";

function getHKTime() {
  return new Date().toLocaleTimeString('en-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
}

export default function Dashboard() {
  const { data, isLoading, isError, refetch } = useTickers();
  const refreshSignals = useRefreshSignals();
  const [countdown, setCountdown] = useState("");
  const [hkTime, setHkTime] = useState(getHKTime());

  // Clear cache on mount to force fresh data
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['tickers', 'live'] });
    refetch();
  }, []);

  const signals = data?.signals || [];
  const lastUpdated = data?.lastUpdated ? new Date(data.lastUpdated) : null;
  const nextUpdate = data?.nextUpdate ? new Date(data.nextUpdate) : null;

  // Debug logging - check console for signal count
  console.log('[Dashboard] Total signals:', signals.length, 
    '| RIVER:', signals.some(s => s.symbol === 'RIVERUSDT'),
    '| 4USDT:', signals.some(s => s.symbol === '4USDT'),
    '| EDEN:', signals.some(s => s.symbol === 'EDENUSDT'));

  useEffect(() => {
    const interval = setInterval(() => {
      setHkTime(getHKTime());
      if (nextUpdate) {
        const now = new Date();
        const diff = nextUpdate.getTime() - now.getTime();
        if (diff > 0) {
          const minutes = Math.floor(diff / 60000);
          const seconds = Math.floor((diff % 60000) / 1000);
          setCountdown(`${minutes}m ${seconds}s`);
        } else {
          setCountdown("Updating...");
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [nextUpdate]);

  const metrics = signals.length > 0 ? {
    activeSignals: signals.length,
    avgRR: (signals.reduce((acc, s) => acc + s.riskReward, 0) / signals.length).toFixed(1),
    strongSignals: signals.filter(s => s.signalStrength >= 4).length,
    multiTFConfirmed: signals.filter(s => s.confirmedTimeframes.length >= 2).length,
    withLiquidity: signals.filter(s => s.leadingIndicators.hasLiquidityZone).length,
    majorPairs: signals.filter(s => s.isMajor).length,
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
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center text-white font-bold shadow-lg shadow-emerald-500/20">
              S
            </div>
            <div>
              <h1 className="text-lg font-bold font-display tracking-tight leading-none" data-testid="text-app-title">Signal Scanner</h1>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">Pre-Spike Detection v2.2</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3 text-xs">
            <div className="hidden sm:flex items-center gap-2 text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-lg">
              <Clock className="w-3.5 h-3.5" />
              <div className="flex flex-col">
                <span className="text-[10px]">
                  Updated: {lastUpdated ? lastUpdated.toLocaleTimeString('en-HK', { timeZone: 'Asia/Hong_Kong', hour12: false }) : "--:--:--"} HKT
                </span>
                <span className="text-[10px] text-primary">
                  Next: {countdown || "--"}
                </span>
              </div>
            </div>
            
            <Button 
              size="sm" 
              variant="outline" 
              onClick={() => refreshSignals.mutate()}
              disabled={refreshSignals.isPending}
              className="gap-1.5"
              data-testid="button-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshSignals.isPending ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="hidden sm:inline">Live Feed</span>
              <span className="font-mono text-[10px]" data-testid="text-hk-time">
                HKT {hkTime}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-[1920px] mx-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
              <MetricCard 
                label="Total Signals" 
                value={metrics?.activeSignals.toString() || "0"} 
                icon={<Layers className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Major Pairs" 
                value={metrics?.majorPairs.toString() || "0"}
                icon={<Crown className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Avg R:R" 
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
                label="Multi-TF" 
                value={metrics?.multiTFConfirmed.toString() || "0"}
                icon={<Activity className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="With Liquidity" 
                value={metrics?.withLiquidity.toString() || "0"}
                icon={<Waves className="w-4 h-4" />}
                loading={isLoading}
              />
            </div>

            <div className="bg-muted/20 rounded-lg p-3 text-xs text-muted-foreground flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Updates every {data?.updateFrequencyMinutes || 5} minutes</span>
              </div>
              <div className="flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5" />
                <span>Sorted by Risk-Reward ratio</span>
              </div>
              <div className="flex items-center gap-2">
                <Crown className="w-3.5 h-3.5 text-amber-400" />
                <span>BTC & ETH always shown</span>
              </div>
              <div className="flex items-center gap-2 ml-auto text-primary font-medium">
                <Activity className="w-3.5 h-3.5" />
                <span data-testid="text-filtered-count">{signals.length} quality signals (filtered from 500+)</span>
              </div>
            </div>

            <div className="space-y-3">
              <h2 className="text-base sm:text-lg font-semibold flex items-center gap-2">
                <BarChart3 className="w-4 sm:w-5 h-4 sm:h-5 text-primary" />
                Pre-Spike Signals
              </h2>
              {isLoading ? (
                <div className="space-y-4 animate-pulse">
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="text-center text-muted-foreground py-8">
                    Analyzing coins with multi-timeframe data...
                  </div>
                </div>
              ) : (
                <SignalTable signals={signals} />
              )}
            </div>
          </div>
        </div>

        <div className="hidden lg:block w-72 xl:w-80 flex-shrink-0 bg-background/50 backdrop-blur-sm z-40">
          <WatchlistSidebar />
        </div>
      </main>
    </div>
  );
}

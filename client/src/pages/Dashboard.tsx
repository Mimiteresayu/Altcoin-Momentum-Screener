import { useTickers } from "@/hooks/use-market-data";
import { TickerTable } from "@/components/TickerTable";
import { WatchlistSidebar } from "@/components/WatchlistSidebar";
import { MetricCard } from "@/components/MetricCard";
import { Activity, BarChart3, Coins, Layers } from "lucide-react";

export default function Dashboard() {
  const { data: tickers, isLoading, isError } = useTickers();

  // Calculate market metrics
  const marketMetrics = tickers ? {
    totalVolume: tickers.reduce((acc, t) => acc + parseFloat(t.baseVol), 0),
    gainers: tickers.filter(t => parseFloat(t.lastPrice) > parseFloat(t.open)).length,
    losers: tickers.filter(t => parseFloat(t.lastPrice) < parseFloat(t.open)).length,
    topGainer: [...tickers].sort((a, b) => {
      const changeA = (parseFloat(a.lastPrice) - parseFloat(a.open)) / parseFloat(a.open);
      const changeB = (parseFloat(b.lastPrice) - parseFloat(b.open)) / parseFloat(b.open);
      return changeB - changeA;
    })[0]
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
      {/* Header */}
      <header className="border-b border-white/10 bg-card/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1920px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold shadow-lg shadow-blue-500/20">
              B
            </div>
            <div>
              <h1 className="text-lg font-bold font-display tracking-tight leading-none">Bitunix Scanner</h1>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">Real-time Terminal</p>
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
        {/* Main Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-[1920px] mx-auto p-6 space-y-6">
            
            {/* Hero Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard 
                label="24h Volume (BTC)" 
                value={marketMetrics ? marketMetrics.totalVolume.toFixed(2) : "0.00"} 
                icon={<BarChart3 className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Market Sentiment" 
                value={marketMetrics ? `${((marketMetrics.gainers / tickers!.length) * 100).toFixed(0)}% Bullish` : "--"}
                trend={marketMetrics ? parseFloat((marketMetrics.gainers / tickers!.length * 100).toFixed(0)) : 0}
                icon={<Activity className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Top Gainer" 
                value={marketMetrics?.topGainer?.symbol || "--"}
                trend={marketMetrics?.topGainer ? parseFloat((((parseFloat(marketMetrics.topGainer.lastPrice) - parseFloat(marketMetrics.topGainer.open)) / parseFloat(marketMetrics.topGainer.open)) * 100).toFixed(2)) : 0}
                icon={<TrendingUp className="w-4 h-4" />}
                loading={isLoading}
              />
              <MetricCard 
                label="Active Pairs" 
                value={tickers?.length.toString() || "0"}
                icon={<Layers className="w-4 h-4" />}
                loading={isLoading}
              />
            </div>

            {/* Main Table */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Coins className="w-5 h-5 text-primary" />
                Market Overview
              </h2>
              {isLoading ? (
                <div className="space-y-4 animate-pulse">
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                  <div className="h-12 bg-white/5 rounded-lg w-full" />
                </div>
              ) : (
                <TickerTable tickers={tickers || []} />
              )}
            </div>
          </div>
        </div>

        {/* Watchlist Sidebar - Hidden on mobile, fixed on desktop */}
        <div className="hidden lg:block w-80 flex-shrink-0 bg-background/50 backdrop-blur-sm z-40">
          <WatchlistSidebar />
        </div>
      </main>
    </div>
  );
}

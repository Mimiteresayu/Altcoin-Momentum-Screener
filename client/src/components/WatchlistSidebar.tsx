import { useWatchlist, useRemoveFromWatchlist, useTickers } from "@/hooks/use-market-data";
import { X, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { clsx } from "clsx";
import { motion, AnimatePresence } from "framer-motion";

export function WatchlistSidebar() {
  const { data: watchlist, isLoading: loadingWatchlist } = useWatchlist();
  const { data: tickersData, isLoading: loadingTickers } = useTickers();
  const removeMutation = useRemoveFromWatchlist();

  const signals = tickersData?.signals || [];

  const getSignal = (symbol: string) => signals.find(s => s.symbol === symbol);

  const formatPrice = (price: number) => {
    if (price < 1) return price.toFixed(6);
    if (price < 10) return price.toFixed(4);
    return price.toFixed(2);
  };

  if (loadingWatchlist || loadingTickers) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
        <RefreshCw className="w-6 h-6 animate-spin mb-2" />
        <span className="text-sm">Loading watchlist...</span>
      </div>
    );
  }

  if (!watchlist || watchlist.length === 0) {
    return (
      <div className="p-6 text-center border-l border-white/5 h-full">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">Watchlist</h3>
        <div className="p-6 rounded-xl border border-dashed border-white/10 bg-white/[0.02]">
          <p className="text-sm text-muted-foreground">
            No items yet. Star a pair in the table to add it here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full border-l border-white/5 bg-card/30 flex flex-col w-full md:w-80">
      <div className="p-6 border-b border-white/5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          Watchlist
          <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-bold">
            {watchlist.length}
          </span>
        </h3>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
        <AnimatePresence mode="popLayout">
          {watchlist.map((item: any) => {
            const signal = getSignal(item.symbol);
            const change = signal?.priceChange24h || 0;
            const isPositive = change > 0;
            const isNegative = change < 0;

            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="group relative p-4 rounded-xl bg-card border border-white/5 hover:border-primary/20 hover:bg-white/[0.02] transition-all shadow-sm"
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="font-mono font-bold text-foreground">{item.symbol}</span>
                  <button
                    onClick={() => removeMutation.mutate(item.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all p-1 -mr-2 -mt-2"
                    data-testid={`button-remove-watchlist-${item.symbol}`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {signal ? (
                  <div className="flex justify-between items-end">
                    <span className="text-lg font-mono-numbers font-medium text-foreground">
                      ${formatPrice(signal.currentPrice)}
                    </span>
                    <div className={clsx(
                      "flex items-center gap-1 text-xs font-bold px-1.5 py-0.5 rounded",
                      isPositive ? "text-emerald-400 bg-emerald-500/10" : isNegative ? "text-rose-400 bg-rose-500/10" : "text-muted-foreground"
                    )}>
                      {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(change).toFixed(2)}%
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground italic">
                    Data unavailable
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

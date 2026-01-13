import { useState, useMemo } from "react";
import { type Signal } from "@shared/schema";
import { ArrowUp, ArrowDown, ArrowUpDown, Star, Search, TrendingUp, TrendingDown, Activity, Target, ShieldAlert, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from "@/hooks/use-market-data";
import { Badge } from "@/components/ui/badge";

interface SignalTableProps {
  signals: Signal[];
}

type SortKey = keyof Signal;
type SortDirection = 'asc' | 'desc';

export function SignalTable({ signals }: SignalTableProps) {
  const [search, setSearch] = useState("");
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'riskReward',
    direction: 'desc'
  });

  const { data: watchlist } = useWatchlist();
  const addToWatchlist = useAddToWatchlist();
  const removeFromWatchlist = useRemoveFromWatchlist();

  const formatPrice = (price: number) => {
    if (price < 1) return price.toFixed(6);
    if (price < 10) return price.toFixed(4);
    return price.toFixed(2);
  };

  const processedData = useMemo(() => {
    let data = [...signals];

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(s => s.symbol.toLowerCase().includes(q));
    }

    data.sort((a, b) => {
      const aVal = a[sortConfig.key];
      const bVal = b[sortConfig.key];

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return 0;
    });

    return data;
  }, [signals, search, sortConfig]);

  const handleSort = (key: SortKey) => {
    setSortConfig(current => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const isWatched = (symbol: string) => watchlist?.some(w => w.symbol === symbol);

  const toggleWatchlist = (e: React.MouseEvent, symbol: string) => {
    e.stopPropagation();
    const existing = watchlist?.find(w => w.symbol === symbol);
    if (existing) {
      removeFromWatchlist.mutate(existing.id);
    } else {
      addToWatchlist.mutate({ symbol });
    }
  };

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortConfig.key !== column) return <ArrowUpDown className="w-3 h-3 ml-1 text-muted-foreground/30" />;
    return sortConfig.direction === 'asc' 
      ? <ArrowUp className="w-3 h-3 ml-1 text-primary" /> 
      : <ArrowDown className="w-3 h-3 ml-1 text-primary" />;
  };

  const getStrengthBadge = (strength: number) => {
    if (strength === 3) return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">{strength}/3</Badge>;
    if (strength === 2) return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">{strength}/3</Badge>;
    return <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30">{strength}/3</Badge>;
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 p-1">
        <div className="relative w-full sm:w-72 group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
          <input
            type="text"
            placeholder="Search symbol..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search"
            className="w-full pl-9 pr-4 py-2 bg-muted/30 border border-white/5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all placeholder:text-muted-foreground/50"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Activity className="w-4 h-4" />
          <span data-testid="text-signal-count">{processedData.length} signals</span>
        </div>
      </div>

      <div className="rounded-xl border border-white/5 bg-card/50 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/20">
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <th className="px-4 py-4 w-10 text-center">
                  <Star className="w-4 h-4 mx-auto" />
                </th>
                <th className="px-4 py-4 cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('symbol')}>
                  <div className="flex items-center">Symbol <SortIcon column="symbol" /></div>
                </th>
                <th className="px-4 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('currentPrice')}>
                  <div className="flex items-center justify-end">Price <SortIcon column="currentPrice" /></div>
                </th>
                <th className="px-4 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('priceChange24h')}>
                  <div className="flex items-center justify-end">24h % <SortIcon column="priceChange24h" /></div>
                </th>
                <th className="px-4 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('volumeSpikeRatio')}>
                  <div className="flex items-center justify-end">Vol Spike <SortIcon column="volumeSpikeRatio" /></div>
                </th>
                <th className="px-4 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('rsi')}>
                  <div className="flex items-center justify-end">RSI <SortIcon column="rsi" /></div>
                </th>
                <th className="px-4 py-4 text-right">
                  <div className="flex items-center justify-end gap-1"><ShieldAlert className="w-3 h-3" /> SL</div>
                </th>
                <th className="px-4 py-4 text-right">
                  <div className="flex items-center justify-end gap-1"><Target className="w-3 h-3" /> TP</div>
                </th>
                <th className="px-4 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('riskReward')}>
                  <div className="flex items-center justify-end">R:R <SortIcon column="riskReward" /></div>
                </th>
                <th className="px-4 py-4 text-center cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('signalStrength')}>
                  <div className="flex items-center justify-center gap-1"><Zap className="w-3 h-3" /> Str <SortIcon column="signalStrength" /></div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <AnimatePresence initial={false}>
                {processedData.map((signal) => {
                  const isPositive = signal.priceChange24h > 0;
                  const isNegative = signal.priceChange24h < 0;
                  const watched = isWatched(signal.symbol);

                  return (
                    <motion.tr 
                      key={signal.symbol}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="group hover:bg-white/[0.02] transition-colors"
                      data-testid={`row-signal-${signal.symbol}`}
                    >
                      <td className="px-4 py-3 text-center">
                        <button 
                          onClick={(e) => toggleWatchlist(e, signal.symbol)}
                          data-testid={`button-watchlist-${signal.symbol}`}
                          className={clsx(
                            "p-1.5 rounded-full hover:bg-white/10 transition-all",
                            watched ? "text-yellow-400" : "text-muted-foreground/20 hover:text-yellow-400/50"
                          )}
                        >
                          <Star className={clsx("w-4 h-4", watched && "fill-current")} />
                        </button>
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">
                        <span className="font-mono tracking-tight">{signal.symbol}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{signal.timeframe}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-foreground font-bold">
                        ${formatPrice(signal.currentPrice)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div className={clsx(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold",
                          isPositive ? "text-emerald-400 bg-emerald-500/10" : isNegative ? "text-rose-400 bg-rose-500/10" : "text-muted-foreground"
                        )}>
                          {isPositive && <TrendingUp className="w-3 h-3" />}
                          {isNegative && <TrendingDown className="w-3 h-3" />}
                          {signal.priceChange24h.toFixed(2)}%
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-amber-400">
                        {signal.volumeSpikeRatio.toFixed(2)}x
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                        {signal.rsi.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div className="text-rose-400">${formatPrice(signal.slPrice)}</div>
                        <div className="text-xs text-rose-400/60">-{signal.slDistancePct.toFixed(1)}%</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <div className="text-emerald-400">${formatPrice(signal.tpPrice)}</div>
                        <div className="text-xs text-emerald-400/60">+{signal.tpDistancePct.toFixed(1)}%</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <Badge className={clsx(
                          "font-bold",
                          signal.riskReward >= 3 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-slate-500/20 text-slate-300 border-slate-500/30"
                        )}>
                          1:{signal.riskReward.toFixed(1)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {getStrengthBadge(signal.signalStrength)}
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
          
          {processedData.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              {search ? `No signals found matching "${search}"` : "No signals detected - waiting for market conditions"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

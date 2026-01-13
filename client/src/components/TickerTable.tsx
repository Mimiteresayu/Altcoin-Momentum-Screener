import { useState, useMemo } from "react";
import { type Ticker } from "@shared/schema";
import { ArrowUp, ArrowDown, ArrowUpDown, Star, Search, TrendingUp, TrendingDown, Activity } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from "@/hooks/use-market-data";

interface TickerTableProps {
  tickers: Ticker[];
}

type SortKey = keyof Ticker | 'change';
type SortDirection = 'asc' | 'desc';

export function TickerTable({ tickers }: TickerTableProps) {
  const [search, setSearch] = useState("");
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'baseVol', // Default sort by volume
    direction: 'desc'
  });

  const { data: watchlist } = useWatchlist();
  const addToWatchlist = useAddToWatchlist();
  const removeFromWatchlist = useRemoveFromWatchlist();

  // Helper to format currency
  const formatPrice = (price: string) => {
    const val = parseFloat(price);
    if (val < 1) return val.toFixed(6);
    if (val < 10) return val.toFixed(4);
    return val.toFixed(2);
  };

  const formatVol = (vol: string) => {
    const val = parseFloat(vol);
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(2)}K`;
    return val.toFixed(2);
  };

  // Calculate change percentage
  const getChange = (ticker: Ticker) => {
    const open = parseFloat(ticker.open);
    const last = parseFloat(ticker.lastPrice);
    if (open === 0) return 0;
    return ((last - open) / open) * 100;
  };

  // Filter and Sort
  const processedData = useMemo(() => {
    let data = [...tickers];

    // Filter
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(t => t.symbol.toLowerCase().includes(q));
    }

    // Sort
    data.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      if (sortConfig.key === 'change') {
        aVal = getChange(a);
        bVal = getChange(b);
      } else if (['lastPrice', 'open', 'high', 'low', 'baseVol', 'quoteVol', 'markPrice'].includes(sortConfig.key)) {
        aVal = parseFloat(a[sortConfig.key as keyof Ticker] as string);
        bVal = parseFloat(b[sortConfig.key as keyof Ticker] as string);
      } else {
        aVal = a[sortConfig.key as keyof Ticker];
        bVal = b[sortConfig.key as keyof Ticker];
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return data;
  }, [tickers, search, sortConfig]);

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

  return (
    <div className="w-full space-y-4">
      {/* Table Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 p-1">
        <div className="relative w-full sm:w-72 group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
          <input
            type="text"
            placeholder="Search symbol (e.g. BTC)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-muted/30 border border-white/5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all placeholder:text-muted-foreground/50"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Activity className="w-4 h-4" />
          <span>{processedData.length} pairs active</span>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-white/5 bg-card/50 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/20">
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <th className="px-6 py-4 w-12 text-center">
                  <Star className="w-4 h-4 mx-auto" />
                </th>
                <th 
                  className="px-6 py-4 cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => handleSort('symbol')}
                >
                  <div className="flex items-center">
                    Pair <SortIcon column="symbol" />
                  </div>
                </th>
                <th 
                  className="px-6 py-4 text-right cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => handleSort('lastPrice')}
                >
                  <div className="flex items-center justify-end">
                    Price <SortIcon column="lastPrice" />
                  </div>
                </th>
                <th 
                  className="px-6 py-4 text-right cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => handleSort('change')}
                >
                  <div className="flex items-center justify-end">
                    24h Change <SortIcon column="change" />
                  </div>
                </th>
                <th 
                  className="px-6 py-4 text-right cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => handleSort('high')}
                >
                  <div className="flex items-center justify-end">
                    24h High <SortIcon column="high" />
                  </div>
                </th>
                <th 
                  className="px-6 py-4 text-right cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => handleSort('low')}
                >
                  <div className="flex items-center justify-end">
                    24h Low <SortIcon column="low" />
                  </div>
                </th>
                <th 
                  className="px-6 py-4 text-right cursor-pointer hover:text-primary transition-colors group select-none"
                  onClick={() => handleSort('baseVol')}
                >
                  <div className="flex items-center justify-end">
                    Volume (Base) <SortIcon column="baseVol" />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <AnimatePresence initial={false}>
                {processedData.map((ticker) => {
                  const change = getChange(ticker);
                  const isPositive = change > 0;
                  const isNegative = change < 0;
                  const watched = isWatched(ticker.symbol);

                  return (
                    <motion.tr 
                      key={ticker.symbol}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="group hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-6 py-3 text-center">
                        <button 
                          onClick={(e) => toggleWatchlist(e, ticker.symbol)}
                          className={clsx(
                            "p-1.5 rounded-full hover:bg-white/10 transition-all",
                            watched ? "text-yellow-400" : "text-muted-foreground/20 hover:text-yellow-400/50"
                          )}
                        >
                          <Star className={clsx("w-4 h-4", watched && "fill-current")} />
                        </button>
                      </td>
                      <td className="px-6 py-3 font-medium text-foreground">
                        <span className="font-mono tracking-tight">{ticker.symbol}</span>
                      </td>
                      <td className="px-6 py-3 text-right font-mono-numbers text-foreground">
                        ${formatPrice(ticker.lastPrice)}
                      </td>
                      <td className="px-6 py-3 text-right font-mono-numbers">
                        <div className={clsx(
                          "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold",
                          isPositive ? "text-up bg-up/10" : isNegative ? "text-down bg-down/10" : "text-muted-foreground bg-muted/10"
                        )}>
                          {isPositive && <TrendingUp className="w-3 h-3" />}
                          {isNegative && <TrendingDown className="w-3 h-3" />}
                          {Math.abs(change).toFixed(2)}%
                        </div>
                      </td>
                      <td className="px-6 py-3 text-right font-mono-numbers text-muted-foreground">
                        {formatPrice(ticker.high)}
                      </td>
                      <td className="px-6 py-3 text-right font-mono-numbers text-muted-foreground">
                        {formatPrice(ticker.low)}
                      </td>
                      <td className="px-6 py-3 text-right font-mono-numbers text-foreground/80">
                        {formatVol(ticker.baseVol)}
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
          
          {processedData.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              No symbols found matching "{search}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useMemo } from "react";
import { type Signal } from "@shared/schema";
import { ArrowUp, ArrowDown, ArrowUpDown, Star, Search, TrendingUp, TrendingDown, Activity, Target, ShieldAlert, Zap, BarChart3, Clock, Check, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from "@/hooks/use-market-data";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SignalTableProps {
  signals: Signal[];
}

type SortKey = "symbol" | "currentPrice" | "priceChange24h" | "volumeSpikeRatio" | "rsi" | "riskReward" | "signalStrength";
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
    if (price < 0.0001) return price.toFixed(8);
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
    if (strength === 5) return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 font-bold">{strength}/5</Badge>;
    if (strength === 4) return <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30 font-bold">{strength}/5</Badge>;
    if (strength === 3) return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 font-bold">{strength}/5</Badge>;
    return <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30 font-bold">{strength}/5</Badge>;
  };

  const StrengthBreakdown = ({ breakdown }: { breakdown: Signal["strengthBreakdown"] }) => (
    <div className="text-xs space-y-1 p-2">
      <div className="flex items-center gap-2">
        {breakdown.priceInRange ? <Check className="w-3 h-3 text-emerald-400" /> : <X className="w-3 h-3 text-rose-400" />}
        <span>Price in range (-5% to +15%)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.volumeInRange ? <Check className="w-3 h-3 text-emerald-400" /> : <X className="w-3 h-3 text-rose-400" />}
        <span>Volume spike (1.5x-3x)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.rsiInRange ? <Check className="w-3 h-3 text-emerald-400" /> : <X className="w-3 h-3 text-rose-400" />}
        <span>RSI (50-75)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.rrInRange ? <Check className="w-3 h-3 text-emerald-400" /> : <X className="w-3 h-3 text-rose-400" />}
        <span>Risk-Reward (2+)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.hasLeadingIndicators ? <Check className="w-3 h-3 text-emerald-400" /> : <X className="w-3 h-3 text-rose-400" />}
        <span>Leading indicators</span>
      </div>
    </div>
  );

  const LeadingIndicatorsTooltip = ({ indicators }: { indicators: Signal["leadingIndicators"] }) => (
    <div className="text-xs space-y-1.5 p-2 min-w-[180px]">
      <div className="font-semibold border-b border-white/10 pb-1 mb-1">Order Book</div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Imbalance:</span>
        <span className={indicators.orderBookImbalance > 0 ? "text-emerald-400" : "text-rose-400"}>
          {(indicators.orderBookImbalance * 100).toFixed(1)}%
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Bid/Ask Ratio:</span>
        <span className={indicators.bidAskRatio > 1 ? "text-emerald-400" : "text-rose-400"}>
          {indicators.bidAskRatio.toFixed(2)}
        </span>
      </div>
      <div className="font-semibold border-b border-white/10 pb-1 mb-1 mt-2">Structure</div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">FVG:</span>
        {indicators.hasFVG ? (
          <span className={indicators.fvgType === "bullish" ? "text-emerald-400" : "text-rose-400"}>
            {indicators.fvgType} @ {formatPrice(indicators.fvgLevel!)}
          </span>
        ) : (
          <span className="text-slate-500">None</span>
        )}
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Order Block:</span>
        {indicators.hasOrderBlock ? (
          <span className={indicators.obType === "bullish" ? "text-emerald-400" : "text-rose-400"}>
            {indicators.obType} @ {formatPrice(indicators.obLevel!)}
          </span>
        ) : (
          <span className="text-slate-500">None</span>
        )}
      </div>
    </div>
  );

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
          <span data-testid="text-signal-count">{processedData.length} quality signals (filtered from 500+)</span>
        </div>
      </div>

      <div className="rounded-xl border border-white/5 bg-card/50 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/20">
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <th className="px-3 py-4 w-10 text-center">
                  <Star className="w-4 h-4 mx-auto" />
                </th>
                <th className="px-3 py-4 cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('symbol')}>
                  <div className="flex items-center">Symbol <SortIcon column="symbol" /></div>
                </th>
                <th className="px-3 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('currentPrice')}>
                  <div className="flex items-center justify-end">Price <SortIcon column="currentPrice" /></div>
                </th>
                <th className="px-3 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('priceChange24h')}>
                  <div className="flex items-center justify-end">24h <SortIcon column="priceChange24h" /></div>
                </th>
                <th className="px-3 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('volumeSpikeRatio')}>
                  <div className="flex items-center justify-end">Vol <SortIcon column="volumeSpikeRatio" /></div>
                </th>
                <th className="px-3 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('rsi')}>
                  <div className="flex items-center justify-end">RSI <SortIcon column="rsi" /></div>
                </th>
                <th className="px-3 py-4 text-center">
                  <div className="flex items-center justify-center gap-1"><Clock className="w-3 h-3" /> TF</div>
                </th>
                <th className="px-3 py-4 text-right">
                  <div className="flex items-center justify-end gap-1"><ShieldAlert className="w-3 h-3" /> SL</div>
                </th>
                <th className="px-3 py-4 text-right">
                  <div className="flex items-center justify-end gap-1"><Target className="w-3 h-3" /> TP</div>
                </th>
                <th className="px-3 py-4 text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('riskReward')}>
                  <div className="flex items-center justify-end">R:R <SortIcon column="riskReward" /></div>
                </th>
                <th className="px-3 py-4 text-center">
                  <div className="flex items-center justify-center gap-1"><BarChart3 className="w-3 h-3" /> Ind</div>
                </th>
                <th className="px-3 py-4 text-center cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort('signalStrength')}>
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
                      <td className="px-3 py-3 text-center">
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
                      <td className="px-3 py-3 font-medium text-foreground">
                        <span className="font-mono tracking-tight">{signal.symbol.replace("USDT", "")}</span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-foreground font-bold">
                        ${formatPrice(signal.currentPrice)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        <div className={clsx(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold",
                          isPositive ? "text-emerald-400 bg-emerald-500/10" : isNegative ? "text-rose-400 bg-rose-500/10" : "text-muted-foreground"
                        )}>
                          {isPositive && <TrendingUp className="w-3 h-3" />}
                          {isNegative && <TrendingDown className="w-3 h-3" />}
                          {signal.priceChange24h.toFixed(1)}%
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-amber-400">
                        {signal.volumeSpikeRatio.toFixed(1)}x
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                        {signal.rsi.toFixed(0)}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {signal.confirmedTimeframes.map(tf => (
                            <Badge key={tf} variant="outline" className="text-[10px] px-1.5 py-0 bg-primary/10 border-primary/30 text-primary">
                              {tf}
                            </Badge>
                          ))}
                          {signal.confirmedTimeframes.length === 0 && (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help">
                              <div className="text-rose-400">${formatPrice(signal.slPrice)}</div>
                              <div className="text-[10px] text-rose-400/60">-{signal.slDistancePct.toFixed(1)}%</div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="bg-card border-white/10">
                            <p className="text-xs">{signal.slReason}</p>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help">
                              <div className="text-emerald-400">${formatPrice(signal.tpPrice)}</div>
                              <div className="text-[10px] text-emerald-400/60">+{signal.tpDistancePct.toFixed(1)}%</div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="bg-card border-white/10">
                            <p className="text-xs">{signal.tpReason}</p>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        <Badge className={clsx(
                          "font-bold",
                          signal.riskReward >= 3 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-slate-500/20 text-slate-300 border-slate-500/30"
                        )}>
                          1:{signal.riskReward.toFixed(1)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center justify-center gap-1 cursor-help">
                              {signal.leadingIndicators.hasFVG && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 bg-purple-500/10 border-purple-500/30 text-purple-400">
                                  FVG
                                </Badge>
                              )}
                              {signal.leadingIndicators.hasOrderBlock && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-500/10 border-blue-500/30 text-blue-400">
                                  OB
                                </Badge>
                              )}
                              {signal.leadingIndicators.bidAskRatio > 1.2 && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-400">
                                  BID+
                                </Badge>
                              )}
                              {!signal.leadingIndicators.hasFVG && !signal.leadingIndicators.hasOrderBlock && signal.leadingIndicators.bidAskRatio <= 1.2 && (
                                <span className="text-muted-foreground text-xs">-</span>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="bg-card border-white/10 p-0">
                            <LeadingIndicatorsTooltip indicators={signal.leadingIndicators} />
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help">
                              {getStrengthBadge(signal.signalStrength)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="bg-card border-white/10 p-0">
                            <StrengthBreakdown breakdown={signal.strengthBreakdown} />
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
          
          {processedData.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              {search ? `No signals found matching "${search}"` : "Calculating signals... This may take a moment as we analyze market structure."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

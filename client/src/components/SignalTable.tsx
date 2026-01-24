import { useState, useMemo } from "react";
import { type Signal } from "@shared/schema";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Star,
  Search,
  TrendingUp,
  TrendingDown,
  Activity,
  Target,
  ShieldAlert,
  Zap,
  BarChart3,
  Clock,
  Check,
  X,
  Waves,
  Crown,
  Timer,
  Flame,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import {
  useWatchlist,
  useAddToWatchlist,
  useRemoveFromWatchlist,
} from "@/hooks/use-market-data";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SignalTableProps {
  signals: Signal[];
}

type SortKey =
  | "symbol"
  | "currentPrice"
  | "priceChange24h"
  | "volumeSpikeRatio"
  | "rsi"
  | "riskReward"
  | "signalStrength"
  | "timeOnListMinutes";
type SortDirection = "asc" | "desc";

export function SignalTable({ signals }: SignalTableProps) {
  const [search, setSearch] = useState("");
  const [sortConfig, setSortConfig] = useState<{
    key: SortKey;
    direction: SortDirection;
  }>({
    key: "riskReward",
    direction: "desc",
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
      data = data.filter((s) => s.symbol.toLowerCase().includes(q));
    }

    // Sort by signalType priority: HOT first, then MAJOR, then ACTIVE, then PRE
    // Within each category, sort by the user-selected column
    const typePriority: Record<string, number> = {
      HOT: 0,
      MAJOR: 1,
      ACTIVE: 2,
      PRE: 3,
    };

    data.sort((a, b) => {
      const aPriority = typePriority[a.signalType ?? "PRE"] ?? 4;
      const bPriority = typePriority[b.signalType ?? "PRE"] ?? 4;

      // First sort by signal type priority
      if (aPriority !== bPriority) return aPriority - bPriority;

      // Within same type, sort by selected column
      const aVal = a[sortConfig.key];
      const bVal = b[sortConfig.key];

      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortConfig.direction === "asc" ? aVal - bVal : bVal - aVal;
      }
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortConfig.direction === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      return 0;
    });

    return data;
  }, [signals, search, sortConfig]);

  const handleSort = (key: SortKey) => {
    setSortConfig((current) => ({
      key,
      direction:
        current.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  };

  const isWatched = (symbol: string) =>
    watchlist?.some((w: any) => w.symbol === symbol);

  const toggleWatchlist = (e: React.MouseEvent, symbol: string) => {
    e.stopPropagation();
    const existing = watchlist?.find((w: any) => w.symbol === symbol);
    if (existing) {
      removeFromWatchlist.mutate(existing.id);
    } else {
      addToWatchlist.mutate({ symbol });
    }
  };

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortConfig.key !== column)
      return <ArrowUpDown className="w-3 h-3 ml-1 text-muted-foreground/30" />;
    return sortConfig.direction === "asc" ? (
      <ArrowUp className="w-3 h-3 ml-1 text-primary" />
    ) : (
      <ArrowDown className="w-3 h-3 ml-1 text-primary" />
    );
  };

  const getStrengthBadge = (strength: number) => {
    if (strength === 5)
      return (
        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 font-bold">
          {strength}/5
        </Badge>
      );
    if (strength === 4)
      return (
        <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30 font-bold">
          {strength}/5
        </Badge>
      );
    if (strength === 3)
      return (
        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 font-bold">
          {strength}/5
        </Badge>
      );
    return (
      <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30 font-bold">
        {strength}/5
      </Badge>
    );
  };

  const getSpikeReadinessBadge = (
    readiness: Signal["spikeReadiness"],
    minutes: number | undefined,
  ) => {
    const mins = minutes ?? 0;
    const timeStr =
      mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;

    switch (readiness) {
      case "warming":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 cursor-help">
                <Timer className="w-3 h-3 mr-1" />
                {timeStr}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-xs">
                <div className="font-semibold text-blue-400">Warming Up</div>
                <div className="text-muted-foreground">
                  Just appeared on list. Building momentum...
                </div>
                <div className="mt-1">
                  Wait for 5-15 min window for optimal entry
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      case "primed":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 animate-pulse cursor-help">
                <Flame className="w-3 h-3 mr-1" />
                {timeStr}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-xs">
                <div className="font-semibold text-emerald-400">
                  PRIMED - Optimal Window!
                </div>
                <div className="text-muted-foreground">
                  5-15 minutes on list
                </div>
                <div className="mt-1 font-bold">
                  High probability spike window
                </div>
              </div>
            </TooltipContent>{" "}
          </Tooltip>
        );
      case "hot":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 cursor-help">
                <Flame className="w-3 h-3 mr-1" />
                {timeStr}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-xs">
                <div className="font-semibold text-orange-400">
                  HOT - Spike Imminent!
                </div>
                <div className="text-muted-foreground">
                  15-30 minutes on list
                </div>
                <div className="mt-1">
                  May spike any moment or already moving
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      case "overdue":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30 cursor-help">
                <Clock className="w-3 h-3 mr-1" />
                {timeStr}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-xs">
                <div className="font-semibold text-slate-400">Overdue</div>
                <div className="text-muted-foreground">30+ minutes on list</div>
                <div className="mt-1">
                  May have already spiked or false signal
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      default:
        return (
          <Badge className="bg-slate-500/20 text-slate-400">{timeStr}</Badge>
        );
    }
  };

  const StrengthBreakdown = ({
    breakdown,
  }: {
    breakdown: Signal["strengthBreakdown"];
  }) => (
    <div className="text-xs space-y-1 p-2">
      <div className="flex items-center gap-2">
        {breakdown.priceInRange ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <X className="w-3 h-3 text-rose-400" />
        )}
        <span>Price in range (-5% to +15%)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.volumeInRange ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <X className="w-3 h-3 text-rose-400" />
        )}
        <span>Volume spike (1.5x-3x)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.rsiInRange ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <X className="w-3 h-3 text-rose-400" />
        )}
        <span>RSI (50-75)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.rrInRange ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <X className="w-3 h-3 text-rose-400" />
        )}
        <span>Risk-Reward (2+)</span>
      </div>
      <div className="flex items-center gap-2">
        {breakdown.hasLeadingIndicators ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <X className="w-3 h-3 text-rose-400" />
        )}
        <span>Leading indicators</span>
      </div>
    </div>
  );

  const TPLevelsDisplay = ({ levels }: { levels: Signal["tpLevels"] }) => (
    <div className="text-xs space-y-1.5 p-2 min-w-[200px]">
      {levels.map((tp, idx) => (
        <div key={idx} className="flex justify-between items-center">
          <span
            className={clsx(
              "font-semibold",
              idx === 0
                ? "text-emerald-400"
                : idx === 1
                  ? "text-teal-400"
                  : "text-cyan-400",
            )}
          >
            {tp.label}:
          </span>
          <span className="font-mono">
            ${formatPrice(tp.price)} (+{tp.pct.toFixed(1)}%)
          </span>
        </div>
      ))}
      <div className="border-t border-white/10 pt-1 mt-1">
        {levels.map((tp, idx) => (
          <div key={idx} className="text-muted-foreground text-[10px]">
            {tp.label}: {tp.reason}
          </div>
        ))}
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
          <span data-testid="text-signal-count">
            {processedData.length} signals
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-white/5 bg-card/50 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/20">
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <th className="px-2 py-3 w-8 text-center">
                  <Star className="w-3 h-3 mx-auto" />
                </th>
                <th className="px-2 py-3 text-center">
                  <div className="flex items-center justify-center">Side</div>
                </th>
                <th
                  className="px-2 py-3 cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("symbol")}
                >
                  <div className="flex items-center">
                    Symbol <SortIcon column="symbol" />
                  </div>
                </th>
                <th
                  className="px-2 py-3 text-right cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("currentPrice")}
                >
                  <div className="flex items-center justify-end">
                    Price <SortIcon column="currentPrice" />
                  </div>
                </th>
                <th
                  className="px-2 py-3 text-right cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("priceChange24h")}
                >
                  <div className="flex items-center justify-end">
                    24h <SortIcon column="priceChange24h" />
                  </div>
                </th>
                <th
                  className="px-2 py-3 text-right cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("volumeSpikeRatio")}
                >
                  <div className="flex items-center justify-end">
                    VOL <SortIcon column="volumeSpikeRatio" />
                  </div>
                </th>
                <th className="px-2 py-3 text-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center justify-center gap-1 cursor-help">
                        <Zap className="w-3 h-3 text-amber-400" /> Accel
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-xs max-w-[200px]">
                        <div className="font-semibold text-amber-400">
                          Volume Acceleration
                        </div>
                        <div className="text-muted-foreground">
                          Current 1H volume / Avg 4H volume
                        </div>
                        <div className="mt-1">
                          2.0x+ = Volume spike starting NOW
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th className="px-2 py-3 text-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center justify-center gap-1.5 cursor-help">
                        <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
                        <span className="text-cyan-400 font-semibold">
                          OI %
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[240px]">
                      <div className="text-xs space-y-2">
                        <div className="font-bold text-cyan-400 text-sm">
                          Open Interest Change (24H)
                        </div>
                        <div className="text-muted-foreground">
                          Measures the change in total open futures contracts
                          over the last 24 hours. Rising OI with rising price =
                          bullish momentum.
                        </div>
                        <div className="border-t border-border pt-2 space-y-1">
                          <div className="flex justify-between">
                            <span className="text-emerald-400">
                              +10% or more
                            </span>
                            <span>Strong bullish</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-emerald-400/70">
                              +5% to +10%
                            </span>
                            <span>Moderate bullish</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-rose-400">-5% or less</span>
                            <span>Bearish/closing</span>
                          </div>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th
                  className="px-2 py-3 text-right cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("rsi")}
                >
                  <div className="flex items-center justify-end">
                    RSI <SortIcon column="rsi" />
                  </div>
                </th>
                <th className="px-2 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Clock className="w-3 h-3" /> TF
                  </div>
                </th>
                <th className="px-2 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <ShieldAlert className="w-3 h-3" /> SL
                  </div>
                </th>
                <th className="px-2 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Target className="w-3 h-3" /> TP1/2/3
                  </div>
                </th>
                <th
                  className="px-2 py-3 text-right cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("riskReward")}
                >
                  <div className="flex items-center justify-end">
                    R:R <SortIcon column="riskReward" />
                  </div>
                </th>
                <th className="px-2 py-3 text-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center justify-center gap-1 cursor-help">
                        <Waves className="w-3 h-3 text-purple-400" /> LIQ
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-xs max-w-[200px]">
                        <div className="font-semibold text-purple-400">
                          Liquidation Levels
                        </div>
                        <div className="text-muted-foreground">
                          Estimated liquidation prices at common leverage levels
                          (10x-100x)
                        </div>
                        <div className="mt-1">
                          Red = Long liquidations below price
                          <br />
                          Green = Short liquidations above price
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th className="px-2 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <BarChart3 className="w-3 h-3" /> Ind
                  </div>
                </th>
                <th
                  className="px-2 py-3 text-center cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("signalStrength")}
                >
                  <div className="flex items-center justify-center gap-1">
                    <Zap className="w-3 h-3" /> Str{" "}
                    <SortIcon column="signalStrength" />
                  </div>
                </th>
                <th
                  className="px-2 py-3 text-center cursor-pointer hover:text-primary transition-colors"
                  onClick={() => handleSort("timeOnListMinutes")}
                >
                  <div className="flex items-center justify-center gap-1">
                    <Timer className="w-3 h-3" /> Time{" "}
                    <SortIcon column="timeOnListMinutes" />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <AnimatePresence initial={false}>
                {processedData.map((signal, rowIndex) => {
                  const isPositive = signal.priceChange24h > 0;
                  const isNegative = signal.priceChange24h < 0;
                  const watched = isWatched(signal.symbol);
                  const tooltipSide = rowIndex < 2 ? "bottom" : "top";

                  return (
                    <motion.tr
                      key={signal.symbol}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className={clsx(
                        "group hover:bg-white/[0.02] transition-colors",
                        signal.signalType === "HOT" &&
                          "bg-rose-500/10 animate-pulse",
                        signal.signalType === "MAJOR" && "bg-amber-500/5",
                        signal.signalType === "ACTIVE" && "bg-emerald-500/5",
                        signal.signalType === "PRE" && "bg-blue-500/5",
                      )}
                      data-testid={`row-signal-${signal.symbol}`}
                    >
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={(e) => toggleWatchlist(e, signal.symbol)}
                          data-testid={`button-watchlist-${signal.symbol}`}
                          className={clsx(
                            "p-1 rounded-full hover:bg-white/10 transition-all",
                            watched
                              ? "text-yellow-400"
                              : "text-muted-foreground/20 hover:text-yellow-400/50",
                          )}
                        >
                          <Star
                            className={clsx(
                              "w-3 h-3",
                              watched && "fill-current",
                            )}
                          />
                        </button>
                      </td>
                      <td
                        className="px-2 py-2 text-center"
                        data-testid={`side-${signal.symbol}`}
                      >
                        <Tooltip>
                          <TooltipTrigger>
                            <Badge
                              className={clsx(
                                "font-bold text-[10px] px-2",
                                (signal.htfBias?.side ?? signal.side) === "LONG"
                                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                                  : "bg-rose-500/20 text-rose-400 border-rose-500/30",
                              )}
                            >
                              {(signal.htfBias?.side ?? signal.side) === "LONG" ? (
                                <TrendingUp className="w-3 h-3 mr-0.5" />
                              ) : (
                                <TrendingDown className="w-3 h-3 mr-0.5" />
                              )}
                              {signal.htfBias?.side ?? signal.side} (4H)
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="text-xs">
                              {signal.htfBias ? (
                                <>
                                  <strong>Supertrend:</strong> {signal.htfBias.supertrendBias}
                                  <br />
                                  <strong>Confidence:</strong> {signal.htfBias.confidence}
                                  <br />
                                  <strong>Funding Confirms:</strong> {signal.htfBias.fundingConfirms ? "Yes" : "No"}
                                </>
                              ) : (
                                <>Based on price direction (4H data unavailable)</>
                              )}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-2 py-2 font-medium text-foreground">
                        <div className="flex items-center gap-1.5">
                          {signal.signalType === "HOT" && (
                            <Badge className="bg-rose-500/30 text-rose-300 border-rose-500/50 text-[9px] px-1 py-0 animate-pulse font-bold">
                              <Flame className="w-2.5 h-2.5 mr-0.5" />
                              HOT
                            </Badge>
                          )}
                          {signal.signalType === "MAJOR" && (
                            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] px-1 py-0">
                              <Crown className="w-2.5 h-2.5 mr-0.5" />
                              MAJOR
                            </Badge>
                          )}
                          {signal.signalType === "ACTIVE" && (
                            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[9px] px-1 py-0 animate-pulse">
                              <Zap className="w-2.5 h-2.5 mr-0.5" />
                              ACTIVE
                            </Badge>
                          )}
                          {signal.signalType === "PRE" && (
                            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[9px] px-1 py-0">
                              <Timer className="w-2.5 h-2.5 mr-0.5" />
                              PRE
                            </Badge>
                          )}
                          <span className="font-mono tracking-tight">
                            {signal.symbol.replace("USDT", "")}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-foreground font-bold text-xs">
                        ${formatPrice(signal.currentPrice)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <div
                          className={clsx(
                            "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold",
                            isPositive
                              ? "text-emerald-400 bg-emerald-500/10"
                              : isNegative
                                ? "text-rose-400 bg-rose-500/10"
                                : "text-muted-foreground",
                          )}
                        >
                          {isPositive && <TrendingUp className="w-2.5 h-2.5" />}
                          {isNegative && (
                            <TrendingDown className="w-2.5 h-2.5" />
                          )}
                          {signal.priceChange24h.toFixed(1)}%
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs">
                        <div className="flex items-center justify-end gap-1">
                          {signal.hasVolAlert && (
                            <Badge className="bg-rose-500/30 text-rose-300 border-rose-500/50 text-[9px] px-1 py-0 animate-pulse">
                              ALERT
                            </Badge>
                          )}
                          <span
                            className={clsx(
                              signal.volumeSpikeRatio >= 2.0
                                ? "text-rose-400 font-bold"
                                : signal.volumeSpikeRatio >= 1.5
                                  ? "text-emerald-400"
                                  : signal.volumeSpikeRatio >= 1.0
                                    ? "text-amber-400"
                                    : "text-muted-foreground",
                            )}
                          >
                            {signal.volumeSpikeRatio.toFixed(1)}x
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        {signal.isAccelerating ? (
                          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[10px] px-1.5 animate-pulse">
                            <Zap className="w-2.5 h-2.5 mr-0.5" />
                            {(signal.volAccel ?? 1).toFixed(1)}x
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs font-mono">
                            {(signal.volAccel ?? 1).toFixed(1)}x
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-xs">
                        {signal.oiChange24h != null ? (
                          <span
                            className={clsx(
                              "inline-flex items-center justify-center min-w-[52px] px-1.5 py-0.5 rounded",
                              signal.oiChange24h >= 10
                                ? "text-emerald-400 font-bold bg-emerald-400/10"
                                : signal.oiChange24h >= 5
                                  ? "text-emerald-400 bg-emerald-400/5"
                                  : signal.oiChange24h <= -5
                                    ? "text-rose-400 bg-rose-400/10"
                                    : "text-cyan-400/70",
                            )}
                          >
                            {`${signal.oiChange24h >= 0 ? "+" : ""}${signal.oiChange24h.toFixed(1)}%`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            N/A
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-muted-foreground text-xs">
                        {signal.rsi.toFixed(0)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          {signal.confirmedTimeframes.map((tf) => (
                            <Badge
                              key={tf}
                              variant="outline"
                              className="text-[9px] px-1 py-0 bg-primary/10 border-primary/30 text-primary"
                            >
                              {tf}
                            </Badge>
                          ))}
                          {signal.confirmedTimeframes.length === 0 && (
                            <span className="text-muted-foreground text-[10px]">
                              -
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help text-xs">
                              <div className="text-rose-400">
                                ${formatPrice(signal.slPrice)}
                              </div>
                              <div className="text-[9px] text-rose-400/60">
                                -{signal.slDistancePct.toFixed(1)}%
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent
                            side={tooltipSide as "top" | "bottom"}
                            className="bg-card border-white/10"
                          >
                            <p className="text-xs">{signal.slReason}</p>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help text-xs">
                              <div className="flex items-center justify-center gap-1">
                                {signal.tpLevels.slice(0, 3).map((tp, idx) => (
                                  <span
                                    key={idx}
                                    className={clsx(
                                      "font-mono",
                                      idx === 0
                                        ? "text-emerald-400"
                                        : idx === 1
                                          ? "text-teal-400"
                                          : "text-cyan-400",
                                    )}
                                  >
                                    +{tp.pct.toFixed(0)}%
                                  </span>
                                ))}
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent
                            side={tooltipSide as "top" | "bottom"}
                            className="bg-card border-white/10 p-0"
                          >
                            <TPLevelsDisplay levels={signal.tpLevels} />
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <Badge
                          className={clsx(
                            "font-bold text-[10px]",
                            signal.riskReward >= 3
                              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                              : "bg-slate-500/20 text-slate-300 border-slate-500/30",
                          )}
                        >
                          1:{signal.riskReward.toFixed(1)}
                        </Badge>
                      </td>
                      <td className="px-2 py-2 text-center">
                        {(signal.liquidationLevels &&
                          signal.liquidationLevels.length > 0) ||
                        signal.leadingIndicators.hasLiquidityZone ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[9px] px-1 cursor-help">
                                {signal.liquidationLevels &&
                                signal.liquidationLevels.length > 0
                                  ? `${signal.liquidationLevels.length}`
                                  : "LIQ"}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent
                              side={tooltipSide as "top" | "bottom"}
                              className="bg-card border-white/10 max-w-[280px]"
                            >
                              <div className="text-xs space-y-2">
                                {signal.liquidationLevels &&
                                  signal.liquidationLevels.length > 0 && (
                                    <div>
                                      <div className="font-semibold text-purple-400 mb-1">
                                        Liquidation Levels
                                      </div>
                                      <div className="space-y-0.5">
                                        {signal.liquidationLevels
                                          .slice(0, 6)
                                          .map((liq, idx) => (
                                            <div
                                              key={idx}
                                              className="flex justify-between gap-3"
                                            >
                                              <span
                                                className={
                                                  liq.direction === "long_liq"
                                                    ? "text-red-400"
                                                    : "text-emerald-400"
                                                }
                                              >
                                                {liq.direction === "long_liq"
                                                  ? "Long"
                                                  : "Short"}{" "}
                                                {liq.volume}x
                                              </span>
                                              <span className="font-mono text-muted-foreground">
                                                ${formatPrice(liq.price)}
                                              </span>
                                            </div>
                                          ))}
                                      </div>
                                    </div>
                                  )}
                                {signal.leadingIndicators.hasLiquidityZone && (
                                  <div className="border-t border-white/10 pt-1">
                                    <span className="text-muted-foreground">
                                      Liquidity Zone:{" "}
                                    </span>
                                    <span className="font-mono">
                                      $
                                      {formatPrice(
                                        signal.leadingIndicators
                                          .liquidityLevel || 0,
                                      )}
                                    </span>
                                    <span className="text-muted-foreground">
                                      {" "}
                                      (
                                      {signal.leadingIndicators.liquidityStrength.toFixed(
                                        1,
                                      )}
                                      x)
                                    </span>
                                  </div>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">
                            -
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          {signal.leadingIndicators.hasFVG && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 bg-purple-500/10 border-purple-500/30 text-purple-400"
                            >
                              FVG
                            </Badge>
                          )}
                          {signal.leadingIndicators.hasOrderBlock && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 bg-blue-500/10 border-blue-500/30 text-blue-400"
                            >
                              OB
                            </Badge>
                          )}
                          {signal.leadingIndicators.bidAskRatio > 1.2 && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                            >
                              B+
                            </Badge>
                          )}
                          {!signal.leadingIndicators.hasFVG &&
                            !signal.leadingIndicators.hasOrderBlock &&
                            signal.leadingIndicators.bidAskRatio <= 1.2 && (
                              <span className="text-muted-foreground text-[10px]">
                                -
                              </span>
                            )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help">
                              {getStrengthBadge(signal.signalStrength)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent
                            side={tooltipSide as "top" | "bottom"}
                            className="bg-card border-white/10 p-0"
                          >
                            <StrengthBreakdown
                              breakdown={signal.strengthBreakdown}
                            />
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td
                        className="px-2 py-2 text-center"
                        data-testid={`time-on-list-${signal.symbol}`}
                      >
                        {getSpikeReadinessBadge(
                          signal.spikeReadiness,
                          signal.timeOnListMinutes,
                        )}
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>

          {processedData.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              {search
                ? `No signals found matching "${search}"`
                : "Calculating signals... This may take a moment."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  AlertTriangle,
  DollarSign,
  BarChart3,
  Waves,
  Info,
  ChevronDown,
  ChevronUp,
  Flame,
  Crown,
  Timer,
} from "lucide-react";
import { clsx } from "clsx";

interface HtfBias {
  side: "LONG" | "SHORT";
  confidence: "high" | "medium" | "low";
  supertrendBias: "LONG" | "SHORT";
  fundingConfirms: boolean;
  supertrendValue: number;
}

interface EnhancedSignal {
  symbol: string;
  side: "LONG" | "SHORT";
  signalType?: "HOT" | "MAJOR" | "ACTIVE" | "PRE" | null;
  currentPrice: number;
  priceChange24h: number;
  volumeSpikeRatio: number;
  rsi: number;
  riskReward: number;
  signalStrength: number;
  priceLocation?: "DISCOUNT" | "NEUTRAL" | "PREMIUM";
  marketPhase?:
    | "ACCUMULATION"
    | "DISTRIBUTION"
    | "BREAKOUT"
    | "TREND"
    | "EXHAUST"
    | "UNKNOWN";
  entryModel?: string;
  preSpikeScore?: number;
  fundingRate?: number;
  fundingBias?: "bullish" | "bearish" | "neutral";
  longShortRatio?: number;
  lsrBias?: "long_dominant" | "short_dominant" | "balanced";
  htfBias?: HtfBias;
  volumeProfilePOC?: number;
  fvgLevels?: {
    price: number;
    type: "bullish" | "bearish";
    strength: number;
  }[];
  obLevels?: { price: number; type: "bullish" | "bearish"; strength: number }[];
  liquidationZones?: {
    nearestLongLiq?: number;
    nearestShortLiq?: number;
    longLiqDistance?: number;
    shortLiqDistance?: number;
  };
  storytelling?: {
    summary: string;
    interpretation: string;
    confidence: "high" | "medium" | "low";
    actionSuggestion: string;
  };
  entryPrice: number;
  slPrice: number;
  tpLevels: { label: string; price: number; pct: number }[];
}

interface ScreenerResponse {
  signals: EnhancedSignal[];
  timestamp: string;
  totalSignals: number;
  unfilteredCount: number;
  enrichedCount: number;
  filters: {
    minPScore?: number;
    hideExhaust?: boolean;
    phaseFilter?: string;
    sideFilter?: string;
  };
}

export function EnhancedScreener() {
  const [minPScore, setMinPScore] = useState<number>(0);
  const [hideExhaust, setHideExhaust] = useState(true);
  const [phaseFilter, setPhaseFilter] = useState("ALL");
  const [sideFilter, setSideFilter] = useState("ALL");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const buildUrl = () => {
    const params = new URLSearchParams({
      limit: "30",
      enrich: "true",
      hideExhaust: hideExhaust.toString(),
      phaseFilter: phaseFilter,
      sideFilter: sideFilter,
    });
    if (minPScore > 0) {
      params.set("minPScore", minPScore.toString());
    }
    return `/api/enhanced-screener?${params.toString()}`;
  };

  const { data, isLoading, isError, refetch, isFetching } =
    useQuery<ScreenerResponse>({
      queryKey: [buildUrl()],
      refetchInterval: 30000,
    });

  const formatPrice = (price: number) => {
    if (price < 0.0001) return price.toFixed(8);
    if (price < 1) return price.toFixed(6);
    if (price < 10) return price.toFixed(4);
    return price.toFixed(2);
  };

  const formatFundingRate = (rate: number | undefined) => {
    if (rate === undefined) return "N/A";
    const pct = rate * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(4)}%`;
  };

  const getLocationBadge = (loc: string | undefined) => {
    switch (loc) {
      case "DISCOUNT":
        return (
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
            DISCOUNT
          </Badge>
        );
      case "PREMIUM":
        return (
          <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30">
            PREMIUM
          </Badge>
        );
      case "EQUILIBRIUM":
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">
            EQUILIB
          </Badge>
        );
      case "NEUTRAL":
      default:
        return (
          <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30">
            NEUTRAL
          </Badge>
        );
    }
  };

  const getPhaseBadge = (phase: string | undefined) => {
    switch (phase) {
      case "ACCUMULATION":
      case "ACCUM":
        return (
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
            ACCUM
          </Badge>
        );
      case "DISTRIBUTION":
        return (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
            DISTRIB
          </Badge>
        );
      case "BREAKOUT":
        return (
          <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 animate-pulse">
            BREAKOUT
          </Badge>
        );
      case "TREND":
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">
            TREND
          </Badge>
        );
      case "EXHAUST":
        return (
          <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30">
            EXHAUST
          </Badge>
        );
      case "NEUTRAL":
      case "UNKNOWN":
      default:
        return (
          <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30">
            NEUTRAL
          </Badge>
        );
    }
  };

  const getEntryBadge = (entry: string | undefined, phase: string | undefined) => {
    const model = entry || getDefaultEntry(phase);
    switch (model) {
      case "BUY DIP":
        return (
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
            BUY DIP
          </Badge>
        );
      case "SCALE IN":
        return (
          <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30">
            SCALE IN
          </Badge>
        );
      case "BOS ENTRY":
        return (
          <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 animate-pulse">
            BOS
          </Badge>
        );
      case "FVG ENTRY":
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">
            FVG
          </Badge>
        );
      case "PULLBACK":
        return (
          <Badge className="bg-indigo-500/20 text-indigo-400 border-indigo-500/30">
            PULLBACK
          </Badge>
        );
      case "ADD":
        return (
          <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30">
            ADD
          </Badge>
        );
      case "TAKE PROFIT":
        return (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
            TP
          </Badge>
        );
      case "SHORT SETUP":
        return (
          <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30">
            SHORT
          </Badge>
        );
      case "AVOID":
        return (
          <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
            AVOID
          </Badge>
        );
      case "REVERSAL":
        return (
          <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">
            REVERSAL
          </Badge>
        );
      default:
        return (
          <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30">
            WAIT
          </Badge>
        );
    }
  };

  const getDefaultEntry = (phase: string | undefined): string => {
    switch (phase) {
      case "ACCUMULATION":
        return "BUY DIP";
      case "BREAKOUT":
        return "BOS ENTRY";
      case "TREND":
        return "PULLBACK";
      case "DISTRIBUTION":
        return "TAKE PROFIT";
      case "EXHAUST":
        return "AVOID";
      default:
        return "WAIT";
    }
  };

  const getPScoreBadge = (score: number | undefined) => {
    const s = score ?? 0;
    if (s >= 4)
      return (
        <Badge className="bg-emerald-500/30 text-emerald-300 border-emerald-500/50 font-bold animate-pulse">
          {s.toFixed(1)}
        </Badge>
      );
    if (s >= 3)
      return (
        <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30 font-bold">
          {s.toFixed(1)}
        </Badge>
      );
    if (s >= 2)
      return (
        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
          {s.toFixed(1)}
        </Badge>
      );
    return (
      <Badge className="bg-slate-500/20 text-slate-400">{s.toFixed(1)}</Badge>
    );
  };

  const getConfidenceBadge = (conf: string | undefined) => {
    switch (conf) {
      case "high":
        return (
          <Badge className="bg-emerald-500/20 text-emerald-400">HIGH</Badge>
        );
      case "medium":
        return <Badge className="bg-amber-500/20 text-amber-400">MED</Badge>;
      default:
        return <Badge className="bg-slate-500/20 text-slate-400">LOW</Badge>;
    }
  };

  if (isError) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="pt-6 text-center text-destructive">
          Failed to fetch enhanced screener data. Please try again.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="border-white/10">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-lg">
              <BarChart3 className="w-5 h-5 text-primary" />
              Enhanced Screener
              <Badge variant="outline" className="ml-2">
                {data?.totalSignals ?? 0} / {data?.unfilteredCount ?? 0}
              </Badge>
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh-screener"
            >
              <RefreshCw
                className={clsx("w-4 h-4 mr-2", isFetching && "animate-spin")}
              />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-2">
              <Label htmlFor="minPScore" className="text-xs whitespace-nowrap">
                Min PSCORE:
              </Label>
              <Select
                value={minPScore.toString()}
                onValueChange={(v) => setMinPScore(parseInt(v))}
              >
                <SelectTrigger
                  className="w-20 h-8"
                  id="minPScore"
                  data-testid="select-min-pscore"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">All</SelectItem>
                  <SelectItem value="2">2+</SelectItem>
                  <SelectItem value="3">3+</SelectItem>
                  <SelectItem value="4">4+</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor="phase" className="text-xs whitespace-nowrap">
                Phase:
              </Label>
              <Select value={phaseFilter} onValueChange={setPhaseFilter}>
                <SelectTrigger
                  className="w-28 h-8"
                  id="phase"
                  data-testid="select-phase"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="ACCUMULATION">Accumulation</SelectItem>
                  <SelectItem value="BREAKOUT">Breakout</SelectItem>
                  <SelectItem value="DISTRIBUTION">Distribution</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor="side" className="text-xs whitespace-nowrap">
                Side:
              </Label>
              <Select value={sideFilter} onValueChange={setSideFilter}>
                <SelectTrigger
                  className="w-24 h-8"
                  id="side"
                  data-testid="select-side"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="LONG">Long</SelectItem>
                  <SelectItem value="SHORT">Short</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="hideExhaust"
                checked={hideExhaust}
                onCheckedChange={setHideExhaust}
                data-testid="switch-hide-exhaust"
              />
              <Label htmlFor="hideExhaust" className="text-xs cursor-pointer">
                Hide Exhaust
              </Label>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-3 animate-pulse">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-16 bg-white/5 rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-white/5 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          BIAS <Info className="w-3 h-3" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[280px]">
                          <p className="text-xs">
                            <strong>HTF Bias Logic (4H Supertrend + Funding):</strong>
                            <br /><br />
                            <strong>1. Supertrend (Primary):</strong>
                            <br />
                            ATR Period: 14, Multiplier: 3.5
                            <br />
                            Price above Supertrend = LONG
                            <br />
                            Price below Supertrend = SHORT
                            <br /><br />
                            <strong>2. Funding Rate (Confirmation):</strong>
                            <br />
                            Negative FR = Longs pay shorts (bullish)
                            <br />
                            Positive FR = Shorts pay longs (bearish)
                            <br /><br />
                            <strong>Confidence:</strong>
                            <br />
                            HIGH = Supertrend + FR align
                            <br />
                            MEDIUM = Supertrend only, FR neutral
                            <br />
                            LOW = Supertrend and FR conflict
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2">Symbol</th>
                    <th className="px-2 py-2 text-right">Price</th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          LOC <Info className="w-3 h-3" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Location:</strong> Where price is in 24h
                            range.
                            <br />
                            DISCOUNT = bottom 33%, PREMIUM = top 33%
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          PHASE <Info className="w-3 h-3" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Market Phase:</strong>
                            <br />
                            ACCUM = Accumulation (smart money buying)
                            <br />
                            BREAKOUT = Strong momentum move
                            <br />
                            DISTRIB = Distribution (selling)
                            <br />
                            EXHAUST = Fading momentum
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          ENTRY <Info className="w-3 h-3" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Entry Model Setup:</strong>
                            <br />
                            BUY DIP / SCALE IN = Accumulation entries
                            <br />
                            BOS / FVG = Breakout entries
                            <br />
                            PULLBACK / ADD = Trend entries
                            <br />
                            TAKE PROFIT / SHORT = Distribution
                            <br />
                            AVOID / REVERSAL = Exhaustion
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          PSCORE <Info className="w-3 h-3" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Pre-Spike Score (0-5):</strong>
                            <br />
                            Composite of volume, OI, RSI, R:R, funding
                            <br />
                            4+ = High probability setup
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          <DollarSign className="w-3 h-3" /> FR
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Funding Rate:</strong>
                            <br />
                            Negative = Longs pay shorts (bullish)
                            <br />
                            Positive = Shorts pay longs (bearish)
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          L/S
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[220px]">
                            <strong>Long/Short Ratio (1H):</strong>
                            <br /><br />
                            <strong>Display Format:</strong>
                            <br />
                            L:1.25 = 1.25 longs per short
                            <br />
                            S:1.50 = 1.50 shorts per long
                            <br /><br />
                            <strong>Interpretation:</strong>
                            <br />
                            High L = Crowded longs (contrarian bearish)
                            <br />
                            High S = Crowded shorts (contrarian bullish)
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          <Waves className="w-3 h-3" /> POC
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Volume Profile POC:</strong>
                            <br />
                            Point of Control - price level with highest traded volume (4H)
                            <br />
                            Acts as strong support/resistance
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger className="flex items-center gap-1 cursor-help">
                          <Target className="w-3 h-3" /> Levels
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs max-w-[200px]">
                            <strong>Key Price Levels:</strong>
                            <br />
                            FVG/OB zones for entries
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                    <th className="px-2 py-2 text-center">Conf</th>
                    <th className="px-2 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {data?.signals.map((signal) => (
                    <>
                      <tr
                        key={signal.symbol}
                        className={clsx(
                          "hover:bg-white/[0.02] transition-colors cursor-pointer",
                          signal.signalType === "HOT" && "hot-signal-row",
                          signal.signalType === "MAJOR" && "bg-amber-500/5",
                          signal.signalType === "ACTIVE" && "bg-emerald-500/5",
                          signal.signalType === "PRE" && "bg-blue-500/5",
                          (signal.preSpikeScore ?? 0) >= 4 &&
                            signal.signalType !== "HOT" &&
                            "border-l-2 border-l-emerald-500",
                        )}
                        onClick={() =>
                          setExpandedRow(
                            expandedRow === signal.symbol
                              ? null
                              : signal.symbol,
                          )
                        }
                        data-testid={`row-enhanced-${signal.symbol}`}
                      >
                        <td className="px-2 py-2 text-center">
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
                                  "Bias from scoring system (HTF data unavailable)"
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
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          ${formatPrice(signal.currentPrice)}
                          <div
                            className={clsx(
                              "text-[10px]",
                              signal.priceChange24h > 0
                                ? "text-emerald-400"
                                : "text-rose-400",
                            )}
                          >
                            {signal.priceChange24h > 0 ? "+" : ""}
                            {signal.priceChange24h.toFixed(1)}%
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {getLocationBadge(signal.priceLocation)}
                        </td>
                        <td
                          className="px-2 py-2 text-
                          center"
                        >
                          {getPhaseBadge(signal.marketPhase)}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {getEntryBadge(signal.entryModel, signal.marketPhase)}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {getPScoreBadge(signal.preSpikeScore)}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span
                            className={clsx(
                              "text-xs font-mono",
                              signal.fundingRate !== undefined &&
                                signal.fundingRate < 0
                                ? "text-emerald-400"
                                : signal.fundingRate !== undefined &&
                                    signal.fundingRate > 0.01
                                  ? "text-rose-400"
                                  : "text-muted-foreground",
                            )}
                          >
                            {formatFundingRate(signal.fundingRate)}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span
                            className={clsx(
                              "text-xs font-mono",
                              signal.lsrBias === "long_dominant"
                                ? "text-amber-400"
                                : signal.lsrBias === "short_dominant"
                                  ? "text-cyan-400"
                                  : "text-muted-foreground",
                            )}
                          >
                            {signal.longShortRatio !== undefined
                              ? signal.longShortRatio >= 1
                                ? `L:${signal.longShortRatio.toFixed(2)}`
                                : `S:${(1 / signal.longShortRatio).toFixed(2)}`
                              : "N/A"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {signal.volumeProfilePOC !== undefined ? (
                            <span className="text-xs font-mono text-cyan-400">
                              ${formatPrice(signal.volumeProfilePOC)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              N/A
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {(signal.fvgLevels?.length ?? 0) +
                            (signal.obLevels?.length ?? 0) >
                          0 ? (
                            <Badge variant="outline" className="text-[10px]">
                              {(signal.fvgLevels?.length ?? 0) +
                                (signal.obLevels?.length ?? 0)}{" "}
                              lvl
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              -
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {getConfidenceBadge(signal.storytelling?.confidence)}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {expandedRow === signal.symbol ? (
                            <ChevronUp className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          )}
                        </td>
                      </tr>
                      {expandedRow === signal.symbol && (
                        <tr className="bg-muted/20">
                          <td colSpan={12} className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              <div className="space-y-2">
                                <h4 className="font-semibold text-primary flex items-center gap-1">
                                  <Info className="w-4 h-4" /> Analysis
                                </h4>
                                <p className="text-foreground font-medium">
                                  {signal.storytelling?.summary}
                                </p>
                                <p className="text-muted-foreground">
                                  {signal.storytelling?.interpretation}
                                </p>
                                <div className="flex items-center gap-2 mt-2 p-2 bg-primary/10 rounded">
                                  <Zap className="w-4 h-4 text-primary" />
                                  <span className="font-medium text-primary">
                                    {signal.storytelling?.actionSuggestion}
                                  </span>
                                </div>
                              </div>
                              <div className="space-y-2">
                                <h4 className="font-semibold flex items-center gap-1">
                                  <Target className="w-4 h-4" /> Key Levels
                                </h4>
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <span className="text-muted-foreground">
                                      Entry:
                                    </span>
                                    <span className="font-mono ml-2">
                                      ${formatPrice(signal.entryPrice)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">
                                      Stop Loss:
                                    </span>
                                    <span className="font-mono ml-2 text-rose-400">
                                      ${formatPrice(signal.slPrice)}
                                    </span>
                                  </div>
                                  {signal.tpLevels.map((tp) => (
                                    <div key={tp.label}>
                                      <span className="text-muted-foreground">
                                        {tp.label}:
                                      </span>
                                      <span className="font-mono ml-2 text-emerald-400">
                                        ${formatPrice(tp.price)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                {(signal.fvgLevels?.length ?? 0) > 0 && (
                                  <div className="mt-2">
                                    <span className="text-muted-foreground">
                                      FVG Zones:
                                    </span>
                                    <div className="flex gap-2 mt-1">
                                      {signal.fvgLevels?.map((fvg, i) => (
                                        <Badge
                                          key={i}
                                          className={clsx(
                                            "text-[10px]",
                                            fvg.type === "bullish"
                                              ? "bg-emerald-500/20 text-emerald-400"
                                              : "bg-rose-500/20 text-rose-400",
                                          )}
                                        >
                                          ${formatPrice(fvg.price)}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {(signal.obLevels?.length ?? 0) > 0 && (
                                  <div className="mt-2">
                                    <span className="text-muted-foreground">
                                      Order Blocks:
                                    </span>
                                    <div className="flex gap-2 mt-1">
                                      {signal.obLevels?.map((ob, i) => (
                                        <Badge
                                          key={i}
                                          className={clsx(
                                            "text-[10px]",
                                            ob.type === "bullish"
                                              ? "bg-emerald-500/20 text-emerald-400"
                                              : "bg-rose-500/20 text-rose-400",
                                          )}
                                        >
                                          ${formatPrice(ob.price)}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
              {data?.signals.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No signals match the current filters. Try adjusting your
                  criteria.
                </div>
              )}
            </div>
          )}

          <div className="mt-4 text-xs text-muted-foreground flex items-center justify-between">
            <span>
              Enriched with Coinglass: {data?.enrichedCount ?? 0} coins | Last
              updated:{" "}
              {data?.timestamp
                ? new Date(data.timestamp).toLocaleTimeString()
                : "--"}
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Professional plan required for full liquidation map data
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

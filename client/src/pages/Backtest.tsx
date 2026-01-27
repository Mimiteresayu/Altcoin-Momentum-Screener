import { useState } from "react";
import { useBacktestStats, useBacktestTrades, useEquityCurve, useGenerateDailyReport, useRunAutoBacktest, useLiveBacktest, useStartLiveBacktest, useStopLiveBacktest } from "@/hooks/use-backtest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Target, 
  BarChart3, 
  Activity,
  Percent,
  AlertTriangle,
  Clock,
  CheckCircle,
  XCircle,
  RefreshCw,
  FileText,
  Wallet,
  LineChart,
  Play,
  Square,
  Zap,
  Eye
} from "lucide-react";
import { clsx } from "clsx";
import { LineChart as RechartsLineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, Area, AreaChart } from "recharts";
import type { TradeDisplay } from "@shared/schema";

function StatCard({ 
  label, 
  value, 
  icon, 
  trend, 
  loading 
}: { 
  label: string; 
  value: string; 
  icon: React.ReactNode; 
  trend?: "up" | "down" | "neutral"; 
  loading?: boolean;
}) {
  return (
    <Card className="bg-card/50 backdrop-blur-sm border-white/5">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            {icon}
            <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
          </div>
          {trend && (
            <Badge variant="outline" className={clsx(
              "text-[10px]",
              trend === "up" && "text-emerald-400 border-emerald-500/30",
              trend === "down" && "text-rose-400 border-rose-500/30"
            )}>
              {trend === "up" ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
            </Badge>
          )}
        </div>
        <div className="mt-2">
          {loading ? (
            <div className="h-7 w-20 bg-white/5 animate-pulse rounded" />
          ) : (
            <span className="text-xl font-bold font-mono">{value}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TradesTable({ trades, loading }: { trades: TradeDisplay[]; loading: boolean }) {
  const formatPrice = (price: number) => {
    if (price < 0.0001) return price.toFixed(8);
    if (price < 1) return price.toFixed(6);
    if (price < 10) return price.toFixed(4);
    return price.toFixed(2);
  };

  const formatPnl = (pnl: number | null | undefined) => {
    if (pnl === null || pnl === undefined) return "-";
    const sign = pnl >= 0 ? "+" : "";
    return `${sign}$${pnl.toFixed(2)}`;
  };

  const formatTime = (timestamp: string | null | undefined) => {
    if (!timestamp) return "-";
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  const formatHoldingTime = (minutes: number | null | undefined) => {
    if (minutes === null || minutes === undefined) return "-";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours < 24) return `${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  };

  const getStatusBadge = (trade: TradeDisplay) => {
    if (trade.status === "active") {
      return (
        <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">
          <Activity className="w-3 h-3 mr-1" />
          Active
        </Badge>
      );
    }
    if (trade.slHit) {
      return (
        <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30">
          <XCircle className="w-3 h-3 mr-1" />
          SL Hit
        </Badge>
      );
    }
    if (trade.tp3Hit) {
      return (
        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
          <CheckCircle className="w-3 h-3 mr-1" />
          TP3 Hit
        </Badge>
      );
    }
    if (trade.tp2Hit) {
      return (
        <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30">
          <CheckCircle className="w-3 h-3 mr-1" />
          TP2 Hit
        </Badge>
      );
    }
    if (trade.tp1Hit) {
      return (
        <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30">
          <CheckCircle className="w-3 h-3 mr-1" />
          TP1 Hit
        </Badge>
      );
    }
    return (
      <Badge className="bg-slate-500/20 text-slate-400 border-slate-500/30">
        Closed
      </Badge>
    );
  };

  const getTPProgress = (trade: TradeDisplay) => {
    const hits = [trade.tp1Hit, trade.tp2Hit, trade.tp3Hit].filter(Boolean).length;
    return (
      <div className="flex gap-1">
        {[1, 2, 3].map(i => (
          <div 
            key={i}
            className={clsx(
              "w-4 h-1.5 rounded-full",
              i === 1 && trade.tp1Hit && "bg-emerald-400",
              i === 2 && trade.tp2Hit && "bg-teal-400",
              i === 3 && trade.tp3Hit && "bg-cyan-400",
              !(i === 1 && trade.tp1Hit) && !(i === 2 && trade.tp2Hit) && !(i === 3 && trade.tp3Hit) && "bg-white/10"
            )}
          />
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-14 bg-white/5 animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="p-12 text-center text-muted-foreground">
        No trades recorded yet. The system will automatically enter trades based on signal criteria.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <th className="px-3 py-3">Trade ID</th>
            <th className="px-3 py-3 text-center">Side</th>
            <th className="px-3 py-3">Symbol</th>
            <th className="px-3 py-3 text-right">Entry $</th>
            <th className="px-3 py-3 text-center">Entry Time</th>
            <th className="px-3 py-3 text-center">Exit Time</th>
            <th className="px-3 py-3 text-center">Duration</th>
            <th className="px-3 py-3 text-center">TP Progress</th>
            <th className="px-3 py-3 text-center">Status</th>
            <th className="px-3 py-3 text-right">PnL</th>
            <th className="px-3 py-3 text-right">R Multiple</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {trades.map(trade => (
            <tr 
              key={trade.tradeId} 
              className="hover:bg-white/[0.02] transition-colors"
              data-testid={`row-trade-${trade.tradeId}`}
            >
              <td className="px-3 py-3">
                <span className="font-mono text-xs text-muted-foreground">{trade.tradeId}</span>
              </td>
              <td className="px-3 py-3 text-center">
                <Badge
                  className={clsx(
                    "font-bold text-[10px] px-2",
                    trade.side === "LONG"
                      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                      : trade.side === "SHORT"
                        ? "bg-rose-500/20 text-rose-400 border-rose-500/30"
                        : "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  )}
                >
                  {trade.side === "LONG" ? (
                    <TrendingUp className="w-3 h-3 mr-0.5" />
                  ) : trade.side === "SHORT" ? (
                    <TrendingDown className="w-3 h-3 mr-0.5" />
                  ) : (
                    <TrendingUp className="w-3 h-3 mr-0.5" />
                  )}
                  {trade.side || "LONG"}
                </Badge>
              </td>
              <td className="px-3 py-3 font-mono font-bold">{trade.symbol.replace("USDT", "")}</td>
              <td className="px-3 py-3 text-right font-mono text-xs">${formatPrice(trade.entryPrice)}</td>
              <td className="px-3 py-3 text-center font-mono text-xs text-muted-foreground">
                {formatTime(trade.entryTimestamp)}
              </td>
              <td className="px-3 py-3 text-center font-mono text-xs text-muted-foreground">
                {trade.status === "active" ? (
                  <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]">
                    Active
                  </Badge>
                ) : (
                  formatTime(trade.exitTimestamp)
                )}
              </td>
              <td className="px-3 py-3 text-center font-mono text-xs">
                <span className={clsx(
                  trade.holdingTimeMinutes !== null && trade.holdingTimeMinutes > 60 * 24 && "text-amber-400",
                  trade.holdingTimeMinutes !== null && trade.holdingTimeMinutes <= 60 && "text-emerald-400"
                )}>
                  {formatHoldingTime(trade.holdingTimeMinutes)}
                </span>
              </td>
              <td className="px-3 py-3 text-center">{getTPProgress(trade)}</td>
              <td className="px-3 py-3 text-center">{getStatusBadge(trade)}</td>
              <td className="px-3 py-3 text-right">
                <span className={clsx(
                  "font-mono font-bold text-xs",
                  trade.finalPnl !== null && trade.finalPnl > 0 && "text-emerald-400",
                  trade.finalPnl !== null && trade.finalPnl < 0 && "text-rose-400",
                  trade.status === "active" && trade.unrealizedPnl !== undefined && (
                    trade.unrealizedPnl > 0 ? "text-emerald-400/70" : "text-rose-400/70"
                  )
                )}>
                  {trade.status === "active" && trade.unrealizedPnl !== undefined 
                    ? `~${formatPnl(trade.unrealizedPnl)}`
                    : formatPnl(trade.finalPnl)
                  }
                </span>
              </td>
              <td className="px-3 py-3 text-right">
                <span className={clsx(
                  "font-mono text-xs",
                  trade.rMultiple !== null && trade.rMultiple > 0 && "text-emerald-400",
                  trade.rMultiple !== null && trade.rMultiple < 0 && "text-rose-400"
                )}>
                  {trade.rMultiple !== null ? `${trade.rMultiple > 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R` : "-"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EquityChart({ data, loading }: { data: { equity: number; timestamp: string; drawdown: number }[]; loading: boolean }) {
  if (loading) {
    return <div className="h-64 bg-white/5 animate-pulse rounded-lg" />;
  }

  if (data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        No equity data available yet.
      </div>
    );
  }

  const chartData = [...data].reverse().map(d => ({
    ...d,
    time: new Date(d.timestamp).toLocaleDateString(),
  }));

  return (
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted-foreground) / 0.1)" />
        <XAxis 
          dataKey="time" 
          stroke="hsl(var(--muted-foreground))" 
          fontSize={10}
          tickLine={false}
        />
        <YAxis 
          stroke="hsl(var(--muted-foreground))" 
          fontSize={10}
          tickLine={false}
          tickFormatter={(val) => `$${val.toLocaleString()}`}
        />
        <RechartsTooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
          }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
          formatter={(value: number) => [`$${value.toLocaleString()}`, "Equity"]}
        />
        <Area 
          type="monotone" 
          dataKey="equity" 
          stroke="hsl(var(--primary))" 
          fill="url(#equityGradient)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function LivePaperTradingTab() {
  const { data: liveData, isLoading } = useLiveBacktest();
  const startLive = useStartLiveBacktest();
  const stopLive = useStopLiveBacktest();

  const formatPrice = (price: number) => {
    if (price < 0.0001) return price.toFixed(8);
    if (price < 1) return price.toFixed(6);
    if (price < 10) return price.toFixed(4);
    return price.toFixed(2);
  };

  const formatTime = (timestamp: string | undefined) => {
    if (!timestamp) return "-";
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  const stats = liveData?.stats;
  const openPositions = liveData?.openPositions || [];
  const closedTrades = liveData?.closedTrades || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge 
            className={clsx(
              "text-sm px-3 py-1",
              stats?.isRunning 
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" 
                : "bg-slate-500/20 text-slate-400 border-slate-500/30"
            )}
          >
            <Zap className="w-3 h-3 mr-1" />
            {stats?.isRunning ? "RUNNING" : "STOPPED"}
          </Badge>
          {stats?.lastScanTime && (
            <span className="text-xs text-muted-foreground">
              Last scan: {formatTime(stats.lastScanTime)}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {stats?.isRunning ? (
            <Button 
              size="sm" 
              variant="destructive"
              onClick={() => stopLive.mutate()}
              disabled={stopLive.isPending}
              className="gap-1.5"
              data-testid="button-stop-live"
            >
              <Square className="w-4 h-4" />
              Stop
            </Button>
          ) : (
            <Button 
              size="sm" 
              onClick={() => startLive.mutate()}
              disabled={startLive.isPending}
              className="gap-1.5"
              data-testid="button-start-live"
            >
              <Play className="w-4 h-4" />
              Start Paper Trading
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard 
          label="Capital" 
          value={stats ? `$${stats.totalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$10,000"}
          icon={<Wallet className="w-4 h-4" />}
          loading={isLoading}
        />
        <StatCard 
          label="Total PnL" 
          value={stats ? `${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}` : "$0.00"}
          icon={<DollarSign className="w-4 h-4" />}
          trend={stats && stats.totalPnl > 0 ? "up" : stats && stats.totalPnl < 0 ? "down" : "neutral"}
          loading={isLoading}
        />
        <StatCard 
          label="Open Positions" 
          value={stats?.openPositions?.toString() || "0"}
          icon={<Eye className="w-4 h-4" />}
          loading={isLoading}
        />
        <StatCard 
          label="Closed Trades" 
          value={stats?.closedTrades?.toString() || "0"}
          icon={<CheckCircle className="w-4 h-4" />}
          loading={isLoading}
        />
        <StatCard 
          label="Win Rate" 
          value={stats ? `${stats.winRate.toFixed(1)}%` : "0%"}
          icon={<Percent className="w-4 h-4" />}
          trend={stats && stats.winRate >= 50 ? "up" : "down"}
          loading={isLoading}
        />
        <StatCard 
          label="Sharpe" 
          value={stats ? stats.sharpeRatio.toFixed(2) : "0.00"}
          icon={<BarChart3 className="w-4 h-4" />}
          trend={stats && stats.sharpeRatio > 1 ? "up" : "neutral"}
          loading={isLoading}
        />
      </div>

      <Card className="bg-card/50 backdrop-blur-sm border-white/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" />
            Open Positions
            <Badge variant="outline" className="ml-2 text-xs">{openPositions.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-12 bg-white/5 animate-pulse rounded-lg" />
              ))}
            </div>
          ) : openPositions.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No open positions. The system scans every 5 minutes for signals with PSCORE &gt;= 1.5 or BREAKOUT phase.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2">Side</th>
                    <th className="px-3 py-2">Entry</th>
                    <th className="px-3 py-2">SL</th>
                    <th className="px-3 py-2">TP1</th>
                    <th className="px-3 py-2">Phase</th>
                    <th className="px-3 py-2">PSCORE</th>
                    <th className="px-3 py-2">Opened</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {openPositions.map((pos) => (
                    <tr key={pos.tradeId} className="hover:bg-white/5">
                      <td className="px-3 py-2 font-mono font-medium">{pos.symbol}</td>
                      <td className="px-3 py-2">
                        <Badge className={clsx(
                          "text-xs",
                          pos.side === "LONG" 
                            ? "bg-emerald-500/20 text-emerald-400" 
                            : "bg-rose-500/20 text-rose-400"
                        )}>
                          {pos.side}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono">${formatPrice(pos.entryPrice)}</td>
                      <td className="px-3 py-2 font-mono text-rose-400">${formatPrice(pos.stopLoss)}</td>
                      <td className="px-3 py-2 font-mono text-emerald-400">${formatPrice(pos.tp1)}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs">{pos.marketPhase}</Badge>
                      </td>
                      <td className="px-3 py-2 font-mono">{pos.pscore?.toFixed(1)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{formatTime(pos.entryTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card/50 backdrop-blur-sm border-white/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Closed Trades
            <Badge variant="outline" className="ml-2 text-xs">{closedTrades.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-12 bg-white/5 animate-pulse rounded-lg" />
              ))}
            </div>
          ) : closedTrades.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No closed trades yet. Trades will appear here when SL or TP is hit.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-white/5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2">Side</th>
                    <th className="px-3 py-2">Entry</th>
                    <th className="px-3 py-2">Exit</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">PnL</th>
                    <th className="px-3 py-2">R</th>
                    <th className="px-3 py-2">Closed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {closedTrades.map((trade) => (
                    <tr key={trade.tradeId} className="hover:bg-white/5">
                      <td className="px-3 py-2 font-mono font-medium">{trade.symbol}</td>
                      <td className="px-3 py-2">
                        <Badge className={clsx(
                          "text-xs",
                          trade.side === "LONG" 
                            ? "bg-emerald-500/20 text-emerald-400" 
                            : "bg-rose-500/20 text-rose-400"
                        )}>
                          {trade.side}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono">${formatPrice(trade.entryPrice)}</td>
                      <td className="px-3 py-2 font-mono">${trade.exitPrice ? formatPrice(trade.exitPrice) : "-"}</td>
                      <td className="px-3 py-2">
                        <Badge className={clsx(
                          "text-xs",
                          trade.exitReason?.includes("TP") 
                            ? "bg-emerald-500/20 text-emerald-400" 
                            : "bg-rose-500/20 text-rose-400"
                        )}>
                          {trade.exitReason || "-"}
                        </Badge>
                      </td>
                      <td className={clsx(
                        "px-3 py-2 font-mono font-medium",
                        (trade.finalPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}>
                        {trade.finalPnl !== undefined 
                          ? `${trade.finalPnl >= 0 ? "+" : ""}$${trade.finalPnl.toFixed(2)}` 
                          : "-"}
                      </td>
                      <td className={clsx(
                        "px-3 py-2 font-mono",
                        (trade.rMultiple || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}>
                        {trade.rMultiple !== undefined 
                          ? `${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R` 
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{formatTime(trade.exitTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HistoricalBacktestTab() {
  const { data: stats, isLoading: loadingStats } = useBacktestStats();
  const { data: trades, isLoading: loadingTrades } = useBacktestTrades(50);
  const { data: equity, isLoading: loadingEquity } = useEquityCurve(100);
  const generateReport = useGenerateDailyReport();
  const runBacktest = useRunAutoBacktest();

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2">
        <Button 
          size="sm" 
          onClick={() => runBacktest.mutate()}
          disabled={runBacktest.isPending}
          className="gap-1.5"
          data-testid="button-run-backtest"
        >
          <Play className="w-4 h-4" />
          {runBacktest.isPending ? "Running..." : "Run Backtest"}
        </Button>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => generateReport.mutate()}
          disabled={generateReport.isPending}
          className="gap-1.5"
          data-testid="button-generate-report"
        >
          <FileText className="w-4 h-4" />
          Generate Report
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard 
          label="Capital" 
          value={stats ? `$${stats.totalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$10,000"}
          icon={<Wallet className="w-4 h-4" />}
          loading={loadingStats}
        />
        <StatCard 
          label="Total PnL" 
          value={stats ? `${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}` : "$0.00"}
          icon={<DollarSign className="w-4 h-4" />}
          trend={stats && stats.totalPnl > 0 ? "up" : stats && stats.totalPnl < 0 ? "down" : "neutral"}
          loading={loadingStats}
        />
        <StatCard 
          label="Win Rate" 
          value={stats ? `${stats.winRate.toFixed(1)}%` : "0%"}
          icon={<Percent className="w-4 h-4" />}
          trend={stats && stats.winRate >= 50 ? "up" : "down"}
          loading={loadingStats}
        />
        <StatCard 
          label="Avg R" 
          value={stats ? `${stats.avgRMultiple >= 0 ? "+" : ""}${stats.avgRMultiple.toFixed(2)}R` : "0R"}
          icon={<Target className="w-4 h-4" />}
          trend={stats && stats.avgRMultiple > 0 ? "up" : "down"}
          loading={loadingStats}
        />
        <StatCard 
          label="Max DD" 
          value={stats ? `${stats.maxDrawdown.toFixed(1)}%` : "0%"}
          icon={<AlertTriangle className="w-4 h-4" />}
          loading={loadingStats}
        />
        <StatCard 
          label="Sharpe" 
          value={stats ? stats.sharpeRatio.toFixed(2) : "0.00"}
          icon={<BarChart3 className="w-4 h-4" />}
          trend={stats && stats.sharpeRatio > 1 ? "up" : "neutral"}
          loading={loadingStats}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-card/50 backdrop-blur-sm border-white/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <LineChart className="w-4 h-4 text-primary" />
              Equity Curve
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EquityChart 
              data={equity?.map(e => ({
                ...e,
                timestamp: typeof e.timestamp === "string" ? e.timestamp : (e.timestamp?.toISOString?.() || new Date().toISOString()),
              })) || []} 
              loading={loadingEquity} 
            />
          </CardContent>
        </Card>

        <Card className="bg-card/50 backdrop-blur-sm border-white/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Trade Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-muted/20">
                <div className="text-xs text-muted-foreground uppercase">Total Trades</div>
                <div className="text-2xl font-bold font-mono mt-1" data-testid="text-total-trades">
                  {loadingStats ? "-" : stats?.totalTrades || 0}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/20">
                <div className="text-xs text-muted-foreground uppercase">Active</div>
                <div className="text-2xl font-bold font-mono mt-1 text-blue-400" data-testid="text-active-trades">
                  {loadingStats ? "-" : stats?.activeTrades || 0}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-emerald-500/10">
                <div className="text-xs text-emerald-400 uppercase">Winners</div>
                <div className="text-2xl font-bold font-mono mt-1 text-emerald-400" data-testid="text-winning-trades">
                  {loadingStats ? "-" : stats?.winningTrades || 0}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-rose-500/10">
                <div className="text-xs text-rose-400 uppercase">Losers</div>
                <div className="text-2xl font-bold font-mono mt-1 text-rose-400" data-testid="text-losing-trades">
                  {loadingStats ? "-" : stats?.losingTrades || 0}
                </div>
              </div>
            </div>
            <div className="p-3 rounded-lg bg-muted/20">
              <div className="text-xs text-muted-foreground uppercase">Profit Factor</div>
              <div className="text-xl font-bold font-mono mt-1" data-testid="text-profit-factor">
                {loadingStats ? "-" : stats?.profitFactor === Infinity ? "∞" : stats?.profitFactor.toFixed(2) || "0.00"}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card/50 backdrop-blur-sm border-white/5">
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Trade History
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {trades?.length || 0} trades
          </Badge>
        </CardHeader>
        <CardContent>
          <TradesTable trades={trades || []} loading={loadingTrades} />
        </CardContent>
      </Card>
    </div>
  );
}

export default function Backtest() {
  const [activeTab, setActiveTab] = useState("live");

  return (
    <div className="min-h-screen bg-background text-foreground p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-backtest-title">
          <LineChart className="w-6 h-6 text-primary" />
          Backtesting Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Continuous paper trading with $10,000 virtual capital</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="live" className="gap-2" data-testid="tab-live">
            <Zap className="w-4 h-4" />
            Live Paper Trading
          </TabsTrigger>
          <TabsTrigger value="historical" className="gap-2" data-testid="tab-historical">
            <Clock className="w-4 h-4" />
            Historical
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-6">
          <LivePaperTradingTab />
        </TabsContent>

        <TabsContent value="historical" className="mt-6">
          <HistoricalBacktestTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

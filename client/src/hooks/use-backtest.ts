import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { BacktestSummary, TradeDisplay, EquityCurvePoint, SignalSnapshot } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useBacktestStats() {
  return useQuery<BacktestSummary>({
    queryKey: ["/api/backtest/stats"],
    queryFn: async () => {
      const res = await fetch("/api/backtest/stats");
      if (!res.ok) throw new Error("Failed to fetch backtest stats");
      return res.json();
    },
    refetchInterval: 30000,
  });
}

export function useBacktestTrades(limit: number = 50) {
  return useQuery<TradeDisplay[]>({
    queryKey: ["/api/backtest/trades", limit],
    queryFn: async () => {
      const res = await fetch(`/api/backtest/trades?limit=${limit}`);
      if (!res.ok) throw new Error("Failed to fetch trades");
      return res.json();
    },
    refetchInterval: 30000,
  });
}

export function useEquityCurve(limit: number = 100) {
  return useQuery<EquityCurvePoint[]>({
    queryKey: ["/api/backtest/equity", limit],
    queryFn: async () => {
      const res = await fetch(`/api/backtest/equity?limit=${limit}`);
      if (!res.ok) throw new Error("Failed to fetch equity curve");
      return res.json();
    },
    refetchInterval: 60000,
  });
}

export function useSignalHistory(symbol?: string, limit: number = 100) {
  return useQuery<SignalSnapshot[]>({
    queryKey: ["/api/backtest/signals", symbol, limit],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (symbol) params.set("symbol", symbol);
      params.set("limit", limit.toString());
      const res = await fetch(`/api/backtest/signals?${params}`);
      if (!res.ok) throw new Error("Failed to fetch signal history");
      return res.json();
    },
    refetchInterval: 60000,
  });
}

export function useGenerateDailyReport() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backtest/report/daily", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to generate report");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/stats"] });
      toast({
        title: "Report Generated",
        description: "Daily report has been generated successfully.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useRunAutoBacktest() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backtest-engine/auto-start", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to run backtest");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/equity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest-engine/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest-engine/trades"] });
      toast({
        title: "Backtest Complete",
        description: `Processed ${data.signalsProcessed || 0} signals. Sharpe: ${data.metrics?.sharpeRatio?.toFixed(2) || "N/A"}`,
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

interface LiveBacktestData {
  stats: {
    totalCapital: number;
    totalPnl: number;
    openPositions: number;
    closedTrades: number;
    winRate: number;
    sharpeRatio: number;
    maxDrawdown: number;
    lastScanTime: string | null;
    isRunning: boolean;
  };
  openPositions: Array<{
    tradeId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    tp3: number;
    entryTimestamp: string;
    capitalUsed: number;
    marketPhase: string;
    pscore: number;
  }>;
  closedTrades: Array<{
    tradeId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    exitPrice?: number;
    stopLoss: number;
    tp1: number;
    entryTimestamp: string;
    exitTimestamp?: string;
    finalPnl?: number;
    rMultiple?: number;
    exitReason?: string;
    capitalUsed: number;
  }>;
  equityCurve: Array<{
    timestamp: string;
    equity: number;
    drawdown: number;
  }>;
}

export function useLiveBacktest() {
  return useQuery<LiveBacktestData>({
    queryKey: ["/api/backtest/live"],
    queryFn: async () => {
      const res = await fetch("/api/backtest/live");
      if (!res.ok) throw new Error("Failed to fetch live backtest data");
      return res.json();
    },
    refetchInterval: 10000,
  });
}

export function useStartLiveBacktest() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backtest/live/start", { method: "POST" });
      if (!res.ok) throw new Error("Failed to start live backtest");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/live"] });
      toast({ title: "Paper Trading Started", description: "Continuous paper trading is now running." });
    },
    onError: (error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
}

export function useStopLiveBacktest() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/backtest/live/stop", { method: "POST" });
      if (!res.ok) throw new Error("Failed to stop live backtest");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/live"] });
      toast({ title: "Paper Trading Stopped", description: "Continuous paper trading has been stopped." });
    },
    onError: (error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
}

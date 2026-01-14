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

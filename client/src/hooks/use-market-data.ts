import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type TickerResponse, type WatchlistInput } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";

// ============================================
// MARKET DATA HOOKS
// ============================================

export function useTickers() {
  return useQuery({
    queryKey: [api.tickers.list.path],
    queryFn: async () => {
      const res = await fetch(api.tickers.list.path);
      if (!res.ok) throw new Error("Failed to fetch market data");
      return api.tickers.list.responses[200].parse(await res.json());
    },
    // Auto-refresh every 5 seconds for real-time feel
    refetchInterval: 5000,
  });
}

// ============================================
// WATCHLIST HOOKS
// ============================================

export function useWatchlist() {
  return useQuery({
    queryKey: [api.watchlist.list.path],
    queryFn: async () => {
      const res = await fetch(api.watchlist.list.path);
      if (!res.ok) throw new Error("Failed to fetch watchlist");
      return api.watchlist.list.responses[200].parse(await res.json());
    },
  });
}

export function useAddToWatchlist() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: WatchlistInput) => {
      const res = await fetch(api.watchlist.create.path, {
        method: api.watchlist.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      
      if (!res.ok) {
        if (res.status === 400) {
          const error = api.watchlist.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw new Error("Failed to add to watchlist");
      }
      
      return api.watchlist.create.responses[201].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [api.watchlist.list.path] });
      toast({
        title: "Added to Watchlist",
        description: `${data.symbol} is now being tracked.`,
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

export function useRemoveFromWatchlist() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.watchlist.delete.path, { id });
      const res = await fetch(url, {
        method: api.watchlist.delete.method,
      });
      
      if (!res.ok) throw new Error("Failed to remove from watchlist");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.watchlist.list.path] });
      toast({
        title: "Removed from Watchlist",
        description: "Item has been removed successfully.",
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

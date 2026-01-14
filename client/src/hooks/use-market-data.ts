import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type SignalListResponse, type WatchlistInput } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";

export function useTickers() {
  return useQuery<SignalListResponse>({
    queryKey: [api.tickers.list.path],
    queryFn: async () => {
      // Add cache buster to prevent stale data
      const url = `${api.tickers.list.path}?t=${Date.now()}`;
      const res = await fetch(url, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error("Failed to fetch market data");
      return res.json();
    },
    refetchInterval: 15000, // Refresh every 15 seconds
    refetchOnWindowFocus: true,
    staleTime: 0, // Always consider data stale
  });
}

export function useRefreshSignals() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(api.tickers.refresh.path, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to trigger refresh");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.tickers.list.path] });
      toast({
        title: "Refresh Triggered",
        description: "Signal data is being recalculated...",
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

export function useWatchlist() {
  return useQuery({
    queryKey: [api.watchlist.list.path],
    queryFn: async () => {
      const res = await fetch(api.watchlist.list.path);
      if (!res.ok) throw new Error("Failed to fetch watchlist");
      return res.json();
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
        throw new Error("Failed to add to watchlist");
      }
      
      return res.json();
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

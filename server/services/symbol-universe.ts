/**
 * Symbol Universe Service
 * Extracted from routes.ts — manages unified coin selection logic
 * Used by both Classic view (calculateSignals) and Enhanced view (/api/screen)
 */
import { getStorage } from "../storage";

export const MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

const EQUITY_PERPS = new Set([
  "TSLAUSDT", "INTCUSDT", "HOODSDT", "AAPLUSDT", "NVDAUSDT",
  "MSFTUSDT", "AMZNUSDT", "GOOGLUSDT", "METAUSDT", "COINUSDT"
]);

export async function getUnifiedSymbolUniverse(rawData: any[]): Promise<any[]> {
  let watchlistSymbols: string[] = [];
  try {
    const watchlist = await getStorage().getWatchlist();
    watchlistSymbols = watchlist.map((w) => w.symbol);
  } catch (err) {
    console.warn('[SYMBOLS] Could not fetch watchlist');
  }

  const allSymbols = rawData.filter((t: any) => {
    const symbol = t.symbol || "";
    const price = parseFloat(t.lastPrice);
    const volume = parseFloat(t.quoteVol);
    if (symbol.includes("USDC") || (symbol.includes("USDT") && !symbol.endsWith("USDT"))) return false;
    if (EQUITY_PERPS.has(symbol)) return false;
    return price > 0 && volume > 0 && !isNaN(price) && !isNaN(volume) && symbol.endsWith("USDT");
  });

  // Priority 1: Major pairs
  const majorSymbols = allSymbols.filter((t: any) => MAJOR_SYMBOLS.includes(t.symbol));

  // Priority 2: Watchlist
  const watchedSymbols = allSymbols.filter(
    (t: any) => watchlistSymbols.includes(t.symbol) && !MAJOR_SYMBOLS.includes(t.symbol)
  );

  // Priority 3: Top 50 by price change
  const selectedSymbols = new Set([...MAJOR_SYMBOLS, ...watchlistSymbols]);
  const otherSymbols = allSymbols
    .filter((t: any) => !selectedSymbols.has(t.symbol))
    .sort((a: any, b: any) => {
      const aChange = Math.abs(((parseFloat(a.lastPrice) - parseFloat(a.open)) / parseFloat(a.open)) * 100);
      const bChange = Math.abs(((parseFloat(b.lastPrice) - parseFloat(b.open)) / parseFloat(b.open)) * 100);
      return bChange - aChange;
    })
    .slice(0, 50);

  // Priority 4: High movers (>10% change)
  const highMovers = allSymbols
    .filter((t: any) => {
      if (selectedSymbols.has(t.symbol)) return false;
      if (otherSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      const price = parseFloat(t.lastPrice);
      const open = parseFloat(t.open);
      const change = ((price - open) / open) * 100;
      return change >= 10 || change <= -10;
    })
    .slice(0, 20);

  // Priority 5: New Binance futures listings
  let newListingSymbols: any[] = [];
  try {
    const { getNewFuturesListings } = await import('../listing-monitor');
    const newListings = await getNewFuturesListings();
    newListingSymbols = allSymbols.filter((t: any) => {
      if (selectedSymbols.has(t.symbol)) return false;
      if (otherSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      if (highMovers.some((o: any) => o.symbol === t.symbol)) return false;
      return newListings.has(t.symbol);
    });
    if (newListingSymbols.length > 0) {
      console.log(`[SYMBOLS] New listings: ${newListingSymbols.map((s: any) => s.symbol).join(', ')}`);
    }
  } catch (err) {
    console.warn('[SYMBOLS] New listing detection unavailable:', (err as Error).message);
  }

  // Priority 6: Korea exchange new listings
  let koreaNewSymbols: any[] = [];
  try {
    const { getUpbitNewListings } = await import('../listing-monitor');
    const koreaListings = await getUpbitNewListings();
    koreaNewSymbols = allSymbols.filter((t: any) => {
      if (selectedSymbols.has(t.symbol)) return false;
      if (otherSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      if (highMovers.some((o: any) => o.symbol === t.symbol)) return false;
      if (newListingSymbols.some((o: any) => o.symbol === t.symbol)) return false;
      return koreaListings.has(t.symbol);
    });
    if (koreaNewSymbols.length > 0) {
      console.log(`[SYMBOLS] Korea new listings: ${koreaNewSymbols.map((s: any) => s.symbol).join(', ')}`);
    }
  } catch (err) {
    console.warn('[SYMBOLS] Korea listing unavailable:', (err as Error).message);
  }

  // Priority 7: Binance-only symbols
  let binanceOnlySymbols: any[] = [];
  try {
    const { getBinanceFuturesSymbols } = await import('../listing-monitor');
    const binanceSymbols = await getBinanceFuturesSymbols();
    const alreadySelected = new Set([
      ...majorSymbols.map((s: any) => s.symbol),
      ...watchedSymbols.map((s: any) => s.symbol),
      ...otherSymbols.map((s: any) => s.symbol),
      ...highMovers.map((s: any) => s.symbol),
      ...newListingSymbols.map((s: any) => s.symbol),
      ...koreaNewSymbols.map((s: any) => s.symbol),
    ]);
    const bitunixSymbols = new Set(allSymbols.map((s: any) => s.symbol));
    const missingFromBitunix: string[] = [];
    for (const sym of binanceSymbols) {
      if (!bitunixSymbols.has(sym) && !alreadySelected.has(sym)) {
        missingFromBitunix.push(sym);
      }
    }
    if (missingFromBitunix.length > 0) {
      console.log(`[SYMBOLS] Binance-only: ${missingFromBitunix.join(', ')}`);
      try {
        const resp = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', {
          headers: { 'User-Agent': 'Giiq-Screener/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const tickers = await resp.json() as Array<{
            symbol: string; lastPrice: string; priceChangePercent: string;
            volume: string; quoteVolume: string; openPrice: string;
            highPrice: string; lowPrice: string;
          }>;
          const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
          for (const sym of missingFromBitunix.slice(0, 10)) {
            const ticker = tickerMap.get(sym);
            if (ticker && parseFloat(ticker.lastPrice) > 0) {
              binanceOnlySymbols.push({
                symbol: sym,
                lastPrice: ticker.lastPrice,
                open: ticker.openPrice,
                high24h: ticker.highPrice,
                low24h: ticker.lowPrice,
                quoteVol: ticker.quoteVolume,
                vol: ticker.volume,
                priceChange24h: parseFloat(ticker.priceChangePercent),
                _source: 'binance-backfill',
              });
            }
          }
        }
      } catch (err) {
        console.warn('[SYMBOLS] Binance ticker backfill failed:', (err as Error).message);
      }
    }
  } catch (err) {
    console.warn('[SYMBOLS] Binance symbol fetch unavailable:', (err as Error).message);
  }

  const symbolsToProcess = [
    ...majorSymbols, ...watchedSymbols, ...otherSymbols,
    ...highMovers, ...newListingSymbols, ...koreaNewSymbols, ...binanceOnlySymbols,
  ];

  const uniqueSymbols = Array.from(
    new Map(symbolsToProcess.map((s) => [s.symbol, s])).values()
  );

  console.log(
    `[SYMBOLS] Unified universe: ${majorSymbols.length} major, ${watchedSymbols.length} watched, ${otherSymbols.length} top-change, ${highMovers.length} movers, ${newListingSymbols.length} new-listings, ${koreaNewSymbols.length} korea-new, ${binanceOnlySymbols.length} binance-only = ${uniqueSymbols.length} total`
  );
  return uniqueSymbols;
}

import { useMemo } from "react";

interface Props {
  symbol: string;            // e.g. "ZEREBROUSDT"
  exchange?: string;         // BINANCE / OKX / BITUNIX
  interval?: "5" | "15" | "60" | "240" | "D";
  height?: number;
  isPerp?: boolean;          // append .P for perpetual
}

/**
 * Bitunix-priced chart via TradingView's iframe embed.
 *
 * Why iframe instead of tv.js widget script:
 *   - tv.js widget often fails to resolve `BITUNIX:XXXUSDT.P` cleanly when
 *     the script-loaded widget runs symbol-search; iframe embed resolves
 *     the symbol on TradingView's server-side and renders directly.
 *   - No global TradingView object; no race conditions; no script tag leaks.
 *
 * The "Open in Bitunix" link below jumps to the actual Bitunix trading page
 * for the same pair so the user can place orders on the same chart they see.
 */
export function TradingViewChart({
  symbol,
  exchange = "BITUNIX",
  interval = "60",
  height = 480,
  isPerp = true,
}: Props) {
  const tvSymbol = `${exchange}:${symbol}${isPerp ? ".P" : ""}`;

  const src = useMemo(() => {
    const params = new URLSearchParams({
      symbol: tvSymbol,
      interval,
      hidesidetoolbar: "0",
      hidetoptoolbar: "0",
      symboledit: "1",
      saveimage: "0",
      toolbarbg: "151924",
      studies: "RSI@tv-basicstudies,Volume@tv-basicstudies",
      theme: "dark",
      style: "1",
      timezone: "Asia/Hong_Kong",
      withdateranges: "1",
      hideideas: "1",
      locale: "en",
      utm_source: "altcoin-cockpit",
      utm_medium: "widget",
    });
    return `https://s.tradingview.com/widgetembed/?${params.toString()}`;
  }, [tvSymbol, interval]);

  // Bitunix native trading page (same pair) for "open in Bitunix" jump
  const bitunixHref = `https://www.bitunix.com/contract-trade/${symbol}`;

  return (
    <div className="rounded-lg overflow-hidden bg-[#151924] border border-zinc-800">
      <iframe
        title={`TradingView ${tvSymbol}`}
        src={src}
        style={{
          width: "100%",
          height: `${height}px`,
          border: 0,
          display: "block",
        }}
        allowTransparency
        allowFullScreen
      />
      <div className="flex items-center justify-between px-3 py-2 text-xs text-zinc-400">
        <span>
          Bitunix {symbol}
          {isPerp ? " Perp" : ""} · {interval === "D" ? "1D" : `${interval}m`}
        </span>
        <a
          href={bitunixHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 hover:text-emerald-300 underline-offset-2 hover:underline"
        >
          Open in Bitunix →
        </a>
      </div>
    </div>
  );
}

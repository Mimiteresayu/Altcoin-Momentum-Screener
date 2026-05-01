import { useEffect, useRef } from "react";

interface Props {
  symbol: string;            // e.g. "ZEREBROUSDT"
  exchange?: string;         // BINANCE / OKX / BITUNIX
  interval?: "5" | "15" | "60" | "240" | "D";
  height?: number;
  isPerp?: boolean;          // append .P for perpetual
}

declare global {
  interface Window {
    TradingView?: any;
  }
}

/**
 * Free TradingView Advanced Chart widget (iframe).
 * Pro account just gives nicer features; embed itself is free.
 *
 * To upgrade to Charting Library (with overlay support for entry/stop lines),
 * apply at https://www.tradingview.com/charting-library/ (free for indie devs).
 */
export function TradingViewChart({
  symbol,
  exchange = "BITUNIX",
  interval = "60",
  height = 480,
  isPerp = true,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";

    const tvSymbol = `${exchange}:${symbol}${isPerp ? ".P" : ""}`;

    const container = document.createElement("div");
    container.id = `tv_${Math.random().toString(36).slice(2)}`;
    container.style.height = `${height}px`;
    container.style.width = "100%";
    ref.current.appendChild(container);

    const loadWidget = () => {
      if (!window.TradingView || !ref.current) return;
      try {
        new window.TradingView.widget({
          autosize: false,
          symbol: tvSymbol,
          interval,
          timezone: "Asia/Hong_Kong",
          theme: "dark",
          style: "1",
          locale: "en",
          enable_publishing: false,
          allow_symbol_change: true,
          hide_legend: false,
          save_image: false,
          studies: ["RSI@tv-basicstudies", "Volume@tv-basicstudies"],
          container_id: container.id,
          width: "100%",
          height,
        });
      } catch (e) {
        console.error("[TV] widget error", e);
      }
    };

    if (window.TradingView) {
      loadWidget();
    } else {
      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/tv.js";
      script.async = true;
      script.onload = loadWidget;
      document.body.appendChild(script);
    }
  }, [symbol, exchange, interval, height, isPerp]);

  return <div ref={ref} style={{ minHeight: height }} className="rounded-lg overflow-hidden" />;
}

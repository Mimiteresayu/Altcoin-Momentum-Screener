import { Signal } from "@shared/schema";
import {
  getFundingRate,
  getLongShortRatio,
  getLiquidationMap,
  getEnhancedMarketData,
  type EnhancedMarketData,
  type LiquidationMapData,
} from "./coinglass";
import { bitunixTradeService, BitunixTradeService } from "./bitunix-trade";

// Simple kline interface for internal use
interface SimpleKline {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  openTime: number;
  closeTime: number;
}
import { getBinanceFuturesData, getBinanceKlines, getSymbolListingDate, calculateAgeDays } from "./binance";
import { getOKXMarketData, getOKXFundingRate, getOKXKlines } from "./okx";

type PriceLocation = "DISCOUNT" | "NEUTRAL" | "PREMIUM";
type MarketPhase = "ACCUMULATION" | "BREAKOUT" | "DISTRIBUTION" | "TREND" | "EXHAUST";
type Confidence = "high" | "medium" | "low";

type HtfBias = {
  side: "LONG" | "SHORT";
  confidence: "high" | "medium" | "low";
  supertrendBias: "LONG" | "SHORT";
  fundingConfirms: boolean;
  supertrendValue: number;
};

type EntryModel = "BUY DIP" | "SCALE IN" | "BOS ENTRY" | "FVG ENTRY" | "PULLBACK" | "ADD" | "TAKE PROFIT" | "SHORT SETUP" | "AVOID" | "REVERSAL" | "WAIT";

interface CandlestickAnalysis {
  isBullish: boolean;
  isBearish: boolean;
  hasLongUpperWick: boolean;  // Selling pressure
  hasLongLowerWick: boolean;  // Buying pressure
  bodySize: number;           // Relative body size
  wickRatio: number;          // Wick to body ratio
}
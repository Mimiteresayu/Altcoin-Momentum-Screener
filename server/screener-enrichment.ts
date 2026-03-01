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

interface EnrichedSignalData {
  priceLocation: PriceLocation;
  marketPhase: MarketPhase;
  entryModel: EntryModel;
  preSpikeScore: number;
  fundingRate: number | undefined;
  fundingBias: "bullish" | "bearish" | "neutral" | undefined;
  longShortRatio: number | undefined;
  lsrBias: "long_dominant" | "short_dominant" | "balanced" | undefined;
  htfBias: HtfBias | undefined;
  fvgLevels: { price: number; type: "bullish" | "bearish"; strength: number }[];
  obLevels: { price: number; type: "bullish" | "bearish"; strength: number }[];
  liquidationZones: {
    nearestLongLiq: number | undefined;
    nearestShortLiq: number | undefined;
    longLiqDistance: number | undefined;
    shortLiqDistance: number | undefined;
  };
  volumeProfilePOC: number | undefined; // Point of Control - highest volume price level
  storytelling: {
    summary: string;
    interpretation: string;
    confidence: Confidence;
    actionSuggestion: string;
  };
  ageDays: number | undefined; // Days since first listed on exchange
    efficiencyRatio: number | undefined; // ER: net price change / sum of absolute changes (0-1, higher = trending)
  volatilitySpread: number | undefined; // VSpread: normalized ATR-SD spread (volatility clustering detector)
  channelRange: number | undefined; // CRange: normalized position in price channel (-1 to 1, >0.8 = breakout zone)
    permutationEntropy: number | undefined; // PE: permutation entropy from 4H klines
  erZScore: number | undefined; // Z-score of Efficiency Ratio
  vsZScore: number | undefined; // Z-score of Volatility Spread
  peZScore: number | undefined; // Z-score of Permutation Entropy
    aurVelocity: number | undefined; // AUR slope/velocity
  aurRising: boolean | undefined; // Whether AUR is rising
  preSpikeCombo: {
    comboScore: number;
    aurCondition: boolean;
    erCondition: boolean;
    vsCondition: boolean;
    peCondition: boolean;
  };
}

export function calculatePriceLocation(
  currentPrice: number,
  high24h: number,
  low24h: number,
): PriceLocation {
  const range = high24h - low24h;
  if (range <= 0) return "NEUTRAL";

  const position = (currentPrice - low24h) / range;

  if (position <= 0.33) return "DISCOUNT";
  if (position >= 0.67) return "PREMIUM";
  return "NEUTRAL";
}
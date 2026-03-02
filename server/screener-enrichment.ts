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
  // NEW: Intraday spike detection signals
  spikeScore: number; // New composite score 0-10
  rvol: number | undefined; // Relative Volume ratio
  rvolZScore: number | undefined; // RVOL z-score
  squeezeState: SqueezeState | undefined; // BB/KC squeeze state
  squeezeBars: number | undefined; // Consecutive bars in squeeze
  oiSurgeZScore: number | undefined; // OI surge z-score
  oiDirection: "RISING" | "FALLING" | "FLAT" | undefined;
  fundingSignal: "SQUEEZE_FUEL" | "OVERCROWDED_LONG" | "NEUTRAL" | undefined;
  atrExpanding: boolean | undefined; // ATR expansion confirmation
  atrRatio: number | undefined; // Current ATR / avg ATR
  // NEW: Spike probability engine output
  spikeProbability: SpikeProbability | undefined;
}

/**
 * SpikeProbability — output of the logistic sigmoid spike probability engine.
 * Answers: "What is the instantaneous probability of a spike in the next 15 minutes?"
 */
export interface SpikeProbability {
  probability: number;          // 0.0-1.0, P(spike in next 15min)
  confidence: "HIGH" | "MEDIUM" | "LOW"; // Based on signal agreement + data quality
  expectedMagnitude: number;    // Expected spike % if it occurs (2-20%)
  timeDecay: number;            // 0.0-1.0, how fresh signals are (1.0 = just happened)
  dominantDriver: string;       // Which signal is contributing most
  signalAgreement: number;      // 0.0-1.0, fraction of signals that agree (confluence)
  spikeScore: number;           // Backward-compatible 0-10 score
  vwapConfirmation: "BULLISH" | "BEARISH" | "NEUTRAL"; // Price vs VWAP
  koreaListingAlpha: boolean;   // True if new Korean exchange listing detected
}

/**
 * coil-signal.ts
 * COIL Signal Type for Giiq Trading Platform
 *
 * Detects volatility compression before explosive breakout moves.
 * COIL = ALL conditions simultaneously: VS Z < -1.5, CR < 20th pct,
 * AUR slope > 0, AUR Z < 1.5, ER < 0.3, PE < 0.7, volume declining.
 *
 * Also implements Universe Expansion streams A/B/C with deduplication.
 *
 * @module coil-signal
 */

// ─── Type Definitions ────────────────────────────────────────────────────────

export type CoilPhase = 'COIL_EARLY' | 'COIL_READY' | 'COIL_TRIGGER' | 'NONE';

export interface CoilConditions {
  /** Volatility Squeeze Z-Score — must be < -1.5 */
  vsZScore: number;
  /** Channel Range percentile (0-100) — must be < 20 */
  channelRangePercentile: number;
  /** Accumulation Under Range slope — must be > 0 */
  aurSlope: number;
  /** AUR Z-Score — must be < 1.5 (not overextended) */
  aurZ: number;
  /** Efficiency Ratio — must be < 0.3 (choppy) */
  efficiencyRatio: number;
  /** Price Entropy — must be < 0.7 (orderly structure) */
  priceEntropy: number;
  /** Whether volume is declining (boolean) */
  volumeDeclining: boolean;
}

export interface CoilConditionResult {
  vsZScorePassed: boolean;
  channelRangePassed: boolean;
  aurSlopePassed: boolean;
  aurZPassed: boolean;
  erPassed: boolean;
  pePassed: boolean;
  volumePassed: boolean;
  /** Count of conditions that passed (max 7) */
  conditionsMet: number;
  /** All 7 conditions true */
  allMet: boolean;
}

export interface CoilSignal {
  symbol: string;
  phase: CoilPhase;
  /** Weighted composite score 0-100 */
  score: number;
  conditions: CoilConditions;
  conditionResult: CoilConditionResult;
  /** Estimated breakout direction bias */
  breakoutBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  /** Confidence in breakout direction (0-1) */
  directionConfidence: number;
  /** Suggested entry type for COIL_TRIGGER */
  entryType: 'BREAKOUT' | 'PULLBACK' | null;
  timestamp: number;
}

export interface MarketData {
  symbol: string;
  /** Close prices array (most recent last) */
  closes: number[];
  /** Volume array (same length as closes) */
  volumes: number[];
  /** High prices */
  highs: number[];
  /** Low prices */
  lows: number[];
  /** Current 24h volume USD */
  volume24hUsd: number;
  /** How many days since listing (for Korea Alpha stream C) */
  daysListed?: number;
}

// ─── Universe Expansion Streams ──────────────────────────────────────────────

export interface UniverseStream {
  symbol: string;
  source: 'STREAM_A' | 'STREAM_B' | 'STREAM_C';
  reason: string;
}

/**
 * Expand the trading universe beyond the top-50 by volume.
 *
 * - Stream A: Top 50 by 24h volume (existing screener universe)
 * - Stream B: All coins with VS Z-Score < -1.0 (COIL candidates)
 * - Stream C: New listings < 14 days old (Korea Alpha)
 *
 * @param allMarketData - Full market data for all tradeable coins
 * @param top50byVolume - Pre-sorted symbols of top 50 by volume
 * @returns Deduplicated merged universe with source labels
 */
export function expandUniverse(
  allMarketData: MarketData[],
  top50byVolume: string[]
): UniverseStream[] {
  const seen = new Set<string>();
  const universe: UniverseStream[] = [];

  const addSymbol = (symbol: string, source: UniverseStream['source'], reason: string) => {
    if (!seen.has(symbol)) {
      seen.add(symbol);
      universe.push({ symbol, source, reason });
    }
  };

  // Stream A: Top 50 by Volume
  for (const sym of top50byVolume.slice(0, 50)) {
    addSymbol(sym, 'STREAM_A', 'Top 50 by volume');
  }

  // Stream B: VS Z-Score < -1.0 (catch COIL candidates with lower volume)
  for (const md of allMarketData) {
    if (top50byVolume.includes(md.symbol)) continue; // already in A
    const vsZ = calculateVSZScore(md.closes, md.volumes);
    if (vsZ < -1.0) {
      addSymbol(md.symbol, 'STREAM_B', `VS Z-Score ${vsZ.toFixed(2)} < -1.0 (COIL candidate)`);
    }
  }

  // Stream C: New listings < 14 days (Korea Alpha)
  const FOURTEEN_DAYS = 14;
  for (const md of allMarketData) {
    if (md.daysListed !== undefined && md.daysListed < FOURTEEN_DAYS) {
      addSymbol(md.symbol, 'STREAM_C', `New listing — ${md.daysListed} days old (Korea Alpha)`);
    }
  }

  return universe;
}

// ─── Statistical Helpers ─────────────────────────────────────────────────────

/**
 * Compute the mean of an array.
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Compute the standard deviation of an array.
 */
function stdDev(arr: number[], ddof = 1): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance =
    arr.reduce((sum, x) => sum + Math.pow(x - m, 2), 0) / (arr.length - ddof);
  return Math.sqrt(variance);
}

/**
 * Compute a Z-score for the latest value in a series.
 */
function zScore(series: number[]): number {
  if (series.length < 3) return 0;
  const latest = series[series.length - 1];
  const historical = series.slice(0, -1);
  const m = mean(historical);
  const s = stdDev(historical);
  if (s === 0) return 0;
  return (latest - m) / s;
}

/**
 * Calculate percentile rank of the last element in a series (0-100).
 */
function percentileRank(series: number[]): number {
  if (series.length < 2) return 50;
  const latest = series[series.length - 1];
  const below = series.slice(0, -1).filter((v) => v <= latest).length;
  return (below / (series.length - 1)) * 100;
}

/**
 * True Range array from OHLC data.
 */
function trueRange(highs: number[], lows: number[], closes: number[]): number[] {
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  return trs;
}

/**
 * ATR — Average True Range over N periods.
 */
function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const trs = trueRange(highs, lows, closes);
  const recent = trs.slice(-period);
  return mean(recent);
}

// ─── Indicator Calculations ─────────────────────────────────────────────────────

/**
 * Volatility Squeeze Z-Score (VS Z-Score).
 * Compares current ATR volatility to its historical distribution.
 * Returns Z-score — negative = compressed volatility.
 *
 * @param closes - Close prices
 * @param volumes - Volume data (not used here but kept for API consistency)
 * @param period - ATR period (default 14)
 * @param lookback - History window for Z-score (default 50)
 */
export function calculateVSZScore(
  closes: number[],
  _volumes: number[],
  period = 14,
  lookback = 50
): number {
  if (closes.length < lookback + period) return 0;

  // Build a rolling ATR series
  const atrSeries: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const slice = closes.slice(Math.max(0, i - period - 1), i + 1);
    // Approximate ATR using close-to-close volatility when OHLC not available
    const returns = slice
      .slice(1)
      .map((c, j) => Math.abs(c - slice[j]) / slice[j]);
    atrSeries.push(mean(returns));
  }

  if (atrSeries.length < 2) return 0;
  return zScore(atrSeries.slice(-lookback));
}

/**
 * Full VS Z-Score with OHLC data.
 */
export function calculateVSZScoreOHLC(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
  lookback = 50
): number {
  if (closes.length < lookback + period) return 0;

  const atrSeries: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const h = highs.slice(Math.max(0, i - period), i + 1);
    const l = lows.slice(Math.max(0, i - period), i + 1);
    const c = closes.slice(Math.max(0, i - period - 1), i + 1);
    atrSeries.push(atr(h, l, c, period));
  }

  return zScore(atrSeries.slice(-lookback));
}

/**
 * Channel Range Percentile.
 * Measures how tight the current price range is relative to history.
 * Low percentile = tight channel = compression.
 *
 * @param highs - High prices
 * @param lows - Low prices
 * @param period - Lookback for channel measurement (default 20)
 * @param rankPeriod - Period for percentile rank (default 50)
 */
export function calculateChannelRangePercentile(
  highs: number[],
  lows: number[],
  period = 20,
  rankPeriod = 50
): number {
  if (highs.length < period + rankPeriod) return 50;

  const rangeSeries: number[] = [];
  for (let i = period; i < highs.length; i++) {
    const hSlice = highs.slice(i - period, i);
    const lSlice = lows.slice(i - period, i);
    const channelHigh = Math.max(...hSlice);
    const channelLow = Math.min(...lSlice);
    rangeSeries.push((channelHigh - channelLow) / channelLow);
  }

  return percentileRank(rangeSeries.slice(-rankPeriod));
}

/**
 * AUR (Accumulation Under Range) calculation.
 * Tracks volume-weighted buying pressure during consolidation.
 * Returns { slope, zScore } — positive slope = accumulation building.
 *
 * @param closes - Close prices
 * @param volumes - Volume data
 * @param period - Period for AUR calculation (default 20)
 */
export function calculateAUR(
  closes: number[],
  volumes: number[],
  period = 20
): { slope: number; zScore: number } {
  if (closes.length < period + 10 || volumes.length < period + 10) {
    return { slope: 0, zScore: 0 };
  }

  // Build AUR series: volume-weighted delta
  const aurSeries: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const weightedDelta = delta * volumes[i];
    aurSeries.push(weightedDelta);
  }

  // Cumulative AUR
  const cumAUR: number[] = [];
  let cum = 0;
  for (const v of aurSeries) {
    cum += v;
    cumAUR.push(cum);
  }

  const recent = cumAUR.slice(-period);
  if (recent.length < 2) return { slope: 0, zScore: 0 };

  // Slope via linear regression
  const n = recent.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = recent.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, i) => sum + x * recent[i], 0);
  const sumX2 = xs.reduce((sum, x) => sum + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Z-score of latest AUR vs history
  const zScoreVal = zScore(cumAUR.slice(-50));

  return { slope, zScore: zScoreVal };
}

/**
 * Efficiency Ratio (ER) — measures directional efficiency of price movement.
 * ER = |net price change| / sum of absolute bar-to-bar changes
 * ER ≈ 0 = random/choppy, ER ≈ 1 = strongly trending.
 *
 * @param closes - Close prices
 * @param period - Lookback period (default 14)
 */
export function calculateEfficiencyRatio(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 0.5;

  const slice = closes.slice(-period - 1);
  const netChange = Math.abs(slice[slice.length - 1] - slice[0]);
  const sumChanges = slice
    .slice(1)
    .reduce((sum, c, i) => sum + Math.abs(c - slice[i]), 0);

  if (sumChanges === 0) return 0;
  return Math.min(1, netChange / sumChanges);
}

/**
 * Price Entropy (PE) — measures orderliness of price structure.
 * Uses approximate entropy of returns distribution.
 * Low PE = orderly structure, high PE = chaotic.
 *
 * @param closes - Close prices
 * @param period - Lookback period (default 20)
 */
export function calculatePriceEntropy(closes: number[], period = 20): number {
  if (closes.length < period + 1) return 0.5;

  const slice = closes.slice(-period - 1);
  const returns = slice.slice(1).map((c, i) => (c - slice[i]) / slice[i]);

  // Bin returns into 5 buckets for entropy calculation
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const range = max - min;

  if (range === 0) return 0;

  const buckets = 5;
  const bucketSize = range / buckets;
  const counts = new Array(buckets).fill(0);

  for (const r of returns) {
    const bucket = Math.min(Math.floor((r - min) / bucketSize), buckets - 1);
    counts[bucket]++;
  }

  const total = returns.length;
  let entropy = 0;
  for (const count of counts) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize to 0-1 range (max entropy = log2(buckets))
  return entropy / Math.log2(buckets);
}

/**
 * Check if volume is declining over a period.
 * Uses linear regression slope on volume series.
 *
 * @param volumes - Volume data
 * @param period - Lookback period (default 10)
 */
export function isVolumeDeclining(volumes: number[], period = 10): boolean {
  if (volumes.length < period) return false;

  const recent = volumes.slice(-period);
  const n = recent.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = recent.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, i) => sum + x * recent[i], 0);
  const sumX2 = xs.reduce((sum, x) => sum + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  return slope < 0;
}

// ─── COIL Phase Determination ──────────────────────────────────────────────────

/**
 * Determine COIL phase based on conditions met and score.
 *
 * - COIL_EARLY:   3-4 conditions met, score 30-55
 * - COIL_READY:   5-6 conditions met, score 55-79
 * - COIL_TRIGGER: All 7 conditions met, score ≥ 80 — imminent breakout
 * - NONE:         Fewer than 3 conditions or score < 30
 */
export function determineCoilPhase(
  conditionResult: CoilConditionResult,
  score: number
): CoilPhase {
  if (conditionResult.allMet && score >= 80) return 'COIL_TRIGGER';
  if (conditionResult.conditionsMet >= 5 && score >= 55) return 'COIL_READY';
  if (conditionResult.conditionsMet >= 3 && score >= 30) return 'COIL_EARLY';
  return 'NONE';
}

// ─── COIL Scoring ──────────────────────────────────────────────────────────────

/**
 * Calculate the COIL composite score (0-100).
 *
 * Weighted contributions:
 * - VS Z-Score:          25 pts (compression depth)
 * - Channel Range:       20 pts (tightness)
 * - AUR Slope:           20 pts (accumulation quality)
 * - AUR Z-Score:         10 pts (not overextended)
 * - Efficiency Ratio:    10 pts (choppiness)
 * - Price Entropy:       10 pts (orderliness)
 * - Volume Declining:     5 pts (classic pre-breakout sign)
 */
export function calculateCoilScore(conditions: CoilConditions): number {
  let score = 0;

  // VS Z-Score: deeper compression = higher score (max 25)
  // -1.5 = 12.5pts, -2.0 = 18pts, -3.0 = 25pts
  if (conditions.vsZScore < -1.5) {
    const depth = Math.min(3, Math.abs(conditions.vsZScore + 1.5));
    score += 12.5 + (depth / 1.5) * 12.5;
  }

  // Channel Range: lower percentile = higher score (max 20)
  if (conditions.channelRangePercentile < 20) {
    score += ((20 - conditions.channelRangePercentile) / 20) * 20;
  }

  // AUR Slope: positive slope = full 20 pts, scale magnitude
  if (conditions.aurSlope > 0) {
    score += Math.min(20, 10 + conditions.aurSlope * 10);
  }

  // AUR Z-Score: closer to 0 from below = better (max 10)
  if (conditions.aurZ < 1.5) {
    score += ((1.5 - Math.max(0, conditions.aurZ)) / 1.5) * 10;
  }

  // ER: lower = choppier = coil building (max 10)
  if (conditions.efficiencyRatio < 0.3) {
    score += ((0.3 - conditions.efficiencyRatio) / 0.3) * 10;
  }

  // PE: lower = more orderly (max 10)
  if (conditions.priceEntropy < 0.7) {
    score += ((0.7 - conditions.priceEntropy) / 0.7) * 10;
  }

  // Volume Declining: 5 pts bonus
  if (conditions.volumeDeclining) {
    score += 5;
  }

  return Math.min(100, Math.round(score));
}

// ─── Breakout Bias ────────────────────────────────────────────────────────────

/**
 * Estimate breakout direction from AUR and volume profile.
 * AUR slope + positive volume delta bias = LONG.
 * Negative AUR slope despite price stability = SHORT bias.
 */
function estimateBreakoutBias(
  conditions: CoilConditions,
  closes: number[],
  volumes: number[]
): { bias: CoilSignal['breakoutBias']; confidence: number } {
  const recentCloses = closes.slice(-10);
  const recentVolumes = volumes.slice(-10);

  if (recentCloses.length < 5) return { bias: 'NEUTRAL', confidence: 0.5 };

  // Check if closes are making higher lows (LONG bias)
  const lows = recentCloses.slice(0, 5);
  const latestLows = recentCloses.slice(-5);
  const higherLows = mean(latestLows) > mean(lows);

  // Volume on up bars vs down bars
  let upVolume = 0;
  let downVolume = 0;
  for (let i = 1; i < recentCloses.length; i++) {
    if (recentCloses[i] > recentCloses[i - 1]) upVolume += recentVolumes[i];
    else downVolume += recentVolumes[i];
  }

  const volumeBias = upVolume / (upVolume + downVolume || 1);
  const aurPositive = conditions.aurSlope > 0;

  const longSignals = [higherLows, aurPositive, volumeBias > 0.55].filter(Boolean).length;
  const shortSignals = [!higherLows, !aurPositive, volumeBias < 0.45].filter(Boolean).length;

  if (longSignals >= 2) {
    return { bias: 'LONG', confidence: 0.5 + longSignals * 0.15 };
  }
  if (shortSignals >= 2) {
    return { bias: 'SHORT', confidence: 0.5 + shortSignals * 0.15 };
  }
  return { bias: 'NEUTRAL', confidence: 0.5 };
}

// ─── Main COIL Analysis Function ─────────────────────────────────────────────────

/**
 * Evaluate all COIL conditions for a given market data snapshot.
 * Returns a full CoilSignal with phase, score, and bias.
 *
 * @param marketData - OHLCV data for the symbol
 * @param crPeriod - Channel range lookback period (default 20)
 * @param crRankPeriod - Channel range percentile rank period (default 50)
 */
export function analyzeCoil(
  marketData: MarketData,
  crPeriod = 20,
  crRankPeriod = 50
): CoilSignal {
  const { symbol, closes, volumes, highs, lows } = marketData;

  // Calculate all indicators
  const vsZ = highs.length > 0
    ? calculateVSZScoreOHLC(highs, lows, closes)
    : calculateVSZScore(closes, volumes);

  const cr = calculateChannelRangePercentile(highs, lows, crPeriod, crRankPeriod);
  const aur = calculateAUR(closes, volumes);
  const er = calculateEfficiencyRatio(closes);
  const pe = calculatePriceEntropy(closes);
  const volDeclining = isVolumeDeclining(volumes);

  const conditions: CoilConditions = {
    vsZScore: vsZ,
    channelRangePercentile: cr,
    aurSlope: aur.slope,
    aurZ: aur.zScore,
    efficiencyRatio: er,
    priceEntropy: pe,
    volumeDeclining: volDeclining,
  };

  // Check which conditions pass
  const conditionResult: CoilConditionResult = {
    vsZScorePassed: vsZ < -1.5,
    channelRangePassed: cr < 20,
    aurSlopePassed: aur.slope > 0,
    aurZPassed: aur.zScore < 1.5,
    erPassed: er < 0.3,
    pePassed: pe < 0.7,
    volumePassed: volDeclining,
    conditionsMet: 0,
    allMet: false,
  };

  conditionResult.conditionsMet = [
    conditionResult.vsZScorePassed,
    conditionResult.channelRangePassed,
    conditionResult.aurSlopePassed,
    conditionResult.aurZPassed,
    conditionResult.erPassed,
    conditionResult.pePassed,
    conditionResult.volumePassed,
  ].filter(Boolean).length;

  conditionResult.allMet = conditionResult.conditionsMet === 7;

  const score = calculateCoilScore(conditions);
  const phase = determineCoilPhase(conditionResult, score);

  const { bias, confidence } = estimateBreakoutBias(conditions, closes, volumes);

  return {
    symbol,
    phase,
    score,
    conditions,
    conditionResult,
    breakoutBias: bias,
    directionConfidence: Math.min(1, confidence),
    entryType: phase === 'COIL_TRIGGER' ? 'BREAKOUT' : null,
    timestamp: Date.now(),
  };
}

/**
 * Filter an array of market data to return only active COIL signals.
 * Useful for the screener expanded universe pipeline.
 *
 * @param marketDataArray - Array of market data snapshots
 * @param minPhase - Minimum phase to include (default: COIL_EARLY)
 * @returns Sorted array of COIL signals (highest score first)
 */
export function filterCoilSignals(
  marketDataArray: MarketData[],
  minPhase: CoilPhase = 'COIL_EARLY'
): CoilSignal[] {
  const phaseOrder: Record<CoilPhase, number> = {
    NONE: 0,
    COIL_EARLY: 1,
    COIL_READY: 2,
    COIL_TRIGGER: 3,
  };

  const minOrder = phaseOrder[minPhase];

  return marketDataArray
    .map((md) => analyzeCoil(md))
    .filter((s) => phaseOrder[s.phase] >= minOrder)
    .sort((a, b) => b.score - a.score);
}

export default { analyzeCoil, filterCoilSignals, expandUniverse };

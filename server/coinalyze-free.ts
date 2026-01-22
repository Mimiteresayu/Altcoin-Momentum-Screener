/**
 * Open Interest & Liquidation Data using Coinglass API
 * User has STARTUP plan ($49/month)
 * Full API access for OI, Liquidations, Funding Rate, Long/Short Ratio
 */

const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || '';
const BASE_URL = 'https://open-api-v3.coinglass.com/api';

// ============ INTERFACES ============

export interface OpenInterestData {
  symbol: string;
  openInterest: number;
  openInterestValue: number;
  h24Change: number;
  timestamp: number;
}

export interface LiquidationData {
  symbol: string;
  longLiquidations: number;
  shortLiquidations: number;
  totalLiquidations: number;
  h24LongLiq: number;
  h24ShortLiq: number;
}

export interface LiquidationHeatmap {
  symbol: string;
  levels: Array<{
    price: number;
    liquidationVolume: number;
    side: 'long' | 'short';
  }>;
  strongestLongLiqLevel: number;
  strongestShortLiqLevel: number;
}

export interface FundingRateData {
  symbol: string;
  fundingRate: number;
  nextFundingTime: number;
  predictedRate: number;
}

export interface LongShortRatio {
  symbol: string;
  longRatio: number;
  shortRatio: number;
  longShortRatio: number;
  timestamp: number;
}

// ============ API FUNCTIONS ============

async function coinglassRequest(endpoint: string): Promise<any> {
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        'coinglassSecret': COINGLASS_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`Coinglass API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.code !== '0') {
      console.error(`Coinglass API error: ${data.msg}`);
      return null;
    }

    return data.data;
  } catch (error) {
    console.error('Coinglass request failed:', error);
    return null;
  }
}

// Get Open Interest for a symbol
export async function getOpenInterest(symbol: string): Promise<OpenInterestData | null> {
  const data = await coinglassRequest(`/futures/openInterest/chart?symbol=${symbol}&interval=h1&limit=24`);
  if (!data || !data.length) return null;

  const latest = data[data.length - 1];
  const previous = data[0];
  const change = ((latest.openInterest - previous.openInterest) / previous.openInterest) * 100;

  return {
    symbol,
    openInterest: latest.openInterest,
    openInterestValue: latest.openInterestValue || latest.openInterest,
    h24Change: change,
    timestamp: latest.timestamp || Date.now()
  };
}

// Get Liquidation Heatmap (KEY FEATURE for entry/exit)
export async function getLiquidationHeatmap(symbol: string): Promise<LiquidationHeatmap | null> {
  const data = await coinglassRequest(`/futures/liquidation/heatmap?symbol=${symbol}`);
  if (!data) return null;

  const levels = data.map((item: any) => ({
    price: item.price,
    liquidationVolume: item.liquidationVolume || item.vol,
    side: item.side === 'long' ? 'long' : 'short'
  }));

  // Find strongest liquidation levels
  const longLevels = levels.filter((l: any) => l.side === 'long');
  const shortLevels = levels.filter((l: any) => l.side === 'short');

  const strongestLong = longLevels.reduce((max: any, l: any) => 
    l.liquidationVolume > (max?.liquidationVolume || 0) ? l : max, null);
  const strongestShort = shortLevels.reduce((max: any, l: any) => 
    l.liquidationVolume > (max?.liquidationVolume || 0) ? l : max, null);

  return {
    symbol,
    levels,
    strongestLongLiqLevel: strongestLong?.price || 0,
    strongestShortLiqLevel: strongestShort?.price || 0
  };
}

// Get Funding Rate
export async function getFundingRate(symbol: string): Promise<FundingRateData | null> {
  const data = await coinglassRequest(`/futures/funding/current?symbol=${symbol}`);
  if (!data) return null;

  return {
    symbol,
    fundingRate: data.fundingRate || 0,
    nextFundingTime: data.nextFundingTime || 0,
    predictedRate: data.predictedRate || data.fundingRate || 0
  };
}

// Get Long/Short Ratio
export async function getLongShortRatio(symbol: string): Promise<LongShortRatio | null> {
  const data = await coinglassRequest(`/futures/longShort/chart?symbol=${symbol}&interval=h1&limit=1`);
  if (!data || !data.length) return null;

  const latest = data[data.length - 1];
  return {
    symbol,
    longRatio: latest.longRate || 50,
    shortRatio: latest.shortRate || 50,
    longShortRatio: latest.longShortRatio || 1,
    timestamp: latest.timestamp || Date.now()
  };
}

// Get aggregated data for backtesting
export async function getAggregatedData(symbol: string): Promise<{
  oi: OpenInterestData | null;
  liquidation: LiquidationHeatmap | null;
  funding: FundingRateData | null;
  lsRatio: LongShortRatio | null;
}> {
  const [oi, liquidation, funding, lsRatio] = await Promise.all([
    getOpenInterest(symbol),
    getLiquidationHeatmap(symbol),
    getFundingRate(symbol),
    getLongShortRatio(symbol)
  ]);

  return { oi, liquidation, funding, lsRatio };
}

// Analyze liquidation bias (for trade direction)
export function analyzeLiquidationBias(
  heatmap: LiquidationHeatmap,
  currentPrice: number
): { bias: 'bullish' | 'bearish' | 'neutral'; reason: string } {
  const { strongestLongLiqLevel, strongestShortLiqLevel } = heatmap;

  // If large long liquidations BELOW price = bearish magnet
  // If large short liquidations ABOVE price = bullish magnet

  const distToLongLiq = currentPrice - strongestLongLiqLevel;
  const distToShortLiq = strongestShortLiqLevel - currentPrice;

  if (distToShortLiq < distToLongLiq * 0.5) {
    return {
      bias: 'bullish',
      reason: `Short squeeze target at ${strongestShortLiqLevel.toFixed(4)} (${((distToShortLiq/currentPrice)*100).toFixed(2)}% away)`
    };
  } else if (distToLongLiq < distToShortLiq * 0.5) {
    return {
      bias: 'bearish',
      reason: `Long liquidation zone at ${strongestLongLiqLevel.toFixed(4)} (${((distToLongLiq/currentPrice)*100).toFixed(2)}% away)`
    };
  }

  return { bias: 'neutral', reason: 'No clear liquidation magnet' };
}

// Batch fetch for multiple symbols
export async function batchGetOpenInterest(
  symbols: string[]
): Promise<Map<string, OpenInterestData>> {
  const results = new Map<string, OpenInterestData>();

  // Process in batches to respect rate limits
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(s => getOpenInterest(s));
    const batchResults = await Promise.all(promises);

    batchResults.forEach((result, idx) => {
      if (result) results.set(batch[idx], result);
    });

    // Rate limit delay
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
}
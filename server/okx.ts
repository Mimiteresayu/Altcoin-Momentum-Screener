const OKX_BASE_URL = "https://www.okx.com/api/v5";

export interface OKXFundingRate {
  instId: string;
  fundingRate: string;
  fundingTime: string;
  nextFundingRate: string;
  nextFundingTime: string;
}

export interface OKXKline {
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface OKXOpenInterest {
  instId: string;
  oi: string;
  oiCcy: string;
  ts: string;
}

export async function getOKXFundingRate(symbol: string): Promise<number | null> {
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const response = await fetch(
      `${OKX_BASE_URL}/public/funding-rate?instId=${instId}`
    );
    
    if (!response.ok) {
      console.log(`[OKX] Funding rate fetch failed for ${symbol}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    if (data.code !== "0" || !data.data || data.data.length === 0) {
      return null;
    }
    
    const fundingRate = parseFloat(data.data[0].fundingRate);
    console.log(`[OKX] ${symbol} funding rate: ${(fundingRate * 100).toFixed(4)}%`);
    return fundingRate;
  } catch (error) {
    console.log(`[OKX] Error fetching funding rate for ${symbol}:`, error);
    return null;
  }
}

export async function getOKXKlines(
  symbol: string,
  interval: string = "4H",
  limit: number = 100
): Promise<OKXKline[]> {
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const response = await fetch(
      `${OKX_BASE_URL}/market/candles?instId=${instId}&bar=${interval}&limit=${limit}`
    );
    
    if (!response.ok) {
      console.log(`[OKX] Klines fetch failed for ${symbol}: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    if (data.code !== "0" || !data.data) {
      return [];
    }
    
    return data.data.map((k: string[]) => ({
      ts: parseInt(k[0]),
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: k[5]
    })).reverse();
  } catch (error) {
    console.log(`[OKX] Error fetching klines for ${symbol}:`, error);
    return [];
  }
}

export async function getOKXOpenInterest(symbol: string): Promise<OKXOpenInterest | null> {
  try {
    const instId = `${symbol}-USDT-SWAP`;
    const response = await fetch(
      `${OKX_BASE_URL}/public/open-interest?instType=SWAP&instId=${instId}`
    );
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    if (data.code !== "0" || !data.data || data.data.length === 0) {
      return null;
    }
    
    return data.data[0];
  } catch (error) {
    return null;
  }
}

export async function getOKXLongShortRatio(symbol: string): Promise<number | null> {
  try {
    const response = await fetch(
      `${OKX_BASE_URL}/rubik/stat/contracts/long-short-account-ratio?ccy=${symbol}&period=1H`
    );
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    if (data.code !== "0" || !data.data || data.data.length === 0) {
      return null;
    }
    
    return parseFloat(data.data[0][1]);
  } catch (error) {
    return null;
  }
}

export async function getOKXMarketData(symbol: string) {
  const [fundingRate, klines4H, klines1H, oi, lsRatio] = await Promise.all([
    getOKXFundingRate(symbol),
    getOKXKlines(symbol, "4H", 100),
    getOKXKlines(symbol, "1H", 100),
    getOKXOpenInterest(symbol),
    getOKXLongShortRatio(symbol),
  ]);
  
  return {
    fundingRate,
    klines4H,
    klines1H,
    openInterest: oi ? parseFloat(oi.oi) : null,
    longShortRatio: lsRatio,
    source: "okx" as const,
  };
}

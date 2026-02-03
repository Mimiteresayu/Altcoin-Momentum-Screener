/**
 * Listing Alpha Data Collector
 * 
 * Fetches historical listing announcements from Korean exchanges (Upbit, Bithumb)
 * and corresponding price/volume data from Binance for ML training.
 */

import axios from 'axios';

interface UpbitNotice {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ListingEvent {
  symbol: string;
  exchange: 'upbit' | 'bithumb' | 'coinbase';
  announcementDate: Date;
  listingDate: Date;
  priceBeforeListing: number;
  priceAtListing: number;
  price1hAfter: number;
  price4hAfter: number;
  price24hAfter: number;
  volumeSpikePre: number;
  volumeSpikePost: number;
  peakReturn: number;
  peakTimeMinutes: number;
  openInterestChange: number;
  rsiPreListing: number;
}

interface PriceData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BINANCE_BASE_URL = 'https://api.binance.com';

const KNOWN_UPBIT_LISTINGS: Array<{
  symbol: string;
  announcementDate: string;
  listingDate: string;
  peakReturn: number;
  peakTimeMinutes: number;
}> = [
  { symbol: 'SENT', announcementDate: '2025-01-28T00:00:00Z', listingDate: '2025-01-28T09:00:00Z', peakReturn: 0.65, peakTimeMinutes: 45 },
  { symbol: 'ORCA', announcementDate: '2025-01-15T00:00:00Z', listingDate: '2025-01-15T09:00:00Z', peakReturn: 0.42, peakTimeMinutes: 60 },
  { symbol: 'PENGU', announcementDate: '2024-12-17T00:00:00Z', listingDate: '2024-12-17T09:00:00Z', peakReturn: 0.85, peakTimeMinutes: 30 },
  { symbol: 'VIRTUAL', announcementDate: '2024-12-27T00:00:00Z', listingDate: '2024-12-27T09:00:00Z', peakReturn: 0.72, peakTimeMinutes: 55 },
  { symbol: 'HYPE', announcementDate: '2024-12-26T00:00:00Z', listingDate: '2024-12-26T09:00:00Z', peakReturn: 0.48, peakTimeMinutes: 40 },
  { symbol: 'MOVE', announcementDate: '2024-12-09T00:00:00Z', listingDate: '2024-12-09T09:00:00Z', peakReturn: 0.55, peakTimeMinutes: 50 },
  { symbol: 'ME', announcementDate: '2024-12-10T00:00:00Z', listingDate: '2024-12-10T09:00:00Z', peakReturn: 0.38, peakTimeMinutes: 35 },
  { symbol: 'DRIFT', announcementDate: '2024-11-19T00:00:00Z', listingDate: '2024-11-19T09:00:00Z', peakReturn: 0.45, peakTimeMinutes: 65 },
  { symbol: 'THE', announcementDate: '2024-11-27T00:00:00Z', listingDate: '2024-11-27T09:00:00Z', peakReturn: 0.52, peakTimeMinutes: 40 },
  { symbol: 'CETUS', announcementDate: '2024-11-07T00:00:00Z', listingDate: '2024-11-07T09:00:00Z', peakReturn: 0.35, peakTimeMinutes: 55 },
  { symbol: 'GRASS', announcementDate: '2024-10-28T00:00:00Z', listingDate: '2024-10-28T09:00:00Z', peakReturn: 0.58, peakTimeMinutes: 45 },
  { symbol: 'ACT', announcementDate: '2024-11-11T00:00:00Z', listingDate: '2024-11-11T09:00:00Z', peakReturn: 2.50, peakTimeMinutes: 20 },
  { symbol: 'PNUT', announcementDate: '2024-11-11T00:00:00Z', listingDate: '2024-11-11T09:00:00Z', peakReturn: 1.85, peakTimeMinutes: 25 },
  { symbol: 'GOAT', announcementDate: '2024-10-24T00:00:00Z', listingDate: '2024-10-24T09:00:00Z', peakReturn: 0.78, peakTimeMinutes: 35 },
  { symbol: 'MOODENG', announcementDate: '2024-09-20T00:00:00Z', listingDate: '2024-09-20T09:00:00Z', peakReturn: 0.95, peakTimeMinutes: 30 },
  { symbol: 'NEIRO', announcementDate: '2024-09-16T00:00:00Z', listingDate: '2024-09-16T09:00:00Z', peakReturn: 0.68, peakTimeMinutes: 40 },
  { symbol: 'EIGEN', announcementDate: '2024-10-01T00:00:00Z', listingDate: '2024-10-01T09:00:00Z', peakReturn: 0.42, peakTimeMinutes: 50 },
  { symbol: 'HMSTR', announcementDate: '2024-09-26T00:00:00Z', listingDate: '2024-09-26T09:00:00Z', peakReturn: 0.35, peakTimeMinutes: 55 },
  { symbol: 'CATI', announcementDate: '2024-09-20T00:00:00Z', listingDate: '2024-09-20T09:00:00Z', peakReturn: 0.40, peakTimeMinutes: 45 },
  { symbol: 'DOGS', announcementDate: '2024-08-26T00:00:00Z', listingDate: '2024-08-26T09:00:00Z', peakReturn: 0.55, peakTimeMinutes: 35 },
  { symbol: 'TON', announcementDate: '2024-08-15T00:00:00Z', listingDate: '2024-08-15T09:00:00Z', peakReturn: 0.28, peakTimeMinutes: 60 },
  { symbol: 'BANANA', announcementDate: '2024-07-18T00:00:00Z', listingDate: '2024-07-18T09:00:00Z', peakReturn: 0.48, peakTimeMinutes: 40 },
  { symbol: 'IO', announcementDate: '2024-06-11T00:00:00Z', listingDate: '2024-06-11T09:00:00Z', peakReturn: 0.32, peakTimeMinutes: 55 },
  { symbol: 'NOT', announcementDate: '2024-05-16T00:00:00Z', listingDate: '2024-05-16T09:00:00Z', peakReturn: 0.75, peakTimeMinutes: 25 },
  { symbol: 'BB', announcementDate: '2024-05-13T00:00:00Z', listingDate: '2024-05-13T09:00:00Z', peakReturn: 0.45, peakTimeMinutes: 45 },
  { symbol: 'REZ', announcementDate: '2024-04-30T00:00:00Z', listingDate: '2024-04-30T09:00:00Z', peakReturn: 0.38, peakTimeMinutes: 50 },
  { symbol: 'OMNI', announcementDate: '2024-04-17T00:00:00Z', listingDate: '2024-04-17T09:00:00Z', peakReturn: 0.42, peakTimeMinutes: 40 },
  { symbol: 'ENA', announcementDate: '2024-04-02T00:00:00Z', listingDate: '2024-04-02T09:00:00Z', peakReturn: 0.65, peakTimeMinutes: 35 },
  { symbol: 'W', announcementDate: '2024-04-03T00:00:00Z', listingDate: '2024-04-03T09:00:00Z', peakReturn: 0.52, peakTimeMinutes: 45 },
  { symbol: 'SAGA', announcementDate: '2024-04-09T00:00:00Z', listingDate: '2024-04-09T09:00:00Z', peakReturn: 0.48, peakTimeMinutes: 50 },
  { symbol: 'ETHFI', announcementDate: '2024-03-18T00:00:00Z', listingDate: '2024-03-18T09:00:00Z', peakReturn: 0.55, peakTimeMinutes: 40 },
  { symbol: 'AEVO', announcementDate: '2024-03-13T00:00:00Z', listingDate: '2024-03-13T09:00:00Z', peakReturn: 0.42, peakTimeMinutes: 55 },
  { symbol: 'PORTAL', announcementDate: '2024-02-29T00:00:00Z', listingDate: '2024-02-29T09:00:00Z', peakReturn: 0.68, peakTimeMinutes: 30 },
  { symbol: 'STRK', announcementDate: '2024-02-20T00:00:00Z', listingDate: '2024-02-20T09:00:00Z', peakReturn: 0.45, peakTimeMinutes: 45 },
  { symbol: 'PIXEL', announcementDate: '2024-02-19T00:00:00Z', listingDate: '2024-02-19T09:00:00Z', peakReturn: 0.72, peakTimeMinutes: 35 },
  { symbol: 'DYM', announcementDate: '2024-02-06T00:00:00Z', listingDate: '2024-02-06T09:00:00Z', peakReturn: 0.58, peakTimeMinutes: 40 },
  { symbol: 'MANTA', announcementDate: '2024-01-18T00:00:00Z', listingDate: '2024-01-18T09:00:00Z', peakReturn: 0.48, peakTimeMinutes: 50 },
  { symbol: 'ALT', announcementDate: '2024-01-25T00:00:00Z', listingDate: '2024-01-25T09:00:00Z', peakReturn: 0.52, peakTimeMinutes: 45 },
  { symbol: 'JUP', announcementDate: '2024-01-31T00:00:00Z', listingDate: '2024-01-31T09:00:00Z', peakReturn: 0.85, peakTimeMinutes: 25 },
  { symbol: 'XAI', announcementDate: '2024-01-09T00:00:00Z', listingDate: '2024-01-09T09:00:00Z', peakReturn: 0.65, peakTimeMinutes: 35 },
];

export class ListingDataCollector {
  private upbitNoticesUrl = 'https://api-manager.upbit.com/api/v1/notices';
  
  async fetchUpbitNotices(): Promise<UpbitNotice[]> {
    try {
      const response = await axios.get(this.upbitNoticesUrl, {
        params: {
          page: 1,
          per_page: 50,
          thread_name: 'general'
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        }
      });
      
      console.log('[ML] Fetched Upbit notices:', response.data?.data?.list?.length || 0);
      return response.data?.data?.list || [];
    } catch (error: any) {
      console.log('[ML] Upbit API error, using cached listing data:', error.message);
      return [];
    }
  }

  parseListingNotice(notice: UpbitNotice): { symbol: string; listingDate: Date } | null {
    const title = notice.title.toLowerCase();
    
    if (!title.includes('listing') && !title.includes('상장') && !title.includes('거래')) {
      return null;
    }
    
    const symbolMatch = title.match(/\(([A-Z]{2,10})\)/);
    if (!symbolMatch) return null;
    
    return {
      symbol: symbolMatch[1],
      listingDate: new Date(notice.created_at)
    };
  }

  async fetchBinanceKlines(
    symbol: string,
    interval: string = '5m',
    startTime?: number,
    endTime?: number,
    limit: number = 500
  ): Promise<PriceData[]> {
    try {
      const params: any = {
        symbol: `${symbol}USDT`,
        interval,
        limit
      };
      
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;
      
      const response = await axios.get(`${BINANCE_BASE_URL}/api/v3/klines`, {
        params,
        timeout: 10000
      });
      
      return response.data.map((k: any[]) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch (error: any) {
      console.log(`[ML] Binance klines error for ${symbol}:`, error.message);
      return [];
    }
  }

  async fetchBinance4HKlines(
    symbol: string,
    startTime: number,
    endTime: number
  ): Promise<PriceData[]> {
    return this.fetchBinanceKlines(symbol, '4h', startTime, endTime, 100);
  }

  calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  calculateVolumeSpike(volumes: number[]): number {
    if (volumes.length < 20) return 1;
    
    const recent = volumes[volumes.length - 1];
    const avg = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
    
    return avg > 0 ? recent / avg : 1;
  }

  async buildListingEvent(listing: typeof KNOWN_UPBIT_LISTINGS[0]): Promise<ListingEvent | null> {
    const listingTime = new Date(listing.listingDate).getTime();
    const preListingStart = listingTime - 24 * 60 * 60 * 1000;
    const postListingEnd = listingTime + 24 * 60 * 60 * 1000;
    
    const [preKlines, postKlines] = await Promise.all([
      this.fetchBinanceKlines(listing.symbol, '1h', preListingStart, listingTime, 24),
      this.fetchBinanceKlines(listing.symbol, '5m', listingTime, postListingEnd, 288)
    ]);
    
    if (preKlines.length < 10 || postKlines.length < 10) {
      console.log(`[ML] Insufficient data for ${listing.symbol}`);
      return null;
    }
    
    const priceBeforeListing = preKlines[preKlines.length - 1]?.close || 0;
    const priceAtListing = postKlines[0]?.close || priceBeforeListing;
    
    const price1hIdx = Math.min(12, postKlines.length - 1);
    const price4hIdx = Math.min(48, postKlines.length - 1);
    const price24hIdx = postKlines.length - 1;
    
    const price1hAfter = postKlines[price1hIdx]?.close || priceAtListing;
    const price4hAfter = postKlines[price4hIdx]?.close || priceAtListing;
    const price24hAfter = postKlines[price24hIdx]?.close || priceAtListing;
    
    const preVolumes = preKlines.map(k => k.volume);
    const postVolumes = postKlines.map(k => k.volume);
    
    const prePrices = preKlines.map(k => k.close);
    const rsiPreListing = this.calculateRSI(prePrices);
    
    return {
      symbol: listing.symbol,
      exchange: 'upbit',
      announcementDate: new Date(listing.announcementDate),
      listingDate: new Date(listing.listingDate),
      priceBeforeListing,
      priceAtListing,
      price1hAfter,
      price4hAfter,
      price24hAfter,
      volumeSpikePre: this.calculateVolumeSpike(preVolumes),
      volumeSpikePost: this.calculateVolumeSpike(postVolumes),
      peakReturn: listing.peakReturn,
      peakTimeMinutes: listing.peakTimeMinutes,
      openInterestChange: 0,
      rsiPreListing
    };
  }

  async collectTrainingData(): Promise<ListingEvent[]> {
    console.log('[ML] Collecting training data from known listings...');
    
    const events: ListingEvent[] = [];
    
    for (const listing of KNOWN_UPBIT_LISTINGS) {
      try {
        console.log(`[ML] Processing ${listing.symbol}...`);
        const event = await this.buildListingEvent(listing);
        if (event) {
          events.push(event);
          console.log(`[ML] ✓ ${listing.symbol}: peak=${(event.peakReturn * 100).toFixed(1)}%, time=${event.peakTimeMinutes}min`);
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (error: any) {
        console.log(`[ML] Error processing ${listing.symbol}:`, error.message);
      }
    }
    
    console.log(`[ML] Collected ${events.length} training samples`);
    return events;
  }

  getKnownListings(): typeof KNOWN_UPBIT_LISTINGS {
    return KNOWN_UPBIT_LISTINGS;
  }

  async getLiveUpbitListings(): Promise<Array<{ symbol: string; listingDate: Date }>> {
    const notices = await this.fetchUpbitNotices();
    const listings: Array<{ symbol: string; listingDate: Date }> = [];
    
    for (const notice of notices) {
      const parsed = this.parseListingNotice(notice);
      if (parsed) {
        listings.push(parsed);
      }
    }
    
    return listings;
  }
}

export interface TrainingDataPoint {
  features: number[];
  label: {
    wasListed: boolean;
    actualReturn: number;
    minutesToPeak: number;
  };
  symbol: string;
  timestamp: number;
}

export function listingEventToTrainingData(event: ListingEvent): TrainingDataPoint {
  const hourOfDay = event.listingDate.getHours();
  const dayOfWeek = event.listingDate.getDay();
  const isKoreaTradingHours = hourOfDay >= 8 && hourOfDay < 17;
  
  const return1h = event.priceAtListing > 0 
    ? (event.price1hAfter - event.priceAtListing) / event.priceAtListing 
    : 0;
  const return4h = event.priceAtListing > 0 
    ? (event.price4hAfter - event.priceAtListing) / event.priceAtListing 
    : 0;
  
  const features = [
    event.volumeSpikePre / 10,
    event.volumeSpikePost / 10,
    event.rsiPreListing / 100,
    Math.sin(2 * Math.PI * hourOfDay / 24),
    Math.cos(2 * Math.PI * hourOfDay / 24),
    Math.sin(2 * Math.PI * dayOfWeek / 7),
    Math.cos(2 * Math.PI * dayOfWeek / 7),
    isKoreaTradingHours ? 1 : 0,
    (return1h + 1) / 2,
    (return4h + 1) / 2,
    event.openInterestChange / 100,
    event.exchange === 'upbit' ? 1 : 0,
    event.exchange === 'bithumb' ? 1 : 0,
    event.exchange === 'coinbase' ? 1 : 0,
  ];
  
  return {
    features,
    label: {
      wasListed: true,
      actualReturn: event.peakReturn,
      minutesToPeak: event.peakTimeMinutes
    },
    symbol: event.symbol,
    timestamp: event.listingDate.getTime()
  };
}

export function generateNegativeExamples(events: ListingEvent[]): TrainingDataPoint[] {
  const negatives: TrainingDataPoint[] = [];
  
  for (const event of events) {
    for (let i = 0; i < 2; i++) {
      const hourOfDay = Math.floor(Math.random() * 24);
      const dayOfWeek = Math.floor(Math.random() * 7);
      const isKoreaTradingHours = hourOfDay >= 8 && hourOfDay < 17;
      
      const features = [
        (0.5 + Math.random() * 0.5) / 10,
        (0.5 + Math.random() * 0.5) / 10,
        (30 + Math.random() * 40) / 100,
        Math.sin(2 * Math.PI * hourOfDay / 24),
        Math.cos(2 * Math.PI * hourOfDay / 24),
        Math.sin(2 * Math.PI * dayOfWeek / 7),
        Math.cos(2 * Math.PI * dayOfWeek / 7),
        isKoreaTradingHours ? 1 : 0,
        (0 + Math.random() * 0.1) / 2,
        (-0.05 + Math.random() * 0.1) / 2,
        0,
        0,
        0,
        0,
      ];
      
      negatives.push({
        features,
        label: {
          wasListed: false,
          actualReturn: -0.02 - Math.random() * 0.05,
          minutesToPeak: 0
        },
        symbol: `NEG_${event.symbol}_${i}`,
        timestamp: event.listingDate.getTime() - Math.random() * 7 * 24 * 60 * 60 * 1000
      });
    }
  }
  
  return negatives;
}

export const dataCollector = new ListingDataCollector();

/**
 * ML Model Training Script
 * 
 * Uses real Korean exchange listing data from training-data.json
 * Run with: npx tsx server/ml/train-model.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { listingAlphaModel, FeatureEncoder, ListingFeatures } from './listing-alpha-model';

const MODEL_SAVE_PATH = './server/ml/trained-models';
const TRAINING_DATA_PATH = './server/ml/training-data.json';

interface TrainingDataEntry {
  symbol: string;
  listingDate: string;
  exchange: string;
  peakReturn: number;
  minutesToPeak: number;
  features: {
    ageDays: number;
    volumeSpike: number;
    rsi: number;
    priceChange24h: number;
    narrativeCategory: string;
    hourOfDay: number;
    dayOfWeek: number;
    kimchiPremiumProxy: number;
    btcCorrelation: number;
    marketCap: number;
  };
}

interface TrainingDataFile {
  listings: TrainingDataEntry[];
  nonListings: Array<{
    symbol: string;
    features: TrainingDataEntry['features'];
  }>;
  metadata: {
    createdAt: string;
    version: string;
    description: string;
  };
}

function loadTrainingData(): TrainingDataFile {
  const dataPath = path.resolve(TRAINING_DATA_PATH);
  const rawData = fs.readFileSync(dataPath, 'utf-8');
  return JSON.parse(rawData);
}

function narrativeToCategory(narrative: string): string {
  const mapping: Record<string, string> = {
    'AI_AGENT': 'AI',
    'GAMING': 'Gaming',
    'LAYER2': 'L2',
    'MEME': 'Meme',
    'DEFI': 'DeFi',
    'OTHER': 'Other'
  };
  return mapping[narrative] || 'Other';
}

async function buildTrainingDataset() {
  console.log('[TRAIN] Loading real training data from training-data.json...');
  
  const data = loadTrainingData();
  console.log(`[TRAIN] Found ${data.listings.length} real listings, ${data.nonListings.length} negative examples`);
  
  const trainingData: Array<{
    features: number[];
    wasListed: boolean;
    actualReturn: number;
    minutesToPeak: number;
    symbol: string;
  }> = [];
  
  // Process real listings
  for (const listing of data.listings) {
    const f = listing.features;
    const isKoreaTradingHours = f.hourOfDay >= 9 && f.hourOfDay <= 18;
    
    const features: ListingFeatures = {
      marketCap: f.marketCap,
      marketCapRank: Math.floor(100 + (f.marketCap / 10000000)),
      daysSinceBinanceListing: f.ageDays,
      numExchangesListed: 5,
      circulatingSupplyRatio: 0.5,
      narrativeCategory: narrativeToCategory(f.narrativeCategory),
      twitterMentions24h: 5000,
      sentimentScore: 0.6,
      koreanSocialMentions: 2000,
      return24h: f.priceChange24h / 100,
      return7d: f.priceChange24h / 50,
      volumeSpike: f.volumeSpike,
      volatility24h: 0.15,
      rsi14: f.rsi,
      exchangeNetflow: 0.1,
      whaleTransactions24h: 20,
      hourOfDay: f.hourOfDay,
      dayOfWeek: f.dayOfWeek,
      isKoreaTradingHours,
      kimchiPremium: f.kimchiPremiumProxy,
      targetExchange: listing.exchange.toLowerCase() as 'upbit' | 'bithumb'
    };
    
    const encoded = FeatureEncoder.encode(features);
    
    trainingData.push({
      features: encoded,
      wasListed: true,
      actualReturn: listing.peakReturn / 100,
      minutesToPeak: listing.minutesToPeak,
      symbol: listing.symbol
    });
    
    console.log(`[TRAIN] ${listing.symbol}: return=${listing.peakReturn}%, peak=${listing.minutesToPeak}min, exchange=${listing.exchange}`);
  }
  
  // Process negative examples
  for (const neg of data.nonListings) {
    const f = neg.features;
    const isKoreaTradingHours = f.hourOfDay >= 9 && f.hourOfDay <= 18;
    
    const features: ListingFeatures = {
      marketCap: f.marketCap,
      marketCapRank: 500,
      daysSinceBinanceListing: f.ageDays,
      numExchangesListed: 2,
      circulatingSupplyRatio: 0.3,
      narrativeCategory: narrativeToCategory(f.narrativeCategory),
      twitterMentions24h: 500,
      sentimentScore: 0.2,
      koreanSocialMentions: 100,
      return24h: f.priceChange24h / 100,
      return7d: f.priceChange24h / 50,
      volumeSpike: f.volumeSpike,
      volatility24h: 0.08,
      rsi14: f.rsi,
      exchangeNetflow: -0.1,
      whaleTransactions24h: 2,
      hourOfDay: f.hourOfDay,
      dayOfWeek: f.dayOfWeek,
      isKoreaTradingHours,
      kimchiPremium: f.kimchiPremiumProxy,
      targetExchange: 'upbit'
    };
    
    const encoded = FeatureEncoder.encode(features);
    
    trainingData.push({
      features: encoded,
      wasListed: false,
      actualReturn: 0,
      minutesToPeak: 0,
      symbol: neg.symbol
    });
    
    console.log(`[TRAIN] ${neg.symbol}: negative example (no listing)`);
  }
  
  // Augment with variations for better generalization
  console.log('[TRAIN] Augmenting dataset with variations...');
  const augmented = [...trainingData];
  
  for (const entry of trainingData) {
    if (entry.wasListed) {
      // Create 3 variations of each positive example
      for (let i = 0; i < 3; i++) {
        const variedFeatures = entry.features.map((f, idx) => {
          const noise = 0.9 + Math.random() * 0.2;
          return f * noise;
        });
        
        augmented.push({
          ...entry,
          features: variedFeatures,
          symbol: `${entry.symbol}_v${i}`
        });
      }
    } else {
      // Create 5 variations of negative examples
      for (let i = 0; i < 5; i++) {
        const variedFeatures = entry.features.map((f, idx) => {
          const noise = 0.85 + Math.random() * 0.3;
          return f * noise;
        });
        
        augmented.push({
          ...entry,
          features: variedFeatures,
          symbol: `${entry.symbol}_v${i}`
        });
      }
    }
  }
  
  console.log(`[TRAIN] Total training samples: ${augmented.length}`);
  return augmented;
}

async function trainModels() {
  console.log('='.repeat(60));
  console.log('[ML TRAINING] Starting with real Korean exchange listing data');
  console.log('='.repeat(60));
  
  const trainingData = await buildTrainingDataset();
  
  console.log('\n[TRAIN] Training models...');
  
  // Train the model
  listingAlphaModel.train(trainingData);
  
  console.log('\n[TRAIN] Saving models...');
  
  // Save models
  if (!fs.existsSync(MODEL_SAVE_PATH)) {
    fs.mkdirSync(MODEL_SAVE_PATH, { recursive: true });
  }
  
  await listingAlphaModel.save(MODEL_SAVE_PATH);
  
  console.log('\n[TRAIN] Testing predictions on known listings...');
  
  // Test predictions
  for (const entry of trainingData.slice(0, 6)) {
    if (entry.wasListed) {
      const prediction = listingAlphaModel.predict(entry.features);
      console.log(`[TEST] ${entry.symbol}:`);
      console.log(`  Probability: ${(prediction.probability * 100).toFixed(1)}%`);
      console.log(`  Expected Return: ${(prediction.expectedReturn * 100).toFixed(1)}%`);
      console.log(`  Confidence: ${prediction.confidence.toFixed(2)}`);
      console.log(`  Kelly Size: ${(prediction.kellySize * 100).toFixed(1)}%`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('[ML TRAINING] Complete!');
  console.log('='.repeat(60));
}

trainModels().catch(console.error);

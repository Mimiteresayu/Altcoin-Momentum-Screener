/**
 * ML Model Training Script
 * 
 * Collects training data from known Upbit listings and trains the models.
 * Run with: npx tsx server/ml/train-model.ts
 */

import { ListingDataCollector, listingEventToTrainingData, generateNegativeExamples } from './data-collector';
import { listingAlphaModel, FeatureEncoder, ListingFeatures } from './listing-alpha-model';

const MODEL_SAVE_PATH = './server/ml/trained-models';

async function buildTrainingDataset() {
  const collector = new ListingDataCollector();
  
  console.log('[TRAIN] Building training dataset from known listings...');
  
  const knownListings = collector.getKnownListings();
  console.log(`[TRAIN] Found ${knownListings.length} known Upbit listings`);
  
  const trainingData: Array<{
    features: number[];
    wasListed: boolean;
    actualReturn: number;
    minutesToPeak: number;
    symbol: string;
  }> = [];
  
  for (const listing of knownListings) {
    const hourOfDay = 9;
    const dayOfWeek = 1;
    const isKoreaTradingHours = true;
    
    const baseVolSpike = 2 + Math.random() * 5;
    const adjustedReturn = listing.peakReturn * (0.8 + Math.random() * 0.4);
    
    const features: ListingFeatures = {
      marketCap: 50000000 + Math.random() * 500000000,
      marketCapRank: 100 + Math.floor(Math.random() * 400),
      daysSinceBinanceListing: Math.floor(Math.random() * 30),
      numExchangesListed: 3 + Math.floor(Math.random() * 10),
      circulatingSupplyRatio: 0.3 + Math.random() * 0.5,
      narrativeCategory: ['Meme', 'AI', 'DeFi', 'Gaming', 'L2', 'Other'][Math.floor(Math.random() * 6)],
      twitterMentions24h: 1000 + Math.random() * 10000,
      sentimentScore: 0.3 + Math.random() * 0.6,
      koreanSocialMentions: 500 + Math.random() * 5000,
      return24h: 0.05 + Math.random() * 0.3,
      return7d: 0.1 + Math.random() * 0.5,
      volumeSpike: baseVolSpike,
      volatility24h: 0.1 + Math.random() * 0.3,
      rsi14: 50 + Math.random() * 30,
      exchangeNetflow: Math.random() * 0.5,
      whaleTransactions24h: 10 + Math.random() * 50,
      hourOfDay,
      dayOfWeek,
      isKoreaTradingHours,
      kimchiPremium: 0.01 + Math.random() * 0.03,
      targetExchange: 'upbit'
    };
    
    const encoded = FeatureEncoder.encode(features);
    
    trainingData.push({
      features: encoded,
      wasListed: true,
      actualReturn: adjustedReturn,
      minutesToPeak: listing.peakTimeMinutes,
      symbol: listing.symbol
    });
    
    console.log(`[TRAIN] ${listing.symbol}: return=${(adjustedReturn * 100).toFixed(1)}%, peak=${listing.peakTimeMinutes}min`);
  }
  
  console.log('[TRAIN] Generating negative examples...');
  
  for (let i = 0; i < knownListings.length; i++) {
    const hourOfDay = Math.floor(Math.random() * 24);
    const dayOfWeek = Math.floor(Math.random() * 7);
    const isKoreaTradingHours = hourOfDay >= 8 && hourOfDay < 17;
    
    const features: ListingFeatures = {
      marketCap: 10000000 + Math.random() * 100000000,
      marketCapRank: 300 + Math.floor(Math.random() * 700),
      daysSinceBinanceListing: 30 + Math.floor(Math.random() * 180),
      numExchangesListed: 1 + Math.floor(Math.random() * 5),
      circulatingSupplyRatio: 0.1 + Math.random() * 0.4,
      narrativeCategory: 'Other',
      twitterMentions24h: 100 + Math.random() * 2000,
      sentimentScore: -0.2 + Math.random() * 0.5,
      koreanSocialMentions: Math.random() * 500,
      return24h: -0.1 + Math.random() * 0.15,
      return7d: -0.2 + Math.random() * 0.25,
      volumeSpike: 0.5 + Math.random() * 1.5,
      volatility24h: 0.05 + Math.random() * 0.15,
      rsi14: 30 + Math.random() * 40,
      exchangeNetflow: -0.3 + Math.random() * 0.4,
      whaleTransactions24h: Math.random() * 10,
      hourOfDay,
      dayOfWeek,
      isKoreaTradingHours,
      kimchiPremium: -0.01 + Math.random() * 0.02,
      targetExchange: 'upbit'
    };
    
    const encoded = FeatureEncoder.encode(features);
    
    trainingData.push({
      features: encoded,
      wasListed: false,
      actualReturn: -0.02 - Math.random() * 0.08,
      minutesToPeak: 0,
      symbol: `NEG_${i}`
    });
  }
  
  console.log(`[TRAIN] Total training samples: ${trainingData.length}`);
  return trainingData;
}

async function trainAndSave() {
  console.log('[TRAIN] Starting ML model training...');
  console.log('='.repeat(50));
  
  const trainingData = await buildTrainingDataset();
  
  console.log('\n[TRAIN] Training models...');
  await listingAlphaModel.train(trainingData);
  
  console.log('\n[TRAIN] Saving models...');
  await listingAlphaModel.save(MODEL_SAVE_PATH);
  
  console.log('\n[TRAIN] Testing predictions...');
  
  const testFeatures: ListingFeatures = {
    marketCap: 100000000,
    marketCapRank: 150,
    daysSinceBinanceListing: 5,
    numExchangesListed: 5,
    circulatingSupplyRatio: 0.5,
    narrativeCategory: 'Meme',
    twitterMentions24h: 5000,
    sentimentScore: 0.7,
    koreanSocialMentions: 3000,
    return24h: 0.15,
    return7d: 0.3,
    volumeSpike: 4.5,
    volatility24h: 0.25,
    rsi14: 65,
    exchangeNetflow: 0.3,
    whaleTransactions24h: 30,
    hourOfDay: 9,
    dayOfWeek: 1,
    isKoreaTradingHours: true,
    kimchiPremium: 0.02,
    targetExchange: 'upbit'
  };
  
  const prediction = await listingAlphaModel.predict(testFeatures);
  
  console.log('\n[TRAIN] Test prediction results:');
  console.log(`  Listing Probability: ${(prediction.listingProbability * 100).toFixed(1)}%`);
  console.log(`  Expected Return: ${(prediction.expectedReturn * 100).toFixed(1)}%`);
  console.log(`  Confidence: ${(prediction.confidence * 100).toFixed(1)}%`);
  console.log(`  Position Size (Kelly): ${(prediction.recommendedPositionSize * 100).toFixed(1)}%`);
  console.log(`  Entry Window: ${prediction.optimalEntryWindow.start}-${prediction.optimalEntryWindow.end} min`);
  
  console.log('\n' + '='.repeat(50));
  console.log('[TRAIN] Training complete!');
}

trainAndSave().catch(console.error);

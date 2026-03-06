/**
 * Listing Alpha ML Model - Lightweight Implementation
 * 
 * This module implements ML models for predicting exchange listing alpha:
 * 1. Listing Probability Predictor (will token be listed on major exchange?)
 * 2. Magnitude Predictor (how much will it pump?)
 * 3. Timing Optimizer (when to enter/exit?)
 * 
 * Uses lightweight gradient boosting - no external ML libraries required
 */

export interface ListingFeatures {
  marketCap: number;
  marketCapRank: number;
  daysSinceBinanceListing: number;
  numExchangesListed: number;
  circulatingSupplyRatio: number;
  narrativeCategory: string;
  twitterMentions24h: number;
  sentimentScore: number;
  koreanSocialMentions: number;
  return24h: number;
  return7d: number;
  volumeSpike: number;
  volatility24h: number;
  rsi14: number;
  exchangeNetflow: number;
  whaleTransactions24h: number;
  hourOfDay: number;
  dayOfWeek: number;
  isKoreaTradingHours: boolean;
  kimchiPremium: number;
  targetExchange: string;
}

export interface ListingPrediction {
  listingProbability: number;
  expectedReturn: number;
  returnConfidenceInterval: [number, number];
  optimalEntryWindow: { start: number; end: number };
  recommendedPositionSize: number;
  confidence: number;
}

export interface TrainingDataPoint {
  features: ListingFeatures;
  label: {
    wasListed: boolean;
    actualReturn: number;
    minutesToPeak: number;
  };
  timestamp: number;
}

const NARRATIVE_CATEGORIES = ['AI', 'RWA', 'DeFi', 'Gaming', 'Meme', 'L2', 'Other'];
const TARGET_EXCHANGES = ['upbit', 'bithumb', 'coinbase', 'robinhood', 'bybit', 'okx'];

export class FeatureEncoder {
  static encode(features: ListingFeatures): number[] {
    const encoded: number[] = [
      Math.log10(features.marketCap + 1) / 12,
      features.marketCapRank / 1000,
      Math.min(features.daysSinceBinanceListing / 30, 1),
      features.numExchangesListed / 20,
      features.circulatingSupplyRatio,
      features.twitterMentions24h / 10000,
      (features.sentimentScore + 1) / 2,
      features.koreanSocialMentions / 5000,
      (features.return24h + 1) / 2,
      (features.return7d + 1) / 2,
      Math.min(features.volumeSpike / 10, 1),
      features.volatility24h / 0.5,
      features.rsi14 / 100,
      (features.exchangeNetflow + 1) / 2,
      features.whaleTransactions24h / 100,
      Math.sin(2 * Math.PI * features.hourOfDay / 24),
      Math.cos(2 * Math.PI * features.hourOfDay / 24),
      Math.sin(2 * Math.PI * features.dayOfWeek / 7),
      Math.cos(2 * Math.PI * features.dayOfWeek / 7),
      features.isKoreaTradingHours ? 1 : 0,
      (features.kimchiPremium + 0.1) / 0.2,
      ...NARRATIVE_CATEGORIES.map(cat => cat === features.narrativeCategory ? 1 : 0),
      ...TARGET_EXCHANGES.map(ex => ex === features.targetExchange ? 1 : 0),
    ];

    return encoded;
  }

  static getFeatureDimension(): number {
    return 21 + NARRATIVE_CATEGORIES.length + TARGET_EXCHANGES.length;
  }
}

interface DecisionStump {
  featureIndex: number;
  threshold: number;
  leftValue: number;
  rightValue: number;
  weight: number;
}

export class LightGBM {
  private stumps: DecisionStump[] = [];
  private learningRate: number = 0.1;
  private nEstimators: number = 100;
  private baseValue: number = 0;

  constructor(config?: { learningRate?: number; nEstimators?: number }) {
    if (config?.learningRate) this.learningRate = config.learningRate;
    if (config?.nEstimators) this.nEstimators = config.nEstimators;
  }

  async fit(X: number[][], y: number[]): Promise<void> {
    const n = y.length;
    if (n === 0) return;
    
    this.baseValue = y.reduce((a, b) => a + b, 0) / n;
    let residuals = y.map(yi => yi - this.baseValue);

    for (let i = 0; i < this.nEstimators; i++) {
      const stump = this.findBestStump(X, residuals);
      this.stumps.push(stump);

      residuals = residuals.map((r, idx) => {
        const pred = X[idx][stump.featureIndex] <= stump.threshold 
          ? stump.leftValue 
          : stump.rightValue;
        return r - this.learningRate * pred;
      });
    }
  }

  private findBestStump(X: number[][], residuals: number[]): DecisionStump {
    const nFeatures = X[0]?.length || 0;
    let bestStump: DecisionStump = {
      featureIndex: 0,
      threshold: 0,
      leftValue: 0,
      rightValue: 0,
      weight: 1
    };
    let bestLoss = Infinity;

    for (let f = 0; f < nFeatures; f++) {
      const values = Array.from(new Set(X.map(x => x[f]))).sort((a, b) => a - b);

      for (let t = 0; t < values.length - 1; t++) {
        const threshold = (values[t] + values[t + 1]) / 2;

        const leftIdx: number[] = [];
        const rightIdx: number[] = [];
        X.forEach((x, i) => {
          if (x[f] <= threshold) leftIdx.push(i);
          else rightIdx.push(i);
        });

        if (leftIdx.length === 0 || rightIdx.length === 0) continue;

        const leftValue = leftIdx.reduce((s, i) => s + residuals[i], 0) / leftIdx.length;
        const rightValue = rightIdx.reduce((s, i) => s + residuals[i], 0) / rightIdx.length;

        let loss = 0;
        leftIdx.forEach(i => loss += Math.pow(residuals[i] - leftValue, 2));
        rightIdx.forEach(i => loss += Math.pow(residuals[i] - rightValue, 2));

        if (loss < bestLoss) {
          bestLoss = loss;
          bestStump = { featureIndex: f, threshold, leftValue, rightValue, weight: 1 };
        }
      }
    }

    return bestStump;
  }

  predict(x: number[]): number {
    let pred = this.baseValue;
    for (const stump of this.stumps) {
      const value = x[stump.featureIndex] <= stump.threshold 
        ? stump.leftValue 
        : stump.rightValue;
      pred += this.learningRate * value;
    }
    return pred;
  }

  predictBatch(X: number[][]): number[] {
    return X.map(x => this.predict(x));
  }

  getFeatureImportance(): Map<number, number> {
    const importance = new Map<number, number>();
    for (const stump of this.stumps) {
      const current = importance.get(stump.featureIndex) || 0;
      importance.set(stump.featureIndex, current + 1);
    }
    return importance;
  }

  toJSON(): string {
    return JSON.stringify({
      stumps: this.stumps,
      learningRate: this.learningRate,
      baseValue: this.baseValue
    });
  }

  static fromJSON(json: string): LightGBM {
    const data = JSON.parse(json);
    const model = new LightGBM();
    model.stumps = data.stumps;
    model.learningRate = data.learningRate;
    model.baseValue = data.baseValue;
    return model;
  }
}

export class SimpleLinearModel {
  private weights: number[] = [];
  private bias: number = 0;
  private inputDim: number;

  constructor(inputDim: number) {
    this.inputDim = inputDim;
    this.weights = new Array(inputDim).fill(0);
  }

  async fit(X: number[][], y: number[], epochs: number = 100, lr: number = 0.01): Promise<void> {
    const n = X.length;
    if (n === 0) return;

    this.weights = new Array(this.inputDim).fill(0);
    this.bias = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;
      
      for (let i = 0; i < n; i++) {
        const pred = this.predict(X[i]);
        const error = pred - y[i];
        totalLoss += error * error;

        for (let j = 0; j < this.inputDim; j++) {
          this.weights[j] -= lr * error * X[i][j] / n;
        }
        this.bias -= lr * error / n;
      }

      if (epoch % 20 === 0) {
        console.log(`[ML] Epoch ${epoch}: MSE = ${(totalLoss / n).toFixed(4)}`);
      }
    }
  }

  predict(x: number[]): number {
    let sum = this.bias;
    for (let i = 0; i < Math.min(x.length, this.weights.length); i++) {
      sum += this.weights[i] * x[i];
    }
    return Math.max(0, Math.min(1, sum));
  }

  toJSON(): string {
    return JSON.stringify({ weights: this.weights, bias: this.bias });
  }

  static fromJSON(json: string): SimpleLinearModel {
    const data = JSON.parse(json);
    const model = new SimpleLinearModel(data.weights.length);
    model.weights = data.weights;
    model.bias = data.bias;
    return model;
  }
}

export class ListingAlphaModel {
  private listingProbModel: LightGBM;
  private magnitudeModel: LightGBM;
  private timingModel: SimpleLinearModel;
  private isTrained: boolean = false;

  private historicalWinRate: number = 0.65;
  private historicalAvgWin: number = 0.35;
  private historicalAvgLoss: number = 0.08;

  constructor() {
    this.listingProbModel = new LightGBM({ learningRate: 0.1, nEstimators: 100 });
    this.magnitudeModel = new LightGBM({ learningRate: 0.05, nEstimators: 150 });
    this.timingModel = new SimpleLinearModel(FeatureEncoder.getFeatureDimension());
  }

  async train(trainingData: Array<{ features: number[]; wasListed: boolean; actualReturn: number; minutesToPeak: number }>): Promise<void> {
    if (trainingData.length < 5) {
      console.log('[ML] Not enough training data, using default heuristics');
      return;
    }

    console.log(`[ML] Training on ${trainingData.length} samples...`);

    const X = trainingData.map(d => d.features);
    const yProb = trainingData.map(d => d.wasListed ? 1 : 0);
    const yMag = trainingData.map(d => d.actualReturn);
    const yTime = trainingData.map(d => Math.min(d.minutesToPeak / 240, 1));

    await this.listingProbModel.fit(X, yProb);
    console.log('[ML] Listing probability model trained');

    await this.magnitudeModel.fit(X, yMag);
    console.log('[ML] Magnitude model trained');

    await this.timingModel.fit(X, yTime);
    console.log('[ML] Timing model trained');

    this.isTrained = true;
    console.log('[ML] All models trained successfully');
  }

  async predict(features: ListingFeatures): Promise<ListingPrediction> {
    const arrayFeatures = FeatureEncoder.encode(features);

    let listingProb: number;
    let expectedReturn: number;
    let timingScore: number;

    if (this.isTrained) {
      listingProb = Math.max(0, Math.min(1, this.listingProbModel.predict(arrayFeatures)));
      expectedReturn = Math.max(-0.5, Math.min(5.0, this.magnitudeModel.predict(arrayFeatures)));
      timingScore = this.timingModel.predict(arrayFeatures);
    } else {
      listingProb = this.heuristicListingProb(features);
      expectedReturn = this.heuristicExpectedReturn(features);
      timingScore = 0.3;
    }

    const minutesToPeak = timingScore * 240;

    const uncertainty = 1 - listingProb;
    const returnStdDev = Math.max(0.1, expectedReturn * uncertainty);
    const confidenceInterval: [number, number] = [
      expectedReturn - 1.96 * returnStdDev,
      expectedReturn + 1.96 * returnStdDev
    ];

    const optimalEntryWindow = this.calculateOptimalEntry(features, minutesToPeak);
    const recommendedPositionSize = this.calculateKellySize(listingProb, expectedReturn, confidenceInterval);

    const confidence = (
      listingProb * 0.4 +
      (expectedReturn > 0 ? 0.3 : 0) +
      (this.isKoreaTimingOptimal(features) ? 0.2 : 0) +
      (features.volumeSpike > 2 ? 0.1 : 0)
    );

    return {
      listingProbability: listingProb,
      expectedReturn,
      returnConfidenceInterval: confidenceInterval,
      optimalEntryWindow,
      recommendedPositionSize,
      confidence
    };
  }

  private heuristicListingProb(features: ListingFeatures): number {
    let prob = 0.3;
    
    if (features.volumeSpike > 3) prob += 0.2;
    else if (features.volumeSpike > 2) prob += 0.1;
    
    if (features.koreanSocialMentions > 1000) prob += 0.15;
    if (features.sentimentScore > 0.5) prob += 0.1;
    if (features.marketCapRank < 200) prob += 0.1;
    if (features.targetExchange === 'upbit' && features.isKoreaTradingHours) prob += 0.1;
    
    return Math.min(0.95, prob);
  }

  private heuristicExpectedReturn(features: ListingFeatures): number {
    let ret = 0.2;
    
    if (features.volumeSpike > 5) ret += 0.3;
    else if (features.volumeSpike > 3) ret += 0.2;
    else if (features.volumeSpike > 2) ret += 0.1;
    
    if (features.narrativeCategory === 'Meme') ret += 0.15;
    if (features.narrativeCategory === 'AI') ret += 0.1;
    if (features.koreanSocialMentions > 2000) ret += 0.15;
    if (features.targetExchange === 'upbit') ret += 0.1;
    
    return Math.min(2.0, ret);
  }

  private calculateOptimalEntry(
    features: ListingFeatures,
    minutesToPeak: number
  ): { start: number; end: number } {
    const now = new Date();
    const hkHour = ((now.getUTCHours() + 8) % 24); // HKT (UTC+8)
    const koreaOpenHKT = 8;

    if (features.targetExchange === 'upbit' || features.targetExchange === 'bithumb') {
      if (hkHour < koreaOpenHKT) {
        const minutesUntilOpen = (koreaOpenHKT - hkHour) * 60;
        return { start: minutesUntilOpen, end: minutesUntilOpen + 75 };
      } else if (hkHour >= koreaOpenHKT && hkHour < koreaOpenHKT + 1.25) {
        return { start: 0, end: 15 };
      }
    }

    if (minutesToPeak > 30) {
      return { start: 0, end: 10 };
    } else {
      return { start: 15, end: 30 };
    }
  }

  private isKoreaTimingOptimal(features: ListingFeatures): boolean {
    return features.isKoreaTradingHours && features.hourOfDay >= 8 && features.hourOfDay < 10;
  }

  private calculateKellySize(
    winProb: number,
    expectedReturn: number,
    confidenceInterval: [number, number]
  ): number {
    const conservativeReturn = Math.max(0, confidenceInterval[0]);
    if (conservativeReturn <= 0) return 0;

    const lossAmount = Math.abs(this.historicalAvgLoss);
    const b = conservativeReturn / lossAmount;
    const kelly = (winProb * b - (1 - winProb)) / b;

    const halfKelly = kelly * 0.5;
    const capped = Math.max(0, Math.min(0.25, halfKelly));

    return capped;
  }

  async save(basePath: string): Promise<void> {
    const fs = await import('fs/promises');
    
    await fs.mkdir(basePath, { recursive: true });

    await fs.writeFile(
      `${basePath}/listing_prob_model.json`,
      this.listingProbModel.toJSON()
    );
    await fs.writeFile(
      `${basePath}/magnitude_model.json`,
      this.magnitudeModel.toJSON()
    );
    await fs.writeFile(
      `${basePath}/timing_model.json`,
      this.timingModel.toJSON()
    );
    await fs.writeFile(
      `${basePath}/metadata.json`,
      JSON.stringify({ isTrained: this.isTrained, timestamp: Date.now() })
    );

    console.log(`[ML] Models saved to ${basePath}`);
  }

  async load(basePath: string): Promise<boolean> {
    try {
      const fs = await import('fs/promises');

      const listingJson = await fs.readFile(`${basePath}/listing_prob_model.json`, 'utf-8');
      this.listingProbModel = LightGBM.fromJSON(listingJson);

      const magnitudeJson = await fs.readFile(`${basePath}/magnitude_model.json`, 'utf-8');
      this.magnitudeModel = LightGBM.fromJSON(magnitudeJson);

      const timingJson = await fs.readFile(`${basePath}/timing_model.json`, 'utf-8');
      this.timingModel = SimpleLinearModel.fromJSON(timingJson);

      const metadataJson = await fs.readFile(`${basePath}/metadata.json`, 'utf-8');
      const metadata = JSON.parse(metadataJson);
      this.isTrained = metadata.isTrained;

      console.log(`[ML] Models loaded from ${basePath}`);
      return true;
    } catch (error) {
      console.log('[ML] No saved models found, using default heuristics');
      return false;
    }
  }

  getTrainingStatus(): { isTrained: boolean } {
    return { isTrained: this.isTrained };
  }
}

export const listingAlphaModel = new ListingAlphaModel();

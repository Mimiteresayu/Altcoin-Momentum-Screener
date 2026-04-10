/**
 * Services barrel export
 * Import all extracted services from a single entry point:
 *   import { getUnifiedSymbolUniverse, fetchKlines, classifySignalType } from "./services";
 */
export { getUnifiedSymbolUniverse, MAJOR_SYMBOLS } from "./symbol-universe";
export {
  fetchKlines,
  calculateRSI,
  calculateVolumeSpike,
  calculateVolumeAcceleration,
  findSwingLows,
  findSwingHighs,
  detectFairValueGap,
  detectOrderBlock,
  calculateAUR,
  type Kline,
  type FVG,
  type OrderBlock,
  type AURResult,
} from "./indicator-pipeline";
export {
  classifySignalType,
  calculateSignalStrength,
  determineTradeSide,
  detectLiquidityClusters,
  calculateOrderBookImbalance,
  calculateMultipleTPLevels,
  calculateSL,
  getSpikeReadiness,
  type SignalType,
  type SpikeReadiness,
  type LiquidityCluster,
  type OrderBookData,
} from "./signal-classifier";
export {
  fetchOpenInterestWithBinanceFallback,
  getOiDataSource,
} from "./oi-service";

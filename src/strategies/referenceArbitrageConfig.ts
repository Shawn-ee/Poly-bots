import type { ReferenceArbitrageRebalancerConfig } from "./referenceArbitrageTypes.js";

export const DEFAULT_REFERENCE_ARBITRAGE_REBALANCER_CONFIG: ReferenceArbitrageRebalancerConfig = {
  enabled: true,
  dryRun: true,
  allowedMarketIds: [],
  maxLiveMarkets: 1,
  liveBankrollOverride: 100,
  tickSize: "0.01",
  thresholdTicks: 2,
  minEdgeAfterFees: "0.005",
  priceImprovementBuffer: "0.001",
  maxBankrollPerMarket: 1000,
  maxOrderNotional: 50,
  minOrderNotional: 5,
  maxDailyNotionalPerMarket: 1000,
  cooldownMs: 3000,
  maxReferenceAgeMs: 15000,
  minReferenceLiquidity: 10,
  allowSyntheticOppositeTrade: true,
  maxOneSidedExposureRatio: 0.8,
};

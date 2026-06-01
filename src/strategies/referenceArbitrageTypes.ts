import type { Balance, MarketReferencePlanResponse, Order, Position, Quote } from "../api/types.js";
import type { BotConfig } from "../config/loadConfig.js";
import type { StrategyAction } from "./shared/types.js";

export type ReferenceArbitrageRebalancerConfig = {
  enabled: boolean;
  dryRun: boolean;
  allowedMarketIds: string[];
  maxLiveMarkets: number;
  liveBankrollOverride: number | null;
  tickSize: string;
  thresholdTicks: number;
  minEdgeAfterFees: string;
  priceImprovementBuffer: string;
  maxBankrollPerMarket: number;
  maxOrderNotional: number;
  minOrderNotional: number;
  maxDailyNotionalPerMarket: number;
  cooldownMs: number;
  maxReferenceAgeMs: number;
  minReferenceLiquidity: number;
  allowSyntheticOppositeTrade: boolean;
  maxOneSidedExposureRatio: number;
};

export type ReferenceArbitrageContext = {
  bot: BotConfig;
  marketId: string;
  marketQuotes: Quote[];
  referencePlan: MarketReferencePlanResponse;
  balance: Balance;
  positions: Position[];
  totalOpenOrders: Order[];
  marketOpenOrders: Order[];
  now: Date;
  recentQuoteLagEvents: number;
  recentSubmittedNotionalCents: number;
  cooldownActive: boolean;
};

export type ReferenceArbitrageOpportunity = {
  marketId: string;
  outcomeId: string;
  outcomeName: string;
  side: "BUY" | "SELL";
  edge: string;
  fairPrice: string;
  limitPrice: string;
  availableTopPrice: string;
  reason: string;
  details: Record<string, unknown>;
};

export type ReferenceArbitragePlan = {
  actions: StrategyAction[];
  opportunities: ReferenceArbitrageOpportunity[];
};

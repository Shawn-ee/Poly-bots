import { Balance, Order, OrderSide, Position, Quote } from "../../api/types.js";
import { BotConfig, StrategyName } from "../../config/loadConfig.js";

export type StrategyCategory = "userSimulation" | "systemLiquidity";

export const STRATEGY_CATEGORY_BY_NAME: Record<StrategyName, StrategyCategory> = {
  noiseTrader: "userSimulation",
  tightMarketMaker: "systemLiquidity",
  inventoryAwareMaker: "systemLiquidity",
  dynamicMarketMaker: "systemLiquidity",
  referenceArbitrageRebalancer: "systemLiquidity",
};

export function getStrategyCategory(strategy: StrategyName): StrategyCategory {
  return STRATEGY_CATEGORY_BY_NAME[strategy];
}

export type StrategyAction =
  | {
      type: "place";
      reason: string;
      side: OrderSide;
      marketId: string;
      outcomeId: string;
      price: string;
      size: string;
      idempotencyKey: string;
      clientOrderId: string;
      details?: Record<string, unknown>;
    }
  | {
      type: "cancel";
      reason: string;
      orderId: string;
      details?: Record<string, unknown>;
    }
  | {
      type: "skip";
      reason: string;
      marketId: string;
      outcomeId: string;
      side?: OrderSide;
      details?: Record<string, unknown>;
    };

export type StrategyContext = {
  bot: BotConfig;
  marketId: string;
  quote: Quote;
  marketQuotes: Quote[];
  balance: Balance;
  positions: Position[];
  totalOpenOrders: Order[];
  marketOpenOrders: Order[];
  outcomeOpenOrders: Order[];
  now: Date;
  recentQuoteLagEvents: number;
};

export type MarketView = {
  fairPrice: string;
  bestBid: string | null;
  bestAsk: string | null;
  midpoint: string;
};

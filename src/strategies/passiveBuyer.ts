import { Balance, Order, Position, Quote } from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { clampDecimal, compareDecimal, decimalToUnits, subtractDecimal, unitsToDecimal } from "../utils/decimal.js";
import { createId } from "../utils/ids.js";
import { countNearPriceOrders, countOrdersForSide } from "./common.js";

export type StrategyAction =
  | {
      type: "place";
      reason: string;
      side: "BUY" | "SELL";
      marketId: string;
      outcomeId: string;
      price: string;
      size: string;
      idempotencyKey: string;
      clientOrderId: string;
    }
  | {
      type: "cancel";
      reason: string;
      orderId: string;
    }
  | {
      type: "skip";
      reason: string;
      marketId: string;
      outcomeId: string;
      side?: "BUY" | "SELL";
      details?: Record<string, unknown>;
    };

export type StrategyContext = {
  bot: BotConfig;
  marketId: string;
  quote: Quote;
  balance: Balance;
  positions: Position[];
  totalOpenOrders: Order[];
  marketOpenOrders: Order[];
  outcomeOpenOrders: Order[];
  now: Date;
};

export function passiveBuyerStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, balance, positions, totalOpenOrders, outcomeOpenOrders } = context;
  const actions: StrategyAction[] = [];

  if (totalOpenOrders.length >= bot.maxOpenOrders) {
    actions.push(buildSkip("at_total_open_order_cap_skip", marketId, quote.outcomeId, "BUY", {
      totalOpenOrders: totalOpenOrders.length,
      maxOpenOrders: bot.maxOpenOrders,
    }));
    return actions;
  }

  const currentShares = positions
    .filter((position) => position.marketId === marketId && position.outcomeId === quote.outcomeId)
    .reduce((sum, position) => sum + decimalToUnits(position.shares), 0n);

  if (currentShares >= decimalToUnits(bot.maxPositionShares)) {
    actions.push(buildSkip("max_position_reached_skip", marketId, quote.outcomeId, "BUY", {
      currentShares: unitsToDecimal(currentShares),
      maxPositionShares: bot.maxPositionShares,
    }));
    return actions;
  }

  const referencePrice = quote.bestBid ?? quote.midPrice ?? quote.lastPrice ?? "0.50";
  const price = clampDecimal(subtractTicks(referencePrice, bot.tickSize, bot.priceOffsetTicks), "0.01", "0.99");
  const affordableSize = maxAffordableSize(bot.maxOrderSize, balance.availableUSDC, price);
  if (compareDecimal(affordableSize, "0.000001") < 0) {
    actions.push(buildSkip("insufficient_balance_skip", marketId, quote.outcomeId, "BUY", {
      availableUSDC: balance.availableUSDC,
      targetPrice: price,
    }));
    return actions;
  }

  const sameSideCount = countOrdersForSide(outcomeOpenOrders, "BUY");
  if (sameSideCount >= bot.maxOrdersPerSidePerOutcome) {
    actions.push(buildSkip("duplicate_quote_skip", marketId, quote.outcomeId, "BUY", {
      sameSideOrderCount: sameSideCount,
      maxOrdersPerSidePerOutcome: bot.maxOrdersPerSidePerOutcome,
    }));
    return actions;
  }

  const similarOrderCount = countNearPriceOrders(
    outcomeOpenOrders,
    "BUY",
    price,
    bot.tickSize,
    bot.similarOrderTicks,
  );
  if (similarOrderCount >= bot.maxSimilarOpenOrders) {
    actions.push(buildSkip("near_existing_order_skip", marketId, quote.outcomeId, "BUY", {
      similarOrderCount,
      maxSimilarOpenOrders: bot.maxSimilarOpenOrders,
      targetPrice: price,
      similarOrderTicks: bot.similarOrderTicks,
    }));
    return actions;
  }

  const id = createId(`${bot.name}-buy`);
  actions.push({
    type: "place",
    reason: "passive buyer quote",
    side: "BUY",
    marketId,
    outcomeId: quote.outcomeId,
    price,
    size: affordableSize,
    idempotencyKey: id,
    clientOrderId: id,
  });
  return actions;
}

function subtractTicks(price: string, tickSize: string, ticks: number): string {
  const offset = unitsToDecimal(decimalToUnits(tickSize) * BigInt(ticks));
  return subtractDecimal(price, offset);
}

function maxAffordableSize(maxOrderSize: string, availableUSDC: string, price: string): string {
  const safePrice = compareDecimal(price, "0.000001") <= 0 ? "0.000001" : price;
  const sizeUnits = (decimalToUnits(availableUSDC) * 1_000_000n) / decimalToUnits(safePrice);
  const affordable = unitsToDecimal(sizeUnits);
  return compareDecimal(affordable, maxOrderSize) < 0 ? affordable : maxOrderSize;
}

function buildSkip(
  reason: string,
  marketId: string,
  outcomeId: string,
  side: "BUY" | "SELL",
  details?: Record<string, unknown>,
): StrategyAction {
  return {
    type: "skip",
    reason,
    marketId,
    outcomeId,
    side,
    ...(details ? { details } : {}),
  };
}

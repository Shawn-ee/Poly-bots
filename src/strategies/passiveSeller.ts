import { Position } from "../api/types.js";
import { addDecimal, clampDecimal, compareDecimal, decimalToUnits, unitsToDecimal } from "../utils/decimal.js";
import { createId } from "../utils/ids.js";
import { StrategyAction, StrategyContext } from "./passiveBuyer.js";
import { countNearPriceOrders, countOrdersForSide } from "./common.js";

export function passiveSellerStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, positions, totalOpenOrders, outcomeOpenOrders } = context;
  const actions: StrategyAction[] = [];

  if (totalOpenOrders.length >= bot.maxOpenOrders) {
    actions.push(buildSkip("at_total_open_order_cap_skip", marketId, quote.outcomeId, "SELL", {
      totalOpenOrders: totalOpenOrders.length,
      maxOpenOrders: bot.maxOpenOrders,
    }));
    return actions;
  }

  const position = findPosition(positions, marketId, quote.outcomeId);
  if (!position) {
    actions.push(buildSkip("no_inventory_skip", marketId, quote.outcomeId, "SELL"));
    return actions;
  }

  const sellable = unitsToDecimal(decimalToUnits(position.shares) - decimalToUnits(position.reservedShares));
  if (compareDecimal(sellable, "0.000001") <= 0) {
    actions.push(buildSkip("no_inventory_skip", marketId, quote.outcomeId, "SELL", {
      shares: position.shares,
      reservedShares: position.reservedShares,
    }));
    return actions;
  }

  const size = compareDecimal(sellable, bot.maxOrderSize) < 0 ? sellable : bot.maxOrderSize;
  const referencePrice = quote.bestAsk ?? quote.midPrice ?? quote.lastPrice ?? position.avgCost ?? "0.50";
  const price = clampDecimal(addTicks(referencePrice, bot.tickSize, bot.priceOffsetTicks), "0.01", "0.99");

  const sameSideCount = countOrdersForSide(outcomeOpenOrders, "SELL");
  if (sameSideCount >= bot.maxOrdersPerSidePerOutcome) {
    actions.push(buildSkip("duplicate_quote_skip", marketId, quote.outcomeId, "SELL", {
      sameSideOrderCount: sameSideCount,
      maxOrdersPerSidePerOutcome: bot.maxOrdersPerSidePerOutcome,
    }));
    return actions;
  }

  const similarOrderCount = countNearPriceOrders(
    outcomeOpenOrders,
    "SELL",
    price,
    bot.tickSize,
    bot.similarOrderTicks,
  );
  if (similarOrderCount >= bot.maxSimilarOpenOrders) {
    actions.push(buildSkip("near_existing_order_skip", marketId, quote.outcomeId, "SELL", {
      similarOrderCount,
      maxSimilarOpenOrders: bot.maxSimilarOpenOrders,
      targetPrice: price,
      similarOrderTicks: bot.similarOrderTicks,
    }));
    return actions;
  }

  const id = createId(`${bot.name}-sell`);
  actions.push({
    type: "place",
    reason: "passive seller quote",
    side: "SELL",
    marketId,
    outcomeId: quote.outcomeId,
    price,
    size,
    idempotencyKey: id,
    clientOrderId: id,
  });
  return actions;
}

function findPosition(positions: Position[], marketId: string, outcomeId: string): Position | undefined {
  return positions.find((position) => position.marketId === marketId && position.outcomeId === outcomeId);
}

function addTicks(price: string, tickSize: string, ticks: number): string {
  const offset = unitsToDecimal(decimalToUnits(tickSize) * BigInt(ticks));
  return addDecimal(price, offset);
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

import { addDecimal, clampDecimal, compareDecimal, decimalToUnits, subtractDecimal, unitsToDecimal } from "../utils/decimal.js";
import { createId } from "../utils/ids.js";
import { StrategyAction, StrategyContext } from "./passiveBuyer.js";
import { countNearPriceOrders, countOrdersForSide } from "./common.js";

export function randomMakerStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, positions, totalOpenOrders, outcomeOpenOrders } = context;
  const actions: StrategyAction[] = [];

  if (totalOpenOrders.length >= bot.maxOpenOrders) {
    actions.push(buildSkip("at_total_open_order_cap_skip", marketId, quote.outcomeId, undefined, {
      totalOpenOrders: totalOpenOrders.length,
      maxOpenOrders: bot.maxOpenOrders,
    }));
    return actions;
  }

  if (Math.random() < 0.45) {
    actions.push(buildSkip("random_throttle_skip", marketId, quote.outcomeId));
    return actions;
  }

  const side: "BUY" | "SELL" = Math.random() < 0.5 ? "BUY" : "SELL";
  if (side === "SELL") {
    const owned = positions
      .filter((position) => position.marketId === marketId && position.outcomeId === quote.outcomeId)
      .reduce((sum, position) => sum + decimalToUnits(position.shares) - decimalToUnits(position.reservedShares), 0n);
    if (owned <= 0n) {
      actions.push(buildSkip("no_inventory_skip", marketId, quote.outcomeId, side));
      return actions;
    }
  }

  const priceAnchor = quote.midPrice ?? quote.lastPrice ?? quote.bestBid ?? quote.bestAsk ?? "0.50";
  const driftTicks = BigInt(bot.priceOffsetTicks + Math.floor(Math.random() * 2));
  const drift = unitsToDecimal(decimalToUnits(bot.tickSize) * driftTicks);
  const rawPrice = side === "BUY" ? subtractDecimal(priceAnchor, drift) : addDecimal(priceAnchor, drift);
  const price = clampDecimal(rawPrice, "0.01", "0.99");

  let size = bot.maxOrderSize;
  if (compareDecimal(bot.maxOrderSize, "0.250000") > 0) {
    size = "0.250000";
  }

  const sameSideCount = countOrdersForSide(outcomeOpenOrders, side);
  if (sameSideCount >= bot.maxOrdersPerSidePerOutcome) {
    actions.push(buildSkip("duplicate_quote_skip", marketId, quote.outcomeId, side, {
      sameSideOrderCount: sameSideCount,
      maxOrdersPerSidePerOutcome: bot.maxOrdersPerSidePerOutcome,
    }));
    return actions;
  }

  const similarOrderCount = countNearPriceOrders(
    outcomeOpenOrders,
    side,
    price,
    bot.tickSize,
    bot.similarOrderTicks,
  );
  if (similarOrderCount >= bot.maxSimilarOpenOrders) {
    actions.push(buildSkip("near_existing_order_skip", marketId, quote.outcomeId, side, {
      similarOrderCount,
      maxSimilarOpenOrders: bot.maxSimilarOpenOrders,
      targetPrice: price,
      similarOrderTicks: bot.similarOrderTicks,
    }));
    return actions;
  }

  const id = createId(`${bot.name}-maker`);
  actions.push({
    type: "place",
    reason: "random maker quote",
    side,
    marketId,
    outcomeId: quote.outcomeId,
    price,
    size,
    idempotencyKey: id,
    clientOrderId: id,
  });

  return actions;
}

function buildSkip(
  reason: string,
  marketId: string,
  outcomeId: string,
  side?: "BUY" | "SELL",
  details?: Record<string, unknown>,
): StrategyAction {
  return {
    type: "skip",
    reason,
    marketId,
    outcomeId,
    ...(side ? { side } : {}),
    ...(details ? { details } : {}),
  };
}

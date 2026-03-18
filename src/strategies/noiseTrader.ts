import { compareDecimal } from "../utils/decimal.js";
import {
  StrategyAction,
  StrategyContext,
  buildStateSnapshot,
  canBuyMore,
  makePlaceAction,
  makeSkipAction,
  makerAskPrice,
  makerBidPrice,
  planMakerQuote,
  shouldTakeLiquidity,
  sizeForMaker,
  sizeForTaker,
} from "./common.js";

export function noiseTraderStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, balance, positions, totalOpenOrders, outcomeOpenOrders, now } = context;
  const { view, inventoryBiasTicks, availableShares } = buildStateSnapshot(context);

  const side = chooseSide(availableShares, inventoryBiasTicks);
  if (!side) {
    return [
      makeSkipAction("noise_trader_idle_skip", marketId, quote.outcomeId, undefined, {
        fairPrice: view.fairPrice,
      }),
    ];
  }

  if (shouldTakeLiquidity(bot, side, view, inventoryBiasTicks)) {
    if (side === "BUY" && view.bestAsk && canBuyMore(bot, marketId, quote.outcomeId, positions)) {
      const size = sizeForTaker(bot, balance, view.bestAsk);
      if (compareDecimal(size, "0.000001") > 0) {
        return [
          makePlaceAction({
            bot,
            reason: "noise_trader_taker_buy",
            side,
            marketId,
            outcomeId: quote.outcomeId,
            price: view.bestAsk,
            size,
            details: { fairPrice: view.fairPrice },
          }),
        ];
      }
    }

    if (side === "SELL" && view.bestBid && compareDecimal(availableShares, "0.000001") > 0) {
      const sellSize = compareDecimal(availableShares, bot.maxTakerSize) < 0 ? availableShares : bot.maxTakerSize;
      return [
        makePlaceAction({
          bot,
          reason: "noise_trader_taker_sell",
          side,
          marketId,
          outcomeId: quote.outcomeId,
          price: view.bestBid,
          size: sellSize,
          details: { fairPrice: view.fairPrice },
        }),
      ];
    }
  }

  if (side === "BUY") {
    if (!canBuyMore(bot, marketId, quote.outcomeId, positions)) {
      return [makeSkipAction("noise_trader_buy_capacity_skip", marketId, quote.outcomeId, side)];
    }

    const price = makerBidPrice(bot, view, inventoryBiasTicks);
    const size = sizeForMaker(bot, balance, price);
    if (compareDecimal(size, "0.000001") <= 0) {
      return [makeSkipAction("noise_trader_insufficient_balance_skip", marketId, quote.outcomeId, side)];
    }

    return planMakerQuote({
      bot,
      marketId,
      outcomeId: quote.outcomeId,
      side,
      price,
      size: compareDecimal(size, bot.maxTakerSize) < 0 ? size : bot.maxTakerSize,
      openOrders: outcomeOpenOrders,
      totalOpenOrders,
      now,
      reason: "noise_trader_maker_buy",
      topPrice: view.bestBid,
      fairPrice: view.fairPrice,
    });
  }

  if (compareDecimal(availableShares, "0.000001") <= 0) {
    return [makeSkipAction("noise_trader_no_inventory_skip", marketId, quote.outcomeId, side)];
  }

  const sellPrice = makerAskPrice(bot, view, inventoryBiasTicks);
  const sellSize = compareDecimal(availableShares, bot.maxTakerSize) < 0 ? availableShares : bot.maxTakerSize;
  return planMakerQuote({
    bot,
    marketId,
    outcomeId: quote.outcomeId,
    side,
    price: sellPrice,
    size: sellSize,
    openOrders: outcomeOpenOrders,
    totalOpenOrders,
    now,
    reason: "noise_trader_maker_sell",
    topPrice: view.bestAsk,
    fairPrice: view.fairPrice,
  });
}

function chooseSide(
  availableShares: string,
  inventoryBiasTicks: number,
): "BUY" | "SELL" | null {
  const sellable = compareDecimal(availableShares, "0.000001") > 0;
  const buyWeight = Math.max(0.2, 0.5 - inventoryBiasTicks * 0.05);
  const sellWeight = sellable ? Math.max(0.2, 0.5 + inventoryBiasTicks * 0.05) : 0;
  const totalWeight = buyWeight + sellWeight;
  if (totalWeight <= 0) {
    return null;
  }

  const pick = Math.random();
  return pick <= buyWeight / totalWeight ? "BUY" : sellable ? "SELL" : "BUY";
}

import { compareDecimal } from "../utils/decimal.js";
import {
  StrategyAction,
  StrategyContext,
  buildStateSnapshot,
  canBuyMore,
  getAvailableShares,
  makeSkipAction,
  makerAskPrice,
  makerBidPrice,
  planMakerQuote,
  sizeForMaker,
} from "./common.js";

export function inventoryAwareMakerStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, balance, positions, totalOpenOrders, outcomeOpenOrders, now } = context;
  const { view, inventoryBiasTicks } = buildStateSnapshot(context);
  const actions: StrategyAction[] = [];

  const adjustedBidPrice = makerBidPrice(bot, view, inventoryBiasTicks + Math.ceil(bot.inventorySkewStrength / 2));
  const adjustedAskPrice = makerAskPrice(bot, view, inventoryBiasTicks - Math.ceil(bot.inventorySkewStrength / 2));

  const buySize = sizeForMaker(bot, balance, adjustedBidPrice);
  if (canBuyMore(bot, marketId, quote.outcomeId, positions) && compareDecimal(buySize, "0.000001") > 0) {
    actions.push(
      ...planMakerQuote({
        bot,
        marketId,
        outcomeId: quote.outcomeId,
        side: "BUY",
        price: adjustedBidPrice,
        size: buySize,
        openOrders: outcomeOpenOrders,
        totalOpenOrders,
        now,
        reason: "inventory_aware_maker_bid",
        topPrice: view.bestBid,
        fairPrice: view.fairPrice,
      }),
    );
  } else {
    actions.push(
      makeSkipAction("inventory_buy_bias_skip", marketId, quote.outcomeId, "BUY", {
        fairPrice: view.fairPrice,
        inventoryBiasTicks,
      }),
    );
  }

  const availableShares = getAvailableShares(positions, marketId, quote.outcomeId);
  if (compareDecimal(availableShares, "0.000001") > 0) {
    const sellSize = compareDecimal(availableShares, bot.maxOrderSize) < 0 ? availableShares : bot.maxOrderSize;
    actions.push(
      ...planMakerQuote({
        bot,
        marketId,
        outcomeId: quote.outcomeId,
        side: "SELL",
        price: adjustedAskPrice,
        size: sellSize,
        openOrders: outcomeOpenOrders,
        totalOpenOrders,
        now,
        reason: "inventory_aware_maker_ask",
        topPrice: view.bestAsk,
        fairPrice: view.fairPrice,
      }),
    );
  } else {
    actions.push(
      makeSkipAction("inventory_sell_bias_skip", marketId, quote.outcomeId, "SELL", {
        fairPrice: view.fairPrice,
        inventoryBiasTicks,
      }),
    );
  }

  return actions;
}

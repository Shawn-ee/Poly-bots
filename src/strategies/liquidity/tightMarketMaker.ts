import { compareDecimal } from "../../utils/decimal.js";
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
} from "../shared/common.js";

export function tightMarketMakerStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, balance, positions, totalOpenOrders, outcomeOpenOrders, now } = context;
  const { view, inventoryBiasTicks } = buildStateSnapshot(context);
  const actions: StrategyAction[] = [];

  const bidPrice = makerBidPrice(bot, view, inventoryBiasTicks);
  const buySize = sizeForMaker(bot, balance, bidPrice);
  if (canBuyMore(bot, marketId, quote.outcomeId, positions) && compareDecimal(buySize, "0.000001") > 0) {
    actions.push(
      ...planMakerQuote({
        bot,
        marketId,
        outcomeId: quote.outcomeId,
        side: "BUY",
        price: bidPrice,
        size: buySize,
        openOrders: outcomeOpenOrders,
        totalOpenOrders,
        now,
        reason: "tight_market_maker_bid",
        topPrice: view.bestBid,
        fairPrice: view.fairPrice,
      }),
    );
  } else {
    actions.push(
      makeSkipAction("buy_capacity_skip", marketId, quote.outcomeId, "BUY", {
        fairPrice: view.fairPrice,
        price: bidPrice,
      }),
    );
  }

  const availableShares = getAvailableShares(positions, marketId, quote.outcomeId);
  const askPrice = makerAskPrice(bot, view, inventoryBiasTicks);
  if (compareDecimal(availableShares, "0.000001") > 0) {
    const sellSize = compareDecimal(availableShares, bot.maxOrderSize) < 0 ? availableShares : bot.maxOrderSize;
    actions.push(
      ...planMakerQuote({
        bot,
        marketId,
        outcomeId: quote.outcomeId,
        side: "SELL",
        price: askPrice,
        size: sellSize,
        openOrders: outcomeOpenOrders,
        totalOpenOrders,
        now,
        reason: "tight_market_maker_ask",
        topPrice: view.bestAsk,
        fairPrice: view.fairPrice,
      }),
    );
  } else {
    actions.push(
      makeSkipAction("no_inventory_skip", marketId, quote.outcomeId, "SELL", {
        fairPrice: view.fairPrice,
        price: askPrice,
      }),
    );
  }

  return actions;
}

import { Order, Position, QuoteResponse } from "../../api/types.js";
import { BotConfig } from "../../config/loadConfig.js";
import { LocalReferenceMarket, findBinaryOutcome } from "../../referenceMarket/localReferenceMarkets.js";
import {
  CachedReferenceQuote,
  ReferencePriceCache,
  ReferenceQuoteQualityReason,
} from "../../referenceMarket/referencePriceCache.js";
import { compareDecimal } from "../../utils/decimal.js";
import {
  clampPrice,
  getAvailableShares,
  makeCancelAction,
  makePlaceAction,
  makeSkipAction,
  maxAffordableBuySize,
  shiftPriceByTicks,
} from "../shared/common.js";
import { StrategyAction } from "../shared/types.js";

export type OutcomeQuotePlan = {
  outcomeId: string;
  outcomeName: string;
  mmEligible: boolean;
  reason: string;
  referenceBid: string | null;
  referenceAsk: string | null;
  botBid: string | null;
  botAsk: string | null;
};

export type MarketQuotePlan = {
  marketId: string;
  marketTitle: string;
  actions: StrategyAction[];
  outcomes: OutcomeQuotePlan[];
};

export function buildReferenceAwareQuotePlan(params: {
  bot: BotConfig;
  market: LocalReferenceMarket;
  quoteResponse: QuoteResponse;
  balanceAvailableUSDC: string;
  positions: Position[];
  openOrders: Order[];
  now: Date;
  referenceCache: ReferencePriceCache;
  riskState: string;
}): MarketQuotePlan {
  const actions: StrategyAction[] = [];
  const outcomes: OutcomeQuotePlan[] = [];
  const marketOpenOrders = params.openOrders.filter((order) => order.marketId === params.market.id);
  const eligibleReason = getMarketEligibilityReason(params.bot, params.market);

  if (eligibleReason !== "ok") {
    for (const outcome of params.market.outcomes) {
      const outcomeOrders = marketOpenOrders.filter((order) => order.outcomeId === outcome.id);
      actions.push(...outcomeOrders.map((order) => makeCancelAction(order.id, eligibleReason)));
      actions.push(makeSkipAction(eligibleReason, params.market.id, outcome.id, undefined, {
        botType: "system_liquidity",
        riskState: params.riskState,
      }));
      outcomes.push({
        outcomeId: outcome.id,
        outcomeName: outcome.name,
        mmEligible: false,
        reason: eligibleReason,
        referenceBid: null,
        referenceAsk: null,
        botBid: null,
        botAsk: null,
      });
    }

    return {
      marketId: params.market.id,
      marketTitle: params.market.title,
      actions,
      outcomes,
    };
  }

  const yesOutcome = findBinaryOutcome(params.market, "YES");
  const noOutcome = findBinaryOutcome(params.market, "NO");
  if (!yesOutcome || !noOutcome || params.market.outcomes.length !== 2) {
    for (const outcome of params.market.outcomes) {
      const outcomeOrders = marketOpenOrders.filter((order) => order.outcomeId === outcome.id);
      actions.push(...outcomeOrders.map((order) => makeCancelAction(order.id, "market_not_binary")));
      outcomes.push({
        outcomeId: outcome.id,
        outcomeName: outcome.name,
        mmEligible: false,
        reason: "market_not_binary",
        referenceBid: null,
        referenceAsk: null,
        botBid: null,
        botAsk: null,
      });
    }
    return {
      marketId: params.market.id,
      marketTitle: params.market.title,
      actions,
      outcomes,
    };
  }

  for (const outcome of params.market.outcomes) {
    const localQuote = params.quoteResponse.quotes.find((quote) => quote.outcomeId === outcome.id) ?? null;
    const quality = params.referenceCache.getQualityStatus(params.market.id, outcome.id, {
      staleMs: params.bot.referenceAwareSystemLiquidity.referenceStaleMs,
      minReferenceSpread: params.bot.referenceAwareSystemLiquidity.minReferenceSpread,
      maxReferenceSpread: params.bot.referenceAwareSystemLiquidity.maxReferenceSpread,
      minReferenceLiquidity: params.bot.referenceAwareSystemLiquidity.minReferenceLiquidity,
      minVolume24hr: params.bot.referenceAwareSystemLiquidity.minVolume24hr,
    });
    const referenceQuote = quality.quote;
    const outcomeOrders = marketOpenOrders.filter((order) => order.outcomeId === outcome.id);

    if (!quality.eligible || !referenceQuote) {
      actions.push(...cancelOutcomeOrders(outcomeOrders, quality.reason));
      actions.push(makeSkipAction(quality.reason, params.market.id, outcome.id, undefined, {
        botType: "system_liquidity",
        riskState: params.riskState,
      }));
      outcomes.push({
        outcomeId: outcome.id,
        outcomeName: outcome.name,
        mmEligible: false,
        reason: quality.reason,
        referenceBid: referenceQuote?.bestBid ?? null,
        referenceAsk: referenceQuote?.bestAsk ?? null,
        botBid: null,
        botAsk: null,
      });
      continue;
    }

    const targets = deriveTargetQuotes({
      bot: params.bot,
      referenceQuote,
      localQuote,
    });
    if (!targets) {
      actions.push(...cancelOutcomeOrders(outcomeOrders, "reference_invalid_target_band"));
      outcomes.push({
        outcomeId: outcome.id,
        outcomeName: outcome.name,
        mmEligible: false,
        reason: "reference_invalid_target_band",
        referenceBid: referenceQuote.bestBid,
        referenceAsk: referenceQuote.bestAsk,
        botBid: null,
        botAsk: null,
      });
      continue;
    }

    const availableShares = getAvailableShares(
      params.positions,
      params.market.id,
      outcome.id,
    );
    const buySize = maxAffordableBuySize(
      params.bot.maxOrderSize,
      params.balanceAvailableUSDC,
      targets.bid,
    );
    const sellSize =
      compareDecimal(availableShares, params.bot.maxOrderSize) < 0
        ? availableShares
        : params.bot.maxOrderSize;

    actions.push(
      ...planSide({
        bot: params.bot,
        marketId: params.market.id,
        outcomeId: outcome.id,
        side: "BUY",
        desiredPrice: targets.bid,
        desiredSize: buySize,
        openOrders: outcomeOrders.filter((order) => order.side === "BUY"),
        now: params.now,
        details: buildActionDetails(params, outcome.id, referenceQuote, targets.bid, targets.ask, "reference_ok"),
      }),
    );
    actions.push(
      ...planSide({
        bot: params.bot,
        marketId: params.market.id,
        outcomeId: outcome.id,
        side: "SELL",
        desiredPrice: targets.ask,
        desiredSize: sellSize,
        openOrders: outcomeOrders.filter((order) => order.side === "SELL"),
        now: params.now,
        details: buildActionDetails(
          params,
          outcome.id,
          referenceQuote,
          targets.bid,
          targets.ask,
          compareDecimal(sellSize, "0.000001") > 0 ? "reference_ok" : "no_inventory_for_sell",
        ),
      }),
    );

    outcomes.push({
      outcomeId: outcome.id,
      outcomeName: outcome.name,
      mmEligible: true,
      reason: "reference_ok",
      referenceBid: referenceQuote.bestBid,
      referenceAsk: referenceQuote.bestAsk,
      botBid: targets.bid,
      botAsk: targets.ask,
    });
  }

  return {
    marketId: params.market.id,
    marketTitle: params.market.title,
    actions,
    outcomes,
  };
}

function getMarketEligibilityReason(bot: BotConfig, market: LocalReferenceMarket): string {
  if (market.referenceSource !== "polymarket") {
    return "reference_market_not_enabled";
  }
  if (market.importStatus !== "approved") {
    return "reference_market_not_enabled";
  }
  if (market.mmEnabled !== true) {
    return "reference_market_not_enabled";
  }
  if (!(market.tradable === true || bot.referenceAwareSystemLiquidity.explicitBotTradable)) {
    return "reference_market_not_enabled";
  }
  if (market.type !== "BINARY") {
    return "market_not_binary";
  }
  return "ok";
}

function deriveTargetQuotes(params: {
  bot: BotConfig;
  referenceQuote: CachedReferenceQuote;
  localQuote: QuoteResponse["quotes"][number] | null;
}): { bid: string; ask: string } | null {
  if (!params.referenceQuote.bestBid || !params.referenceQuote.bestAsk) {
    return null;
  }

  const offsetTicks = params.bot.referenceAwareSystemLiquidity.quoteOffsetTicks;
  let bid = clampPrice(
    params.bot,
    shiftPriceByTicks(params.referenceQuote.bestBid, params.bot.tickSize, -offsetTicks),
  );
  let ask = clampPrice(
    params.bot,
    shiftPriceByTicks(params.referenceQuote.bestAsk, params.bot.tickSize, offsetTicks),
  );

  if (params.localQuote?.bestAsk && compareDecimal(bid, params.localQuote.bestAsk) >= 0) {
    bid = clampPrice(params.bot, shiftPriceByTicks(params.localQuote.bestAsk, params.bot.tickSize, -1));
  }
  if (params.localQuote?.bestBid && compareDecimal(ask, params.localQuote.bestBid) <= 0) {
    ask = clampPrice(params.bot, shiftPriceByTicks(params.localQuote.bestBid, params.bot.tickSize, 1));
  }

  return compareDecimal(bid, ask) < 0 ? { bid, ask } : null;
}

function planSide(params: {
  bot: BotConfig;
  marketId: string;
  outcomeId: string;
  side: "BUY" | "SELL";
  desiredPrice: string;
  desiredSize: string;
  openOrders: Order[];
  now: Date;
  details: Record<string, unknown>;
}): StrategyAction[] {
  const actions: StrategyAction[] = [];
  const positiveSize = compareDecimal(params.desiredSize, "0.000001") > 0;

  if (!positiveSize) {
    actions.push(...params.openOrders.map((order) => makeCancelAction(order.id, "no_inventory_for_sell", params.details)));
    actions.push(
      makeSkipAction("no_inventory_for_sell", params.marketId, params.outcomeId, params.side, params.details),
    );
    return actions;
  }

  const keepable = params.openOrders.find((order) => shouldKeepOrder(order, params.desiredPrice, params.desiredSize, params.now, params.bot.staleOrderMs));
  if (keepable) {
    actions.push(
      makeSkipAction("keep_existing_quote_skip", params.marketId, params.outcomeId, params.side, {
        ...params.details,
        existingOrderId: keepable.id,
        existingPrice: keepable.price,
      }),
    );
    return actions;
  }

  for (const order of params.openOrders) {
    actions.push(makeCancelAction(order.id, "reference_requote", params.details));
  }

  actions.push(
    makePlaceAction({
      bot: params.bot,
      reason: "reference_quote_place",
      side: params.side,
      marketId: params.marketId,
      outcomeId: params.outcomeId,
      price: params.desiredPrice,
      size: params.desiredSize,
      details: params.details,
    }),
  );

  return actions;
}

function shouldKeepOrder(
  order: Order,
  desiredPrice: string,
  desiredSize: string,
  now: Date,
  staleOrderMs: number,
) {
  if (!order.createdAt) {
    return false;
  }
  if (now.getTime() - new Date(order.createdAt).getTime() > staleOrderMs) {
    return false;
  }
  return compareDecimal(order.price, desiredPrice) === 0 && compareDecimal(order.remaining, desiredSize) === 0;
}

function cancelOutcomeOrders(openOrders: Order[], reason: string) {
  return openOrders.map((order) => makeCancelAction(order.id, reason));
}

function buildActionDetails(
  params: {
    bot: BotConfig;
    market: LocalReferenceMarket;
    riskState: string;
  },
  outcomeId: string,
  referenceQuote: CachedReferenceQuote,
  botBid: string | null,
  botAsk: string | null,
  reason: string,
) {
  return {
    botId: params.bot.name,
    botType: "system_liquidity",
    marketId: params.market.id,
    outcomeId,
    referenceBid: referenceQuote.bestBid,
    referenceAsk: referenceQuote.bestAsk,
    botBid,
    botAsk,
    quoteOffsetTicks: params.bot.referenceAwareSystemLiquidity.quoteOffsetTicks,
    reason,
    riskState: params.riskState,
  };
}

import { MarketReferencePlanOutcome, Order, Quote } from "../api/types.js";
import {
  addDecimal,
  clampDecimal,
  compareDecimal,
  decimalToUnits,
  multiplyDecimal,
  subtractDecimal,
  unitsToDecimal,
} from "../utils/decimal.js";
import {
  clampPrice,
  getAvailableShares,
  makeCancelAction,
  makePlaceAction,
  makeSkipAction,
  shiftPriceByTicks,
  ticksToDecimal,
  type StrategyAction,
} from "./shared/common.js";
import {
  ReferenceArbitrageContext,
  ReferenceArbitrageOpportunity,
  ReferenceArbitragePlan,
} from "./referenceArbitrageTypes.js";

export function referenceArbitrageRebalancerStrategy(
  context: ReferenceArbitrageContext,
): ReferenceArbitragePlan {
  const actions = collectReferenceArbitrageWorkingOrderCleanup(context);
  const opportunities: ReferenceArbitrageOpportunity[] = [];
  const config = context.bot.referenceArbitrageRebalancer;
  const effectiveBankrollPerMarket = effectiveMaxBankrollPerMarket(config);
  const skipOutcomeId = fallbackOutcomeId(context);

  if (!config.enabled) {
    return {
      actions: [
        makeSkipAction("reference_arbitrage_disabled", context.marketId, skipOutcomeId, undefined, {
          strategy: "referenceArbitrageRebalancer",
        }),
      ],
      opportunities,
    };
  }

  if (context.cooldownActive) {
    return toDryRunSafePlanIfNeeded(context, {
      actions: [
        ...actions,
        makeSkipAction("reference_arbitrage_cooldown_skip", context.marketId, skipOutcomeId, undefined, {
          cooldownMs: config.cooldownMs,
          strategy: "referenceArbitrageRebalancer",
        }),
      ],
      opportunities,
    });
  }

  const quoteByOutcome = new Map(context.marketQuotes.map((quote) => [quote.outcomeId, quote]));
  const referenceByOutcome = new Map(
    context.referencePlan.outcomes.map((outcome) => [outcome.localOutcomeId, outcome]),
  );
  const dailyBudgetRemaining = clampNonNegative(
    subtractDecimal(
      dollarsToDecimal(config.maxDailyNotionalPerMarket),
      centsToDecimal(context.recentSubmittedNotionalCents),
    ),
  );

  let plannedBuyNotional = "0";
  let plannedSubmittedNotional = "0";
  let plannedAvailableUSDC = context.balance.availableUSDC;

  for (const outcome of context.referencePlan.outcomes) {
    const localQuote = quoteByOutcome.get(outcome.localOutcomeId);
    const fairPrice = deriveReferenceFairPrice(outcome);
    const eligibilityError = validateReferenceOutcome(outcome, fairPrice, config.maxReferenceAgeMs, config.minReferenceLiquidity);
    if (!localQuote || !fairPrice || eligibilityError) {
      continue;
    }

    const sellOpportunity = buildSellOpportunity(context, outcome, localQuote, fairPrice);
    if (sellOpportunity) {
      const sellNotional = minDecimal(
        dollarsToDecimal(config.maxOrderNotional),
        minDecimal(
          clampNonNegative(subtractDecimal(dailyBudgetRemaining, plannedSubmittedNotional)),
          multiplyDecimal(
            getAvailableShares(context.positions, context.marketId, outcome.localOutcomeId),
            sellOpportunity.limitPrice,
          ),
        ),
      );
      if (compareDecimal(sellNotional, dollarsToDecimal(config.minOrderNotional)) < 0) {
        continue;
      }

      const sellSize = sizeFromNotional(sellNotional, sellOpportunity.limitPrice);
      if (compareDecimal(sellSize, "0.000001") <= 0) {
        continue;
      }

      opportunities.push(sellOpportunity);
      plannedSubmittedNotional = addDecimal(
        plannedSubmittedNotional,
        multiplyDecimal(sellSize, sellOpportunity.limitPrice),
      );
      actions.push(
        makePlaceAction({
          bot: context.bot,
          reason: sellOpportunity.reason,
          side: "SELL",
          marketId: context.marketId,
          outcomeId: outcome.localOutcomeId,
          price: sellOpportunity.limitPrice,
          size: sellSize,
          details: sellOpportunity.details,
        }),
      );
    }
  }

  const buyCandidates = context.referencePlan.outcomes
    .map((outcome) => {
      const localQuote = quoteByOutcome.get(outcome.localOutcomeId);
      const fairPrice = deriveReferenceFairPrice(outcome);
      const eligibilityError = validateReferenceOutcome(
        outcome,
        fairPrice,
        config.maxReferenceAgeMs,
        config.minReferenceLiquidity,
      );
      if (!localQuote || !fairPrice || eligibilityError) {
        return null;
      }
      return buildBuyOpportunity(context, outcome, localQuote, fairPrice);
    })
    .filter((candidate): candidate is ReferenceArbitrageOpportunity => candidate !== null)
    .sort((left, right) => compareDecimal(right.edge, left.edge));

  for (const opportunity of buyCandidates) {
    const marketBudgetRemaining = clampNonNegative(
      subtractDecimal(
        dollarsToDecimal(effectiveBankrollPerMarket),
        addDecimal(
          estimateMarketCommittedNotional(context, referenceByOutcome, quoteByOutcome),
          plannedBuyNotional,
        ),
      ),
    );
    const outcomeBudgetRemaining = clampNonNegative(
      subtractDecimal(
        dollarsToDecimal(effectiveBankrollPerMarket * config.maxOneSidedExposureRatio),
        estimateOutcomeCommittedNotional(
          context,
          opportunity.outcomeId,
          referenceByOutcome,
          quoteByOutcome,
        ),
      ),
    );
    const remainingDailyCapacity = clampNonNegative(
      subtractDecimal(dailyBudgetRemaining, plannedSubmittedNotional),
    );
    const candidateNotional = minDecimal(
      dollarsToDecimal(config.maxOrderNotional),
      minDecimal(
        plannedAvailableUSDC,
        minDecimal(marketBudgetRemaining, minDecimal(outcomeBudgetRemaining, remainingDailyCapacity)),
      ),
    );

    if (compareDecimal(candidateNotional, dollarsToDecimal(config.minOrderNotional)) < 0) {
      continue;
    }

    const size = sizeFromNotional(candidateNotional, opportunity.limitPrice);
    if (compareDecimal(size, "0.000001") <= 0) {
      continue;
    }

    opportunities.push(opportunity);
    const plannedOrderNotional = multiplyDecimal(size, opportunity.limitPrice);
    plannedBuyNotional = addDecimal(plannedBuyNotional, plannedOrderNotional);
    plannedSubmittedNotional = addDecimal(plannedSubmittedNotional, plannedOrderNotional);
    plannedAvailableUSDC = clampNonNegative(subtractDecimal(plannedAvailableUSDC, plannedOrderNotional));
    actions.push(
      makePlaceAction({
        bot: context.bot,
        reason: opportunity.reason,
        side: "BUY",
        marketId: context.marketId,
        outcomeId: opportunity.outcomeId,
        price: opportunity.limitPrice,
        size,
        details: opportunity.details,
      }),
    );
  }

  if (actions.length === 0) {
    actions.push(
      makeSkipAction("reference_arbitrage_no_opportunity_skip", context.marketId, skipOutcomeId, undefined, {
        referenceOutcomeCount: context.referencePlan.outcomes.length,
        strategy: "referenceArbitrageRebalancer",
      }),
    );
  }

  return toDryRunSafePlanIfNeeded(context, { actions, opportunities });
}

export function collectReferenceArbitrageCleanupActions(
  context: ReferenceArbitrageContext,
  reason: string,
): StrategyAction[] {
  return context.marketOpenOrders.map((order) =>
    makeCancelAction(order.id, reason, {
      strategy: "referenceArbitrageRebalancer",
      side: order.side,
      existingPrice: order.price,
    }),
  );
}

function collectReferenceArbitrageWorkingOrderCleanup(
  context: ReferenceArbitrageContext,
): StrategyAction[] {
  const quoteByOutcome = new Map(context.marketQuotes.map((quote) => [quote.outcomeId, quote]));
  const referenceByOutcome = new Map(
    context.referencePlan.outcomes.map((outcome) => [outcome.localOutcomeId, outcome]),
  );
  const config = context.bot.referenceArbitrageRebalancer;

  return context.marketOpenOrders.flatMap((order) => {
    const quote = quoteByOutcome.get(order.outcomeId);
    const outcome = referenceByOutcome.get(order.outcomeId);
    const fairPrice = outcome ? deriveReferenceFairPrice(outcome) : null;
    if (!quote || !outcome || !fairPrice) {
      return [
        makeCancelAction(order.id, "reference_arbitrage_reference_missing_cleanup", {
          strategy: "referenceArbitrageRebalancer",
          side: order.side,
        }),
      ];
    }

    if (shouldKeepArbitrageOrder(order, quote, fairPrice, config.priceImprovementBuffer, context.now, config.cooldownMs)) {
      return [];
    }

    return [
      makeCancelAction(order.id, "reference_arbitrage_stale_order_cleanup", {
        strategy: "referenceArbitrageRebalancer",
        side: order.side,
        fairPrice,
        bestBid: quote.bestBid,
        bestAsk: quote.bestAsk,
      }),
    ];
  });
}

function buildBuyOpportunity(
  context: ReferenceArbitrageContext,
  outcome: MarketReferencePlanOutcome,
  localQuote: Quote,
  fairPrice: string,
): ReferenceArbitrageOpportunity | null {
  const bestAsk = localQuote.bestAsk ? clampPrice(context.bot, localQuote.bestAsk) : null;
  if (!bestAsk) {
    return null;
  }

  const config = context.bot.referenceArbitrageRebalancer;
  const threshold = ticksToDecimal(config.tickSize, config.thresholdTicks);
  const capPrice = clampPrice(
    context.bot,
    roundDownToTick(subtractDecimal(fairPrice, config.priceImprovementBuffer), config.tickSize),
  );
  if (compareDecimal(bestAsk, capPrice) > 0) {
    return null;
  }

  const rawEdge = subtractDecimal(fairPrice, bestAsk);
  const edgeAfterBuffer = clampNonNegative(subtractDecimal(rawEdge, config.priceImprovementBuffer));
  if (compareDecimal(rawEdge, threshold) <= 0 || compareDecimal(edgeAfterBuffer, config.minEdgeAfterFees) < 0) {
    return null;
  }

  return {
    marketId: context.marketId,
    outcomeId: outcome.localOutcomeId,
    outcomeName: outcome.outcomeName,
    side: "BUY",
    edge: edgeAfterBuffer,
    fairPrice,
    limitPrice: capPrice,
    availableTopPrice: bestAsk,
    reason: "reference_arbitrage_buy_mispricing",
    details: {
      strategy: "referenceArbitrageRebalancer",
      fairPrice,
      localBestAsk: bestAsk,
      referenceBid: outcome.referenceBid,
      referenceAsk: outcome.referenceAsk,
      gammaOutcomePrice: outcome.gammaOutcomePrice,
      edge: rawEdge,
      edgeAfterBuffer,
      threshold,
      referenceAgeMs: outcome.ageMs,
      referenceLiquidity: outcome.liquidity,
      quotePlanEnabled: outcome.quotePlanEnabled,
      recentQuoteLagEvents: context.recentQuoteLagEvents,
    },
  };
}

function buildSellOpportunity(
  context: ReferenceArbitrageContext,
  outcome: MarketReferencePlanOutcome,
  localQuote: Quote,
  fairPrice: string,
): ReferenceArbitrageOpportunity | null {
  const bestBid = localQuote.bestBid ? clampPrice(context.bot, localQuote.bestBid) : null;
  if (!bestBid) {
    return null;
  }

  const availableShares = getAvailableShares(context.positions, context.marketId, outcome.localOutcomeId);
  if (compareDecimal(availableShares, "0.000001") <= 0) {
    return null;
  }

  const config = context.bot.referenceArbitrageRebalancer;
  const threshold = ticksToDecimal(config.tickSize, config.thresholdTicks);
  const floorPrice = clampPrice(
    context.bot,
    roundUpToTick(addDecimal(fairPrice, config.priceImprovementBuffer), config.tickSize),
  );
  if (compareDecimal(bestBid, floorPrice) < 0) {
    return null;
  }

  const rawEdge = subtractDecimal(bestBid, fairPrice);
  const edgeAfterBuffer = clampNonNegative(subtractDecimal(rawEdge, config.priceImprovementBuffer));
  if (compareDecimal(rawEdge, threshold) <= 0 || compareDecimal(edgeAfterBuffer, config.minEdgeAfterFees) < 0) {
    return null;
  }

  return {
    marketId: context.marketId,
    outcomeId: outcome.localOutcomeId,
    outcomeName: outcome.outcomeName,
    side: "SELL",
    edge: edgeAfterBuffer,
    fairPrice,
    limitPrice: floorPrice,
    availableTopPrice: bestBid,
    reason: "reference_arbitrage_sell_mispricing",
    details: {
      strategy: "referenceArbitrageRebalancer",
      fairPrice,
      localBestBid: bestBid,
      referenceBid: outcome.referenceBid,
      referenceAsk: outcome.referenceAsk,
      gammaOutcomePrice: outcome.gammaOutcomePrice,
      edge: rawEdge,
      edgeAfterBuffer,
      threshold,
      availableShares,
      referenceAgeMs: outcome.ageMs,
      referenceLiquidity: outcome.liquidity,
    },
  };
}

function validateReferenceOutcome(
  outcome: MarketReferencePlanOutcome,
  fairPrice: string | null,
  maxReferenceAgeMs: number,
  minReferenceLiquidity: number,
): string | null {
  if (!outcome.hasSnapshot || !outcome.quotePlanEnabled || !outcome.acceptingOrders) {
    return "reference_not_tradeable";
  }
  if (!fairPrice) {
    return "reference_fair_price_unavailable";
  }
  if (!outcome.isFresh) {
    return "reference_too_stale";
  }
  if (outcome.ageMs !== null && outcome.ageMs > maxReferenceAgeMs) {
    return "reference_too_stale";
  }
  if (outcome.liquidity !== null && outcome.liquidity < minReferenceLiquidity) {
    return "reference_liquidity_too_low";
  }
  return null;
}

function deriveReferenceFairPrice(outcome: MarketReferencePlanOutcome): string | null {
  if (outcome.referenceBid !== null && outcome.referenceAsk !== null) {
    return midpointDecimal(String(outcome.referenceBid), String(outcome.referenceAsk));
  }
  if (outcome.gammaOutcomePrice !== null) {
    return clampDecimal(String(outcome.gammaOutcomePrice), "0.01", "0.99");
  }
  if (outcome.lastTradePrice !== null) {
    return clampDecimal(String(outcome.lastTradePrice), "0.01", "0.99");
  }
  if (outcome.plannedBotBid !== null && outcome.plannedBotAsk !== null) {
    return midpointDecimal(String(outcome.plannedBotBid), String(outcome.plannedBotAsk));
  }
  return null;
}

function estimateMarketCommittedNotional(
  context: ReferenceArbitrageContext,
  referenceByOutcome: Map<string, MarketReferencePlanOutcome>,
  quoteByOutcome: Map<string, Quote>,
): string {
  let total = "0";
  for (const position of context.positions.filter((position) => position.marketId === context.marketId)) {
    total = addDecimal(
      total,
      multiplyDecimal(position.shares, markPriceForOutcome(position.outcomeId, position.avgCost, referenceByOutcome, quoteByOutcome)),
    );
  }
  for (const order of context.marketOpenOrders.filter((item) => item.side === "BUY")) {
    total = addDecimal(total, openOrderNotional(order));
  }
  return total;
}

function estimateOutcomeCommittedNotional(
  context: ReferenceArbitrageContext,
  outcomeId: string,
  referenceByOutcome: Map<string, MarketReferencePlanOutcome>,
  quoteByOutcome: Map<string, Quote>,
): string {
  let total = "0";
  for (const position of context.positions.filter(
    (position) => position.marketId === context.marketId && position.outcomeId === outcomeId,
  )) {
    total = addDecimal(
      total,
      multiplyDecimal(position.shares, markPriceForOutcome(outcomeId, position.avgCost, referenceByOutcome, quoteByOutcome)),
    );
  }
  for (const order of context.marketOpenOrders.filter(
    (item) => item.side === "BUY" && item.outcomeId === outcomeId,
  )) {
    total = addDecimal(total, openOrderNotional(order));
  }
  return total;
}

function markPriceForOutcome(
  outcomeId: string,
  fallbackPrice: string,
  referenceByOutcome: Map<string, MarketReferencePlanOutcome>,
  quoteByOutcome: Map<string, Quote>,
): string {
  const fairPrice = referenceByOutcome.get(outcomeId) ? deriveReferenceFairPrice(referenceByOutcome.get(outcomeId)!) : null;
  if (fairPrice) {
    return fairPrice;
  }
  const quote = quoteByOutcome.get(outcomeId);
  return quote?.midPrice ?? quote?.lastPrice ?? fallbackPrice;
}

function fallbackOutcomeId(context: ReferenceArbitrageContext): string {
  return (
    context.referencePlan.outcomes[0]?.localOutcomeId ??
    context.marketQuotes[0]?.outcomeId ??
    "__reference_arbitrage__"
  );
}

function shouldKeepArbitrageOrder(
  order: Order,
  quote: Quote,
  fairPrice: string,
  priceImprovementBuffer: string,
  now: Date,
  cooldownMs: number,
): boolean {
  const createdAtMs = order.createdAt ? Date.parse(order.createdAt) : null;
  if (createdAtMs !== null && now.getTime() - createdAtMs < cooldownMs) {
    return true;
  }

  if (order.side === "BUY" && quote.bestAsk) {
    const profitableCap = clampNonNegative(subtractDecimal(fairPrice, priceImprovementBuffer));
    return compareDecimal(order.price, quote.bestAsk) >= 0 && compareDecimal(order.price, profitableCap) <= 0;
  }

  if (order.side === "SELL" && quote.bestBid) {
    const profitableFloor = addDecimal(fairPrice, priceImprovementBuffer);
    return compareDecimal(order.price, quote.bestBid) <= 0 && compareDecimal(order.price, profitableFloor) >= 0;
  }

  return false;
}

function openOrderNotional(order: Order): string {
  return Number(order.reservedNotional) > 0 ? order.reservedNotional : multiplyDecimal(order.price, order.remaining);
}

function midpointDecimal(left: string, right: string): string {
  return unitsToDecimal((decimalToUnits(left) + decimalToUnits(right)) / 2n);
}

function roundDownToTick(price: string, tickSize: string): string {
  const tickUnits = decimalToUnits(tickSize);
  const bounded = clampDecimal(price, "0.01", "0.99");
  const units = decimalToUnits(bounded);
  return unitsToDecimal((units / tickUnits) * tickUnits);
}

function roundUpToTick(price: string, tickSize: string): string {
  const tickUnits = decimalToUnits(tickSize);
  const bounded = clampDecimal(price, "0.01", "0.99");
  const units = decimalToUnits(bounded);
  const rounded = ((units + tickUnits - 1n) / tickUnits) * tickUnits;
  return unitsToDecimal(rounded);
}

function sizeFromNotional(notional: string, price: string): string {
  const priceUnits = decimalToUnits(price);
  if (priceUnits <= 0n) {
    return "0";
  }
  return unitsToDecimal((decimalToUnits(notional) * 1_000_000n) / priceUnits);
}

function clampNonNegative(value: string): string {
  return compareDecimal(value, "0") < 0 ? "0" : value;
}

function dollarsToDecimal(value: number): string {
  return value.toFixed(6);
}

function centsToDecimal(value: number): string {
  return (value / 100).toFixed(6);
}

function minDecimal(left: string, right: string): string {
  return compareDecimal(left, right) <= 0 ? left : right;
}

function effectiveMaxBankrollPerMarket(
  config: ReferenceArbitrageContext["bot"]["referenceArbitrageRebalancer"],
): number {
  if (config.dryRun || config.liveBankrollOverride === null) {
    return config.maxBankrollPerMarket;
  }
  return Math.min(config.maxBankrollPerMarket, config.liveBankrollOverride);
}

function toDryRunSafePlanIfNeeded(
  context: ReferenceArbitrageContext,
  plan: ReferenceArbitragePlan,
): ReferenceArbitragePlan {
  if (!context.bot.referenceArbitrageRebalancer.dryRun) {
    return plan;
  }

  return {
    actions: plan.actions.map((action) => {
      if (action.type === "place") {
        return makeSkipAction("reference_arbitrage_dry_run_opportunity", action.marketId, action.outcomeId, action.side, {
          ...action.details,
          strategy: "referenceArbitrageRebalancer",
          intendedAction: "place",
          intendedPrice: action.price,
          intendedSize: action.size,
        });
      }
      if (action.type === "cancel") {
        return makeSkipAction("reference_arbitrage_dry_run_cancel", context.marketId, fallbackOutcomeId(context), undefined, {
          ...action.details,
          strategy: "referenceArbitrageRebalancer",
          intendedAction: "cancel",
          intendedOrderId: action.orderId,
          cancelReason: action.reason,
        });
      }
      return action;
    }),
    opportunities: plan.opportunities,
  };
}

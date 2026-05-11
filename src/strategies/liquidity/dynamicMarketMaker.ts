import { Order, OrderSide } from "../../api/types.js";
import { DynamicMarketMakerConfig } from "../../config/loadConfig.js";
import {
  addDecimal,
  compareDecimal,
  decimalToUnits,
  multiplyDecimal,
  subtractDecimal,
  unitsToDecimal,
} from "../../utils/decimal.js";
import {
  StrategyAction,
  StrategyContext,
  canBuyMore,
  clampPrice,
  getAvailableShares,
  getPosition,
  makeSkipAction,
  maxAffordableBuySize,
  maxDecimal,
  midpoint,
  minDecimal,
  normalizePrice,
  planMakerQuote,
  shiftPriceByTicks,
  ticksToDecimal,
} from "../shared/common.js";

type BinaryView = {
  fairPrice: string;
  midpoint: string;
  bestBid: string | null;
  bestAsk: string | null;
  siblingBestBid: string | null;
  siblingBestAsk: string | null;
  siblingOutcomeId: string | null;
  ownMidPrice: string | null;
  ownLastPrice: string | null;
  impliedMidPrice: string | null;
  impliedLastPrice: string | null;
  usedSiblingInference: boolean;
  fairPriceSource: string;
};

type InventoryProfile = {
  ownShares: string;
  siblingShares: string;
  availableShares: string;
  inventoryImbalance: number;
  ownPositionRatio: number;
  siblingPositionRatio: number;
};

type SpreadPlan = {
  observedSpreadTicks: number;
  dynamicSpreadTicks: number;
  halfSpreadTicks: number;
  baseSpreadPrice: string;
  extremeSpreadPrice: string;
  inventorySpreadPrice: string;
  extremeDistanceRatio: number;
  tightenTicksApplied: number;
};

type PlannedLevel = {
  price: string;
  size: string;
  details: Record<string, unknown>;
};

type SelectiveCompetitivePlan = {
  enabled: boolean;
  buyImproveTicks: number;
  sellImproveTicks: number;
  sizeBumpRatio: number;
  reason: string;
};

export type MintReplenishmentPlan = {
  shouldConsider: boolean;
  shouldMint: boolean;
  marketId: string;
  mid: string;
  yesAvailable: string;
  noAvailable: string;
  minOutcomeAvailable: string;
  threshold: string;
  requestedMintAmount: string;
  finalMintAmount: string;
  availableUSDC: string;
  mintedLastHour: string;
  hourlyCapacityRemaining: string;
  effectiveMaxMintAmountPerCycle: string;
  isExtremeMarket: boolean;
  reason: string | null;
};

export function dynamicMarketMakerStrategy(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, positions, totalOpenOrders, outcomeOpenOrders } = context;
  const config = bot.dynamicMarketMaker;
  const view = buildBinaryView(context);
  const inventory = buildInventoryProfile(context, view.siblingOutcomeId);
  const spreadPlan = buildSpreadPlan(bot, config, view.fairPrice, inventory.inventoryImbalance, view.bestBid, view.bestAsk);
  const selectiveCompetitivePlan = buildSelectiveCompetitivePlan({
    context,
    view,
    inventory,
    spreadPlan,
  });
  const inventoryLeanTicks = Math.round(inventory.inventoryImbalance * config.inventoryLeanTicks);
  const levelCount = deriveLevelCount(config, spreadPlan.dynamicSpreadTicks);
  const buyPressure = Math.max(0, inventory.inventoryImbalance);
  const sellPressure = Math.max(0, -inventory.inventoryImbalance);
  const buyLevels = buyPressure >= config.inventoryEmergencyThreshold ? 0 : reduceLevelsForPressure(levelCount, buyPressure, config);
  const sellLevels = sellPressure >= config.inventoryEmergencyThreshold ? 0 : reduceLevelsForPressure(levelCount, sellPressure, config);
  const actions: StrategyAction[] = [];
  const metrics = {
    strategy: "dynamicMarketMaker",
    fairPrice: view.fairPrice,
    fairPriceSource: view.fairPriceSource,
    midpoint: view.midpoint,
    bestBid: view.bestBid,
    bestAsk: view.bestAsk,
    ownMidPrice: view.ownMidPrice,
    ownLastPrice: view.ownLastPrice,
    impliedMidPrice: view.impliedMidPrice,
    impliedLastPrice: view.impliedLastPrice,
    usedSiblingInference: view.usedSiblingInference,
    siblingOutcomeId: view.siblingOutcomeId,
    observedSpreadTicks: spreadPlan.observedSpreadTicks,
    dynamicSpreadTicks: spreadPlan.dynamicSpreadTicks,
    halfSpreadTicks: spreadPlan.halfSpreadTicks,
    baseSpreadPrice: spreadPlan.baseSpreadPrice,
    extremeSpreadPrice: spreadPlan.extremeSpreadPrice,
    inventorySpreadPrice: spreadPlan.inventorySpreadPrice,
    extremeDistanceRatio: roundMetric(spreadPlan.extremeDistanceRatio),
    tightenTicksApplied: spreadPlan.tightenTicksApplied,
    selectiveCompetitiveEnabled: selectiveCompetitivePlan.enabled,
    selectiveCompetitiveReason: selectiveCompetitivePlan.reason,
    selectiveCompetitiveBuyImproveTicks: selectiveCompetitivePlan.buyImproveTicks,
    selectiveCompetitiveSellImproveTicks: selectiveCompetitivePlan.sellImproveTicks,
    selectiveCompetitiveSizeBumpRatio: roundMetric(selectiveCompetitivePlan.sizeBumpRatio),
    inventoryImbalance: roundMetric(inventory.inventoryImbalance),
    inventoryLeanTicks,
    configuredLevelCount: levelCount,
    buyLevels,
    sellLevels,
    availableShares: inventory.availableShares,
    ownShares: inventory.ownShares,
    siblingShares: inventory.siblingShares,
    ownPositionRatio: roundMetric(inventory.ownPositionRatio),
    siblingPositionRatio: roundMetric(inventory.siblingPositionRatio),
    levelSizeMultipliers: config.levelSizeMultipliers,
  };

  let plannedOpenOrders = outcomeOpenOrders;
  let plannedTotalOpenOrders = totalOpenOrders;

  if (buyLevels > 0 && canBuyMore(bot, marketId, quote.outcomeId, positions)) {
    const buyLadder = buildBuyLadder({
      context,
      view,
      config,
      inventory,
      spreadPlan,
      selectiveCompetitivePlan,
      levelCount: buyLevels,
      inventoryLeanTicks,
    });
    const buyActions = planLadder({
      context,
      side: "BUY",
      levels: buyLadder,
      workingOrders: plannedOpenOrders,
      totalOpenOrders: plannedTotalOpenOrders,
      topPrice: view.bestBid,
      fairPrice: view.fairPrice,
      reasonPrefix: "dynamic_market_maker_bid",
      baseDetails: metrics,
    });
    actions.push(...buyActions.actions);
    plannedOpenOrders = buyActions.nextOutcomeOpenOrders;
    plannedTotalOpenOrders = buyActions.nextTotalOpenOrders;
  } else {
    actions.push(
      makeSkipAction("dynamic_market_maker_buy_capacity_skip", marketId, quote.outcomeId, "BUY", {
        ...metrics,
        canBuyMore: canBuyMore(bot, marketId, quote.outcomeId, positions),
      }),
    );
  }

  const desiredSellInventory = sumLevelSizes(
    buildSellLadder({
      context,
      view,
      config,
      inventory,
      spreadPlan,
      selectiveCompetitivePlan,
      levelCount: sellLevels,
      inventoryLeanTicks,
      dryRun: true,
    }),
  );

  if (sellLevels > 0 && compareDecimal(inventory.availableShares, "0.000001") > 0) {
    const sellLadder = buildSellLadder({
      context,
      view,
      config,
      inventory,
      spreadPlan,
      selectiveCompetitivePlan,
      levelCount: sellLevels,
      inventoryLeanTicks,
      dryRun: false,
    });
    const sellActions = planLadder({
      context,
      side: "SELL",
      levels: sellLadder,
      workingOrders: plannedOpenOrders,
      totalOpenOrders: plannedTotalOpenOrders,
      topPrice: view.bestAsk,
      fairPrice: view.fairPrice,
      reasonPrefix: "dynamic_market_maker_ask",
      baseDetails: metrics,
    });
    actions.push(...sellActions.actions);
    plannedOpenOrders = sellActions.nextOutcomeOpenOrders;
    plannedTotalOpenOrders = sellActions.nextTotalOpenOrders;
  } else {
    actions.push(
      makeSkipAction("dynamic_market_maker_no_inventory_skip", marketId, quote.outcomeId, "SELL", {
        ...metrics,
        sellLevels,
      }),
    );
  }

  return actions;
}

export function planDynamicMarketMakerMintReplenishment(params: {
  bot: StrategyContext["bot"];
  marketId: string;
  marketQuotes: QuoteLike[];
  positions: StrategyContext["positions"];
  availableUSDC: string;
  mintedLastHour: string;
}): MintReplenishmentPlan {
  const yesQuote = selectYesQuote(params.marketQuotes);
  const noQuote = selectNoQuote(params.marketQuotes, yesQuote?.outcomeId ?? null);
  const mid = deriveMarketMid(params.bot, yesQuote);
  const emptyPlan = {
    shouldConsider: false,
    shouldMint: false,
    marketId: params.marketId,
    mid,
    yesAvailable: yesQuote ? getAvailableShares(params.positions, params.marketId, yesQuote.outcomeId) : "0",
    noAvailable: noQuote ? getAvailableShares(params.positions, params.marketId, noQuote.outcomeId) : "0",
    minOutcomeAvailable: "0",
    threshold: "0",
    requestedMintAmount: "0",
    finalMintAmount: "0",
    availableUSDC: params.availableUSDC,
    mintedLastHour: params.mintedLastHour,
    hourlyCapacityRemaining: "0",
    effectiveMaxMintAmountPerCycle: "0",
    isExtremeMarket: false,
    reason: "not_binary_market",
  } satisfies MintReplenishmentPlan;

  if (!params.bot.dynamicMarketMaker.enableMintReplenishment || !yesQuote || !noQuote) {
    return {
      ...emptyPlan,
      reason: params.bot.dynamicMarketMaker.enableMintReplenishment ? "not_binary_market" : "mint_replenishment_disabled",
    };
  }

  const yesAvailable = getAvailableShares(params.positions, params.marketId, yesQuote.outcomeId);
  const noAvailable = getAvailableShares(params.positions, params.marketId, noQuote.outcomeId);
  const minOutcomeAvailable = compareDecimal(yesAvailable, noAvailable) <= 0 ? yesAvailable : noAvailable;
  const threshold = multiplyDecimal(
    params.bot.dynamicMarketMaker.targetAskDepthShares,
    formatFactor(params.bot.dynamicMarketMaker.safetyMultiplier),
  );

  if (compareDecimal(minOutcomeAvailable, threshold) >= 0) {
    return {
      ...emptyPlan,
      yesAvailable,
      noAvailable,
      minOutcomeAvailable,
      threshold,
      reason: "threshold_not_met",
    };
  }

  const requestedMintAmount = maxDecimal(
    "0",
    subtractDecimal(params.bot.dynamicMarketMaker.targetInventoryShares, minOutcomeAvailable),
  );
  const isExtremeMarket =
    compareDecimal(mid, formatThreshold(params.bot.dynamicMarketMaker.extremeMintReductionThresholdHigh)) > 0 ||
    compareDecimal(mid, formatThreshold(params.bot.dynamicMarketMaker.extremeMintReductionThresholdLow)) < 0;
  const effectiveMaxMintAmountPerCycle = isExtremeMarket
    ? multiplyDecimal(
        params.bot.dynamicMarketMaker.maxMintAmountPerCycle,
        formatFactor(params.bot.dynamicMarketMaker.extremeMintReductionFactor),
      )
    : params.bot.dynamicMarketMaker.maxMintAmountPerCycle;
  const hourlyCapacityRemaining = maxDecimal(
    "0",
    subtractDecimal(params.bot.dynamicMarketMaker.maxMintPerMarketPerHour, params.mintedLastHour),
  );

  let finalMintAmount = requestedMintAmount;
  finalMintAmount = minDecimal(finalMintAmount, effectiveMaxMintAmountPerCycle);
  finalMintAmount = minDecimal(finalMintAmount, params.availableUSDC);
  finalMintAmount = minDecimal(finalMintAmount, hourlyCapacityRemaining);

  if (compareDecimal(requestedMintAmount, params.bot.dynamicMarketMaker.minMintAmount) < 0) {
    return {
      shouldConsider: true,
      shouldMint: false,
      marketId: params.marketId,
      mid,
      yesAvailable,
      noAvailable,
      minOutcomeAvailable,
      threshold,
      requestedMintAmount,
      finalMintAmount,
      availableUSDC: params.availableUSDC,
      mintedLastHour: params.mintedLastHour,
      hourlyCapacityRemaining,
      effectiveMaxMintAmountPerCycle,
      isExtremeMarket,
      reason: "requested_below_min_mint_amount",
    };
  }

  if (compareDecimal(finalMintAmount, params.bot.dynamicMarketMaker.minMintAmount) < 0) {
    const reason =
      compareDecimal(params.availableUSDC, params.bot.dynamicMarketMaker.minMintAmount) < 0
        ? "insufficient_usdc"
        : compareDecimal(hourlyCapacityRemaining, params.bot.dynamicMarketMaker.minMintAmount) < 0
          ? "hourly_mint_cap_reached"
          : "final_mint_below_min_mint_amount";
    return {
      shouldConsider: true,
      shouldMint: false,
      marketId: params.marketId,
      mid,
      yesAvailable,
      noAvailable,
      minOutcomeAvailable,
      threshold,
      requestedMintAmount,
      finalMintAmount,
      availableUSDC: params.availableUSDC,
      mintedLastHour: params.mintedLastHour,
      hourlyCapacityRemaining,
      effectiveMaxMintAmountPerCycle,
      isExtremeMarket,
      reason,
    };
  }

  return {
    shouldConsider: true,
    shouldMint: true,
    marketId: params.marketId,
    mid,
    yesAvailable,
    noAvailable,
    minOutcomeAvailable,
    threshold,
    requestedMintAmount,
    finalMintAmount,
    availableUSDC: params.availableUSDC,
    mintedLastHour: params.mintedLastHour,
    hourlyCapacityRemaining,
    effectiveMaxMintAmountPerCycle,
    isExtremeMarket,
    reason: null,
  };
}

function buildBinaryView(context: StrategyContext): BinaryView {
  const { bot, quote, marketQuotes } = context;
  const siblingQuote = marketQuotes.find((item) => item.outcomeId !== quote.outcomeId) ?? null;
  const ownBestBid = normalizePrice(bot, quote.bestBid);
  const ownBestAsk = normalizePrice(bot, quote.bestAsk);
  const ownMidPrice = normalizePrice(bot, quote.midPrice);
  const ownLastPrice = normalizePrice(bot, quote.lastPrice);
  const siblingBestBid = siblingQuote ? normalizePrice(bot, siblingQuote.bestBid) : null;
  const siblingBestAsk = siblingQuote ? normalizePrice(bot, siblingQuote.bestAsk) : null;
  const siblingMidPrice = siblingQuote ? normalizePrice(bot, siblingQuote.midPrice) : null;
  const siblingLastPrice = siblingQuote ? normalizePrice(bot, siblingQuote.lastPrice) : null;

  const impliedBestBid = siblingBestAsk ? clampPrice(bot, subtractDecimal("1", siblingBestAsk)) : null;
  const impliedBestAsk = siblingBestBid ? clampPrice(bot, subtractDecimal("1", siblingBestBid)) : null;
  const impliedMidPrice = siblingMidPrice ? clampPrice(bot, subtractDecimal("1", siblingMidPrice)) : null;
  const impliedLastPrice = siblingLastPrice ? clampPrice(bot, subtractDecimal("1", siblingLastPrice)) : null;

  const bestBid = chooseBestBid(ownBestBid, impliedBestBid);
  const bestAsk = chooseBestAsk(ownBestAsk, impliedBestAsk);

  let fairPrice = bot.fallbackFairPrice;
  let fairPriceSource = "fallback_fair_price";
  if (bestBid && bestAsk) {
    fairPrice = midpoint(bestBid, bestAsk);
    fairPriceSource = "book_midpoint";
  } else if (ownLastPrice && impliedLastPrice) {
    fairPrice = midpoint(ownLastPrice, impliedLastPrice);
    fairPriceSource = "last_and_implied_last";
  } else if (ownLastPrice) {
    fairPrice = ownLastPrice;
    fairPriceSource = "last_price";
  } else if (impliedLastPrice) {
    fairPrice = impliedLastPrice;
    fairPriceSource = "implied_sibling_last";
  } else if (ownMidPrice && impliedMidPrice) {
    fairPrice = midpoint(ownMidPrice, impliedMidPrice);
    fairPriceSource = "mid_and_implied_mid";
  } else if (ownMidPrice) {
    fairPrice = ownMidPrice;
    fairPriceSource = "mid_price";
  } else if (impliedMidPrice) {
    fairPrice = impliedMidPrice;
    fairPriceSource = "implied_sibling_mid";
  }

  return {
    fairPrice: clampPrice(bot, fairPrice),
    midpoint: clampPrice(bot, fairPrice),
    bestBid,
    bestAsk,
    siblingBestBid,
    siblingBestAsk,
    siblingOutcomeId: siblingQuote?.outcomeId ?? null,
    ownMidPrice,
    ownLastPrice,
    impliedMidPrice,
    impliedLastPrice,
    usedSiblingInference: Boolean(impliedBestBid || impliedBestAsk || impliedMidPrice || impliedLastPrice),
    fairPriceSource,
  };
}

function buildInventoryProfile(context: StrategyContext, siblingOutcomeId: string | null): InventoryProfile {
  const ownPosition = getPosition(context.positions, context.marketId, context.quote.outcomeId);
  const siblingPosition = siblingOutcomeId
    ? getPosition(context.positions, context.marketId, siblingOutcomeId)
    : undefined;
  const ownShares = ownPosition?.shares ?? "0";
  const siblingShares = siblingPosition?.shares ?? "0";

  return {
    ownShares,
    siblingShares,
    availableShares: getAvailableShares(context.positions, context.marketId, context.quote.outcomeId),
    inventoryImbalance: clampSigned(ratioOfSignedDelta(ownShares, siblingShares, context.bot.maxPositionShares)),
    ownPositionRatio: ratioOf(ownShares, context.bot.maxPositionShares),
    siblingPositionRatio: ratioOf(siblingShares, context.bot.maxPositionShares),
  };
}

function buildSpreadPlan(
  bot: StrategyContext["bot"],
  config: DynamicMarketMakerConfig,
  fairPrice: string,
  inventoryImbalance: number,
  bestBid: string | null,
  bestAsk: string | null,
): SpreadPlan {
  const observedSpreadTicks = quoteSpreadTicks(bestBid, bestAsk, bot.targetSpreadTicks, bot.tickSize);
  const baseSpreadPrice = ticksToDecimal(bot.tickSize, config.baseSpreadTicks);
  const extremeDistanceRatio = computeExtremeDistanceRatio(fairPrice);
  const extremeSpreadPrice = scaleDecimal(
    ticksToDecimal(bot.tickSize, config.extremeSpreadTicks),
    extremeDistanceRatio,
  );
  const inventorySpreadPrice = scaleDecimal(
    ticksToDecimal(bot.tickSize, config.inventorySpreadTicks),
    Math.abs(inventoryImbalance),
  );
  const unclampedSpreadPrice = addDecimal(addDecimal(baseSpreadPrice, extremeSpreadPrice), inventorySpreadPrice);
  const rawSpreadTicks = clampInt(
    priceToTicks(unclampedSpreadPrice, bot.tickSize),
    config.minSpreadTicks,
    config.maxSpreadTicks,
  );
  const shouldTighten =
    config.normalMarketTightenTicks > 0 &&
    compareDecimal(fairPrice, "0.25") >= 0 &&
    compareDecimal(fairPrice, "0.75") <= 0 &&
    Math.abs(inventoryImbalance) <= 0.15 &&
    extremeDistanceRatio <= 0.35;
  const tightenTicksApplied = shouldTighten
    ? Math.min(config.normalMarketTightenTicks, Math.max(0, rawSpreadTicks - config.minSpreadTicks))
    : 0;
  const dynamicSpreadTicks = Math.max(config.minSpreadTicks, rawSpreadTicks - tightenTicksApplied);

  return {
    observedSpreadTicks,
    dynamicSpreadTicks,
    halfSpreadTicks: Math.max(1, Math.ceil(dynamicSpreadTicks / 2)),
    baseSpreadPrice,
    extremeSpreadPrice,
    inventorySpreadPrice,
    extremeDistanceRatio,
    tightenTicksApplied,
  };
}

function buildSelectiveCompetitivePlan(params: {
  context: StrategyContext;
  view: BinaryView;
  inventory: InventoryProfile;
  spreadPlan: SpreadPlan;
}): SelectiveCompetitivePlan {
  const { context, view, inventory, spreadPlan } = params;
  const config = context.bot.dynamicMarketMaker;
  if (config.selectiveCompetitiveTicks <= 0) {
    return {
      enabled: false,
      buyImproveTicks: 0,
      sellImproveTicks: 0,
      sizeBumpRatio: 0,
      reason: "profile_disabled",
    };
  }

  const ownAvailable = getAvailableShares(context.positions, context.marketId, context.quote.outcomeId);
  const siblingAvailable = view.siblingOutcomeId
    ? getAvailableShares(context.positions, context.marketId, view.siblingOutcomeId)
    : "0";
  const replenishmentThreshold = multiplyDecimal(config.targetAskDepthShares, String(config.safetyMultiplier));
  const midSafe =
    compareDecimal(view.midpoint, "0.20") >= 0 &&
    compareDecimal(view.midpoint, "0.85") <= 0;
  const inventoryHealthy =
    compareDecimal(ownAvailable, replenishmentThreshold) >= 0 &&
    compareDecimal(siblingAvailable, replenishmentThreshold) >= 0;
  const cashHealthy = compareDecimal(context.balance.availableUSDC, config.selectiveCompetitiveMinAvailableUSDC) >= 0;
  const lagHealthy = context.recentQuoteLagEvents <= config.selectiveCompetitiveRecentLagLimit;
  const imbalanceHealthy = Math.abs(inventory.inventoryImbalance) <= config.selectiveCompetitiveMaxInventoryImbalance;
  const notExtreme = spreadPlan.extremeDistanceRatio <= 0.65;

  if (!midSafe || !inventoryHealthy || !cashHealthy || !lagHealthy || !imbalanceHealthy || !notExtreme) {
    return {
      enabled: false,
      buyImproveTicks: 0,
      sellImproveTicks: 0,
      sizeBumpRatio: 0,
      reason: !midSafe
        ? "mid_outside_safe_band"
        : !inventoryHealthy
          ? "inventory_below_threshold"
          : !cashHealthy
            ? "available_usdc_not_healthy"
            : !lagHealthy
              ? "quote_lag_too_high"
              : !imbalanceHealthy
                ? "inventory_imbalance_too_high"
                : "extreme_market",
    };
  }

  const buyImproveTicks =
    config.safeCompetitiveJoinTouchBothSides
      ? (
          spreadPlan.observedSpreadTicks >= config.safeCompetitiveMinimumObservedSpreadTicks
            ? config.selectiveCompetitiveTicks
            : 0
        )
      : (
          spreadPlan.observedSpreadTicks >= 3 && inventory.inventoryImbalance <= -0.05
            ? config.selectiveCompetitiveTicks
            : 0
        );
  const sellImproveTicks =
    config.safeCompetitiveJoinTouchBothSides
      ? (
          spreadPlan.observedSpreadTicks >= config.safeCompetitiveMinimumObservedSpreadTicks
            ? config.selectiveCompetitiveTicks
            : 0
        )
      : (
          spreadPlan.observedSpreadTicks >= 2 && inventory.inventoryImbalance >= -0.05
            ? config.selectiveCompetitiveTicks
            : 0
        );

  if (buyImproveTicks <= 0 && sellImproveTicks <= 0) {
    return {
      enabled: false,
      buyImproveTicks: 0,
      sellImproveTicks: 0,
      sizeBumpRatio: 0,
      reason: "no_safe_side_improvement",
    };
  }

  return {
    enabled: true,
    buyImproveTicks,
    sellImproveTicks,
    sizeBumpRatio: config.selectiveCompetitiveSizeBumpRatio,
    reason: "safe_competitive_improvement",
  };
}

function buildBuyLadder(params: {
  context: StrategyContext;
  view: BinaryView;
  config: DynamicMarketMakerConfig;
  inventory: InventoryProfile;
  spreadPlan: SpreadPlan;
  selectiveCompetitivePlan: SelectiveCompetitivePlan;
  levelCount: number;
  inventoryLeanTicks: number;
}): PlannedLevel[] {
  const { context, view, config, inventory, spreadPlan, selectiveCompetitivePlan, levelCount, inventoryLeanTicks } = params;
  const baseReference = shiftPriceByTicks(
    view.fairPrice,
    context.bot.tickSize,
    -(spreadPlan.halfSpreadTicks + Math.max(0, inventoryLeanTicks)),
  );
  const topReference = view.bestBid
    ? minDecimal(shiftPriceByTicks(view.bestBid, context.bot.tickSize, 1), shiftPriceByTicks(view.fairPrice, context.bot.tickSize, -1))
    : baseReference;
  let entryPrice = minDecimal(baseReference, topReference);
  const siblingBidCap = view.siblingBestBid ? clampPrice(context.bot, subtractDecimal("1", view.siblingBestBid)) : null;
  if (siblingBidCap) {
    entryPrice = minDecimal(entryPrice, siblingBidCap);
  }
  if (
    selectiveCompetitivePlan.buyImproveTicks > 0 &&
    levelCount > 0 &&
    hasInsideSpreadRoomForBid(view.bestBid, view.bestAsk, selectiveCompetitivePlan.buyImproveTicks)
  ) {
    entryPrice = clampPrice(
      context.bot,
      shiftPriceByTicks(entryPrice, context.bot.tickSize, selectiveCompetitivePlan.buyImproveTicks),
    );
    if (siblingBidCap) {
      entryPrice = minDecimal(entryPrice, siblingBidCap);
    }
    if (view.bestAsk) {
      entryPrice = minDecimal(entryPrice, shiftPriceByTicks(view.bestAsk, context.bot.tickSize, -1));
    }
  }
  const baseSize = maxAffordableBuySize(context.bot.maxOrderSize, context.balance.availableUSDC, entryPrice);

  if (compareDecimal(baseSize, config.minLevelSize) < 0) {
    return [];
  }

  const buyCapacityRatio = clamp01(
    ratioOf(
      subtractFloor(context.bot.maxPositionShares, inventory.ownShares),
      context.bot.maxPositionShares,
    ),
  );
  const buyInventoryFactor = inventory.inventoryImbalance > 0 ? Math.max(0.1, 1 - inventory.inventoryImbalance) : 1;
  const extremeSizeFactor = deriveExtremeSizeFactor(spreadPlan.extremeDistanceRatio, config);
  const competitivenessSizeFactor =
    selectiveCompetitivePlan.buyImproveTicks > 0 ? 1 + selectiveCompetitivePlan.sizeBumpRatio : 1;
  const baseSizeFactor = Math.max(0.1, buyCapacityRatio * buyInventoryFactor * extremeSizeFactor * competitivenessSizeFactor);

  return Array.from({ length: levelCount }, (_, levelIndex) => {
    const price = clampPrice(
      context.bot,
      shiftPriceByTicks(entryPrice, context.bot.tickSize, -(levelIndex * config.levelSpacingTicks)),
    );
    const levelMultiplier = levelSizeMultiplier(config, levelIndex);
    const size = sizeForLevel(baseSize, config, baseSizeFactor * levelMultiplier);
    return {
      price,
      size,
      details: {
        levelIndex,
        ladderSide: "BUY",
        sizeFactor: roundMetric(baseSizeFactor),
        levelMultiplier: roundMetric(levelMultiplier),
      },
    };
  }).filter((level) => compareDecimal(level.size, "0.000001") > 0);
}

function buildSellLadder(params: {
  context: StrategyContext;
  view: BinaryView;
  config: DynamicMarketMakerConfig;
  inventory: InventoryProfile;
  spreadPlan: SpreadPlan;
  selectiveCompetitivePlan: SelectiveCompetitivePlan;
  levelCount: number;
  inventoryLeanTicks: number;
  dryRun: boolean;
}): PlannedLevel[] {
  const { context, view, config, inventory, spreadPlan, selectiveCompetitivePlan, levelCount, inventoryLeanTicks, dryRun } = params;
  const baseReference = shiftPriceByTicks(
    view.fairPrice,
    context.bot.tickSize,
    spreadPlan.halfSpreadTicks - Math.min(0, inventoryLeanTicks),
  );
  const topReference = view.bestAsk
    ? maxDecimal(shiftPriceByTicks(view.bestAsk, context.bot.tickSize, -1), shiftPriceByTicks(view.fairPrice, context.bot.tickSize, 1))
    : baseReference;
  let entryPrice = maxDecimal(baseReference, topReference);
  const siblingAskFloor = view.siblingBestAsk ? clampPrice(context.bot, subtractDecimal("1", view.siblingBestAsk)) : null;
  if (siblingAskFloor) {
    entryPrice = maxDecimal(entryPrice, siblingAskFloor);
  }
  if (
    selectiveCompetitivePlan.sellImproveTicks > 0 &&
    levelCount > 0 &&
    hasInsideSpreadRoomForAsk(view.bestBid, view.bestAsk, selectiveCompetitivePlan.sellImproveTicks)
  ) {
    entryPrice = clampPrice(
      context.bot,
      shiftPriceByTicks(entryPrice, context.bot.tickSize, -selectiveCompetitivePlan.sellImproveTicks),
    );
    if (siblingAskFloor) {
      entryPrice = maxDecimal(entryPrice, siblingAskFloor);
    }
    if (view.bestBid) {
      entryPrice = maxDecimal(entryPrice, shiftPriceByTicks(view.bestBid, context.bot.tickSize, 1));
    }
  }
  const sizedBase = capDecimal(context.bot.maxOrderSize, inventory.availableShares);
  const sellInventoryFactor = inventory.inventoryImbalance < 0 ? Math.max(0.1, 1 + inventory.inventoryImbalance) : 1;
  const extremeSizeFactor = deriveExtremeSizeFactor(spreadPlan.extremeDistanceRatio, config);
  const competitivenessSizeFactor =
    selectiveCompetitivePlan.sellImproveTicks > 0 ? 1 + selectiveCompetitivePlan.sizeBumpRatio : 1;
  const baseSizeFactor = Math.max(0.1, sellInventoryFactor * extremeSizeFactor * competitivenessSizeFactor);
  let remainingShares = inventory.availableShares;

  return Array.from({ length: levelCount }, (_, levelIndex) => {
    const price = clampPrice(
      context.bot,
      shiftPriceByTicks(entryPrice, context.bot.tickSize, levelIndex * config.levelSpacingTicks),
    );
    const levelMultiplier = levelSizeMultiplier(config, levelIndex);
    let size = sizeForLevel(sizedBase, config, baseSizeFactor * levelMultiplier);
    if (!dryRun) {
      size = capDecimal(size, remainingShares);
      remainingShares = subtractFloor(remainingShares, size);
    }
    return {
      price,
      size,
      details: {
        levelIndex,
        ladderSide: "SELL",
        sizeFactor: roundMetric(baseSizeFactor),
        levelMultiplier: roundMetric(levelMultiplier),
      },
    };
  }).filter((level) => compareDecimal(level.size, "0.000001") > 0);
}

function planLadder(params: {
  context: StrategyContext;
  side: OrderSide;
  levels: PlannedLevel[];
  workingOrders: Order[];
  totalOpenOrders: Order[];
  topPrice: string | null;
  fairPrice: string;
  reasonPrefix: string;
  baseDetails: Record<string, unknown>;
}): {
  actions: StrategyAction[];
  nextOutcomeOpenOrders: Order[];
  nextTotalOpenOrders: Order[];
} {
  const { context, side, levels, topPrice, fairPrice, reasonPrefix, baseDetails } = params;
  const actions: StrategyAction[] = [];
  let workingOrders = params.workingOrders;
  let totalOpenOrders = params.totalOpenOrders;

  for (const level of levels) {
    const planned = planMakerQuote({
      bot: context.bot,
      marketId: context.marketId,
      outcomeId: context.quote.outcomeId,
      side,
      price: level.price,
      size: level.size,
      openOrders: workingOrders,
      totalOpenOrders,
      now: context.now,
      reason: `${reasonPrefix}_l${level.details.levelIndex}`,
      topPrice,
      fairPrice,
    }).map((action) => decorateAction(action, baseDetails, level.details));
    actions.push(...planned);
    const updated = applyPlannedActions(planned, workingOrders, totalOpenOrders, context);
    workingOrders = updated.nextOutcomeOpenOrders;
    totalOpenOrders = updated.nextTotalOpenOrders;
  }

  return {
    actions,
    nextOutcomeOpenOrders: workingOrders,
    nextTotalOpenOrders: totalOpenOrders,
  };
}

function applyPlannedActions(
  actions: StrategyAction[],
  outcomeOpenOrders: Order[],
  totalOpenOrders: Order[],
  context: StrategyContext,
): {
  nextOutcomeOpenOrders: Order[];
  nextTotalOpenOrders: Order[];
} {
  let nextOutcomeOpenOrders = outcomeOpenOrders;
  let nextTotalOpenOrders = totalOpenOrders;

  for (const action of actions) {
    if (action.type === "cancel") {
      nextOutcomeOpenOrders = nextOutcomeOpenOrders.filter((order) => order.id !== action.orderId);
      nextTotalOpenOrders = nextTotalOpenOrders.filter((order) => order.id !== action.orderId);
      continue;
    }

    if (action.type !== "place") {
      continue;
    }

    const placeholder: Order = {
      id: `planned:${action.clientOrderId}`,
      clientOrderId: action.clientOrderId,
      marketId: action.marketId,
      outcomeId: action.outcomeId,
      side: action.side,
      type: "LIMIT",
      status: "OPEN",
      apiKeyId: null,
      price: action.price,
      size: action.size,
      remaining: action.size,
      reservedNotional: action.side === "BUY" ? action.price : "0",
      createdAt: context.now.toISOString(),
    };
    nextOutcomeOpenOrders = [...nextOutcomeOpenOrders, placeholder];
    nextTotalOpenOrders = [...nextTotalOpenOrders, placeholder];
  }

  return {
    nextOutcomeOpenOrders,
    nextTotalOpenOrders,
  };
}

function decorateAction(
  action: StrategyAction,
  baseDetails: Record<string, unknown>,
  levelDetails: Record<string, unknown>,
): StrategyAction {
  const details = {
    ...baseDetails,
    ...levelDetails,
    ...(action.details ?? {}),
  };

  if (action.type === "cancel") {
    return { ...action, details };
  }

  if (action.type === "skip") {
    return { ...action, details };
  }

  return { ...action, details };
}

function deriveLevelCount(config: DynamicMarketMakerConfig, dynamicSpreadTicks: number): number {
  const derived = 1 + Math.floor((dynamicSpreadTicks - config.minSpreadTicks) / Math.max(1, config.levelSpacingTicks));
  return clampInt(derived, config.minLevelsPerSide, config.maxLevelsPerSide);
}

function reduceLevelsForPressure(levelCount: number, pressure: number, config: DynamicMarketMakerConfig): number {
  let next = levelCount;
  if (pressure >= config.inventoryReduceThreshold) {
    next -= 1;
  }
  if (pressure >= config.inventoryEmergencyThreshold) {
    next -= 1;
  }
  return Math.max(0, next);
}

function hasInsideSpreadRoomForBid(bestBid: string | null, bestAsk: string | null, improveTicks: number): boolean {
  if (!bestBid || !bestAsk || improveTicks <= 0) {
    return false;
  }
  return priceToTicks(subtractDecimal(bestAsk, bestBid), "0.01") > improveTicks;
}

function hasInsideSpreadRoomForAsk(bestBid: string | null, bestAsk: string | null, improveTicks: number): boolean {
  if (!bestBid || !bestAsk || improveTicks <= 0) {
    return false;
  }
  return priceToTicks(subtractDecimal(bestAsk, bestBid), "0.01") > improveTicks;
}

function sizeForLevel(baseSize: string, config: DynamicMarketMakerConfig, sizeFactor: number): string {
  const scaled = scaleDecimal(baseSize, Math.max(0, sizeFactor));
  return compareDecimal(scaled, config.minLevelSize) < 0 ? "0" : scaled;
}

function sumLevelSizes(levels: PlannedLevel[]): string {
  let total = 0n;
  for (const level of levels) {
    total += decimalToUnits(level.size);
  }
  return unitsToDecimal(total);
}

function quoteSpreadTicks(bestBid: string | null, bestAsk: string | null, fallback: number, tickSize: string): number {
  if (!bestBid || !bestAsk) {
    return fallback;
  }

  const tickUnits = decimalToUnits(tickSize);
  const spreadUnits = decimalToUnits(bestAsk) - decimalToUnits(bestBid);
  if (spreadUnits <= 0n || tickUnits <= 0n) {
    return fallback;
  }
  return Number(spreadUnits / tickUnits);
}

function chooseBestBid(ownBestBid: string | null, impliedBestBid: string | null): string | null {
  if (ownBestBid && impliedBestBid) {
    return compareDecimal(ownBestBid, impliedBestBid) >= 0 ? ownBestBid : impliedBestBid;
  }
  return ownBestBid ?? impliedBestBid;
}

function chooseBestAsk(ownBestAsk: string | null, impliedBestAsk: string | null): string | null {
  if (ownBestAsk && impliedBestAsk) {
    return compareDecimal(ownBestAsk, impliedBestAsk) <= 0 ? ownBestAsk : impliedBestAsk;
  }
  return ownBestAsk ?? impliedBestAsk;
}

function scaleDecimal(value: string, factor: number): string {
  const scaledFactor = BigInt(Math.max(0, Math.round(factor * 1_000_000)));
  return unitsToDecimal((decimalToUnits(value) * scaledFactor) / 1_000_000n);
}

function ratioOf(value: string, maxValue: string): number {
  const numerator = Number(decimalToUnits(value));
  const denominator = Number(decimalToUnits(maxValue));
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return clamp01(numerator / denominator);
}

function ratioOfSignedDelta(a: string, b: string, maxValue: string): number {
  const delta = Number(decimalToUnits(a) - decimalToUnits(b));
  const denominator = Number(decimalToUnits(maxValue));
  if (!Number.isFinite(delta) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return delta / denominator;
}

function subtractFloor(a: string, b: string): string {
  return compareDecimal(a, b) <= 0 ? "0" : subtractDecimal(a, b);
}

function capDecimal(value: string, cap: string): string {
  return compareDecimal(value, cap) <= 0 ? value : cap;
}

function computeExtremeDistanceRatio(fairPrice: string): number {
  const distanceFromCenter = Math.abs(Number(fairPrice) - 0.5);
  return clamp01(distanceFromCenter / 0.49);
}

function deriveExtremeSizeFactor(extremeDistanceRatio: number, config: DynamicMarketMakerConfig): number {
  return Math.max(0.1, 1 - extremeDistanceRatio * config.extremeSizeReduction);
}

function levelSizeMultiplier(config: DynamicMarketMakerConfig, levelIndex: number): number {
  return config.levelSizeMultipliers[Math.min(levelIndex, config.levelSizeMultipliers.length - 1)] ?? 1;
}

function priceToTicks(price: string, tickSize: string): number {
  const tickUnits = decimalToUnits(tickSize);
  if (tickUnits <= 0n) {
    return 0;
  }
  return Number(decimalToUnits(price) / tickUnits);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

type QuoteLike = StrategyContext["marketQuotes"][number];

function selectYesQuote(quotes: QuoteLike[]): QuoteLike | null {
  const explicit = quotes.find((quote) => quote.outcomeName.trim().toUpperCase() === "YES");
  return explicit ?? quotes[0] ?? null;
}

function selectNoQuote(quotes: QuoteLike[], yesOutcomeId: string | null): QuoteLike | null {
  const explicit = quotes.find((quote) => quote.outcomeName.trim().toUpperCase() === "NO");
  if (explicit) {
    return explicit;
  }
  return quotes.find((quote) => quote.outcomeId !== yesOutcomeId) ?? null;
}

function deriveMarketMid(bot: StrategyContext["bot"], quote: QuoteLike | null): string {
  if (!quote) {
    return bot.fallbackFairPrice;
  }

  return (
    normalizePrice(bot, quote.midPrice) ??
    normalizePrice(bot, quote.lastPrice) ??
    normalizePrice(bot, quote.bestBid) ??
    normalizePrice(bot, quote.bestAsk) ??
    bot.fallbackFairPrice
  );
}

function formatFactor(value: number): string {
  return value.toFixed(6);
}

function formatThreshold(value: number): string {
  return value.toFixed(2);
}

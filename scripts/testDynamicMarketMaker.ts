import assert from "node:assert/strict";

import { Balance, Order, Position, Quote } from "../src/api/types.js";
import { BotConfig } from "../src/config/loadConfig.js";
import {
  dynamicMarketMakerStrategy,
  planDynamicMarketMakerMintReplenishment,
} from "../src/strategies/dynamicMarketMaker.js";
import { StrategyContext } from "../src/strategies/common.js";

function main() {
  testBuildsMultiLevelLadderFromBinaryQuotes();
  testPrefersLastPriceBeforeFallbackFairPrice();
  testUsesBinaryInventoryImbalanceAcrossOutcomes();
  testMintReplenishmentNeutralLowInventory();
  testMintReplenishmentBullishYesKeepsMidAnchored();
  testMintReplenishmentExtremeYesReducesSize();
  testBinaryAskPairClampUsesSiblingAsk();
  testBinaryBidPairClampUsesSiblingBid();
  testMintReplenishmentSkipsOnInsufficientUsdc();
  testMintReplenishmentHonorsHourlyCap();
  console.log("dynamicMarketMaker checks passed");
}

function testBuildsMultiLevelLadderFromBinaryQuotes() {
  const bot = createBotConfig({
    inventoryTargetShares: "2.500000",
    replaceThresholdTicks: 0,
    replaceHysteresisTicks: 0,
    dynamicMarketMaker: {
      replenishmentTargetShares: "2.500000",
    },
  });
  const yesQuote: Quote = {
    outcomeId: "yes",
    outcomeName: "YES",
    bestBid: "0.44",
    bestAsk: "0.56",
    midPrice: "0.50",
    lastPrice: "0.50",
    lastTradeAt: null,
  };
  const noQuote: Quote = {
    outcomeId: "no",
    outcomeName: "NO",
    bestBid: "0.43",
    bestAsk: "0.55",
    midPrice: "0.49",
    lastPrice: "0.49",
    lastTradeAt: null,
  };
  const context = createContext(bot, yesQuote, [yesQuote, noQuote], "2.500000", "2.500000");

  const actions = dynamicMarketMakerStrategy(context);
  const placeActions = actions.filter((action) => action.type === "place");
  const buyActions = placeActions.filter((action) => action.side === "BUY");
  const sellActions = placeActions.filter((action) => action.side === "SELL");

  assert.ok(buyActions.length >= 2, "expected multiple bid levels");
  assert.ok(sellActions.length >= 2, "expected multiple ask levels");
  assert.equal(buyActions[0]?.details?.strategy, "dynamicMarketMaker");
  assert.equal(buyActions[0]?.details?.usedSiblingInference, true);
  assert.equal(buyActions[0]?.details?.siblingOutcomeId, "no");
}

function testPrefersLastPriceBeforeFallbackFairPrice() {
  const bot = createBotConfig({
    fallbackFairPrice: "0.50",
  });
  const yesQuote: Quote = {
    outcomeId: "yes",
    outcomeName: "YES",
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    lastPrice: "0.63",
    lastTradeAt: null,
  };
  const noQuote: Quote = {
    outcomeId: "no",
    outcomeName: "NO",
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    lastPrice: null,
    lastTradeAt: null,
  };
  const context = createContext(bot, yesQuote, [yesQuote, noQuote], "1.000000", "1.000000");
  const actions = dynamicMarketMakerStrategy(context);
  const place = actions.find((action) => action.type === "place");

  assert.ok(place, "expected at least one place action");
  assert.equal(place?.details?.fairPrice, "0.63");
  assert.equal(place?.details?.fairPriceSource, "last_price");
}

function testUsesBinaryInventoryImbalanceAcrossOutcomes() {
  const bot = createBotConfig();
  const yesQuote: Quote = {
    outcomeId: "yes",
    outcomeName: "YES",
    bestBid: "0.48",
    bestAsk: "0.52",
    midPrice: "0.50",
    lastPrice: "0.50",
    lastTradeAt: null,
  };
  const noQuote: Quote = {
    outcomeId: "no",
    outcomeName: "NO",
    bestBid: "0.48",
    bestAsk: "0.52",
    midPrice: "0.50",
    lastPrice: "0.50",
    lastTradeAt: null,
  };
  const context = createContext(bot, yesQuote, [yesQuote, noQuote], "4.000000", "2.000000", [
    {
      marketId: "market-1",
      marketTitle: "Test Market",
      marketStatus: "LIVE",
      outcomeId: "no",
      outcomeName: "NO",
      shares: "0.500000",
      reservedShares: "0",
      avgCost: "0.50",
      realizedPnl: "0",
      updatedAt: new Date().toISOString(),
    },
  ]);
  const actions = dynamicMarketMakerStrategy(context);
  const buySkip = actions.find((action) => action.type === "skip" && action.reason === "dynamic_market_maker_buy_capacity_skip");
  const place = actions.find((action) => action.type === "place");

  assert.ok(!buySkip, "expected buy side to remain active below emergency imbalance");
  assert.equal(place?.details?.inventoryImbalance, 0.7);
  assert.equal(place?.details?.siblingShares, "0.500000");
}

function testMintReplenishmentNeutralLowInventory() {
  const bot = createBotConfig();
  const { quote, marketQuotes, positions } = createBinaryInventorySetup({
    yesMid: "0.50",
    noMid: "0.50",
    yesAvailable: "40.000000",
    noAvailable: "40.000000",
  });

  const plan = planDynamicMarketMakerMintReplenishment({
    bot,
    marketId: "market-1",
    marketQuotes,
    positions,
    availableUSDC: "500.000000",
    mintedLastHour: "0",
  });
  const actions = dynamicMarketMakerStrategy(
    createContext(bot, quote, marketQuotes, "40.000000", "40.000000", [positions[1]]),
  );
  const place = actions.find((action) => action.type === "place" && action.side === "SELL");

  assert.equal(plan.shouldMint, true);
  assert.equal(plan.finalMintAmount, "260");
  assert.equal(plan.mid, "0.5");
  assert.ok(place, "expected sell quote after planning");
  assert.equal(place?.details?.fairPrice, "0.5");
}

function testMintReplenishmentBullishYesKeepsMidAnchored() {
  const bot = createBotConfig();
  const { quote, marketQuotes, positions } = createBinaryInventorySetup({
    yesMid: "0.80",
    noMid: "0.20",
    yesAvailable: "40.000000",
    noAvailable: "300.000000",
  });

  const plan = planDynamicMarketMakerMintReplenishment({
    bot,
    marketId: "market-1",
    marketQuotes,
    positions,
    availableUSDC: "500.000000",
    mintedLastHour: "0",
  });
  const actions = dynamicMarketMakerStrategy(
    createContext(bot, quote, marketQuotes, "40.000000", "40.000000", [positions[1]]),
  );
  const anchoredAction = actions.find((action) => action.details?.fairPrice === "0.8");

  assert.equal(plan.shouldMint, true);
  assert.equal(plan.finalMintAmount, "260");
  assert.equal(plan.mid, "0.8");
  assert.ok(anchoredAction, "expected strategy details to remain anchored near 0.80");
}

function testMintReplenishmentExtremeYesReducesSize() {
  const bot = createBotConfig();
  const { quote, marketQuotes, positions } = createBinaryInventorySetup({
    yesMid: "0.92",
    noMid: "0.08",
    yesAvailable: "20.000000",
    noAvailable: "400.000000",
  });

  const plan = planDynamicMarketMakerMintReplenishment({
    bot,
    marketId: "market-1",
    marketQuotes,
    positions,
    availableUSDC: "500.000000",
    mintedLastHour: "0",
  });
  const actions = dynamicMarketMakerStrategy(
    createContext(bot, quote, marketQuotes, "20.000000", "20.000000", [positions[1]]),
  );
  const anchoredActions = actions.filter((action) => action.details?.fairPrice === "0.92");

  assert.equal(plan.shouldMint, true);
  assert.equal(plan.isExtremeMarket, true);
  assert.equal(plan.effectiveMaxMintAmountPerCycle, "105");
  assert.equal(plan.finalMintAmount, "105");
  assert.ok(anchoredActions.length > 0, "expected strategy details to remain anchored near 0.92");
}

function testBinaryAskPairClampUsesSiblingAsk() {
  const bot = createBotConfig();
  const yesQuote: Quote = {
    outcomeId: "yes",
    outcomeName: "YES",
    bestBid: "0.79",
    bestAsk: "0.81",
    midPrice: "0.80",
    lastPrice: "0.80",
    lastTradeAt: null,
  };
  const noQuote: Quote = {
    outcomeId: "no",
    outcomeName: "NO",
    bestBid: "0.17",
    bestAsk: "0.18",
    midPrice: "0.18",
    lastPrice: "0.18",
    lastTradeAt: null,
  };

  const actions = dynamicMarketMakerStrategy(
    createContext(bot, yesQuote, [yesQuote, noQuote], "40.000000", "40.000000", [
      {
        marketId: "market-1",
        marketTitle: "Test Market",
        marketStatus: "LIVE",
        outcomeId: "no",
        outcomeName: "NO",
        shares: "40.000000",
        reservedShares: "0",
        avgCost: "0.18",
        realizedPnl: "0",
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  const firstSell = actions.find((action) => action.type === "place" && action.side === "SELL");

  assert.ok(firstSell, "expected a sell quote");
  assert.ok(Number(firstSell?.price) >= 0.82, "expected sell quote to respect sibling ask floor");
}

function testBinaryBidPairClampUsesSiblingBid() {
  const bot = createBotConfig();
  const yesQuote: Quote = {
    outcomeId: "yes",
    outcomeName: "YES",
    bestBid: "0.79",
    bestAsk: "0.81",
    midPrice: "0.80",
    lastPrice: "0.80",
    lastTradeAt: null,
  };
  const noQuote: Quote = {
    outcomeId: "no",
    outcomeName: "NO",
    bestBid: "0.22",
    bestAsk: "0.24",
    midPrice: "0.23",
    lastPrice: "0.23",
    lastTradeAt: null,
  };

  const actions = dynamicMarketMakerStrategy(
    createContext(bot, yesQuote, [yesQuote, noQuote], "1.000000", "1.000000", [
      {
        marketId: "market-1",
        marketTitle: "Test Market",
        marketStatus: "LIVE",
        outcomeId: "no",
        outcomeName: "NO",
        shares: "1.000000",
        reservedShares: "0",
        avgCost: "0.23",
        realizedPnl: "0",
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  const firstBuy = actions.find((action) => action.type === "place" && action.side === "BUY");

  assert.ok(firstBuy, "expected a buy quote");
  assert.ok(Number(firstBuy?.price) <= 0.78, "expected buy quote to respect sibling bid cap");
}

function testMintReplenishmentSkipsOnInsufficientUsdc() {
  const bot = createBotConfig();
  const { marketQuotes, positions } = createBinaryInventorySetup({
    yesMid: "0.50",
    noMid: "0.50",
    yesAvailable: "40.000000",
    noAvailable: "40.000000",
  });

  const plan = planDynamicMarketMakerMintReplenishment({
    bot,
    marketId: "market-1",
    marketQuotes,
    positions,
    availableUSDC: "20.000000",
    mintedLastHour: "0",
  });

  assert.equal(plan.shouldMint, false);
  assert.equal(plan.reason, "insufficient_usdc");
}

function testMintReplenishmentHonorsHourlyCap() {
  const bot = createBotConfig();
  const { marketQuotes, positions } = createBinaryInventorySetup({
    yesMid: "0.50",
    noMid: "0.50",
    yesAvailable: "40.000000",
    noAvailable: "40.000000",
  });

  const cappedPlan = planDynamicMarketMakerMintReplenishment({
    bot,
    marketId: "market-1",
    marketQuotes,
    positions,
    availableUSDC: "500.000000",
    mintedLastHour: "980.000000",
  });
  const blockedPlan = planDynamicMarketMakerMintReplenishment({
    bot,
    marketId: "market-1",
    marketQuotes,
    positions,
    availableUSDC: "500.000000",
    mintedLastHour: "990.000000",
  });

  assert.equal(cappedPlan.shouldMint, false);
  assert.equal(cappedPlan.reason, "hourly_mint_cap_reached");
  assert.equal(blockedPlan.shouldMint, false);
  assert.equal(blockedPlan.reason, "hourly_mint_cap_reached");
}

function createContext(
  bot: BotConfig,
  quote: Quote,
  marketQuotes: Quote[],
  totalShares: string,
  availableShares: string,
  extraPositions: Position[] = [],
): StrategyContext {
  const balance: Balance = {
    availableUSDC: "100.000000",
    lockedUSDC: "0",
    totalUSDC: "100.000000",
    updatedAt: new Date().toISOString(),
  };
  const positions: Position[] = [
    {
      marketId: "market-1",
      marketTitle: "Test Market",
      marketStatus: "LIVE",
      outcomeId: quote.outcomeId,
      outcomeName: quote.outcomeName,
      shares: totalShares,
      reservedShares: subtractShare(totalShares, availableShares),
      avgCost: "0.50",
      realizedPnl: "0",
      updatedAt: new Date().toISOString(),
    },
    ...extraPositions,
  ];

  return {
    bot,
    marketId: "market-1",
    quote,
    marketQuotes,
    balance,
    positions,
    totalOpenOrders: [] as Order[],
    marketOpenOrders: [] as Order[],
    outcomeOpenOrders: [] as Order[],
    now: new Date(),
  };
}

function createBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base: BotConfig = {
    name: "dynamic-mm-test",
    baseUrl: "http://localhost:3000",
    apiKey: "test.secret",
    strategy: "dynamicMarketMaker",
    marketIds: ["market-1"],
    pollIntervalMs: 2000,
    loopIntervalMinMs: 1000,
    loopIntervalMaxMs: 2000,
    maxOrderSize: "1.000000",
    maxTakerSize: "0.250000",
    maxOpenOrders: 12,
    staleOrderMs: 8000,
    minQuoteLifetimeMs: 5000,
    decisionCooldownMs: 1200,
    capBackoffMs: 8000,
    tickSize: "0.01",
    maxPositionShares: "5.000000",
    inventoryTargetShares: "1.000000",
    targetSpreadTicks: 2,
    quoteOffsetMinTicks: 0,
    quoteOffsetMaxTicks: 1,
    staleDistanceTicks: 4,
    replaceThresholdTicks: 1,
    replaceHysteresisTicks: 1,
    maxOrdersPerSide: 3,
    takerProbability: 0,
    takerThresholdTicks: 1,
    inventorySkewStrength: 3,
    fallbackFairPrice: "0.50",
    dailyNotionalPauseMode: "pause_for_run",
    dailyNotionalCooldownMs: 86_400_000,
    pausedPollIntervalMs: 45_000,
    pauseLogIntervalMs: 60_000,
    dynamicMarketMaker: {
      minLevelsPerSide: 1,
      maxLevelsPerSide: 3,
      levelSpacingTicks: 1,
      minSpreadTicks: 2,
      maxSpreadTicks: 8,
      baseSpreadTicks: 2,
      extremeSpreadTicks: 3,
      inventorySpreadTicks: 2,
      inventoryLeanTicks: 3,
      inventoryReduceThreshold: 0.65,
      inventoryEmergencyThreshold: 0.92,
      levelSizeMultipliers: [1, 0.7, 0.45],
      extremeSizeReduction: 0.55,
      minLevelSize: "0.100000",
      replenishmentTargetShares: "1.000000",
      enableMintReplenishment: true,
      targetAskDepthShares: "100.000000",
      safetyMultiplier: 1.2,
      targetInventoryShares: "300.000000",
      minMintAmount: "50.000000",
      maxMintAmountPerCycle: "300.000000",
      maxMintPerMarketPerHour: "1000.000000",
      extremeMintReductionThresholdHigh: 0.85,
      extremeMintReductionThresholdLow: 0.15,
      extremeMintReductionFactor: 0.35,
      quoteKeepBandTicks: 0,
      quoteKeepSizeToleranceRatio: 0,
      normalMarketTightenTicks: 0,
      selectiveCompetitiveTicks: 0,
      selectiveCompetitiveSizeBumpRatio: 0,
      selectiveCompetitiveMaxInventoryImbalance: 0,
      selectiveCompetitiveMinAvailableUSDC: "0",
      selectiveCompetitiveRecentLagLimit: 0,
      safeCompetitiveJoinTouchBothSides: false,
      safeCompetitiveMinimumObservedSpreadTicks: 2,
    },
    risk: {
      botUserId: "dynamic-mm-test-user",
      enabled: true,
      maxTotalCapitalCents: 500000,
      maxCapitalPerMarketCents: 100000,
      maxOpenOrderNotionalCents: 5000,
      maxOrderSizeCents: 100,
      maxDailyLossCents: 100000,
      maxDailySubmittedNotionalCents: 1000000,
      maxYesSharesPerMarket: "300.000000",
      maxNoSharesPerMarket: "300.000000",
      maxOrdersPerMarket: 12,
      maxQuoteLevelsPerSide: 3,
      staleDataMaxAgeMs: 15000,
      pauseNearResolutionMinutes: 0,
      repeatedErrorPauseMs: 30000,
      inventoryReduceOnlyThreshold: 0.85,
      inventoryStopThreshold: 0.98,
      emergencyStopOnInvariantViolation: true,
      emergencyStopOnRepeatedApiErrors: true,
      emergencyStopOnBalanceMismatch: true,
      repeatedApiErrorThreshold: 5,
      repeatedApiErrorWindowMs: 60000,
      repeatedCancelConflictThreshold: 5,
      repeatedStaleStateThreshold: 10,
      cancelOpenOrdersOnPause: false,
      cancelOpenOrdersOnEmergencyStop: true,
    },
  };

  return {
    ...base,
    ...overrides,
    dynamicMarketMaker: {
      ...base.dynamicMarketMaker,
      ...(overrides.dynamicMarketMaker ?? {}),
    },
  };
}

function subtractShare(totalShares: string, availableShares: string): string {
  const total = Number(totalShares);
  const available = Number(availableShares);
  return Math.max(0, total - available).toFixed(6);
}

function createBinaryInventorySetup(params: {
  yesMid: string;
  noMid: string;
  yesAvailable: string;
  noAvailable: string;
}) {
  const yesQuote: Quote = {
    outcomeId: "yes",
    outcomeName: "YES",
    bestBid: params.yesMid,
    bestAsk: params.yesMid,
    midPrice: params.yesMid,
    lastPrice: params.yesMid,
    lastTradeAt: null,
  };
  const noQuote: Quote = {
    outcomeId: "no",
    outcomeName: "NO",
    bestBid: params.noMid,
    bestAsk: params.noMid,
    midPrice: params.noMid,
    lastPrice: params.noMid,
    lastTradeAt: null,
  };
  const positions: Position[] = [
    {
      marketId: "market-1",
      marketTitle: "Test Market",
      marketStatus: "LIVE",
      outcomeId: "yes",
      outcomeName: "YES",
      shares: params.yesAvailable,
      reservedShares: "0",
      avgCost: params.yesMid,
      realizedPnl: "0",
      updatedAt: new Date().toISOString(),
    },
    {
      marketId: "market-1",
      marketTitle: "Test Market",
      marketStatus: "LIVE",
      outcomeId: "no",
      outcomeName: "NO",
      shares: params.noAvailable,
      reservedShares: "0",
      avgCost: params.noMid,
      realizedPnl: "0",
      updatedAt: new Date().toISOString(),
    },
  ];

  return {
    quote: yesQuote,
    marketQuotes: [yesQuote, noQuote],
    positions,
  };
}

main();

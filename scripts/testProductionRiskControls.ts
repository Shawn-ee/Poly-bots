import assert from "node:assert/strict";

import { PolyApiError } from "../src/api/apiClient.js";
import { Balance, Order, Position, QuoteResponse } from "../src/api/types.js";
import { BotConfig } from "../src/config/loadConfig.js";
import { BotRiskManager } from "../src/runner/botRiskManager.js";

async function main() {
  await testStaleStateTrigger();
  await testMaxExposureTrigger();
  await testRepeatedApiErrorTrigger();
  await testEmergencyStopCancelRequest();
  console.log("production risk control checks passed");
}

async function testStaleStateTrigger() {
  const manager = createManager(createBotConfig());
  const evaluation = await manager.evaluateMarket({
    marketId: "market-1",
    balance: createBalance(),
    positions: createPositions(),
    openOrders: [],
    quoteResponse: createQuoteResponse(),
    freshness: {
      marketStateAgeMs: 20_000,
      accountStateAgeMs: 20_000,
      staleStateDetectedCount: 1,
    },
  });
  assert.equal(evaluation.state, "paused");
  assert.equal(evaluation.reason, "stale_state_pause");
}

async function testMaxExposureTrigger() {
  const manager = createManager(createBotConfig({
    risk: {
      maxCapitalPerMarketCents: 50,
    },
  }));
  const evaluation = await manager.evaluateMarket({
    marketId: "market-1",
    balance: createBalance(),
    positions: createPositions(),
    openOrders: [],
    quoteResponse: createQuoteResponse(),
    freshness: {
      marketStateAgeMs: 1_000,
      accountStateAgeMs: 1_000,
      staleStateDetectedCount: 0,
    },
  });
  const decision = manager.checkPlacement({
    marketId: "market-1",
    outcomeId: "yes",
    action: {
      type: "place",
      reason: "test",
      side: "BUY",
      marketId: "market-1",
      outcomeId: "yes",
      price: "0.60",
      size: "1.000000",
      idempotencyKey: "id",
      clientOrderId: "id",
    },
    balance: createBalance(),
    positions: createPositions(),
    openOrders: [],
    quote: createQuoteResponse().quotes[0]!,
    marketQuotes: createQuoteResponse().quotes,
    freshness: {
      marketStateAgeMs: 1_000,
      accountStateAgeMs: 1_000,
      staleStateDetectedCount: 0,
    },
    evaluation,
  });
  assert.equal(decision.allow, false);
  if (!decision.allow) {
    assert.equal(decision.reason, "max_per_market_exposure");
  }
}

async function testRepeatedApiErrorTrigger() {
  const manager = createManager(createBotConfig());
  for (let i = 0; i < 5; i += 1) {
    manager.noteApiError(new PolyApiError(500, "HTTP_ERROR", "server down"), {
      stage: "place_order",
      marketId: "market-1",
    });
  }
  const evaluation = await manager.evaluateMarket({
    marketId: "market-1",
    balance: createBalance(),
    positions: createPositions(),
    openOrders: [],
    quoteResponse: createQuoteResponse(),
    freshness: {
      marketStateAgeMs: 1_000,
      accountStateAgeMs: 1_000,
      staleStateDetectedCount: 0,
    },
  });
  assert.equal(evaluation.state, "emergency_stop");
  assert.equal(evaluation.reason, "repeated_api_errors");
}

async function testEmergencyStopCancelRequest() {
  const manager = createManager(createBotConfig());
  manager.noteApiError(new PolyApiError(409, "BINARY_INVARIANT_VIOLATION", "nope"), {
    stage: "place_order",
    marketId: "market-1",
  });
  assert.equal(manager.shouldCancelAllOpenOrders(), true);
  assert.equal(manager.shouldCancelAllOpenOrders(), false);
}

function createManager(bot: BotConfig) {
  return new BotRiskManager(
    bot,
    "systemLiquidity",
    {
      listMarkets: async () => ({ markets: [] }),
    } as never,
    {
      info() {},
      warn() {},
      error() {},
    } as never,
  );
}

function createBotConfig(overrides: Partial<BotConfig> & { risk?: Partial<BotConfig["risk"]> } = {}): BotConfig {
  const base: BotConfig = {
    name: "risk-test-bot",
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
      botUserId: "bot-user",
      enabled: true,
      maxTotalCapitalCents: 500000,
      maxCapitalPerMarketCents: 100000,
      maxOpenOrderNotionalCents: 5000,
      maxOrderSizeCents: 100,
      maxDailyLossCents: 100000,
      maxDailySubmittedNotionalCents: 1000000,
      maxYesSharesPerMarket: "5.000000",
      maxNoSharesPerMarket: "5.000000",
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
    risk: {
      ...base.risk,
      ...(overrides.risk ?? {}),
    },
  };
}

function createBalance(): Balance {
  return {
    availableUSDC: "1000.000000",
    lockedUSDC: "0",
    totalUSDC: "1000.000000",
    updatedAt: new Date().toISOString(),
  };
}

function createPositions(): Position[] {
  return [
    {
      marketId: "market-1",
      marketTitle: "Market",
      marketStatus: "LIVE",
      outcomeId: "yes",
      outcomeName: "YES",
      shares: "1.000000",
      reservedShares: "0",
      avgCost: "0.50",
      realizedPnl: "0",
      updatedAt: new Date().toISOString(),
    },
    {
      marketId: "market-1",
      marketTitle: "Market",
      marketStatus: "LIVE",
      outcomeId: "no",
      outcomeName: "NO",
      shares: "1.000000",
      reservedShares: "0",
      avgCost: "0.50",
      realizedPnl: "0",
      updatedAt: new Date().toISOString(),
    },
  ];
}

function createQuoteResponse(): QuoteResponse {
  return {
    marketId: "market-1",
    quotes: [
      {
        outcomeId: "yes",
        outcomeName: "YES",
        bestBid: "0.49",
        bestAsk: "0.51",
        midPrice: "0.50",
        lastPrice: "0.50",
        lastTradeAt: null,
      },
      {
        outcomeId: "no",
        outcomeName: "NO",
        bestBid: "0.49",
        bestAsk: "0.51",
        midPrice: "0.50",
        lastPrice: "0.50",
        lastTradeAt: null,
      },
    ],
  };
}

main();

import assert from "node:assert/strict";

import { Balance, MarketReferencePlanResponse, Order, Position, Quote } from "../src/api/types.js";
import { BotConfig } from "../src/config/loadConfig.js";
import { DEFAULT_REFERENCE_ARBITRAGE_REBALANCER_CONFIG } from "../src/strategies/referenceArbitrageConfig.js";
import {
  collectReferenceArbitrageCleanupActions,
  referenceArbitrageRebalancerStrategy,
} from "../src/strategies/referenceArbitrageRebalancer.js";
import { ReferenceArbitrageContext } from "../src/strategies/referenceArbitrageTypes.js";

function main() {
  testBuysUndervaluedOutcomeAboveThreshold();
  testDryRunConvertsPlacementsIntoSkips();
  testDryRunConvertsCancelsIntoSkips();
  testSkipsWhenEdgeOnlyMeetsThreshold();
  testSkipsOnExplicitlyStaleReference();
  testCleanupCancelsStaleNonMarktableOrder();
  testRespectsOneSidedBankrollCap();
  testLiveBankrollOverrideCapsSizing();
  testDoesNotOvercommitAvailableUsdcAcrossOutcomes();
  testRespectsDailyNotionalAcrossWholeCycle();
  console.log("referenceArbitrageRebalancer checks passed");
}

function testBuysUndervaluedOutcomeAboveThreshold() {
  const context = createContext();
  const plan = referenceArbitrageRebalancerStrategy(context);
  const place = plan.actions.find((action) => action.type === "place");

  assert.ok(place, "expected a live placement");
  assert.equal(place?.side, "BUY");
  assert.equal(place?.price, "0.59");
  assert.equal(place?.reason, "reference_arbitrage_buy_mispricing");
}

function testDryRunConvertsPlacementsIntoSkips() {
  const context = createContext({
    bot: createBotConfig({
      referenceArbitrageRebalancer: {
        ...DEFAULT_REFERENCE_ARBITRAGE_REBALANCER_CONFIG,
        dryRun: true,
      },
    }),
  });
  const plan = referenceArbitrageRebalancerStrategy(context);
  const skip = plan.actions.find((action) => action.type === "skip");

  assert.ok(skip, "expected dry-run skip");
  assert.equal(skip?.reason, "reference_arbitrage_dry_run_opportunity");
}

function testDryRunConvertsCancelsIntoSkips() {
  const context = createContext({
    bot: createBotConfig({
      referenceArbitrageRebalancer: {
        ...DEFAULT_REFERENCE_ARBITRAGE_REBALANCER_CONFIG,
        dryRun: true,
      },
    }),
    marketQuotes: [
      {
        outcomeId: "france",
        outcomeName: "France",
        bestBid: "0.54",
        bestAsk: "0.61",
        midPrice: "0.575",
        lastPrice: "0.575",
        lastTradeAt: null,
      },
    ],
    marketOpenOrders: [
      {
        id: "order-1",
        clientOrderId: null,
        marketId: "market-1",
        outcomeId: "france",
        side: "BUY",
        type: "LIMIT",
        status: "OPEN",
        apiKeyId: "test-key",
        price: "0.58",
        size: "10.000000",
        remaining: "10.000000",
        reservedNotional: "5.800000",
        createdAt: new Date(Date.now() - 10_000).toISOString(),
      },
    ],
  });
  const plan = referenceArbitrageRebalancerStrategy(context);
  const cancelSkip = plan.actions.find(
    (action) => action.type === "skip" && action.reason === "reference_arbitrage_dry_run_cancel",
  );

  assert.ok(cancelSkip, "expected dry-run cancel skip");
}

function testSkipsWhenEdgeOnlyMeetsThreshold() {
  const context = createContext({
    marketQuotes: [
      {
        outcomeId: "france",
        outcomeName: "France",
        bestBid: "0.57",
        bestAsk: "0.58",
        midPrice: "0.575",
        lastPrice: "0.575",
        lastTradeAt: null,
      },
    ],
  });
  const plan = referenceArbitrageRebalancerStrategy(context);

  assert.equal(plan.actions.some((action) => action.type === "place"), false);
  assert.equal(plan.actions.some((action) => action.type === "skip"), true);
}

function testSkipsOnExplicitlyStaleReference() {
  const context = createContext({
    referencePlan: createReferencePlan({
      outcomes: [
        {
          ...createReferencePlan().outcomes[0]!,
          isFresh: false,
          ageMs: 1000,
        },
      ],
    }),
  });
  const plan = referenceArbitrageRebalancerStrategy(context);

  assert.equal(plan.actions.some((action) => action.type === "place"), false);
}

function testCleanupCancelsStaleNonMarktableOrder() {
  const context = createContext({
    marketQuotes: [
      {
        outcomeId: "france",
        outcomeName: "France",
        bestBid: "0.54",
        bestAsk: "0.61",
        midPrice: "0.575",
        lastPrice: "0.575",
        lastTradeAt: null,
      },
    ],
    marketOpenOrders: [
      {
        id: "order-1",
        clientOrderId: null,
        marketId: "market-1",
        outcomeId: "france",
        side: "BUY",
        type: "LIMIT",
        status: "OPEN",
        apiKeyId: "test-key",
        price: "0.58",
        size: "10.000000",
        remaining: "10.000000",
        reservedNotional: "5.800000",
        createdAt: new Date(Date.now() - 10_000).toISOString(),
      },
    ],
  });
  const actions = collectReferenceArbitrageCleanupActions(context, "manual_cleanup");
  const plan = referenceArbitrageRebalancerStrategy(context);

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "cancel");
  assert.equal(plan.actions.some((action) => action.type === "cancel"), true);
}

function testRespectsOneSidedBankrollCap() {
  const context = createContext({
    positions: [
      {
        marketId: "market-1",
        marketTitle: "France World Cup",
        marketStatus: "LIVE",
        outcomeId: "france",
        outcomeName: "France",
        shares: "1400.000000",
        reservedShares: "0.000000",
        avgCost: "0.60",
        realizedPnl: "0.000000",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  const plan = referenceArbitrageRebalancerStrategy(context);

  assert.equal(plan.actions.some((action) => action.type === "place"), false);
}

function testLiveBankrollOverrideCapsSizing() {
  const context = createContext({
    bot: createBotConfig({
      referenceArbitrageRebalancer: {
        ...DEFAULT_REFERENCE_ARBITRAGE_REBALANCER_CONFIG,
        dryRun: false,
        maxBankrollPerMarket: 1000,
        liveBankrollOverride: 100,
        maxOrderNotional: 150,
      },
    }),
    positions: [
      {
        marketId: "market-1",
        marketTitle: "France World Cup",
        marketStatus: "LIVE",
        outcomeId: "france",
        outcomeName: "France",
        shares: "100.000000",
        reservedShares: "0.000000",
        avgCost: "0.60",
        realizedPnl: "0.000000",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  const plan = referenceArbitrageRebalancerStrategy(context);
  const placeActions = plan.actions.filter((action) => action.type === "place");
  const totalNotional = placeActions.reduce((sum, action) => sum + Number(action.price) * Number(action.size), 0);

  assert.ok(placeActions.length > 0, "expected at least one live action");
  assert.ok(totalNotional <= 100.01, `expected live rollout notional <= 100, got ${totalNotional}`);
}

function testDoesNotOvercommitAvailableUsdcAcrossOutcomes() {
  const context = createContext({
    balance: {
      availableUSDC: "60.000000",
      lockedUSDC: "0.000000",
      totalUSDC: "60.000000",
      updatedAt: new Date().toISOString(),
    },
    marketQuotes: [
      {
        outcomeId: "france",
        outcomeName: "France",
        bestBid: "0.54",
        bestAsk: "0.56",
        midPrice: "0.55",
        lastPrice: "0.55",
        lastTradeAt: null,
      },
      {
        outcomeId: "spain",
        outcomeName: "Spain",
        bestBid: "0.49",
        bestAsk: "0.51",
        midPrice: "0.50",
        lastPrice: "0.50",
        lastTradeAt: null,
      },
    ],
    referencePlan: createReferencePlan({
      outcomes: [
        createReferencePlan().outcomes[0]!,
        {
          ...createReferencePlan().outcomes[0]!,
          localOutcomeId: "spain",
          outcomeName: "Spain",
          polymarketTokenId: "tok-spain",
          gammaOutcomePrice: 0.56,
          gammaBestBid: 0.55,
          gammaBestAsk: 0.57,
          referenceBid: 0.55,
          referenceAsk: 0.57,
          plannedBotBid: 0.53,
          plannedBotAsk: 0.59,
        },
      ],
    }),
  });
  const plan = referenceArbitrageRebalancerStrategy(context);
  const buyActions = plan.actions.filter((action) => action.type === "place" && action.side === "BUY");
  const totalNotional = buyActions.reduce((sum, action) => sum + Number(action.price) * Number(action.size), 0);

  assert.equal(buyActions.length, 2);
  assert.ok(totalNotional <= 60.01, `expected total notional <= 60, got ${totalNotional}`);
}

function testRespectsDailyNotionalAcrossWholeCycle() {
  const context = createContext({
    recentSubmittedNotionalCents: 98000,
    positions: [
      {
        marketId: "market-1",
        marketTitle: "France World Cup",
        marketStatus: "LIVE",
        outcomeId: "france",
        outcomeName: "France",
        shares: "100.000000",
        reservedShares: "0.000000",
        avgCost: "0.30",
        realizedPnl: "0.000000",
        updatedAt: new Date().toISOString(),
      },
    ],
    marketQuotes: [
      {
        outcomeId: "france",
        outcomeName: "France",
        bestBid: "0.64",
        bestAsk: "0.66",
        midPrice: "0.65",
        lastPrice: "0.65",
        lastTradeAt: null,
      },
      {
        outcomeId: "spain",
        outcomeName: "Spain",
        bestBid: "0.49",
        bestAsk: "0.50",
        midPrice: "0.495",
        lastPrice: "0.495",
        lastTradeAt: null,
      },
    ],
    referencePlan: createReferencePlan({
      outcomes: [
        {
          ...createReferencePlan().outcomes[0]!,
          gammaOutcomePrice: 0.60,
          gammaBestBid: 0.59,
          gammaBestAsk: 0.61,
          referenceBid: 0.59,
          referenceAsk: 0.61,
          plannedBotBid: 0.57,
          plannedBotAsk: 0.63,
        },
        {
          ...createReferencePlan().outcomes[0]!,
          localOutcomeId: "spain",
          outcomeName: "Spain",
          polymarketTokenId: "tok-spain",
          gammaOutcomePrice: 0.56,
          gammaBestBid: 0.55,
          gammaBestAsk: 0.57,
          referenceBid: 0.55,
          referenceAsk: 0.57,
          plannedBotBid: 0.53,
          plannedBotAsk: 0.59,
        },
      ],
    }),
  });
  const plan = referenceArbitrageRebalancerStrategy(context);
  const placeActions = plan.actions.filter((action) => action.type === "place");
  const totalNotional = placeActions.reduce((sum, action) => sum + Number(action.price) * Number(action.size), 0);

  assert.ok(totalNotional <= 20.01, `expected remaining daily capacity <= 20, got ${totalNotional}`);
}

function createContext(overrides: Partial<ReferenceArbitrageContext> = {}): ReferenceArbitrageContext {
  const marketQuotes =
    overrides.marketQuotes ??
    [
      {
        outcomeId: "france",
        outcomeName: "France",
        bestBid: "0.54",
        bestAsk: "0.56",
        midPrice: "0.55",
        lastPrice: "0.55",
        lastTradeAt: null,
      },
    ];

  return {
    bot: overrides.bot ?? createBotConfig(),
    marketId: "market-1",
    marketQuotes,
    referencePlan: overrides.referencePlan ?? createReferencePlan(),
    balance: overrides.balance ?? createBalance(),
    positions: overrides.positions ?? [],
    totalOpenOrders: overrides.totalOpenOrders ?? (overrides.marketOpenOrders ?? []),
    marketOpenOrders: overrides.marketOpenOrders ?? [],
    now: overrides.now ?? new Date(),
    recentQuoteLagEvents: overrides.recentQuoteLagEvents ?? 0,
    recentSubmittedNotionalCents: overrides.recentSubmittedNotionalCents ?? 0,
    cooldownActive: overrides.cooldownActive ?? false,
  };
}

function createBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name: "reference-arb-test",
    baseUrl: "http://localhost:3000",
    apiKey: "test-key",
    strategy: "referenceArbitrageRebalancer",
    marketIds: ["market-1"],
    pollIntervalMs: 2000,
    loopIntervalMinMs: 1500,
    loopIntervalMaxMs: 2500,
    maxOrderSize: "50.000000",
    maxTakerSize: "50.000000",
    maxOpenOrders: 8,
    staleOrderMs: 8000,
    minQuoteLifetimeMs: 500,
    decisionCooldownMs: 1000,
    capBackoffMs: 8000,
    tickSize: "0.01",
    maxPositionShares: "5000.000000",
    inventoryTargetShares: "0.000000",
    targetSpreadTicks: 2,
    quoteOffsetMinTicks: 0,
    quoteOffsetMaxTicks: 0,
    staleDistanceTicks: 4,
    replaceThresholdTicks: 1,
    replaceHysteresisTicks: 1,
    maxOrdersPerSide: 1,
    takerProbability: 0,
    takerThresholdTicks: 1,
    inventorySkewStrength: 0,
    fallbackFairPrice: "0.50",
    dailyNotionalPauseMode: "pause_for_run",
    dailyNotionalCooldownMs: 86_400_000,
    pausedPollIntervalMs: 45_000,
    pauseLogIntervalMs: 60_000,
    dynamicMarketMaker: {
      minLevelsPerSide: 1,
      maxLevelsPerSide: 1,
      levelSpacingTicks: 1,
      minSpreadTicks: 2,
      maxSpreadTicks: 4,
      baseSpreadTicks: 2,
      extremeSpreadTicks: 4,
      inventorySpreadTicks: 1,
      inventoryLeanTicks: 1,
      inventoryReduceThreshold: 0.65,
      inventoryEmergencyThreshold: 0.92,
      levelSizeMultipliers: [1],
      extremeSizeReduction: 0.55,
      minLevelSize: "0.100000",
      replenishmentTargetShares: "1.000000",
      enableMintReplenishment: false,
      targetAskDepthShares: "1.000000",
      safetyMultiplier: 1.2,
      targetInventoryShares: "1.000000",
      minMintAmount: "1.000000",
      maxMintAmountPerCycle: "1.000000",
      maxMintPerMarketPerHour: "1.000000",
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
    referenceArbitrageRebalancer: {
      ...DEFAULT_REFERENCE_ARBITRAGE_REBALANCER_CONFIG,
      dryRun: false,
    },
    risk: {
      botUserId: "reference-arb-test-user",
      enabled: true,
      maxTotalCapitalCents: 1_000_000,
      maxCapitalPerMarketCents: 100_000,
      maxOpenOrderNotionalCents: 20_000,
      maxOrderSizeCents: 5_000,
      maxDailyLossCents: 100_000,
      maxDailySubmittedNotionalCents: 500_000,
      maxYesSharesPerMarket: "5000.000000",
      maxNoSharesPerMarket: "5000.000000",
      maxOrdersPerMarket: 8,
      maxQuoteLevelsPerSide: 1,
      staleDataMaxAgeMs: 15_000,
      pauseNearResolutionMinutes: 0,
      repeatedErrorPauseMs: 30_000,
      inventoryReduceOnlyThreshold: 0.85,
      inventoryStopThreshold: 0.98,
      emergencyStopOnInvariantViolation: true,
      emergencyStopOnRepeatedApiErrors: true,
      emergencyStopOnBalanceMismatch: true,
      repeatedApiErrorThreshold: 5,
      repeatedApiErrorWindowMs: 60_000,
      repeatedCancelConflictThreshold: 5,
      repeatedStaleStateThreshold: 10,
      cancelOpenOrdersOnPause: false,
      cancelOpenOrdersOnEmergencyStop: true,
    },
    ...overrides,
  };
}

function createReferencePlan(overrides: Partial<MarketReferencePlanResponse> = {}): MarketReferencePlanResponse {
  return {
    marketId: "market-1",
    source: "polymarket",
    externalSlug: "france-world-cup",
    externalMarketId: "pm-1",
    conditionId: "cond-1",
    hasSnapshot: true,
    reason: null,
    dryRun: false,
    liveOrdersEnabled: false,
    botInitialization: null,
    outcomes: [
      {
        localMarketId: "market-1",
        localOutcomeId: "france",
        outcomeName: "France",
        referenceSource: "polymarket",
        polymarketSlug: "france-world-cup",
        polymarketMarketId: "pm-1",
        conditionId: "cond-1",
        polymarketTokenId: "tok-france",
        gammaOutcomePrice: 0.6,
        gammaBestBid: 0.59,
        gammaBestAsk: 0.61,
        gammaSpread: 0.02,
        lastTradePrice: 0.6,
        volume: 1000,
        volume24hr: 500,
        liquidity: 200,
        acceptingOrders: true,
        fetchedAt: new Date().toISOString(),
        ageMs: 1000,
        isFresh: true,
        hasSnapshot: true,
        qualityStatus: "high_quality",
        mmEligible: true,
        mmEnabled: true,
        reason: null,
        tickSize: "0.01",
        quoteOffsetTicks: 2,
        plannedBotBid: 0.57,
        plannedBotAsk: 0.63,
        referenceBid: 0.59,
        referenceAsk: 0.61,
        dryRun: false,
        liveOrdersEnabled: false,
        quotePlanEnabled: true,
        quotePreviewAvailable: true,
        activeBotBid: null,
        activeBotAsk: null,
        activeBidOrderId: null,
        activeAskOrderId: null,
        formula: "reference midpoint",
      },
    ],
    ...overrides,
  };
}

function createBalance(): Balance {
  return {
    availableUSDC: "500.000000",
    lockedUSDC: "0.000000",
    totalUSDC: "500.000000",
    updatedAt: new Date().toISOString(),
  };
}

main();

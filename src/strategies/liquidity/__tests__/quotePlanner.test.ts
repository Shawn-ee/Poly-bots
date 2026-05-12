import assert from "node:assert/strict";
import test from "node:test";
import { Order, Position, QuoteResponse } from "../../../api/types.js";
import { BotConfig } from "../../../config/loadConfig.js";
import { LocalReferenceMarket } from "../../../referenceMarket/localReferenceMarkets.js";
import { ReferencePriceCache } from "../../../referenceMarket/referencePriceCache.js";
import { ReferenceMarketCandidate } from "../../../referenceMarket/types.js";
import { buildReferenceAwareQuotePlan } from "../quotePlanner.js";

function makeBot(): BotConfig {
  return {
    name: "ref-bot",
    baseUrl: "http://localhost:3000",
    apiKey: "pk_test.secret",
    strategy: "referenceAwareSystemLiquidity",
    marketIds: ["market-1"],
    pollIntervalMs: 2000,
    loopIntervalMinMs: 1500,
    loopIntervalMaxMs: 1500,
    maxOrderSize: "10.000000",
    maxTakerSize: "0.250000",
    maxOpenOrders: 10,
    staleOrderMs: 8000,
    minQuoteLifetimeMs: 1000,
    decisionCooldownMs: 1000,
    capBackoffMs: 8000,
    tickSize: "0.01",
    maxPositionShares: "10.000000",
    inventoryTargetShares: "1.000000",
    targetSpreadTicks: 2,
    quoteOffsetMinTicks: 0,
    quoteOffsetMaxTicks: 0,
    staleDistanceTicks: 4,
    replaceThresholdTicks: 1,
    replaceHysteresisTicks: 1,
    maxOrdersPerSide: 1,
    takerProbability: 0,
    takerThresholdTicks: 1,
    inventorySkewStrength: 1,
    fallbackFairPrice: "0.50",
    dailyNotionalPauseMode: "pause_for_run",
    dailyNotionalCooldownMs: 86400000,
    pausedPollIntervalMs: 45000,
    pauseLogIntervalMs: 60000,
    referenceAwareSystemLiquidity: {
      referencePollMs: 5000,
      referenceStaleMs: 15000,
      liquidityBotCycleMs: 1500,
      quoteOffsetTicks: 2,
      minReferenceSpread: 0,
      maxReferenceSpread: 0.1,
      minReferenceLiquidity: null,
      minVolume24hr: null,
      cancelOnReferenceStale: true,
      cancelOnReferenceWide: true,
      dryRun: true,
      explicitBotTradable: false,
    },
    dynamicMarketMaker: {
      minLevelsPerSide: 1,
      maxLevelsPerSide: 1,
      levelSpacingTicks: 1,
      minSpreadTicks: 2,
      maxSpreadTicks: 2,
      baseSpreadTicks: 2,
      extremeSpreadTicks: 0,
      inventorySpreadTicks: 0,
      inventoryLeanTicks: 0,
      inventoryReduceThreshold: 1,
      inventoryEmergencyThreshold: 1,
      levelSizeMultipliers: [1],
      extremeSizeReduction: 0,
      minLevelSize: "0.1",
      replenishmentTargetShares: "1",
      enableMintReplenishment: false,
      targetAskDepthShares: "1",
      safetyMultiplier: 1,
      targetInventoryShares: "1",
      minMintAmount: "1",
      maxMintAmountPerCycle: "1",
      maxMintPerMarketPerHour: "1",
      extremeMintReductionThresholdHigh: 1,
      extremeMintReductionThresholdLow: 0,
      extremeMintReductionFactor: 0,
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
      botUserId: null,
      enabled: true,
      maxTotalCapitalCents: 1_000_000,
      maxCapitalPerMarketCents: 100_000,
      maxOpenOrderNotionalCents: 100_000,
      maxOrderSizeCents: 10_000,
      maxDailyLossCents: 50_000,
      maxDailySubmittedNotionalCents: 500_000,
      maxYesSharesPerMarket: "100.000000",
      maxNoSharesPerMarket: "100.000000",
      maxOrdersPerMarket: 10,
      maxQuoteLevelsPerSide: 1,
      staleDataMaxAgeMs: 15000,
      pauseNearResolutionMinutes: 0,
      repeatedErrorPauseMs: 30000,
      inventoryReduceOnlyThreshold: 0.9,
      inventoryStopThreshold: 0.99,
      emergencyStopOnInvariantViolation: true,
      emergencyStopOnRepeatedApiErrors: true,
      emergencyStopOnBalanceMismatch: true,
      repeatedApiErrorThreshold: 5,
      repeatedApiErrorWindowMs: 60000,
      repeatedCancelConflictThreshold: 5,
      repeatedStaleStateThreshold: 5,
      cancelOpenOrdersOnPause: false,
      cancelOpenOrdersOnEmergencyStop: true,
    },
  };
}

function makeMarket(overrides: Partial<LocalReferenceMarket> = {}): LocalReferenceMarket {
  return {
    id: "market-1",
    title: "Ukraine",
    status: "LIVE",
    type: "BINARY",
    mechanism: "ORDERBOOK",
    visibility: "PUBLIC",
    isListed: false,
    resolveTime: null,
    externalMarketId: "pm-1",
    conditionId: "cond-1",
    referenceSource: "polymarket",
    externalSlug: "ukraine",
    importStatus: "approved",
    referenceOnly: true,
    tradable: true,
    mmEnabled: true,
    outcomes: [
      {
        id: "yes",
        name: "Yes",
        displayOrder: 0,
        isTradable: true,
        referenceTokenId: "tok-yes",
        referenceOutcomeLabel: "Yes",
      },
      {
        id: "no",
        name: "No",
        displayOrder: 1,
        isTradable: true,
        referenceTokenId: "tok-no",
        referenceOutcomeLabel: "No",
      },
    ],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<ReferenceMarketCandidate> = {}): ReferenceMarketCandidate {
  return {
    source: "polymarket",
    externalMarketId: "pm-1",
    conditionId: "cond-1",
    slug: "ukraine",
    question: "Ukraine?",
    description: null,
    category: null,
    tags: [],
    eventSlug: null,
    startDate: null,
    endDate: null,
    resolutionSource: null,
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    competitive: true,
    volume: 5000,
    volume24hr: 500,
    liquidity: 1000,
    liquidityClob: 1000,
    bestBid: 0.39,
    bestAsk: 0.4,
    spread: 0.01,
    lastTradePrice: 0.395,
    image: null,
    icon: null,
    outcomePrices: [0.395, 0.605],
    event: null,
    outcomes: [],
    clobTokenIds: [],
    raw: { updatedAt: "2026-05-12T00:00:00.000Z" },
    ...overrides,
  };
}

function makeLocalQuoteResponse(): QuoteResponse {
  return {
    marketId: "market-1",
    quotes: [
      { outcomeId: "yes", outcomeName: "Yes", bestBid: "0.35", bestAsk: "0.45", midPrice: "0.40", lastPrice: "0.40", lastTradeAt: null },
      { outcomeId: "no", outcomeName: "No", bestBid: "0.55", bestAsk: "0.65", midPrice: "0.60", lastPrice: "0.60", lastTradeAt: null },
    ],
  };
}

function makePosition(outcomeId: string, outcomeName: string, shares: string): Position {
  return {
    marketId: "market-1",
    marketTitle: "Ukraine",
    marketStatus: "LIVE",
    outcomeId,
    outcomeName,
    shares,
    reservedShares: "0.000000",
    avgCost: "0.500000",
    realizedPnl: "0.000000",
    updatedAt: new Date().toISOString(),
  };
}

test("healthy reference plans conservative quotes", () => {
  const bot = makeBot();
  const cache = new ReferencePriceCache(15_000);
  cache.updateMarket(makeMarket(), makeCandidate(), new Date().toISOString());

  const plan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket(),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [makePosition("yes", "Yes", "10.000000")],
    openOrders: [],
    now: new Date(),
    referenceCache: cache,
    riskState: "running",
  });

  const yes = plan.outcomes.find((outcome) => outcome.outcomeId === "yes");
  assert.equal(yes?.botBid, "0.37");
  assert.equal(yes?.botAsk, "0.42");
  assert.ok(plan.actions.some((action) => action.type === "place" && action.side === "BUY" && action.price === "0.37"));
  assert.ok(plan.actions.some((action) => action.type === "place" && action.side === "SELL" && action.price === "0.42"));
});

test("stale, wide, missing, disabled, and non-binary references skip quoting", () => {
  const bot = makeBot();
  const staleCache = new ReferencePriceCache(15_000);
  staleCache.updateMarket(makeMarket(), makeCandidate(), new Date(Date.now() - 20_000).toISOString());
  const stalePlan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket(),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [],
    openOrders: [],
    now: new Date(),
    referenceCache: staleCache,
    riskState: "running",
  });
  assert.equal(stalePlan.outcomes[0]?.reason, "reference_stale");

  const wideCache = new ReferencePriceCache(15_000);
  wideCache.updateMarket(makeMarket(), makeCandidate({ bestBid: 0.2, bestAsk: 0.4, spread: 0.2 }), new Date().toISOString());
  const widePlan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket(),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [],
    openOrders: [],
    now: new Date(),
    referenceCache: wideCache,
    riskState: "running",
  });
  assert.equal(widePlan.outcomes[0]?.reason, "reference_spread_too_wide");

  const missingPlan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket(),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [],
    openOrders: [],
    now: new Date(),
    referenceCache: new ReferencePriceCache(15_000),
    riskState: "running",
  });
  assert.equal(missingPlan.outcomes[0]?.reason, "missing_quote");

  const disabledPlan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket({ mmEnabled: false }),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [],
    openOrders: [],
    now: new Date(),
    referenceCache: new ReferencePriceCache(15_000),
    riskState: "running",
  });
  assert.equal(disabledPlan.outcomes[0]?.reason, "reference_market_not_enabled");

  const nonBinaryPlan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket({ type: "MULTI_WINNER" }),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [],
    openOrders: [],
    now: new Date(),
    referenceCache: new ReferencePriceCache(15_000),
    riskState: "running",
  });
  assert.equal(nonBinaryPlan.outcomes[0]?.reason, "market_not_binary");
});

test("sub-tick movement keeps existing quote", () => {
  const bot = makeBot();
  const cache = new ReferencePriceCache(15_000);
  cache.updateMarket(makeMarket(), makeCandidate(), new Date().toISOString());

  const openOrders: Order[] = [
    {
      id: "o-1",
      clientOrderId: "o-1",
      marketId: "market-1",
      outcomeId: "yes",
      side: "BUY",
      type: "LIMIT",
      status: "OPEN",
      apiKeyId: null,
      price: "0.370000",
      size: "10.000000",
      remaining: "10.000000",
      reservedNotional: "3.700000",
      createdAt: new Date().toISOString(),
    },
  ];

  const plan = buildReferenceAwareQuotePlan({
    bot,
    market: makeMarket(),
    quoteResponse: makeLocalQuoteResponse(),
    balanceAvailableUSDC: "100.000000",
    positions: [makePosition("yes", "Yes", "10.000000")],
    openOrders,
    now: new Date(),
    referenceCache: cache,
    riskState: "running",
  });

  assert.ok(plan.actions.some((action) => action.type === "skip" && action.reason === "keep_existing_quote_skip"));
  assert.ok(!plan.actions.some((action) => action.type === "cancel" && action.orderId === "o-1"));
});

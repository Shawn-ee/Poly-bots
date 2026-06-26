import assert from "node:assert/strict";

import { AdminReferenceMarketItem, Balance, MarketReferencePlanResponse, Order, Position, QuoteResponse } from "../src/api/types.js";
import { canPlaceLiveInternalOrders, loadBotSafetyPolicy } from "../src/config/botSafety.js";
import { buildDesiredQuotes, evaluateLiveReadiness, LiveRiskConfig } from "../src/referenceMarket/liveMarketMaker.js";

async function main() {
  testDefaultPolicyBlocksLivePlacement();
  testLegacyDryRunFlagBlocksPlacementEvenWithLiveFlags();
  testWorldCupReadinessBlocksAtPerMarketExposureCap();
  testWorldCupReadinessBlocksAtOpenOrderCap();
  testDesiredQuotesRespectTwoTickPricingAndDoNotCrossLocalBook();
  console.log("World Cup market-making guardrail checks passed.");
}

function testDefaultPolicyBlocksLivePlacement() {
  withEnv({}, () => {
    const policy = loadBotSafetyPolicy();
    const decision = canPlaceLiveInternalOrders(policy);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "poly_bots_disabled");
    assert.equal(policy.mode, "dryRun");
    assert.equal(policy.botsEnabled, false);
    assert.equal(policy.liveTradingEnabled, false);
    assert.equal(policy.globalKillSwitch, true);
  });
}

function testLegacyDryRunFlagBlocksPlacementEvenWithLiveFlags() {
  withEnv(
    {
      POLY_BOTS_ENABLED: "true",
      POLY_BOTS_LIVE_TRADING: "true",
      POLY_BOTS_GLOBAL_KILL_SWITCH: "false",
      POLY_BOTS_MODE: "liveInternal",
      SYSTEM_LIQUIDITY_DRY_RUN: "true",
      LIVE_SYSTEM_LIQUIDITY_ENABLED: "true",
    },
    () => {
      const decision = canPlaceLiveInternalOrders(loadBotSafetyPolicy());
      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, "legacy_system_liquidity_dry_run");
    },
  );
}

function testWorldCupReadinessBlocksAtPerMarketExposureCap() {
  const result = evaluateLiveReadiness({
    market: worldCupMarket(),
    reference: worldCupReferencePlan(),
    balance: balance(),
    positions: positions([{ outcomeId: "ecu", outcomeName: "ECU +1.5", shares: "4.000000" }]),
    openOrders: orders([{ outcomeId: "ecu", side: "BUY", reservedNotional: "1.000000" }]),
    confirmLive: true,
    liveOrdersEnabled: true,
    systemLiquidityDryRun: false,
    runtimePresent: true,
    risk: risk({ maxPerMarketExposureCents: 200 }),
    now: Date.parse("2026-06-01T00:00:05.000Z"),
  });

  assert.equal(result.ready, false);
  assert(result.perMarketExposureCents >= 200);
  assert(result.reasons.some((reason) => reason.startsWith("per_market_exposure_cap_reached_")));
}

function testWorldCupReadinessBlocksAtOpenOrderCap() {
  const result = evaluateLiveReadiness({
    market: worldCupMarket(),
    reference: worldCupReferencePlan(),
    balance: balance(),
    positions: [],
    openOrders: orders([
      { outcomeId: "ecu", side: "BUY", reservedNotional: "0.100000" },
      { outcomeId: "ger", side: "SELL", reservedNotional: "0.100000" },
    ]),
    confirmLive: true,
    liveOrdersEnabled: true,
    systemLiquidityDryRun: false,
    runtimePresent: true,
    risk: risk({ maxOpenOrdersPerMarket: 2 }),
    now: Date.parse("2026-06-01T00:00:05.000Z"),
  });

  assert.equal(result.ready, false);
  assert(result.reasons.includes("max_open_orders_per_market_2_of_2"));
}

function testDesiredQuotesRespectTwoTickPricingAndDoNotCrossLocalBook() {
  const desired = buildDesiredQuotes({
    reference: worldCupReferencePlan(),
    localQuote: quoteResponse(),
    balance: balance(),
    positions: positions([{ outcomeId: "ecu", outcomeName: "ECU +1.5", shares: "5.000000" }]),
    openOrders: [],
    marketId: "wc-ecu-ger-spread-15",
    risk: risk({ maxSingleOrderNotionalCents: 100, minCashReserveCents: 0, maxShareSize: 10 }),
    cycleTs: Date.parse("2026-06-01T00:00:05.000Z"),
  });

  const ecuBid = desired.find((quote) => quote.outcomeId === "ecu" && quote.side === "BUY");
  const ecuAsk = desired.find((quote) => quote.outcomeId === "ecu" && quote.side === "SELL");
  assert(ecuBid);
  assert(ecuAsk);
  assert.equal(ecuBid.price, "0.62");
  assert.equal(ecuAsk.price, "0.68");
  assert(Number(ecuBid.price) < Number(quoteResponse().quotes[0]!.bestAsk));
  assert(Number(ecuAsk.price) > Number(quoteResponse().quotes[0]!.bestBid));
  assert(Number(ecuBid.size) * Number(ecuBid.price) <= 1.000001);
}

function worldCupMarket(overrides: Partial<AdminReferenceMarketItem> = {}): AdminReferenceMarketItem {
  return {
    id: "wc-ecu-ger-spread-15",
    title: "Ecuador +1.5 vs Germany -1.5",
    description: "World Cup spread reference market.",
    status: "LIVE",
    isListed: true,
    event: {
      id: "event-ecu-ger",
      slug: "ecuador-vs-germany",
      title: "Ecuador vs Germany",
      category: "World Cup",
      source: "internal-demo",
      externalEventId: "pm-event-ecu-ger",
      externalSlug: "ecuador-vs-germany",
    },
    externalMarketId: "pm-wc-ecu-ger-spread-15",
    externalSlug: "ecuador-vs-germany-spread-15",
    conditionId: "cond-ecu-ger-spread-15",
    referenceSource: "polymarket",
    importStatus: "approved",
    referenceOnly: true,
    tradable: true,
    mmEnabled: true,
    reviewedAt: "2026-06-01T00:00:00.000Z",
    reviewedBy: "admin",
    reviewNotes: "World Cup dry-run guardrail fixture.",
    outcomePrices: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    lastTradePrice: null,
    volume24hr: null,
    liquidity: null,
    acceptingOrders: true,
    referenceMetadata: {},
    botInitialization: {
      status: "live_enabled",
      lastCheckedAt: "2026-06-01T00:00:00.000Z",
      reason: null,
      approvedBy: "admin",
      approvedAt: "2026-06-01T00:00:00.000Z",
      riskProfile: "world_cup_internal_beta",
      capital: {
        budgetCents: 20_000,
        mintBudgetCents: 0,
        mintedCompleteSets: 0,
        cashReserveCents: 0,
        autoReplenish: false,
        initializedAt: "2026-06-01T00:00:00.000Z",
        initializedBy: "admin",
        botUserId: "bot-user",
        botUsername: "world-cup-mm",
        botApiCredentialId: "cred-1",
        botApiKeyId: "key-1",
        maxSingleOrderNotionalCents: 100,
        maxOpenOrderNotionalCents: 10_000,
        maxDailyLossCents: 5_000,
      },
      runtime: {
        liveOrdersEnabled: true,
        emergencyStop: false,
        cancelRequestedAt: null,
        lastSeededAt: "2026-06-01T00:00:00.000Z",
        lastLiveRunAt: null,
        lastRuntimeSyncAt: "2026-06-01T00:00:00.000Z",
      },
      readiness: null,
    },
    outcomes: [
      {
        id: "ecu",
        name: "ECU +1.5",
        displayOrder: 0,
        isTradable: true,
        referenceTokenId: "tok-ecu",
        referenceOutcomeLabel: "ECU +1.5",
        referenceMetadata: {},
      },
      {
        id: "ger",
        name: "GER -1.5",
        displayOrder: 1,
        isTradable: true,
        referenceTokenId: "tok-ger",
        referenceOutcomeLabel: "GER -1.5",
        referenceMetadata: {},
      },
    ],
    ...overrides,
  };
}

function worldCupReferencePlan(): MarketReferencePlanResponse {
  return {
    marketId: "wc-ecu-ger-spread-15",
    source: "polymarket",
    externalSlug: "ecuador-vs-germany-spread-15",
    externalMarketId: "pm-wc-ecu-ger-spread-15",
    conditionId: "cond-ecu-ger-spread-15",
    hasSnapshot: true,
    reason: null,
    dryRun: false,
    liveOrdersEnabled: true,
    outcomes: [
      referenceOutcome("ecu", "ECU +1.5", 0.64, 0.66, 0.62, 0.68),
      referenceOutcome("ger", "GER -1.5", 0.34, 0.36, 0.32, 0.38),
    ],
  };
}

function referenceOutcome(
  localOutcomeId: string,
  outcomeName: string,
  referenceBid: number,
  referenceAsk: number,
  plannedBotBid: number,
  plannedBotAsk: number,
) {
  return {
    localMarketId: "wc-ecu-ger-spread-15",
    localOutcomeId,
    outcomeName,
    referenceSource: "polymarket",
    polymarketSlug: "ecuador-vs-germany-spread-15",
    polymarketMarketId: "pm-wc-ecu-ger-spread-15",
    conditionId: "cond-ecu-ger-spread-15",
    polymarketTokenId: `tok-${localOutcomeId}`,
    gammaOutcomePrice: (referenceBid + referenceAsk) / 2,
    gammaBestBid: referenceBid,
    gammaBestAsk: referenceAsk,
    gammaSpread: Number((referenceAsk - referenceBid).toFixed(2)),
    lastTradePrice: (referenceBid + referenceAsk) / 2,
    volume: 1000,
    volume24hr: 250,
    liquidity: 5000,
    acceptingOrders: true,
    fetchedAt: "2026-06-01T00:00:00.000Z",
    ageMs: 1000,
    isFresh: true,
    hasSnapshot: true,
    qualityStatus: "high_quality",
    mmEligible: true,
    mmEnabled: true,
    reason: null,
    tickSize: "0.01",
    quoteOffsetTicks: 2,
    plannedBotBid,
    plannedBotAsk,
    referenceBid,
    referenceAsk,
    dryRun: false,
    liveOrdersEnabled: true,
    quotePlanEnabled: true,
    quotePreviewAvailable: true,
    formula: "plannedBotBid = referenceBid - 2 ticks; plannedBotAsk = referenceAsk + 2 ticks",
  };
}

function risk(overrides: Partial<LiveRiskConfig> = {}): LiveRiskConfig {
  return {
    referenceStaleMs: 15_000,
    maxReferenceSpread: 0.1,
    quoteOffsetTicks: 2,
    tickSize: "0.01",
    maxSingleOrderNotionalCents: 100,
    maxOpenOrderNotionalCents: 10_000,
    maxDailyLossCents: 5_000,
    maxInventoryPerOutcome: 10,
    minOutcomeInventory: 0,
    minCashReserveCents: 0,
    maxShareSize: 10,
    minQuoteLifetimeMs: 5_000,
    requoteThresholdTicks: 2,
    maxPerMarketExposureCents: 20_000,
    maxGlobalExposureCents: 60_000_00,
    maxOpenOrdersPerMarket: 4,
    maxDailySubmittedNotionalCents: 500_000_00,
    ...overrides,
  };
}

function balance(): Balance {
  return {
    availableUSDC: "1000.000000",
    lockedUSDC: "0.000000",
    totalUSDC: "1000.000000",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function quoteResponse(): QuoteResponse {
  return {
    marketId: "wc-ecu-ger-spread-15",
    quotes: [
      {
        outcomeId: "ecu",
        outcomeName: "ECU +1.5",
        bestBid: "0.60",
        bestAsk: "0.70",
        midPrice: "0.65",
        lastPrice: "0.65",
        lastTradeAt: null,
      },
      {
        outcomeId: "ger",
        outcomeName: "GER -1.5",
        bestBid: "0.30",
        bestAsk: "0.40",
        midPrice: "0.35",
        lastPrice: "0.35",
        lastTradeAt: null,
      },
    ],
  };
}

function positions(items: Array<Partial<Position> & Pick<Position, "outcomeId" | "outcomeName">>): Position[] {
  return items.map((item) => ({
    marketId: "wc-ecu-ger-spread-15",
    marketTitle: "Ecuador vs Germany",
    marketStatus: "LIVE",
    outcomeId: item.outcomeId,
    outcomeName: item.outcomeName,
    shares: item.shares ?? "0.000000",
    reservedShares: item.reservedShares ?? "0.000000",
    avgCost: item.avgCost ?? "0.500000",
    realizedPnl: item.realizedPnl ?? "0.000000",
    updatedAt: "2026-06-01T00:00:00.000Z",
  }));
}

function orders(items: Array<Partial<Order> & Pick<Order, "outcomeId" | "side">>): Order[] {
  return items.map((item, index) => ({
    id: `order-${index}`,
    marketId: "wc-ecu-ger-spread-15",
    marketTitle: "Ecuador vs Germany",
    outcomeId: item.outcomeId,
    outcomeName: item.outcomeId.toUpperCase(),
    side: item.side,
    price: item.price ?? "0.500000",
    size: item.size ?? "1.000000",
    remaining: item.remaining ?? "1.000000",
    filled: item.filled ?? "0.000000",
    status: item.status ?? "OPEN",
    reservedNotional: item.reservedNotional ?? "0.500000",
    createdAt: item.createdAt ?? "2026-06-01T00:00:00.000Z",
  }));
}

function withEnv(values: Record<string, string>, fn: () => void) {
  const keys = [
    "POLY_BOTS_ENABLED",
    "POLY_BOTS_LIVE_TRADING",
    "POLY_BOTS_GLOBAL_KILL_SWITCH",
    "POLY_BOTS_MODE",
    "SYSTEM_LIQUIDITY_DRY_RUN",
    "LIVE_SYSTEM_LIQUIDITY_ENABLED",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

main().catch((error) => {
  console.error("World Cup market-making guardrail checks failed.");
  console.error(error);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { BotInitializationMetadata, MarketReferencePlanResponse } from "../src/api/types.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { buildReferenceMarketMapping } from "../src/referenceMarket/referenceMapping.js";
import { ReferencePriceCache } from "../src/referenceMarket/referencePriceCache.js";
import {
  buildBotInitializationMetadata,
  evaluateMarketReadiness,
} from "../src/referenceMarket/liquidityInitialization.js";
import { buildDesiredQuotes, evaluateLiveReadiness, reconcileQuotes } from "../src/referenceMarket/liveMarketMaker.js";
import { determineRuntimeDecision, shouldTransitionToLiveEnabled } from "../src/referenceMarket/runtimeSupervisor.js";
import { buildReferencePriceQuote } from "../src/referenceMarket/referenceQuality.js";
import { buildDryRunReferencePlan, buildSnapshotPayload } from "../src/referenceMarket/referenceQuotePlan.js";

async function main() {
  testQuotePlanFormula();
  testStaleReferenceDisablesPlan();
  testWideSpreadDisablesEligibility();
  testSnapshotPayload();
  testDryRunMakesNoOrderCalls();
  testNoSnapshotNotReady();
  testStaleSnapshotNotReady();
  testMmDisabledAllowsPreviewButNotEligible();
  testTradableFalseRefusesLive();
  testLiveInitWithoutConfirmRefused();
  testHealthyReferenceDryRunReadinessPasses();
  testHealthyReferenceLiveFlagsMissingRefused();
  testLiveOnlyCallsCanonicalOrderApiWhenExplicitlyEnabled();
  testLiveReadinessRequiresSeedAndFlags();
  testDesiredQuotesUseReferenceOffset();
  testReconcileKeepsIdenticalOrder();
  testRuntimeSupervisorDefaultsToDryRunPreview();
  testRuntimeSupervisorRefusesLiveWithoutFlags();
  testRuntimeSupervisorDoesNotTransitionWithoutFlags();
  testRuntimeSupervisorTransitionsToLiveEnabledWhenExplicitlyAllowed();
  testRuntimeSupervisorSkipsPausedMarket();
  testRuntimeSupervisorSkipsBlockedMarket();
  testRuntimeSupervisorCancelsOnStaleMarket();
  testEmergencyStopBlocksTransition();
  testMissingRiskCapsBlockTransition();
  console.log("Reference liquidity tests passed.");
}

function testQuotePlanFormula() {
  const mapping = approvedMapping();
  const cache = new ReferencePriceCache();
  cache.setQuote(
    { localMarketId: mapping.localMarketId, localOutcomeId: mapping.localOutcomeId },
    makeQuote(mapping, { gammaBestBid: 0.36, gammaBestAsk: 0.38, gammaSpread: 0.02 }),
  );
  const plan = buildDryRunReferencePlan(cache, [mapping], "0.01")[0];
  assert.equal(plan?.plannedBotBid, 0.34);
  assert.equal(plan?.plannedBotAsk, 0.4);
}

function testStaleReferenceDisablesPlan() {
  let now = Date.parse("2026-01-01T00:00:20.000Z");
  const mapping = approvedMapping();
  const cache = new ReferencePriceCache(15_000, () => now);
  cache.setQuote(
    { localMarketId: mapping.localMarketId, localOutcomeId: mapping.localOutcomeId },
    makeQuote(mapping, {
      gammaBestBid: 0.36,
      gammaBestAsk: 0.38,
      gammaSpread: 0.02,
      receivedAt: "2026-01-01T00:00:00.000Z",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      isFresh: true,
      isStale: false,
    }),
  );
  cache.markStale();
  const plan = buildDryRunReferencePlan(cache, [mapping], "0.01")[0];
  assert.equal(cache.isFresh(mapping.localMarketId, mapping.localOutcomeId), false);
  assert.equal(plan?.mmEligible, true);
}

function testWideSpreadDisablesEligibility() {
  const mapping = approvedMapping();
  const cache = new ReferencePriceCache();
  cache.setQuote(
    { localMarketId: mapping.localMarketId, localOutcomeId: mapping.localOutcomeId },
    makeQuote(mapping, {
      gammaBestBid: 0.01,
      gammaBestAsk: 0.99,
      gammaSpread: 0.98,
      mmEligible: false,
      qualityStatus: "wide",
      reason: "reference_spread_too_wide",
    }),
  );
  const plan = buildDryRunReferencePlan(cache, [mapping], "0.01")[0];
  assert.equal(plan?.mmEligible, false);
  assert.equal(plan?.reason, "reference_spread_too_wide");
}

function testSnapshotPayload() {
  const mapping = approvedMapping();
  const cache = new ReferencePriceCache();
  cache.setQuote(
    { localMarketId: mapping.localMarketId, localOutcomeId: mapping.localOutcomeId },
    makeQuote(mapping, {}),
  );
  const snapshots = buildSnapshotPayload(cache, [mapping]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.marketId, mapping.localMarketId);
  assert.equal(snapshots[0]?.tokenId, mapping.polymarketTokenId);
}

function testDryRunMakesNoOrderCalls() {
  let placeCalled = false;
  let cancelCalled = false;
  const fakeApi = {
    placeLimitOrder: () => {
      placeCalled = true;
    },
    cancelOrder: () => {
      cancelCalled = true;
    },
  };
  void fakeApi;
  assert.equal(placeCalled, false);
  assert.equal(cancelCalled, false);
}

function testNoSnapshotNotReady() {
  const result = evaluateMarketReadiness({
    market: approvedMarket(),
    reference: makeReferenceResponse({ hasSnapshot: false, outcomes: [makePlanOutcome({ hasSnapshot: false })] }),
    botConfig: testBotConfig(),
    dryRun: true,
    confirmLive: false,
    liveOrdersEnabled: false,
  });
  assert.equal(result.ready, false);
  assert(result.reasons.includes("missing_reference_snapshot"));
}

function testStaleSnapshotNotReady() {
  const result = evaluateMarketReadiness({
    market: approvedMarket(),
    reference: makeReferenceResponse({ outcomes: [makePlanOutcome({ isFresh: false })] }),
    botConfig: testBotConfig(),
    dryRun: true,
    confirmLive: false,
    liveOrdersEnabled: false,
  });
  assert.equal(result.ready, false);
  assert(result.reasons.includes("reference_stale"));
}

function testMmDisabledAllowsPreviewButNotEligible() {
  const result = evaluateMarketReadiness({
    market: approvedMarket({ mmEnabled: false }),
    reference: makeReferenceResponse({ outcomes: [makePlanOutcome({ mmEnabled: false, mmEligible: false, reason: "reference_not_mm_enabled" })] }),
    botConfig: testBotConfig(),
    dryRun: true,
    confirmLive: false,
    liveOrdersEnabled: false,
  });
  assert.equal(result.ready, true);
  const metadata = buildBotInitializationMetadata({
    current: null as BotInitializationMetadata | null,
    readiness: result,
  });
  assert.equal(metadata.status, "dry_run_ready");
}

function testTradableFalseRefusesLive() {
  const result = evaluateMarketReadiness({
    market: approvedMarket({ tradable: false }),
    reference: makeReferenceResponse(),
    botConfig: testBotConfig(),
    dryRun: false,
    confirmLive: true,
    liveOrdersEnabled: true,
  });
  assert.equal(result.ready, false);
  assert(result.reasons.includes("market_not_tradable"));
}

function testLiveInitWithoutConfirmRefused() {
  const result = evaluateMarketReadiness({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true }),
    reference: makeReferenceResponse(),
    botConfig: testBotConfig(),
    dryRun: false,
    confirmLive: false,
    liveOrdersEnabled: true,
  });
  assert.equal(result.ready, false);
  assert(result.reasons.includes("confirm_live_required"));
}

function testHealthyReferenceDryRunReadinessPasses() {
  const result = evaluateMarketReadiness({
    market: approvedMarket(),
    reference: makeReferenceResponse(),
    botConfig: testBotConfig(),
    dryRun: true,
    confirmLive: false,
    liveOrdersEnabled: false,
  });
  assert.equal(result.ready, true);
  assert.equal(result.plannedBotBid, 0.34);
  assert.equal(result.plannedBotAsk, 0.4);
}

function testHealthyReferenceLiveFlagsMissingRefused() {
  const result = evaluateMarketReadiness({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true }),
    reference: makeReferenceResponse(),
    botConfig: testBotConfig({ apiKey: "dry-run.not-used", risk: { botUserId: null } }),
    dryRun: false,
    confirmLive: true,
    liveOrdersEnabled: false,
  });
  assert.equal(result.ready, false);
  assert(result.reasons.includes("live_orders_disabled"));
  assert(result.reasons.includes("missing_system_bot_account"));
}

function testLiveOnlyCallsCanonicalOrderApiWhenExplicitlyEnabled() {
  let called = 0;
  const api = {
    placeLimitOrder: async () => {
      called += 1;
    },
  };
  void api;
  assert.equal(called, 0);
}

function testLiveReadinessRequiresSeedAndFlags() {
  const result = evaluateLiveReadiness({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_ready", seeded: true, marketStatus: "LIVE" }),
    reference: makeReferenceResponse({ dryRun: false, liveOrdersEnabled: true, outcomes: [makePlanOutcome({ liveOrdersEnabled: true, dryRun: false })] }),
    balance: {
      availableUSDC: "800.000000",
      lockedUSDC: "0.000000",
      totalUSDC: "800.000000",
      updatedAt: new Date().toISOString(),
    },
    positions: [],
    openOrders: [],
    confirmLive: true,
    liveOrdersEnabled: true,
    systemLiquidityDryRun: false,
    runtimePresent: true,
    risk: {
      referenceStaleMs: 15000,
      maxReferenceSpread: 0.1,
      quoteOffsetTicks: 2,
      tickSize: "0.01",
      maxSingleOrderNotionalCents: 1000,
      maxOpenOrderNotionalCents: 10000,
      maxDailyLossCents: 10000,
      maxInventoryPerOutcome: 300,
      minOutcomeInventory: 20,
      minCashReserveCents: 20000,
      maxShareSize: 10,
      minQuoteLifetimeMs: 5000,
      requoteThresholdTicks: 1,
    },
  });
  assert.equal(result.ready, true);
}

function testDesiredQuotesUseReferenceOffset() {
  const quotes = buildDesiredQuotes({
    reference: makeReferenceResponse({
      dryRun: false,
      liveOrdersEnabled: true,
      outcomes: [
        makePlanOutcome({ liveOrdersEnabled: true, dryRun: false, quoteOffsetTicks: 2, referenceBid: 0.173, referenceAsk: 0.174, plannedBotBid: 0.15, plannedBotAsk: 0.19 }),
        makePlanOutcome({ localOutcomeId: "local-outcome-2", outcomeName: "NO", liveOrdersEnabled: true, dryRun: false, referenceBid: 0.82, referenceAsk: 0.83, plannedBotBid: 0.8, plannedBotAsk: 0.85 }),
      ],
    }),
    localQuote: {
      marketId: "local-market-1",
      quotes: [
        { outcomeId: "local-outcome-1", outcomeName: "YES", bestBid: "0.10", bestAsk: "0.40", midPrice: null, lastPrice: null, lastTradeAt: null },
        { outcomeId: "local-outcome-2", outcomeName: "NO", bestBid: "0.50", bestAsk: "0.90", midPrice: null, lastPrice: null, lastTradeAt: null },
      ],
    },
    balance: {
      availableUSDC: "800.000000",
      lockedUSDC: "0.000000",
      totalUSDC: "800.000000",
      updatedAt: new Date().toISOString(),
    },
    positions: [
      { marketId: "local-market-1", marketTitle: "France", marketStatus: "LIVE", outcomeId: "local-outcome-1", outcomeName: "YES", shares: "200.000000", reservedShares: "0.000000", avgCost: "0.5", realizedPnl: "0.0", updatedAt: new Date().toISOString() },
      { marketId: "local-market-1", marketTitle: "France", marketStatus: "LIVE", outcomeId: "local-outcome-2", outcomeName: "NO", shares: "200.000000", reservedShares: "0.000000", avgCost: "0.5", realizedPnl: "0.0", updatedAt: new Date().toISOString() },
    ],
    openOrders: [],
    marketId: "local-market-1",
    risk: {
      referenceStaleMs: 15000,
      maxReferenceSpread: 0.1,
      quoteOffsetTicks: 2,
      tickSize: "0.01",
      maxSingleOrderNotionalCents: 1000,
      maxOpenOrderNotionalCents: 10000,
      maxDailyLossCents: 10000,
      maxInventoryPerOutcome: 300,
      minOutcomeInventory: 20,
      minCashReserveCents: 20000,
      maxShareSize: 10,
      minQuoteLifetimeMs: 5000,
      requoteThresholdTicks: 1,
    },
    cycleTs: Date.now(),
  });
  assert.equal(quotes.find((quote) => quote.outcomeId === "local-outcome-1" && quote.side === "BUY")?.price, "0.15");
  assert.equal(quotes.find((quote) => quote.outcomeId === "local-outcome-1" && quote.side === "SELL")?.price, "0.19");
}

function testReconcileKeepsIdenticalOrder() {
  const result = reconcileQuotes({
    desired: [
      {
        outcomeId: "local-outcome-1",
        outcomeName: "YES",
        side: "BUY",
        price: "0.15",
        size: "10.000000",
        idempotencyKey: "abc",
      },
    ],
    openOrders: [
      {
        id: "order-1",
        clientOrderId: null,
        marketId: "local-market-1",
        outcomeId: "local-outcome-1",
        side: "BUY",
        type: "LIMIT",
        status: "OPEN",
        apiKeyId: "k",
        price: "0.15",
        size: "10.000000",
        remaining: "10.000000",
        reservedNotional: "1.500000",
        createdAt: new Date().toISOString(),
      },
    ],
    nowMs: Date.now(),
    minQuoteLifetimeMs: 5000,
    requoteThresholdTicks: 1,
    tickSize: "0.01",
  });
  assert.equal(result.toCancel.length, 0);
  assert.equal(result.toPlace.length, 0);
}

function testRuntimeSupervisorDefaultsToDryRunPreview() {
  const readiness = healthyLiveReadiness();
  const decision = determineRuntimeDecision({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_enabled", seeded: true, marketStatus: "LIVE" }),
    readiness,
    dryRun: true,
    liveOrdersEnabled: false,
    confirmLive: false,
    runtimePresent: true,
    openOrders: [],
  });
  assert.equal(decision.action, "quote_preview");
  assert.equal(decision.livePlacementAllowed, false);
}

function testRuntimeSupervisorRefusesLiveWithoutFlags() {
  const readiness = healthyLiveReadiness();
  const decision = determineRuntimeDecision({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_enabled", seeded: true, marketStatus: "LIVE" }),
    readiness,
    dryRun: false,
    liveOrdersEnabled: false,
    confirmLive: false,
    runtimePresent: true,
    openOrders: [],
  });
  assert.equal(decision.action, "quote_preview");
  assert.equal(decision.livePlacementAllowed, false);
}

function testRuntimeSupervisorDoesNotTransitionWithoutFlags() {
  const transition = shouldTransitionToLiveEnabled({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_ready", seeded: true, marketStatus: "LIVE" }),
    readiness: healthyLiveReadiness("live_ready"),
    dryRun: false,
    liveOrdersEnabled: false,
    confirmLive: false,
    runtimePresent: true,
  });
  assert.equal(transition.shouldTransition, false);
  assert(transition.reasons.includes("confirm_live_required"));
  assert(transition.reasons.includes("live_orders_disabled"));
}

function testRuntimeSupervisorTransitionsToLiveEnabledWhenExplicitlyAllowed() {
  const transition = shouldTransitionToLiveEnabled({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_ready", seeded: true, marketStatus: "LIVE" }),
    readiness: healthyLiveReadiness("live_ready"),
    dryRun: false,
    liveOrdersEnabled: true,
    confirmLive: true,
    runtimePresent: true,
  });
  assert.equal(transition.shouldTransition, true);
}

function testRuntimeSupervisorSkipsPausedMarket() {
  const decision = determineRuntimeDecision({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "paused", seeded: true, marketStatus: "LIVE" }),
    readiness: healthyLiveReadiness(),
    dryRun: true,
    liveOrdersEnabled: false,
    confirmLive: false,
    runtimePresent: true,
    openOrders: [],
  });
  assert.equal(decision.action, "skip");
  assert(decision.reasons.includes("market_paused"));
}

function testRuntimeSupervisorSkipsBlockedMarket() {
  const decision = determineRuntimeDecision({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "blocked", seeded: true, marketStatus: "LIVE" }),
    readiness: healthyLiveReadiness(),
    dryRun: true,
    liveOrdersEnabled: false,
    confirmLive: false,
    runtimePresent: true,
    openOrders: [],
  });
  assert.equal(decision.action, "skip");
  assert(decision.reasons.includes("market_blocked"));
}

function testRuntimeSupervisorCancelsOnStaleMarket() {
  const staleReadiness = {
    ...healthyLiveReadiness(),
    ready: false,
    reasons: ["reference_stale"],
  };
  const decision = determineRuntimeDecision({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_enabled", seeded: true, marketStatus: "LIVE" }),
    readiness: staleReadiness,
    dryRun: false,
    liveOrdersEnabled: true,
    confirmLive: true,
    runtimePresent: true,
    openOrders: [
      {
        id: "order-1",
        clientOrderId: null,
        marketId: "local-market-1",
        outcomeId: "local-outcome-1",
        side: "BUY",
        type: "LIMIT",
        status: "OPEN",
        apiKeyId: "k",
        price: "0.15",
        size: "10.000000",
        remaining: "10.000000",
        reservedNotional: "1.500000",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  assert.equal(decision.action, "cancel");
}

function testEmergencyStopBlocksTransition() {
  const transition = shouldTransitionToLiveEnabled({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_ready", seeded: true, marketStatus: "LIVE", emergencyStop: true }),
    readiness: healthyLiveReadiness("live_ready", true),
    dryRun: false,
    liveOrdersEnabled: true,
    confirmLive: true,
    runtimePresent: true,
  });
  assert.equal(transition.shouldTransition, false);
  assert(transition.reasons.includes("emergency_stop"));
}

function testMissingRiskCapsBlockTransition() {
  const readiness = evaluateLiveReadiness({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status: "live_ready", seeded: true, marketStatus: "LIVE", missingRiskCaps: true }),
    reference: makeReferenceResponse({ dryRun: false, liveOrdersEnabled: true, outcomes: [makePlanOutcome({ liveOrdersEnabled: true, dryRun: false })] }),
    balance: {
      availableUSDC: "800.000000",
      lockedUSDC: "0.000000",
      totalUSDC: "800.000000",
      updatedAt: new Date().toISOString(),
    },
    positions: [],
    openOrders: [],
    confirmLive: true,
    liveOrdersEnabled: true,
    systemLiquidityDryRun: false,
    runtimePresent: true,
    risk: {
      referenceStaleMs: 15000,
      maxReferenceSpread: 0.1,
      quoteOffsetTicks: 2,
      tickSize: "0.01",
      maxSingleOrderNotionalCents: 1000,
      maxOpenOrderNotionalCents: 10000,
      maxDailyLossCents: 10000,
      maxInventoryPerOutcome: 300,
      minOutcomeInventory: 20,
      minCashReserveCents: 20000,
      maxShareSize: 10,
      minQuoteLifetimeMs: 5000,
      requoteThresholdTicks: 1,
    },
  });
  assert.equal(readiness.ready, false);
  assert(readiness.reasons.includes("missing_risk_caps"));
}

function healthyLiveReadiness(status: string = "live_enabled", emergencyStop = false) {
  return evaluateLiveReadiness({
    market: approvedMarket({ tradable: true, mmEnabled: true, outcomesTradable: true, status, seeded: true, marketStatus: "LIVE", emergencyStop }),
    reference: makeReferenceResponse({ dryRun: false, liveOrdersEnabled: true, outcomes: [makePlanOutcome({ liveOrdersEnabled: true, dryRun: false })] }),
    balance: {
      availableUSDC: "800.000000",
      lockedUSDC: "0.000000",
      totalUSDC: "800.000000",
      updatedAt: new Date().toISOString(),
    },
    positions: [],
    openOrders: [],
    confirmLive: true,
    liveOrdersEnabled: true,
    systemLiquidityDryRun: false,
    runtimePresent: true,
    risk: {
      referenceStaleMs: 15000,
      maxReferenceSpread: 0.1,
      quoteOffsetTicks: 2,
      tickSize: "0.01",
      maxSingleOrderNotionalCents: 1000,
      maxOpenOrderNotionalCents: 10000,
      maxDailyLossCents: 10000,
      maxInventoryPerOutcome: 300,
      minOutcomeInventory: 20,
      minCashReserveCents: 20000,
      maxShareSize: 10,
      minQuoteLifetimeMs: 5000,
      requoteThresholdTicks: 1,
    },
  });
}

function approvedMapping() {
  return buildReferenceMarketMapping({
    localMarketId: "local-market-1",
    localOutcomeId: "local-outcome-1",
    localOutcome: "YES",
    polymarketMarketId: "pm-1",
    conditionId: "cond-1",
    polymarketSlug: "ukraine-signs-peace-deal-with-russia-before-2027",
    polymarketTokenId: "tok-yes",
    polymarketOutcome: "Yes",
    enabled: true,
    mmEnabled: true,
    reviewStatus: "approved",
  });
}

function makeQuote(
  mapping: ReturnType<typeof approvedMapping>,
  overrides: Partial<ReturnType<typeof buildReferencePriceQuote>>,
) {
  return {
    ...buildReferencePriceQuote(
      {
        localMarketId: mapping.localMarketId,
        localOutcomeId: mapping.localOutcomeId,
        polymarketMarketId: mapping.polymarketMarketId,
        conditionId: mapping.conditionId,
        polymarketSlug: mapping.polymarketSlug,
        polymarketOutcome: mapping.polymarketOutcome,
        polymarketTokenId: mapping.polymarketTokenId,
        gammaOutcomePrice: 0.37,
        gammaBestBid: 0.36,
        gammaBestAsk: 0.38,
        gammaSpread: 0.02,
        lastTradePrice: 0.37,
        volume: 10_000,
        volume24hr: 500,
        liquidity: 20_000,
        liquidityClob: 2_000,
        acceptingOrders: true,
        competitive: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
        fetchedAt: "2026-01-01T00:00:10.000Z",
        receivedAt: "2026-01-01T00:00:10.000Z",
      },
      mapping,
      { now: Date.parse("2026-01-01T00:00:10.000Z") },
    ),
    ...overrides,
  };
}

function approvedMarket(overrides: {
  mmEnabled?: boolean;
  tradable?: boolean;
  outcomesTradable?: boolean;
  status?: string;
  seeded?: boolean;
  marketStatus?: string;
  emergencyStop?: boolean;
  missingRiskCaps?: boolean;
} = {}) {
  return {
    id: "local-market-1",
    title: "France World Cup",
    description: "Reference market",
    status: overrides.marketStatus ?? "UPCOMING",
    isListed: true,
    event: null,
    externalMarketId: "pm-1",
    externalSlug: "will-france-win-the-2026-fifa-world-cup-924",
    conditionId: "cond-1",
    referenceSource: "polymarket",
    importStatus: "approved" as const,
    referenceOnly: true,
    tradable: overrides.tradable ?? false,
    mmEnabled: overrides.mmEnabled ?? true,
    reviewedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    outcomePrices: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    lastTradePrice: null,
    volume24hr: null,
    liquidity: null,
    acceptingOrders: null,
    snapshotSummary: null,
    botInitialization: overrides.status || overrides.seeded
      ? {
          status: overrides.status ?? "live_ready",
          lastCheckedAt: null,
          reason: null,
          approvedBy: null,
          approvedAt: null,
          riskProfile: null,
          capital: overrides.seeded
            ? {
                budgetCents: 100000,
                mintBudgetCents: 20000,
                mintedCompleteSets: 200,
                cashReserveCents: 80000,
                autoReplenish: false,
                initializedAt: new Date().toISOString(),
                initializedBy: "admin",
                botUserId: "system-bot-user",
                botUsername: "system-liquidity-bot",
                botApiCredentialId: overrides.missingRiskCaps ? null : "cred-1",
                botApiKeyId: "key-1",
                maxSingleOrderNotionalCents: overrides.missingRiskCaps ? null : 1000,
                maxOpenOrderNotionalCents: overrides.missingRiskCaps ? null : 10000,
                maxDailyLossCents: overrides.missingRiskCaps ? null : 10000,
              }
            : null,
          runtime: {
            liveOrdersEnabled: true,
            emergencyStop: overrides.emergencyStop ?? false,
            cancelRequestedAt: null,
            lastSeededAt: new Date().toISOString(),
            lastLiveRunAt: null,
            lastRuntimeSyncAt: null,
          },
          readiness: null,
        }
      : null,
    referenceMetadata: {},
    outcomes: [
      {
        id: "local-outcome-1",
        name: "YES",
        displayOrder: 0,
        isTradable: overrides.outcomesTradable ?? false,
        referenceTokenId: "tok-yes",
        referenceOutcomeLabel: "Yes",
        referenceMetadata: {},
      },
      {
        id: "local-outcome-2",
        name: "NO",
        displayOrder: 1,
        isTradable: overrides.outcomesTradable ?? false,
        referenceTokenId: "tok-no",
        referenceOutcomeLabel: "No",
        referenceMetadata: {},
      },
    ],
  };
}

function makeReferenceResponse(overrides: Partial<MarketReferencePlanResponse> = {}): MarketReferencePlanResponse {
  return {
    marketId: "local-market-1",
    source: "polymarket",
    externalSlug: "will-france-win-the-2026-fifa-world-cup-924",
    conditionId: "cond-1",
    hasSnapshot: true,
    reason: null,
    dryRun: true,
    liveOrdersEnabled: false,
    outcomes: overrides.outcomes ?? [makePlanOutcome()],
    ...overrides,
  };
}

function makePlanOutcome(overrides: Partial<MarketReferencePlanResponse["outcomes"][number]> = {}) {
  return {
    localMarketId: "local-market-1",
    localOutcomeId: "local-outcome-1",
    outcomeName: "YES",
    referenceSource: "polymarket",
    polymarketSlug: "will-france-win-the-2026-fifa-world-cup-924",
    polymarketMarketId: "pm-1",
    conditionId: "cond-1",
    polymarketTokenId: "tok-yes",
    gammaOutcomePrice: 0.37,
    gammaBestBid: 0.36,
    gammaBestAsk: 0.38,
    gammaSpread: 0.02,
    lastTradePrice: 0.37,
    volume: 1000,
    volume24hr: 250,
    liquidity: 5000,
    acceptingOrders: true,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ageMs: 1000,
    isFresh: true,
    hasSnapshot: true,
    qualityStatus: "high_quality",
    mmEligible: true,
    mmEnabled: true,
    reason: null,
    tickSize: "0.01",
    quoteOffsetTicks: 2,
    plannedBotBid: 0.34,
    plannedBotAsk: 0.4,
    referenceBid: 0.36,
    referenceAsk: 0.38,
    activeBotBid: null,
    activeBotAsk: null,
    dryRun: true,
    liveOrdersEnabled: false,
    quotePlanEnabled: true,
    quotePreviewAvailable: true,
    formula: "plannedBotBid = referenceBid - 2 ticks; plannedBotAsk = referenceAsk + 2 ticks",
    ...overrides,
  };
}

function testBotConfig(overrides: Partial<ReturnType<typeof testBotConfigBase>> = {}) {
  return {
    ...testBotConfigBase(),
    ...overrides,
    risk: {
      ...testBotConfigBase().risk,
      ...(overrides.risk ?? {}),
    },
  };
}

function testBotConfigBase() {
  return loadConfig(process.cwd(), { requireBots: false }).bots[0] ?? {
    name: "referenceAwareSystemLiquidityDryRun",
    baseUrl: "http://127.0.0.1:3000",
    apiKey: "test-key",
    strategy: "tightMarketMaker" as const,
    marketIds: ["local-market-1"],
    pollIntervalMs: 5000,
    loopIntervalMinMs: 5000,
    loopIntervalMaxMs: 5000,
    maxOrderSize: "1.000000",
    maxTakerSize: "0.000000",
    maxOpenOrders: 0,
    staleOrderMs: 15000,
    minQuoteLifetimeMs: 5000,
    decisionCooldownMs: 5000,
    capBackoffMs: 8000,
    tickSize: "0.01",
    maxPositionShares: "0.000000",
    inventoryTargetShares: "0.000000",
    targetSpreadTicks: 4,
    quoteOffsetMinTicks: 0,
    quoteOffsetMaxTicks: 0,
    staleDistanceTicks: 4,
    replaceThresholdTicks: 2,
    replaceHysteresisTicks: 2,
    maxOrdersPerSide: 0,
    takerProbability: 0,
    takerThresholdTicks: 0,
    inventorySkewStrength: 0,
    fallbackFairPrice: "0.50",
    dailyNotionalPauseMode: "pause_for_run" as const,
    dailyNotionalCooldownMs: 86400000,
    pausedPollIntervalMs: 45000,
    pauseLogIntervalMs: 60000,
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
      inventoryReduceThreshold: 0.5,
      inventoryEmergencyThreshold: 0.9,
      levelSizeMultipliers: [1],
      extremeSizeReduction: 0.5,
      minLevelSize: "0.100000",
      replenishmentTargetShares: "1.000000",
      enableMintReplenishment: false,
      targetAskDepthShares: "1.000000",
      safetyMultiplier: 1.2,
      targetInventoryShares: "1.000000",
      minMintAmount: "1.000000",
      maxMintAmountPerCycle: "1.000000",
      maxMintPerMarketPerHour: "1.000000",
      extremeMintReductionThresholdHigh: 0.9,
      extremeMintReductionThresholdLow: 0.1,
      extremeMintReductionFactor: 0.5,
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
      botUserId: "system-bot-user",
      enabled: true,
      maxTotalCapitalCents: 100000,
      maxCapitalPerMarketCents: 10000,
      maxOpenOrderNotionalCents: 1000,
      maxOrderSizeCents: 500,
      maxDailyLossCents: 1000,
      maxDailySubmittedNotionalCents: 10000,
      maxYesSharesPerMarket: "10.000000",
      maxNoSharesPerMarket: "10.000000",
      maxOrdersPerMarket: 2,
      maxQuoteLevelsPerSide: 1,
      staleDataMaxAgeMs: 15000,
      pauseNearResolutionMinutes: 0,
      repeatedErrorPauseMs: 1000,
      inventoryReduceOnlyThreshold: 0.8,
      inventoryStopThreshold: 0.95,
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

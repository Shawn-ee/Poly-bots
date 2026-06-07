import assert from "node:assert/strict";
import { createDefaultAgentContext, runMarketCreationAgent, runMarketDiscoveryAgent, runResolutionReviewAgent } from "../src/agents/index.js";
import { blockedAction, isAgentActionAllowed } from "../src/agents/policies.js";
import { createOrderApiTool } from "../src/tools/orderApiTool.js";
import { buildRiskReport, evaluateOrderIntentRisk } from "../src/tools/riskTool.js";
import { evaluateCandidate } from "../src/referenceMarket/marketDiscovery.js";
import { ReferenceMarketCandidate } from "../src/referenceMarket/types.js";

async function main() {
  testPolicyBlocks();
  testGenericSoccerRejection();
  await testMarketDiscoveryAgentDryRun();
  await testMarketCreationDraftOnly();
  testRiskReviewBlocksUnsafeOrder();
  await testResolutionReviewRequiresApproval();
  testOrderToolLivePlacementDisabled();
  console.log("Agent architecture tests passed.");
}

function testPolicyBlocks() {
  const context = createDefaultAgentContext("riskReview", "dryRun");
  assert.equal(isAgentActionAllowed("PLACE_ORDER", context), false);
  assert.equal(isAgentActionAllowed("MOVE_FUNDS", context), false);
  assert.equal(isAgentActionAllowed("ACTIVATE_MARKET", context), false);
  assert.equal(isAgentActionAllowed("RESOLVE_MARKET", context), false);
  assert.equal(blockedAction("MOVE_FUNDS", "move funds", context, "forbidden").safetyLevel, "blocked");
}

function testGenericSoccerRejection() {
  const context = createDefaultAgentContext("marketDiscovery", "dryRun");
  const candidate = makeCandidate("Will Arsenal win the Premier League?", "arsenal-premier-league", {
    tags: ["soccer"],
  });
  const evaluated = evaluateCandidate(candidate, {
    enabled: false,
    dryRun: true,
    topN: 10,
    maxImportedMarkets: context.maxImportedMarketsPerRun,
    maxNewImportsPerRun: context.maxDraftMarketsPerRun,
    allowedVerticals: ["nba", "world_cup"],
    minReferenceLiquidity: null,
    minReferenceVolume: null,
    maxReferenceSpread: 0.1,
    outputPath: "unused.json",
    mappingPath: "unused-map.json",
    baseUrl: "http://127.0.0.1:3001",
    adminSessionCookie: null,
    createDrafts: false,
    createEvents: true,
  });
  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.rejectedReason, "not_allowed_vertical");
}

async function testMarketDiscoveryAgentDryRun() {
  const context = createDefaultAgentContext("marketDiscovery", "dryRun");
  const result = await runMarketDiscoveryAgent(context, {
    candidates: [
      makeCandidate("Will the Celtics win the NBA Finals?", "celtics-nba-finals"),
      makeCandidate("Will Brazil win the FIFA World Cup 2026?", "brazil-world-cup"),
      makeCandidate("Will Arsenal win the Premier League?", "arsenal-premier-league", { tags: ["soccer"] }),
    ],
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.data.candidatesAccepted, 2);
  assert.equal(result.data.rejectionReasons.not_allowed_vertical, 1);
  assert(result.blockedActions.some((action) => action.type === "PLACE_ORDER"));
}

async function testMarketCreationDraftOnly() {
  const context = createDefaultAgentContext("marketCreation", "dryRun");
  const result = await runMarketCreationAgent(context, makeCandidate("Will France win the FIFA World Cup 2026?", "france-world-cup"));
  assert.equal(result.data.draftPayload?.market.desiredStatus, "draft");
  assert.equal(result.data.draftPayload?.market.outcomes.every((outcome) => outcome.isTradable === false), true);
  assert(result.blockedActions.some((action) => action.type === "ACTIVATE_MARKET"));
}

function testRiskReviewBlocksUnsafeOrder() {
  const context = createDefaultAgentContext("riskReview", "dryRun");
  const findings = evaluateOrderIntentRisk(
    { marketId: "m1", outcomeId: "o1", side: "BUY", price: "0.50", size: "1.0", reason: "test" },
    context,
  );
  const report = buildRiskReport(findings);
  assert.equal(report.recommendation, "blocked");
  assert(report.hardBlockers.some((finding) => finding.code === "live_trading_disabled"));
}

async function testResolutionReviewRequiresApproval() {
  const context = createDefaultAgentContext("resolutionReview", "reviewOnly");
  const result = await runResolutionReviewAgent(context, {
    marketId: "m1",
    marketTitle: "Test market",
    candidateWinningOutcomeId: "o1",
    evidence: ["test evidence"],
    confidence: 0.95,
    approvedByAdmin: false,
  });
  assert.equal(result.status, "blocked");
  assert(result.blockedActions.some((action) => action.type === "RESOLVE_MARKET"));
}

function testOrderToolLivePlacementDisabled() {
  const context = createDefaultAgentContext("riskReview", "dryRun");
  const tool = createOrderApiTool(null, context);
  const result = tool.placeOrderDryRun({
    marketId: "m1",
    outcomeId: "o1",
    side: "BUY",
    price: "0.50",
    size: "1.0",
    reason: "test",
  });
  assert.equal(result.dryRun, true);
  assert(result.blockedActions.some((action) => action.type === "PLACE_ORDER"));
}

function makeCandidate(
  question: string,
  slug: string,
  overrides: Partial<ReferenceMarketCandidate> = {},
): ReferenceMarketCandidate {
  const base: ReferenceMarketCandidate = {
    source: "polymarket",
    externalMarketId: `pm-${slug}`,
    conditionId: `cond-${slug}`,
    slug,
    question,
    description: question,
    category: "Sports",
    tags: ["sports"],
    eventSlug: slug.includes("world-cup") ? "fifa-world-cup-2026" : "nba",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-07-19T00:00:00.000Z",
    resolutionSource: "Official source",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    competitive: true,
    volume: 1000,
    volume24hr: 100,
    liquidity: 5000,
    liquidityClob: 4000,
    bestBid: 0.49,
    bestAsk: 0.51,
    spread: 0.02,
    lastTradePrice: 0.5,
    updatedAt: new Date().toISOString(),
    image: null,
    icon: null,
    outcomePrices: [0.5, 0.5],
    event: {
      title: slug.includes("world-cup") ? "FIFA World Cup" : "NBA",
      slug: slug.includes("world-cup") ? "fifa-world-cup" : "nba",
      description: null,
      category: "Sports",
      status: "ACTIVE",
      source: "polymarket",
      externalEventId: `event-${slug}`,
      externalSlug: slug.includes("world-cup") ? "fifa-world-cup" : "nba",
      image: null,
      icon: null,
      metadata: {},
    },
    outcomes: [
      { label: "Yes", tokenId: `tok-${slug}-yes`, index: 0, outcomePrice: 0.5 },
      { label: "No", tokenId: `tok-${slug}-no`, index: 1, outcomePrice: 0.5 },
    ],
    clobTokenIds: [`tok-${slug}-yes`, `tok-${slug}-no`],
    raw: {},
  };
  return { ...base, ...overrides };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


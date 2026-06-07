import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDraftImportPayload,
  classifyVertical,
  evaluateCandidate,
  runMarketDiscovery,
} from "../src/referenceMarket/marketDiscovery.js";
import { ReferenceMarketCandidate } from "../src/referenceMarket/types.js";

async function main() {
  testNbaFilter();
  testWorldCupFilter();
  testUnrelatedRejection();
  testGenericSoccerRejection();
  testScoring();
  testDedupe();
  await testMaxImportedMarketCap();
  testDraftOnlyImportPayload();
  testNoAutoPublishOrResolution();
  await testDryRunNoDbMutation();
  console.log("Market discovery tests passed.");
}

function testNbaFilter() {
  const candidate = makeCandidate("Will the Boston Celtics win the NBA Finals?", "nba-finals");
  const evaluated = evaluateCandidate(candidate, defaultOptions());
  assert.equal(classifyVertical(candidate), "nba");
  assert.equal(evaluated.accepted, true);
  assert.equal(evaluated.vertical, "nba");
}

function testWorldCupFilter() {
  const candidate = makeCandidate("Will Brazil win the FIFA World Cup 2026?", "fifa-world-cup-brazil");
  const evaluated = evaluateCandidate(candidate, defaultOptions());
  assert.equal(classifyVertical(candidate), "world_cup");
  assert.equal(evaluated.accepted, true);
  assert.equal(evaluated.vertical, "world_cup");
}

function testUnrelatedRejection() {
  const candidate = makeCandidate("Will Bitcoin hit $100k before July?", "bitcoin-100k", {
    category: "Crypto",
    tags: ["crypto"],
  });
  const evaluated = evaluateCandidate(candidate, defaultOptions());
  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.rejectedReason, "excluded_topic");
}

function testGenericSoccerRejection() {
  const candidate = makeCandidate("Will Arsenal win the Premier League?", "arsenal-premier-league", {
    tags: ["soccer"],
  });
  const evaluated = evaluateCandidate(candidate, defaultOptions());
  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.rejectedReason, "not_allowed_vertical");
}

function testScoring() {
  const strong = evaluateCandidate(
    makeCandidate("Will the Lakers win the NBA championship?", "lakers-nba-championship", {
      volume: 1_000_000,
      liquidity: 100_000,
      spread: 0.01,
    }),
    defaultOptions(),
  );
  const weak = evaluateCandidate(
    makeCandidate("Will the Lakers win the NBA championship?", "lakers-nba-championship-low", {
      volume: 10,
      liquidity: 10,
      spread: 0.09,
    }),
    defaultOptions(),
  );
  assert(strong.score > weak.score);
  assert(strong.scoreBreakdown.volume > weak.scoreBreakdown.volume);
  assert(strong.scoreBreakdown.spreadQuality > weak.scoreBreakdown.spreadQuality);
}

function testDedupe() {
  const candidate = makeCandidate("Will Canada win the FIFA World Cup 2026?", "canada-world-cup");
  const evaluated = evaluateCandidate(candidate, defaultOptions(), new Set([`externalMarketId:${candidate.externalMarketId}`]));
  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.rejectedReason, "duplicate");
  assert.equal(evaluated.duplicateKeys.length, 1);
}

async function testMaxImportedMarketCap() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-discovery-cap-"));
  const options = {
    ...defaultOptions(),
    outputPath: path.join(tempDir, "out.json"),
    mappingPath: path.join(tempDir, "map.json"),
    maxImportedMarkets: 1,
    maxNewImportsPerRun: 10,
  };
  const result = await runMarketDiscovery(options, {
    gamma: {
      searchMarkets: async ({ query }: { query: string }) =>
        query.includes("NBA")
          ? [makeCandidate("Will the Knicks win the NBA Finals?", "knicks-nba-finals")]
          : [makeCandidate("Will Spain win the FIFA World Cup 2026?", "spain-world-cup")],
    },
  });
  assert.equal(result.totalAccepted, 1);
  assert.equal(result.candidates.filter((item) => item.rejectedReason === "import_cap_reached").length > 0, true);
}

function testDraftOnlyImportPayload() {
  const item = evaluateCandidate(makeCandidate("Will France win the FIFA World Cup 2026?", "france-world-cup"), defaultOptions());
  const payload = buildDraftImportPayload(item);
  assert.equal(payload.market.desiredStatus, "draft");
  assert.equal(payload.market.outcomes.every((outcome) => outcome.isTradable === false), true);
  const metadata = payload.market.referenceMetadata as Record<string, unknown>;
  assert.equal(metadata.importStatus, "pending_review");
  assert.equal(metadata.listed, false);
  assert.equal(metadata.tradable, false);
  assert.equal(metadata.mmEnabled, false);
  assert.equal(metadata.referenceOnly, true);
}

function testNoAutoPublishOrResolution() {
  const item = evaluateCandidate(makeCandidate("Will the Warriors win the NBA playoffs?", "warriors-nba-playoffs"), defaultOptions());
  const metadata = buildDraftImportPayload(item).market.referenceMetadata as Record<string, unknown>;
  assert.equal(metadata.autoPublish, false);
  assert.equal(metadata.autoResolve, false);
}

async function testDryRunNoDbMutation() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "market-discovery-dry-"));
  let importCalls = 0;
  const result = await runMarketDiscovery(
    {
      ...defaultOptions(),
      outputPath: path.join(tempDir, "out.json"),
      mappingPath: path.join(tempDir, "map.json"),
      enabled: true,
      dryRun: true,
      createDrafts: true,
    },
    {
      gamma: {
        searchMarkets: async () => [makeCandidate("Will the Nuggets win the NBA Finals?", "nuggets-nba-finals")],
      },
      adminApi: {
        listAdminReferenceMarkets: async () => ({ items: [] }),
        importAdminReferenceMarket: async () => {
          importCalls += 1;
          throw new Error("dry run should not import");
        },
        updateAdminReferenceMarket: async () => {
          throw new Error("dry run should not update");
        },
      },
    },
  );
  assert.equal(importCalls, 0);
  assert.equal(result.importedDrafts.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(tempDir, "out.json"), "utf8")).dryRun, true);
}

function defaultOptions() {
  return {
    enabled: false,
    dryRun: true,
    topN: 10,
    maxImportedMarkets: 300,
    maxNewImportsPerRun: 10,
    allowedVerticals: ["nba", "world_cup"] as const,
    minReferenceLiquidity: null,
    minReferenceVolume: null,
    maxReferenceSpread: 0.1,
    outputPath: "unused.json",
    mappingPath: "unused-map.json",
    baseUrl: "http://127.0.0.1:3001",
    adminSessionCookie: null,
    createDrafts: false,
    createEvents: true,
  };
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

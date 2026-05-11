import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { importPolymarketWorldCupMarkets } from "../src/referenceMarket/importWorldCupMarkets.js";
import {
  isRelevantWorldCupMarket,
  normalizeGammaMarket,
} from "../src/referenceMarket/polymarketGammaClient.js";
import { PolymarketClobClient } from "../src/referenceMarket/polymarketClobClient.js";
import { ReferenceMarketCandidate } from "../src/referenceMarket/types.js";

async function main() {
  await testGammaNormalization();
  await testWorldCupFiltering();
  await testClobEmptyBookHandling();
  await testDryRunDoesNotCreateMarkets();
  await testSingleMarketImportBySlug();
  await testCreateModeCreatesMappings();
  await testCreateModeIsIdempotent();
  console.log("Reference market import tests passed.");
}

async function testGammaNormalization() {
  const candidate = normalizeGammaMarket({
    id: "pm-1",
    conditionId: "cond-1",
    slug: "fifa-world-cup-winner",
    question: "Who will win the FIFA World Cup 2026?",
    description: "World Cup winner market",
    category: "Sports",
    tags: [{ name: "Soccer" }],
    eventSlug: "world-cup-2026",
    startDate: "2026-06-11T00:00:00Z",
    endDate: "2026-07-19T00:00:00Z",
    resolutionSource: "FIFA",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    competitive: true,
    volume: "12345.67",
    volume24hr: "456.78",
    liquidity: "54321.10",
    liquidityClob: "222.22",
    bestBid: "0.39",
    bestAsk: "0.40",
    spread: "0.01",
    lastTradePrice: "0.38",
    outcomes: "[\"Yes\",\"No\"]",
    outcomePrices: "[\"0.395\",\"0.605\"]",
    clobTokenIds: "[\"tok-yes\",\"tok-no\"]",
    events: [{ id: "evt-1", slug: "fifa-world-cup", title: "FIFA World Cup" }],
  });

  assert(candidate);
  assert.equal(candidate.externalMarketId, "pm-1");
  assert.equal(candidate.clobTokenIds[0], "tok-yes");
  assert.equal(candidate.outcomes[1]?.label, "No");
  assert.equal(candidate.outcomes[0]?.outcomePrice, 0.395);
  assert.equal(candidate.bestBid, 0.39);
  assert.equal(candidate.event?.externalEventId, "evt-1");
}

async function testWorldCupFiltering() {
  const soccer = makeCandidate("Who will win the FIFA World Cup 2026?", ["soccer"]);
  const cricket = makeCandidate("Who will win the Cricket World Cup?", ["cricket"]);
  assert.equal(isRelevantWorldCupMarket(soccer), true);
  assert.equal(isRelevantWorldCupMarket(cricket), false);
}

async function testClobEmptyBookHandling() {
  const client = new PolymarketClobClient("https://clob.polymarket.com", async (input) => {
    const url = String(input);
    if (url.includes("/book")) {
      return jsonResponse({ bids: [], asks: [] });
    }
    if (url.includes("/price")) {
      return jsonResponse({});
    }
    if (url.includes("/midpoint")) {
      return jsonResponse({});
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const quote = await client.getReferenceQuote("tok-empty", "Yes");
  assert.equal(quote.isAvailable, false);
  assert.equal(quote.bestBid, null);
  assert.equal(quote.bestAsk, null);
  assert.equal(quote.midpoint, null);
}

async function testDryRunDoesNotCreateMarkets() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-import-dry-"));
  let createCalls = 0;
  const result = await importPolymarketWorldCupMarkets(
    {
      limit: 5,
      dryRun: true,
      createLocalMarkets: false,
      createEvents: true,
      status: "draft",
      query: "world cup",
      slug: null,
      outputPath: path.join(tempDir, "out.json"),
      mappingPath: path.join(tempDir, "map.json"),
      baseUrl: "http://localhost:3000",
      adminSessionCookie: null,
    },
    {
      gamma: {
        searchWorldCupMarkets: async () => [makeCandidate("Who will win the FIFA World Cup 2026?", ["soccer"])],
      } as never,
      clob: {
        getReferenceQuote: async () => ({
          source: "polymarket",
          tokenId: "tok-yes",
          outcome: "Yes",
          bestBid: 0.49,
          bestAsk: 0.51,
          midpoint: 0.5,
          spread: 0.02,
          receivedAt: new Date().toISOString(),
          isAvailable: true,
          isStale: false,
          raw: {},
        }),
      } as never,
      adminApi: {
        importAdminReferenceMarket: async () => {
          createCalls += 1;
          return { ok: true, eventId: null, eventCreated: false, marketId: "local-1", marketCreated: true, outcomeIds: ["o1", "o2"] };
        },
      },
    },
  );

  assert.equal(result.totalCandidatesSelected, 1);
  assert.equal(createCalls, 0);
}

async function testSingleMarketImportBySlug() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-import-slug-"));
  const result = await importPolymarketWorldCupMarkets(
    {
      limit: 1,
      dryRun: true,
      createLocalMarkets: false,
      createEvents: true,
      status: "draft",
      query: null,
      slug: "ukraine-signs-peace-deal-with-russia-before-2027",
      outputPath: path.join(tempDir, "out.json"),
      mappingPath: path.join(tempDir, "map.json"),
      baseUrl: "http://localhost:3000",
      adminSessionCookie: null,
    },
    {
      gamma: {
        getMarketBySlug: async () => makeCandidate("Ukraine signs peace deal with Russia before 2027?", ["politics"]),
      } as never,
      clob: {
        getReferenceQuote: async (_tokenId: string, outcome: string) => ({
          source: "polymarket",
          tokenId: outcome === "Yes" ? "tok-yes" : "tok-no",
          outcome,
          bestBid: 0.39,
          bestAsk: 0.4,
          midpoint: 0.395,
          spread: 0.01,
          receivedAt: new Date().toISOString(),
          isAvailable: true,
          isStale: false,
          raw: {},
        }),
      } as never,
    },
  );

  assert.equal(result.totalCandidatesSelected, 1);
  assert.equal(result.selectedCandidates[0]?.question, "Ukraine signs peace deal with Russia before 2027?");
}

async function testCreateModeCreatesMappings() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-import-create-"));
  const result = await importPolymarketWorldCupMarkets(
    {
      limit: 1,
      dryRun: false,
      createLocalMarkets: true,
      createEvents: true,
      status: "draft",
      query: "world cup",
      slug: null,
      outputPath: path.join(tempDir, "out.json"),
      mappingPath: path.join(tempDir, "map.json"),
      baseUrl: "http://localhost:3000",
      adminSessionCookie: "next-auth.session-token=test",
    },
    {
      gamma: {
        searchWorldCupMarkets: async () => [makeCandidate("Who will win the FIFA World Cup 2026?", ["soccer"])],
      } as never,
      clob: {
        getReferenceQuote: async (_tokenId: string, outcome: string) => ({
          source: "polymarket",
          tokenId: outcome === "Yes" ? "tok-yes" : "tok-no",
          outcome,
          bestBid: 0.49,
          bestAsk: 0.51,
          midpoint: 0.5,
          spread: 0.02,
          receivedAt: new Date().toISOString(),
          isAvailable: true,
          isStale: false,
          raw: {},
        }),
      } as never,
      adminApi: {
        importAdminReferenceMarket: async () => ({
          ok: true,
          eventId: "event-1",
          eventCreated: true,
          marketId: "local-1",
          marketCreated: true,
          outcomeIds: ["outcome-1", "outcome-2"],
        }),
      },
    },
  );

  assert.equal(result.localMarketsCreated.length, 1);
  assert.equal(result.localMarketsCreated[0]?.created, true);
  assert.equal(result.mappingsWritten.length, 2);

  const mappingFile = JSON.parse(await readFile(path.join(tempDir, "map.json"), "utf8")) as Array<{ localMarketId: string }>;
  assert.equal(mappingFile.length, 2);
  assert.equal(mappingFile[0]?.localMarketId, "local-1");
}

async function testCreateModeIsIdempotent() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-import-idempotent-"));
  let importCalls = 0;
  const options = {
    limit: 1,
    dryRun: false,
    createLocalMarkets: true,
    createEvents: true,
    status: "draft" as const,
    query: "world cup",
    slug: null,
    outputPath: path.join(tempDir, "out.json"),
    mappingPath: path.join(tempDir, "map.json"),
    baseUrl: "http://localhost:3000",
    adminSessionCookie: "next-auth.session-token=test",
  };

  const deps = {
    gamma: {
      searchWorldCupMarkets: async () => [makeCandidate("Who will win the FIFA World Cup 2026?", ["soccer"])],
    } as never,
    clob: {
      getReferenceQuote: async (_tokenId: string, outcome: string) => ({
        source: "polymarket",
        tokenId: outcome === "Yes" ? "tok-yes" : "tok-no",
        outcome,
        bestBid: 0.49,
        bestAsk: 0.51,
        midpoint: 0.5,
        spread: 0.02,
        receivedAt: new Date().toISOString(),
        isAvailable: true,
        isStale: false,
        raw: {},
      }),
    } as never,
    adminApi: {
      importAdminReferenceMarket: async () => {
        importCalls += 1;
        return {
          ok: true,
          eventId: "event-1",
          eventCreated: importCalls === 1,
          marketId: "local-1",
          marketCreated: importCalls === 1,
          outcomeIds: ["outcome-1", "outcome-2"],
        };
      },
    },
  };

  await importPolymarketWorldCupMarkets(options, deps);
  const second = await importPolymarketWorldCupMarkets(options, deps);
  assert.equal(importCalls, 2);
  assert.equal(second.mappingsWritten.length, 2);
  assert.equal(second.localMarketsCreated[0]?.localMarketId, "local-1");
}

function makeCandidate(question: string, tags: string[]): ReferenceMarketCandidate {
  return {
    source: "polymarket",
    externalMarketId: question.toLowerCase().replace(/\s+/g, "-"),
    conditionId: "cond-1",
    slug: "world-cup-market",
    question,
    description: question,
    category: "Sports",
    tags,
    eventSlug: "world-cup-2026",
    startDate: "2026-06-11T00:00:00Z",
    endDate: "2026-07-19T00:00:00Z",
    resolutionSource: "FIFA",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    competitive: true,
    volume: 1000,
    volume24hr: 250,
    liquidity: 5000,
    liquidityClob: 3000,
    bestBid: 0.49,
    bestAsk: 0.51,
    spread: 0.02,
    lastTradePrice: 0.5,
    image: null,
    icon: null,
    outcomePrices: [0.5, 0.5],
    event: {
      title: "FIFA World Cup",
      slug: "fifa-world-cup",
      description: "World Cup event",
      category: "Sports",
      status: "ACTIVE",
      source: "polymarket",
      externalEventId: "evt-1",
      externalSlug: "fifa-world-cup",
      image: null,
      icon: null,
      metadata: {},
    },
    outcomes: [
      { label: "Yes", tokenId: "tok-yes", index: 0, outcomePrice: 0.5 },
      { label: "No", tokenId: "tok-no", index: 1, outcomePrice: 0.5 },
    ],
    clobTokenIds: ["tok-yes", "tok-no"],
    raw: {},
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

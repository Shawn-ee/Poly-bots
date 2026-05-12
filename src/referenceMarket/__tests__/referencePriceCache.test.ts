import assert from "node:assert/strict";
import test from "node:test";
import { LocalReferenceMarket } from "../localReferenceMarkets.js";
import { ReferencePriceCache } from "../referencePriceCache.js";
import { ReferenceMarketCandidate } from "../types.js";

function makeMarket(overrides: Partial<LocalReferenceMarket> = {}): LocalReferenceMarket {
  return {
    id: "market-1",
    title: "Test Market",
    status: "LIVE",
    type: "BINARY",
    mechanism: "ORDERBOOK",
    visibility: "PUBLIC",
    isListed: false,
    resolveTime: null,
    externalMarketId: "pm-1",
    conditionId: "cond-1",
    referenceSource: "polymarket",
    externalSlug: "test-market",
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
    slug: "test-market",
    question: "Test Market?",
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
    volume: 1000,
    volume24hr: 250,
    liquidity: 500,
    liquidityClob: 500,
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

test("reference cache returns fresh binary quotes", () => {
  const cache = new ReferencePriceCache(15_000);
  cache.updateMarket(makeMarket(), makeCandidate(), new Date().toISOString());

  const yes = cache.getQuote("market-1", "yes");
  const no = cache.getQuote("market-1", "no");

  assert.equal(yes?.bestBid, "0.390000");
  assert.equal(yes?.bestAsk, "0.400000");
  assert.equal(no?.bestBid, "0.600000");
  assert.equal(no?.bestAsk, "0.610000");
  assert.equal(cache.getQualityStatus("market-1", "yes", { maxReferenceSpread: 0.1 }).reason, "ok");
});

test("reference cache marks stale quotes", () => {
  const cache = new ReferencePriceCache(100);
  cache.updateMarket(makeMarket(), makeCandidate(), new Date(Date.now() - 1_000).toISOString());

  const status = cache.getQualityStatus("market-1", "yes", { maxReferenceSpread: 0.1 });
  assert.equal(status.reason, "reference_stale");
  assert.equal(status.fresh, false);
});

test("reference cache handles missing quote", () => {
  const cache = new ReferencePriceCache(15_000);
  const status = cache.getQualityStatus("missing", "yes");
  assert.equal(status.reason, "missing_quote");
});

test("reference cache rejects wide spread and bad price range", () => {
  const cache = new ReferencePriceCache(15_000);
  cache.updateMarket(
    makeMarket(),
    makeCandidate({ bestBid: 0.2, bestAsk: 0.4, spread: 0.2 }),
    new Date().toISOString(),
  );
  assert.equal(
    cache.getQualityStatus("market-1", "yes", { maxReferenceSpread: 0.1 }).reason,
    "reference_spread_too_wide",
  );

  cache.updateMarket(
    makeMarket(),
    makeCandidate({ bestBid: 0.98, bestAsk: 0.97, spread: -0.01 }),
    new Date().toISOString(),
  );
  assert.equal(
    cache.getQualityStatus("market-1", "yes", { maxReferenceSpread: 0.1 }).reason,
    "reference_bad_price_range",
  );
});

test("reference cache survives API error and keeps last good quote", () => {
  const cache = new ReferencePriceCache(15_000);
  cache.updateMarket(makeMarket(), makeCandidate(), new Date().toISOString());
  cache.noteMarketPollError("market-1", new Error("network down"));

  const yes = cache.getQuote("market-1", "yes");
  assert.equal(yes?.bestBid, "0.390000");
});

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PolymarketGammaClient,
  normalizeGammaMarket,
} from "../src/referenceMarket/polymarketGammaClient.js";
import { PolymarketClobClient } from "../src/referenceMarket/polymarketClobClient.js";
import { ReferenceMarketCandidate, ReferenceQuote } from "../src/referenceMarket/types.js";

const QUERIES = [
  "FIFA World Cup",
  "World Cup",
  "2026 World Cup",
  "world cup match",
  "world cup game",
  "world cup winner",
  "world cup group",
  "world cup qualifier",
];

type OutcomePriceRow = {
  outcome: string;
  tokenId: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  priceQuality: string;
};

type InvestigatedMarket = {
  rank: number;
  question: string;
  slug: string | null;
  event: string | null;
  marketType: "binary" | "multi-outcome";
  liquidity: number | null;
  volume: number | null;
  endDate: string | null;
  outcomePrices: OutcomePriceRow[];
  usableForReference: boolean;
  reason: string;
  category: string | null;
  tags: string[];
  isOutrightFuture: boolean;
};

type InvestigationOutput = {
  fetchedAt: string;
  queriesUsed: string[];
  totalCandidatesScanned: number;
  top20Selected: number;
  binaryCount: number;
  multiOutcomeCount: number;
  usableForReferenceCount: number;
  selected: InvestigatedMarket[];
  rejectedHighKeywordLowQuality: Array<{
    question: string;
    slug: string | null;
    liquidity: number | null;
    volume: number | null;
    reason: string;
  }>;
};

async function main() {
  const outputPath = path.resolve(
    process.cwd(),
    "../Poly/test-logs/polymarket-worldcup-top20-active.json",
  );

  const gamma = new PolymarketGammaClient();
  const clob = new PolymarketClobClient();
  const queryCandidates = await gamma.searchWorldCupMarkets({
    queries: QUERIES,
    limit: 200,
  });
  const universeCandidates = await fetchWorldCupUniverse();
  const candidates = dedupeCandidates([...queryCandidates, ...universeCandidates]);

  const investigated = await Promise.all(candidates.map(async (candidate) => investigateCandidate(candidate, clob)));
  const filtered = investigated
    .filter((item) => !item.isOutrightFuture)
    .sort(compareInvestigated)
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const rejected = investigated
    .filter((item) => item.isOutrightFuture || !item.usableForReference)
    .sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0) || (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 5)
    .map((item) => ({
      question: item.question,
      slug: item.slug,
      liquidity: item.liquidity,
      volume: item.volume,
      reason: item.reason,
    }));

  const output: InvestigationOutput = {
    fetchedAt: new Date().toISOString(),
    queriesUsed: QUERIES,
    totalCandidatesScanned: candidates.length,
    top20Selected: filtered.length,
    binaryCount: filtered.filter((item) => item.marketType === "binary").length,
    multiOutcomeCount: filtered.filter((item) => item.marketType === "multi-outcome").length,
    usableForReferenceCount: filtered.filter((item) => item.usableForReference).length,
    selected: filtered,
    rejectedHighKeywordLowQuality: rejected,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Candidates scanned: ${output.totalCandidatesScanned}`);
  console.log(`Top 20 selected: ${output.top20Selected}`);
  console.log(`Binary: ${output.binaryCount}`);
  console.log(`Multi-outcome: ${output.multiOutcomeCount}`);
  console.log(`Usable for reference: ${output.usableForReferenceCount}`);
  console.log(`Output: ${outputPath}`);
  console.log("");

  console.table(
    filtered.map((item) => ({
      rank: item.rank,
      question: item.question.length > 64 ? `${item.question.slice(0, 61)}...` : item.question,
      slug: item.slug ?? "",
      event: item.event ?? "",
      marketType: item.marketType,
      liquidity: item.liquidity ?? "",
      volume: item.volume ?? "",
      endDate: item.endDate ?? "",
      outcomePrices: item.outcomePrices
        .map((outcome) => `${outcome.outcome}:${outcome.bestBid ?? "n/a"}/${outcome.bestAsk ?? "n/a"} m=${outcome.midpoint ?? "n/a"} s=${outcome.spread ?? "n/a"}`)
        .join(" ; "),
      usableForReference: item.usableForReference ? "yes" : "no",
      reason: item.reason,
    })),
  );

  console.log("");
  console.log("Rejected high-keyword / low-quality examples:");
  console.table(output.rejectedHighKeywordLowQuality);
}

async function fetchWorldCupUniverse(): Promise<ReferenceMarketCandidate[]> {
  const pageSize = 200;
  const maxPages = 8;
  const seen = new Map<string, ReferenceMarketCandidate>();

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("archived", "false");

    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Gamma active-universe request failed: ${response.status} ${response.statusText}`);
    }

    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      break;
    }

    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const candidate = normalizeGammaMarket(item as Record<string, unknown>);
      if (!candidate || !isStrictWorldCupSoccerMarket(candidate)) {
        continue;
      }
      const key = candidate.externalMarketId || candidate.conditionId || candidate.slug || candidate.question;
      if (!seen.has(key)) {
        seen.set(key, candidate);
      }
    }
  }

  return Array.from(seen.values());
}

function isStrictWorldCupSoccerMarket(candidate: ReferenceMarketCandidate) {
  const haystack = [
    candidate.question,
    candidate.description ?? "",
    candidate.slug ?? "",
    candidate.category ?? "",
    candidate.eventSlug ?? "",
    ...candidate.tags,
  ]
    .join(" ")
    .toLowerCase();

  const mentionsWorldCup = haystack.includes("world cup");
  if (!mentionsWorldCup) {
    return false;
  }

  const soccerHints = ["fifa", "soccer", "football", "qualifier", "group", "match", "game"];
  const hasSoccerHint = soccerHints.some((term) => haystack.includes(term));
  if (!hasSoccerHint) {
    return false;
  }

  const negative = ["cricket", "rugby", "t20", "icc", "ballon d'or", "süper lig", "super lig", "premier league", "champions league"];
  if (negative.some((term) => haystack.includes(term))) {
    return false;
  }

  return candidate.active && !candidate.closed && !candidate.archived && candidate.clobTokenIds.length > 0;
}

function dedupeCandidates(candidates: ReferenceMarketCandidate[]) {
  const seen = new Map<string, ReferenceMarketCandidate>();
  for (const candidate of candidates) {
    const key = candidate.externalMarketId || candidate.conditionId || candidate.slug || candidate.question;
    if (!seen.has(key)) {
      seen.set(key, candidate);
    }
  }
  return Array.from(seen.values());
}

async function investigateCandidate(
  candidate: ReferenceMarketCandidate,
  clob: PolymarketClobClient,
): Promise<InvestigatedMarket> {
  const quotes = await Promise.all(
    candidate.outcomes.map(async (outcome) => {
      if (!outcome.tokenId) {
        return {
          source: "polymarket" as const,
          tokenId: `missing-${outcome.index}`,
          outcome: outcome.label,
          bestBid: null,
          bestAsk: null,
          midpoint: null,
          spread: null,
          receivedAt: new Date().toISOString(),
          isAvailable: false,
          isStale: true,
          raw: {},
        };
      }
      return clob.getReferenceQuote(outcome.tokenId, outcome.label);
    }),
  );

  const outcomePrices = candidate.outcomes.map((outcome, index) => buildOutcomePriceRow(outcome, quotes[index] ?? null));
  const marketType = inferMarketType(candidate);
  const quality = assessMarketQuality(candidate, outcomePrices, marketType);

  return {
    rank: 0,
    question: candidate.question,
    slug: candidate.slug,
    event: candidate.eventSlug,
    marketType,
    liquidity: candidate.liquidity,
    volume: candidate.volume,
    endDate: candidate.endDate,
    outcomePrices,
    usableForReference: quality.usable,
    reason: quality.reason,
    category: candidate.category,
    tags: candidate.tags,
    isOutrightFuture: isCountryOutrightFuture(candidate),
  };
}

function buildOutcomePriceRow(
  outcome: ReferenceMarketCandidate["outcomes"][number],
  quote: ReferenceQuote | null,
): OutcomePriceRow {
  const bestBid = quote?.bestBid ?? null;
  const bestAsk = quote?.bestAsk ?? null;
  const midpoint = quote?.midpoint ?? null;
  const spread = quote?.spread ?? null;
  return {
    outcome: outcome.label,
    tokenId: outcome.tokenId,
    bestBid,
    bestAsk,
    midpoint,
    spread,
    priceQuality: describePriceQuality(bestBid, bestAsk, midpoint, spread),
  };
}

function inferMarketType(candidate: ReferenceMarketCandidate): "binary" | "multi-outcome" {
  if (
    candidate.outcomes.length === 2 &&
    candidate.outcomes.every((outcome) => /^(yes|no)$/i.test(outcome.label))
  ) {
    return "binary";
  }
  return "multi-outcome";
}

function assessMarketQuality(
  candidate: ReferenceMarketCandidate,
  outcomes: OutcomePriceRow[],
  marketType: "binary" | "multi-outcome",
): { usable: boolean; reason: string } {
  if (!candidate.active || candidate.closed || candidate.archived) {
    return { usable: false, reason: "inactive_or_closed" };
  }
  if (candidate.clobTokenIds.length === 0 || outcomes.some((outcome) => !outcome.tokenId)) {
    return { usable: false, reason: "missing_token_ids" };
  }
  if (isCountryOutrightFuture(candidate)) {
    return { usable: false, reason: "country_outright_future_excluded" };
  }

  const hasStubBook = outcomes.every(
    (outcome) =>
      outcome.bestBid != null &&
      outcome.bestAsk != null &&
      outcome.bestBid <= 0.0011 &&
      outcome.bestAsk >= 0.9989,
  );
  if (hasStubBook) {
    return { usable: false, reason: "stub_book_0.001_0.999" };
  }

  const hasMeaningfulTwoSided = outcomes.some(
    (outcome) =>
      outcome.bestBid != null &&
      outcome.bestAsk != null &&
      outcome.bestBid > 0.01 &&
      outcome.bestAsk < 0.99 &&
      outcome.spread != null &&
      outcome.spread <= 0.1,
  );
  if (!hasMeaningfulTwoSided) {
    return { usable: false, reason: "no_meaningful_two_sided_book" };
  }

  if ((candidate.liquidity ?? 0) < 10000 || (candidate.volume ?? 0) < 1000) {
    return { usable: false, reason: "low_liquidity_or_volume" };
  }

  if (marketType === "multi-outcome") {
    return { usable: false, reason: "multi_outcome_not_supported_by_local_binary_model" };
  }

  return { usable: true, reason: "active_liquid_two_sided_binary_market" };
}

function describePriceQuality(
  bestBid: number | null,
  bestAsk: number | null,
  midpoint: number | null,
  spread: number | null,
) {
  if (bestBid == null && bestAsk == null && midpoint == null) {
    return "no_book";
  }
  if (bestBid != null && bestAsk != null && bestBid <= 0.0011 && bestAsk >= 0.9989) {
    return "stub_wide_book";
  }
  if (spread != null && spread <= 0.03) {
    return "tight";
  }
  if (spread != null && spread <= 0.1) {
    return "reasonable";
  }
  return "wide";
}

function compareInvestigated(left: InvestigatedMarket, right: InvestigatedMarket) {
  return (
    Number(right.usableForReference) - Number(left.usableForReference) ||
    (right.liquidity ?? -1) - (left.liquidity ?? -1) ||
    (right.volume ?? -1) - (left.volume ?? -1) ||
    averageObservedSpread(left) - averageObservedSpread(right) ||
    left.question.localeCompare(right.question)
  );
}

function averageObservedSpread(item: InvestigatedMarket) {
  const spreads = item.outcomePrices.map((outcome) => outcome.spread).filter((value): value is number => value != null);
  if (spreads.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return spreads.reduce((sum, value) => sum + value, 0) / spreads.length;
}

function isCountryOutrightFuture(candidate: ReferenceMarketCandidate) {
  return /^Will .* win the 2026 FIFA World Cup\?$/i.test(candidate.question);
}

main().catch((error) => {
  console.error("Polymarket World Cup top-active investigation failed.");
  console.error(error);
  process.exitCode = 1;
});

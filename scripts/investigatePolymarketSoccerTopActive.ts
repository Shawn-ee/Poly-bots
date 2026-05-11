import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeGammaMarket } from "../src/referenceMarket/polymarketGammaClient.js";
import { PolymarketClobClient } from "../src/referenceMarket/polymarketClobClient.js";
import { ReferenceMarketCandidate, ReferenceQuote } from "../src/referenceMarket/types.js";

const POSITIVE_TERMS = [
  "soccer",
  "football",
  "fifa",
  "world cup",
  "premier league",
  "la liga",
  "liga mx",
  "mls",
  "uefa",
  "champions league",
  "europa league",
  "bundesliga",
  "serie a",
  "ligue 1",
  "copa",
  "fa cup",
  "club world cup",
  "friendly",
  "concacaf",
  "qualifier",
];

const NEGATIVE_TERMS = [
  "gta vi",
  "harvey weinstein",
  "bitcoin",
  "taiwan",
  "album",
  "jesus christ",
  "president",
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "wimbledon",
  "ufc",
  "golf",
];

type MarketSubtype = "match" | "outright" | "player_prop" | "league_prop" | "other_soccer";

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
  category: string | null;
  marketType: "binary" | "multi-outcome";
  subtype: MarketSubtype;
  liquidity: number | null;
  volume: number | null;
  endDate: string | null;
  outcomePrices: OutcomePriceRow[];
  usableForReference: boolean;
  reason: string;
};

type Output = {
  fetchedAt: string;
  totalCandidatesScanned: number;
  selectedCount: number;
  binaryCount: number;
  multiOutcomeCount: number;
  usableForReferenceCount: number;
  selected: InvestigatedMarket[];
};

async function main() {
  const outputPath = path.resolve(
    process.cwd(),
    "../Poly/test-logs/polymarket-soccer-top20-active.json",
  );

  const clob = new PolymarketClobClient();
  const candidates = await fetchSoccerUniverse();
  const investigated = await Promise.all(candidates.map((candidate) => investigateCandidate(candidate, clob)));
  const selected = investigated
    .sort(compareInvestigated)
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const output: Output = {
    fetchedAt: new Date().toISOString(),
    totalCandidatesScanned: candidates.length,
    selectedCount: selected.length,
    binaryCount: selected.filter((item) => item.marketType === "binary").length,
    multiOutcomeCount: selected.filter((item) => item.marketType === "multi-outcome").length,
    usableForReferenceCount: selected.filter((item) => item.usableForReference).length,
    selected,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Candidates scanned: ${output.totalCandidatesScanned}`);
  console.log(`Top 20 selected: ${output.selectedCount}`);
  console.log(`Binary: ${output.binaryCount}`);
  console.log(`Multi-outcome: ${output.multiOutcomeCount}`);
  console.log(`Usable for reference: ${output.usableForReferenceCount}`);
  console.log(`Output: ${outputPath}`);
  console.log("");

  console.table(
    selected.map((item) => ({
      rank: item.rank,
      question: item.question.length > 64 ? `${item.question.slice(0, 61)}...` : item.question,
      slug: item.slug ?? "",
      event: item.event ?? "",
      category: item.category ?? "",
      subtype: item.subtype,
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
}

async function fetchSoccerUniverse(): Promise<ReferenceMarketCandidate[]> {
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

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
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
      if (!candidate || !isSoccerMarket(candidate)) {
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

function isSoccerMarket(candidate: ReferenceMarketCandidate) {
  const haystack = textBlob(candidate);
  const hasPositive = POSITIVE_TERMS.some((term) => haystack.includes(term));
  const hasNegative = NEGATIVE_TERMS.some((term) => haystack.includes(term));
  return hasPositive && !hasNegative && candidate.active && !candidate.closed && !candidate.archived && candidate.clobTokenIds.length > 0;
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

  const subtype = classifySubtype(candidate);
  const marketType = inferMarketType(candidate);
  const outcomePrices = candidate.outcomes.map((outcome, index) => buildOutcomePriceRow(outcome, quotes[index] ?? null));
  const quality = assessQuality(candidate, subtype, marketType, outcomePrices);

  return {
    rank: 0,
    question: candidate.question,
    slug: candidate.slug,
    event: candidate.eventSlug,
    category: candidate.category,
    marketType,
    subtype,
    liquidity: candidate.liquidity,
    volume: candidate.volume,
    endDate: candidate.endDate,
    outcomePrices,
    usableForReference: quality.usable,
    reason: quality.reason,
  };
}

function classifySubtype(candidate: ReferenceMarketCandidate): MarketSubtype {
  const haystack = textBlob(candidate);
  if (
    haystack.includes("top goal scorer") ||
    haystack.includes("golden boot") ||
    haystack.includes("ballon d'or") ||
    haystack.includes("play in the")
  ) {
    return "player_prop";
  }
  if (
    haystack.includes(" vs ") ||
    haystack.includes("draw") ||
    haystack.includes("beat ") ||
    haystack.includes("defeat ") ||
    haystack.includes("match")
  ) {
    return "match";
  }
  if (/^will .* win the /i.test(candidate.question)) {
    return "outright";
  }
  if (haystack.includes("premier league") || haystack.includes("la liga") || haystack.includes("champions league")) {
    return "league_prop";
  }
  return "other_soccer";
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

function assessQuality(
  candidate: ReferenceMarketCandidate,
  subtype: MarketSubtype,
  marketType: "binary" | "multi-outcome",
  outcomes: OutcomePriceRow[],
) {
  if (!candidate.active || candidate.closed || candidate.archived) {
    return { usable: false, reason: "inactive_or_closed" };
  }
  if (candidate.clobTokenIds.length === 0 || outcomes.some((outcome) => !outcome.tokenId)) {
    return { usable: false, reason: "missing_token_ids" };
  }
  const stub = outcomes.every(
    (outcome) =>
      outcome.bestBid != null &&
      outcome.bestAsk != null &&
      outcome.bestBid <= 0.0011 &&
      outcome.bestAsk >= 0.9989,
  );
  if (stub) {
    return { usable: false, reason: "stub_book_0.001_0.999" };
  }

  const meaningfulTwoSided = outcomes.some(
    (outcome) =>
      outcome.bestBid != null &&
      outcome.bestAsk != null &&
      outcome.bestBid > 0.01 &&
      outcome.bestAsk < 0.99 &&
      outcome.spread != null &&
      outcome.spread <= 0.12,
  );
  if (!meaningfulTwoSided) {
    return { usable: false, reason: "no_meaningful_two_sided_book" };
  }
  if ((candidate.liquidity ?? 0) < 5000 || (candidate.volume ?? 0) < 1000) {
    return { usable: false, reason: "low_liquidity_or_volume" };
  }
  if (subtype !== "match") {
    return { usable: false, reason: `not_match_market_${subtype}` };
  }
  if (marketType === "multi-outcome") {
    return { usable: false, reason: "multi_outcome_not_supported_by_local_binary_model" };
  }
  return { usable: true, reason: "active_two_sided_soccer_match_market" };
}

function compareInvestigated(left: InvestigatedMarket, right: InvestigatedMarket) {
  return (
    subtypeRank(left.subtype) - subtypeRank(right.subtype) ||
    Number(right.usableForReference) - Number(left.usableForReference) ||
    (right.liquidity ?? -1) - (left.liquidity ?? -1) ||
    (right.volume ?? -1) - (left.volume ?? -1) ||
    averageSpread(left) - averageSpread(right) ||
    left.question.localeCompare(right.question)
  );
}

function subtypeRank(subtype: MarketSubtype) {
  switch (subtype) {
    case "match":
      return 0;
    case "league_prop":
      return 1;
    case "player_prop":
      return 2;
    case "outright":
      return 3;
    default:
      return 4;
  }
}

function averageSpread(item: InvestigatedMarket) {
  const values = item.outcomePrices.map((outcome) => outcome.spread).filter((value): value is number => value != null);
  if (values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function describePriceQuality(bestBid: number | null, bestAsk: number | null, midpoint: number | null, spread: number | null) {
  if (bestBid == null && bestAsk == null && midpoint == null) {
    return "no_book";
  }
  if (bestBid != null && bestAsk != null && bestBid <= 0.0011 && bestAsk >= 0.9989) {
    return "stub_wide_book";
  }
  if (spread != null && spread <= 0.03) {
    return "tight";
  }
  if (spread != null && spread <= 0.12) {
    return "reasonable";
  }
  return "wide";
}

function textBlob(candidate: ReferenceMarketCandidate) {
  return [
    candidate.question,
    candidate.description ?? "",
    candidate.slug ?? "",
    candidate.category ?? "",
    candidate.eventSlug ?? "",
    ...candidate.tags,
  ]
    .join(" ")
    .toLowerCase();
}

main().catch((error) => {
  console.error("Polymarket soccer top-20 investigation failed.");
  console.error(error);
  process.exitCode = 1;
});

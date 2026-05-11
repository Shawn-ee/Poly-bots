import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeGammaMarket } from "../src/referenceMarket/polymarketGammaClient.js";
import { PolymarketClobClient } from "../src/referenceMarket/polymarketClobClient.js";
import { ReferenceMarketCandidate, ReferenceQuote } from "../src/referenceMarket/types.js";

type InspectResult = {
  inspectedAt: string;
  input: {
    slug: string | null;
    url: string | null;
  };
  market: {
    question: string;
    slug: string | null;
    conditionId: string | null;
    marketId: string;
    outcomes: Array<{
      outcome: string;
      tokenId: string | null;
      bestBid: number | null;
      bestAsk: number | null;
      midpoint: number | null;
      spread: number | null;
      priceQuality: string;
      isAvailable: boolean;
    }>;
    volume: number | null;
    liquidity: number | null;
    endDate: string | null;
    active: boolean;
    closed: boolean;
    archived: boolean;
    rules: string | null;
    category: string | null;
    eventSlug: string | null;
    marketType: "binary" | "multi-outcome";
    usableForReference: boolean;
    usableReason: string;
  };
  outputPath: string;
};

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.slug && !parsed.url) {
    throw new Error("Provide --slug <slug> or --url <polymarket-url>.");
  }

  const slug = parsed.slug ?? slugFromUrl(parsed.url!);
  if (!slug) {
    throw new Error("Could not determine market slug from input.");
  }

  const candidate = await fetchMarketBySlug(slug);
  const clob = new PolymarketClobClient();
  const quotes = await Promise.all(
    candidate.outcomes.map(async (outcome) => {
      if (!outcome.tokenId) {
        return null;
      }
      return clob.getReferenceQuote(outcome.tokenId, outcome.label);
    }),
  );

  const outputPath = path.resolve(
    process.cwd(),
    `../Poly/test-logs/polymarket-market-inspect-${slug}.json`,
  );

  const outcomes = candidate.outcomes.map((outcome, index) => {
    const quote = quotes[index];
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
      isAvailable: quote?.isAvailable ?? false,
    };
  });

  const marketType =
    candidate.outcomes.length === 2 &&
    candidate.outcomes.every((outcome) => /^(yes|no)$/i.test(outcome.label))
      ? "binary"
      : "multi-outcome";
  const usable = assessUsability(candidate, outcomes, marketType);

  const result: InspectResult = {
    inspectedAt: new Date().toISOString(),
    input: {
      slug: parsed.slug ?? slug,
      url: parsed.url,
    },
    market: {
      question: candidate.question,
      slug: candidate.slug,
      conditionId: candidate.conditionId,
      marketId: candidate.externalMarketId,
      outcomes,
      volume: candidate.volume,
      liquidity: candidate.liquidity,
      endDate: candidate.endDate,
      active: candidate.active,
      closed: candidate.closed,
      archived: candidate.archived,
      rules: candidate.description,
      category: candidate.category,
      eventSlug: candidate.eventSlug,
      marketType,
      usableForReference: usable.usable,
      usableReason: usable.reason,
    },
    outputPath,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`Market: ${result.market.question}`);
  console.log(`Slug: ${result.market.slug ?? ""}`);
  console.log(`Market ID: ${result.market.marketId}`);
  console.log(`Condition ID: ${result.market.conditionId ?? ""}`);
  console.log(`Type: ${result.market.marketType}`);
  console.log(`Liquidity: ${result.market.liquidity ?? ""}`);
  console.log(`Volume: ${result.market.volume ?? ""}`);
  console.log(`End Date: ${result.market.endDate ?? ""}`);
  console.log(`Active/Closed/Archived: ${result.market.active}/${result.market.closed}/${result.market.archived}`);
  console.log(`Usable for reference: ${result.market.usableForReference ? "yes" : "no"} (${result.market.usableReason})`);
  console.log(`Output: ${outputPath}`);
  console.log("");
  console.table(
    result.market.outcomes.map((outcome) => ({
      outcome: outcome.outcome,
      tokenId: outcome.tokenId ?? "",
      bestBid: outcome.bestBid ?? "",
      bestAsk: outcome.bestAsk ?? "",
      midpoint: outcome.midpoint ?? "",
      spread: outcome.spread ?? "",
      priceQuality: outcome.priceQuality,
      available: outcome.isAvailable ? "yes" : "no",
    })),
  );
}

async function fetchMarketBySlug(slug: string): Promise<ReferenceMarketCandidate> {
  const urls = [
    `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
    `https://gamma-api.polymarket.com/markets?search=${encodeURIComponent(slug)}&limit=50`,
  ];

  for (const url of urls) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      continue;
    }
    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed)) {
      continue;
    }
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const candidate = normalizeGammaMarket(item as Record<string, unknown>);
      if (candidate && candidate.slug === slug) {
        return candidate;
      }
    }
  }

  throw new Error(`Polymarket market not found for slug: ${slug}`);
}

function slugFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? null;
  } catch {
    return null;
  }
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
  if (spread != null && spread <= 0.12) {
    return "reasonable";
  }
  return "wide";
}

function assessUsability(
  candidate: ReferenceMarketCandidate,
  outcomes: Array<{
    bestBid: number | null;
    bestAsk: number | null;
    midpoint: number | null;
    spread: number | null;
    tokenId: string | null;
  }>,
  marketType: "binary" | "multi-outcome",
) {
  if (!candidate.active || candidate.closed || candidate.archived) {
    return { usable: false, reason: "inactive_or_closed" };
  }
  if (outcomes.some((outcome) => !outcome.tokenId)) {
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
  const twoSided = outcomes.some(
    (outcome) =>
      outcome.bestBid != null &&
      outcome.bestAsk != null &&
      outcome.bestBid > 0.01 &&
      outcome.bestAsk < 0.99 &&
      outcome.spread != null &&
      outcome.spread <= 0.12,
  );
  if (!twoSided) {
    return { usable: false, reason: "no_meaningful_two_sided_book" };
  }
  if ((candidate.liquidity ?? 0) < 1000 || (candidate.volume ?? 0) < 1000) {
    return { usable: false, reason: "low_liquidity_or_volume" };
  }
  if (marketType === "multi-outcome") {
    return { usable: false, reason: "multi_outcome_not_supported_by_local_binary_model" };
  }
  return { usable: true, reason: "active_two_sided_binary_market" };
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    slug: args.get("slug") ?? null,
    url: args.get("url") ?? null,
  };
}

main().catch((error) => {
  console.error("Polymarket market inspection failed.");
  console.error(error);
  process.exitCode = 1;
});


import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "../api/apiClient.js";
import { AdminImportReferenceMarketRequest } from "../api/types.js";
import { PolymarketGammaClient } from "./polymarketGammaClient.js";
import { readReferenceMappings } from "./mappingStore.js";
import {
  DiscoveryRejectionReason,
  DiscoveryVertical,
  MarketDiscoveryCandidate,
  MarketDiscoveryOptions,
  MarketDiscoveryResult,
  MarketDiscoveryScoreBreakdown,
  ReferenceMarketCandidate,
} from "./types.js";

const DEFAULT_POLYMARKET_URL = "https://polymarket.com/event/";
const NBA_QUERIES = [
  "NBA",
  "NBA Finals",
  "NBA playoffs",
  "NBA championship",
  "NBA winner",
  "NBA team",
  "NBA player",
  "NBA awards",
];
const WORLD_CUP_QUERIES = [
  "FIFA World Cup",
  "2026 World Cup",
  "World Cup winner",
  "World Cup group",
  "World Cup qualifiers",
  "World Cup match winner",
];
const NBA_STRONG_TERMS = [
  "nba",
  "national basketball association",
  "nba finals",
  "nba playoffs",
  "eastern conference",
  "western conference",
];
const NBA_WEAK_TERMS = ["basketball", "finals", "playoffs", "championship", "mvp", "rookie of the year"];
const WORLD_CUP_STRONG_TERMS = [
  "fifa world cup",
  "2026 world cup",
  "world cup 2026",
  "world cup winner",
  "world cup group",
  "world cup qualifier",
  "world cup qualifiers",
  "world cup match",
];
const WORLD_CUP_HINT_TERMS = ["fifa", "soccer", "football", "qualification", "qualifier", "group stage"];
const EXCLUDED_TERMS = [
  "election",
  "president",
  "senate",
  "congress",
  "politics",
  "crypto",
  "bitcoin",
  "ethereum",
  "celebrity",
  "weather",
  "rain",
  "temperature",
  "ufc",
  "nfl",
  "mlb",
  "nhl",
  "tennis",
  "cricket",
  "rugby",
  "formula 1",
  "f1",
];
const GENERIC_SOCCER_TERMS = ["premier league", "champions league", "la liga", "serie a", "bundesliga", "mls"];

type DiscoveryDeps = {
  gamma?: Pick<PolymarketGammaClient, "searchMarkets">;
  adminApi?: Pick<ApiClient, "importAdminReferenceMarket" | "listAdminReferenceMarkets" | "updateAdminReferenceMarket">;
  now?: () => number;
};

export async function runMarketDiscovery(
  options: MarketDiscoveryOptions,
  deps: DiscoveryDeps = {},
): Promise<MarketDiscoveryResult> {
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const gamma = deps.gamma ?? new PolymarketGammaClient();
  const fetched = await fetchDiscoveryCandidates(gamma, options);
  const existingKeys = await buildExistingKeys(options, deps.adminApi);
  const existingImportedCount = countImportedMarkets(existingKeys);
  const remainingCapacity = Math.max(0, options.maxImportedMarkets - existingImportedCount);

  const evaluated = fetched
    .map((candidate) => evaluateCandidate(candidate, options, existingKeys, deps.now))
    .sort((left, right) => right.score - left.score || left.candidate.question.localeCompare(right.candidate.question));
  const accepted = evaluated.filter((item) => item.accepted).slice(0, Math.min(options.maxNewImportsPerRun, remainingCapacity));
  const capped = markCapRejected(evaluated, new Set(accepted.map((item) => candidateKey(item.candidate))), remainingCapacity);

  const importedDrafts: MarketDiscoveryResult["importedDrafts"] = [];
  const skippedImports: MarketDiscoveryResult["skippedImports"] = [];
  if (!options.enabled || options.dryRun || !options.createDrafts) {
    for (const item of accepted) {
      item.draftCreationStatus = options.dryRun ? "dry_run" : "skipped";
      skippedImports.push({
        externalMarketId: item.candidate.externalMarketId,
        externalSlug: item.candidate.slug,
        title: item.candidate.question,
        reason: options.dryRun ? "dry_run" : "disabled",
      });
    }
  } else {
    const api = deps.adminApi ?? buildAdminApiClient(options);
    for (const item of accepted) {
      try {
        const response = await api.importAdminReferenceMarket(buildDraftImportPayload(item));
        await api.updateAdminReferenceMarket(response.marketId, {
          importStatus: "pending_review",
          referenceOnly: true,
          tradable: false,
          mmEnabled: false,
          isListed: false,
          reviewNotes: "Created by Market Discovery Agent as draft pending admin review.",
        });
        item.draftCreationStatus = response.marketCreated ? "created" : "skipped";
        importedDrafts.push({
          localMarketId: response.marketId,
          externalMarketId: item.candidate.externalMarketId,
          externalSlug: item.candidate.slug,
          title: item.candidate.question,
          created: response.marketCreated,
        });
      } catch {
        item.draftCreationStatus = "failed";
      }
    }
  }

  const result: MarketDiscoveryResult = {
    fetchedAt,
    enabled: options.enabled,
    dryRun: options.dryRun,
    allowedVerticals: options.allowedVerticals,
    totalFetched: fetched.length,
    totalAccepted: capped.filter((item) => item.accepted).length,
    totalRejected: capped.filter((item) => !item.accepted).length,
    currentImportedCount: existingImportedCount,
    maxImportedMarkets: options.maxImportedMarkets,
    maxNewImportsPerRun: options.maxNewImportsPerRun,
    candidates: capped,
    importedDrafts,
    skippedImports,
    outputPath: options.outputPath,
    mappingPath: options.mappingPath,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export async function fetchDiscoveryCandidates(
  gamma: Pick<PolymarketGammaClient, "searchMarkets">,
  options: Pick<MarketDiscoveryOptions, "allowedVerticals" | "topN">,
): Promise<ReferenceMarketCandidate[]> {
  const queries = [
    ...(options.allowedVerticals.includes("nba") ? NBA_QUERIES : []),
    ...(options.allowedVerticals.includes("world_cup") ? WORLD_CUP_QUERIES : []),
  ];
  const byKey = new Map<string, ReferenceMarketCandidate>();
  for (const query of queries) {
    const page = await gamma.searchMarkets({ query, limit: options.topN, sortBy: "volume", activeOnly: true });
    for (const candidate of page) {
      byKey.set(candidateKey(candidate), candidate);
    }
  }
  return Array.from(byKey.values()).slice(0, Math.max(options.topN * Math.max(1, queries.length), options.topN));
}

export function evaluateCandidate(
  candidate: ReferenceMarketCandidate,
  options: Pick<MarketDiscoveryOptions, "allowedVerticals" | "minReferenceLiquidity" | "minReferenceVolume" | "maxReferenceSpread">,
  existingKeys: Set<string> = new Set(),
  now: () => number = Date.now,
): MarketDiscoveryCandidate {
  const vertical = classifyVertical(candidate);
  const rejection = rejectionReason(candidate, vertical, options, existingKeys);
  const breakdown = scoreBreakdown(candidate, vertical, existingKeys, now);
  const score = clampScore(Object.values(breakdown).reduce((total, value) => total + value, 0));
  return {
    candidate,
    vertical: vertical ?? "world_cup",
    score,
    scoreBreakdown: breakdown,
    qualityStatus: classifyDiscoveryQuality(candidate, options.maxReferenceSpread, now),
    sourceUrl: buildSourceUrl(candidate),
    accepted: rejection == null,
    rejectedReason: rejection,
    duplicateKeys: duplicateKeys(candidate).filter((key) => existingKeys.has(key)),
    draftCreationStatus: "not_requested",
  };
}

export function buildDraftImportPayload(item: MarketDiscoveryCandidate): AdminImportReferenceMarketRequest {
  const candidate = item.candidate;
  return {
    createEvents: true,
    event: candidate.event
      ? {
          title: candidate.event.title,
          slug: candidate.event.slug,
          description: candidate.event.description,
          category: candidate.event.category,
          status: candidate.event.status,
          source: candidate.event.source,
          externalEventId: candidate.event.externalEventId,
          externalSlug: candidate.event.externalSlug,
          image: candidate.event.image,
          icon: candidate.event.icon,
          metadata: candidate.event.metadata,
        }
      : null,
    market: {
      title: candidate.question,
      description: buildDraftDescription(candidate),
      category: item.vertical === "nba" ? "NBA" : "FIFA World Cup",
      resolveTime: candidate.endDate,
      type: candidate.outcomes.length > 2 ? "MULTI_WINNER" : "BINARY",
      desiredStatus: "draft",
      externalMarketId: candidate.externalMarketId,
      conditionId: candidate.conditionId,
      externalSlug: candidate.slug,
      referenceSource: "polymarket",
      referenceMetadata: {
        source: "polymarket",
        externalMarketId: candidate.externalMarketId,
        externalSlug: candidate.slug,
        conditionId: candidate.conditionId,
        sourceUrl: buildSourceUrl(candidate),
        importStatus: "pending_review",
        listed: false,
        tradable: false,
        mmEnabled: false,
        referenceOnly: true,
        autoPublish: false,
        autoResolve: false,
        discovery: {
          vertical: item.vertical,
          score: item.score,
          scoreBreakdown: item.scoreBreakdown,
          qualityStatus: item.qualityStatus,
          accepted: item.accepted,
          rejectedReason: item.rejectedReason,
        },
        reference: {
          volume: candidate.volume,
          volume24hr: candidate.volume24hr,
          liquidity: candidate.liquidity,
          liquidityClob: candidate.liquidityClob,
          bestBid: candidate.bestBid,
          bestAsk: candidate.bestAsk,
          spread: candidate.spread,
          lastTradePrice: candidate.lastTradePrice,
          acceptingOrders: candidate.acceptingOrders,
          competitive: candidate.competitive,
          outcomePrices: candidate.outcomePrices,
          updatedAt: candidate.updatedAt,
          raw: candidate.raw,
        },
      },
      outcomes: candidate.outcomes.map((outcome) => ({
        name: outcome.label,
        displayOrder: outcome.index,
        isTradable: false,
        referenceTokenId: outcome.tokenId,
        referenceOutcomeLabel: outcome.label,
        referenceMetadata: {
          source: "polymarket",
          tokenId: outcome.tokenId,
          outcomeLabel: outcome.label,
          outcomePrice: outcome.outcomePrice,
          isTradable: false,
        },
      })),
    },
  };
}

export function classifyVertical(candidate: ReferenceMarketCandidate): DiscoveryVertical | null {
  const text = candidateText(candidate);
  const hasWorldCupTerm = WORLD_CUP_STRONG_TERMS.some((term) => text.includes(term)) || text.includes("fifa");
  if (GENERIC_SOCCER_TERMS.some((term) => text.includes(term)) && !hasWorldCupTerm) {
    return null;
  }
  if (NBA_STRONG_TERMS.some((term) => text.includes(term))) {
    return "nba";
  }
  if (WORLD_CUP_STRONG_TERMS.some((term) => text.includes(term))) {
    return "world_cup";
  }
  if (text.includes("world cup") && WORLD_CUP_HINT_TERMS.some((term) => text.includes(term))) {
    return "world_cup";
  }
  if (text.includes("nba") || (text.includes("basketball") && NBA_WEAK_TERMS.some((term) => text.includes(term)))) {
    return "nba";
  }
  return null;
}

function rejectionReason(
  candidate: ReferenceMarketCandidate,
  vertical: DiscoveryVertical | null,
  options: Pick<MarketDiscoveryOptions, "allowedVerticals" | "minReferenceLiquidity" | "minReferenceVolume" | "maxReferenceSpread">,
  existingKeys: Set<string>,
): DiscoveryRejectionReason | null {
  const text = candidateText(candidate);
  if (!vertical || !options.allowedVerticals.includes(vertical)) {
    return "not_allowed_vertical";
  }
  if (EXCLUDED_TERMS.some((term) => text.includes(term)) && !(vertical === "world_cup" && text.includes("fifa"))) {
    return "excluded_topic";
  }
  if (vertical === "world_cup" && GENERIC_SOCCER_TERMS.some((term) => text.includes(term)) && !text.includes("world cup")) {
    return "generic_soccer";
  }
  if (!candidate.active || candidate.closed || candidate.archived) {
    return "inactive_or_resolved";
  }
  if (candidate.clobTokenIds.length === 0 || candidate.outcomes.some((outcome) => !outcome.tokenId)) {
    return "missing_reference_tokens";
  }
  if (candidate.outcomes.length !== 2) {
    return "unsupported_outcomes";
  }
  if (options.minReferenceLiquidity != null && (candidate.liquidity ?? 0) < options.minReferenceLiquidity) {
    return "low_liquidity";
  }
  if (options.minReferenceVolume != null && (candidate.volume ?? 0) < options.minReferenceVolume) {
    return "low_volume";
  }
  if (candidate.spread != null && candidate.spread > options.maxReferenceSpread) {
    return "wide_spread";
  }
  if (duplicateKeys(candidate).some((key) => existingKeys.has(key))) {
    return "duplicate";
  }
  return null;
}

function scoreBreakdown(
  candidate: ReferenceMarketCandidate,
  vertical: DiscoveryVertical | null,
  existingKeys: Set<string>,
  now: () => number,
): MarketDiscoveryScoreBreakdown {
  return {
    volume: scaleLog(candidate.volume, 20),
    liquidity: scaleLog(candidate.liquidity ?? candidate.liquidityClob, 20),
    spreadQuality: spreadScore(candidate.spread, 15),
    recentActivity: recencyScore(candidate.updatedAt, now, 10) + scaleLog(candidate.volume24hr, 5),
    activeStatus: candidate.active && !candidate.closed && !candidate.archived && candidate.acceptingOrders ? 15 : 0,
    cleanOutcomeMapping: candidate.outcomes.length === 2 && candidate.outcomes.every((outcome) => outcome.tokenId) ? 10 : 0,
    categoryMatchStrength: vertical ? categoryStrength(candidate, vertical) : 0,
    duplicateRisk: duplicateKeys(candidate).some((key) => existingKeys.has(key)) ? -25 : 0,
  };
}

function classifyDiscoveryQuality(
  candidate: ReferenceMarketCandidate,
  maxSpread: number,
  now: () => number,
) {
  if (candidate.bestBid == null || candidate.bestAsk == null) {
    return "missing_book";
  }
  if ((candidate.spread ?? candidate.bestAsk - candidate.bestBid) > maxSpread) {
    return "wide_spread";
  }
  const updatedAt = candidate.updatedAt ? Date.parse(candidate.updatedAt) : null;
  if (!updatedAt || now() - updatedAt > 24 * 60 * 60 * 1000) {
    return "stale";
  }
  return "high_quality";
}

function categoryStrength(candidate: ReferenceMarketCandidate, vertical: DiscoveryVertical) {
  const text = candidateText(candidate);
  if (vertical === "nba") {
    return NBA_STRONG_TERMS.some((term) => text.includes(term)) ? 10 : 6;
  }
  return WORLD_CUP_STRONG_TERMS.some((term) => text.includes(term)) ? 10 : 6;
}

function markCapRejected(
  candidates: MarketDiscoveryCandidate[],
  acceptedKeys: Set<string>,
  remainingCapacity: number,
) {
  let acceptedCount = 0;
  return candidates.map((item) => {
    if (!item.accepted) {
      return item;
    }
    if (acceptedKeys.has(candidateKey(item.candidate)) && acceptedCount < remainingCapacity) {
      acceptedCount += 1;
      return item;
    }
    return {
      ...item,
      accepted: false,
      rejectedReason: "import_cap_reached" as const,
    };
  });
}

async function buildExistingKeys(
  options: Pick<MarketDiscoveryOptions, "mappingPath">,
  adminApi: Pick<ApiClient, "listAdminReferenceMarkets"> | undefined,
) {
  const keys = new Set<string>();
  const mappings = await readReferenceMappings(options.mappingPath);
  for (const mapping of mappings) {
    keys.add(`externalMarketId:${mapping.polymarketMarketId}`);
    if (mapping.conditionId) keys.add(`conditionId:${mapping.conditionId}`);
    if (mapping.polymarketSlug) keys.add(`externalSlug:${mapping.polymarketSlug}`);
    keys.add(`localMarketId:${mapping.localMarketId}`);
  }
  if (adminApi) {
    const response = await adminApi.listAdminReferenceMarkets({ source: "polymarket" });
    for (const market of response.items) {
      if (market.externalMarketId) keys.add(`externalMarketId:${market.externalMarketId}`);
      if (market.conditionId) keys.add(`conditionId:${market.conditionId}`);
      if (market.externalSlug) keys.add(`externalSlug:${market.externalSlug}`);
      keys.add(`normalizedTitle:${normalizeTitle(market.title)}`);
      keys.add(`localMarketId:${market.id}`);
    }
  }
  return keys;
}

function countImportedMarkets(keys: Set<string>) {
  return Array.from(keys).filter((key) => key.startsWith("localMarketId:")).length;
}

function duplicateKeys(candidate: ReferenceMarketCandidate) {
  return [
    `externalMarketId:${candidate.externalMarketId}`,
    candidate.conditionId ? `conditionId:${candidate.conditionId}` : null,
    candidate.slug ? `externalSlug:${candidate.slug}` : null,
    `normalizedTitle:${normalizeTitle(candidate.question)}`,
  ].filter((key): key is string => typeof key === "string");
}

function candidateKey(candidate: ReferenceMarketCandidate) {
  return candidate.externalMarketId || candidate.conditionId || candidate.slug || normalizeTitle(candidate.question);
}

function candidateText(candidate: ReferenceMarketCandidate) {
  return [
    candidate.question,
    candidate.description,
    candidate.category,
    candidate.slug,
    candidate.eventSlug,
    candidate.event?.title,
    candidate.event?.slug,
    ...candidate.tags,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function scaleLog(value: number | null | undefined, max: number) {
  if (value == null || value <= 0) {
    return 0;
  }
  return Math.min(max, Number((Math.log10(value + 1) / 5 * max).toFixed(2)));
}

function spreadScore(spread: number | null, max: number) {
  if (spread == null) {
    return 0;
  }
  if (spread <= 0.01) {
    return max;
  }
  if (spread >= 0.1) {
    return 0;
  }
  return Number((max * (1 - spread / 0.1)).toFixed(2));
}

function recencyScore(updatedAt: string | null, now: () => number, max: number) {
  if (!updatedAt) {
    return 0;
  }
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const ageHours = Math.max(0, (now() - parsed) / 3_600_000);
  return Number((max * Math.max(0, 1 - ageHours / 72)).toFixed(2));
}

function clampScore(value: number) {
  return Number(Math.max(0, Math.min(100, value)).toFixed(2));
}

function buildSourceUrl(candidate: ReferenceMarketCandidate) {
  return candidate.slug ? `${DEFAULT_POLYMARKET_URL}${candidate.slug}` : "https://polymarket.com";
}

function buildDraftDescription(candidate: ReferenceMarketCandidate) {
  return [
    candidate.description ?? candidate.question,
    "",
    "Imported from Polymarket by Market Discovery Agent.",
    "Draft only. Requires admin review before listing, trading, market-maker enablement, or resolution proposal handling.",
    `Polymarket market id: ${candidate.externalMarketId}`,
    candidate.conditionId ? `Condition ID: ${candidate.conditionId}` : null,
    candidate.slug ? `Slug: ${candidate.slug}` : null,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

function buildAdminApiClient(options: MarketDiscoveryOptions) {
  if (!options.adminSessionCookie) {
    throw new Error("Draft import mode requires POLY_SIM_SESSION_COOKIE or equivalent admin session cookie.");
  }
  return new ApiClient(options.baseUrl, options.adminSessionCookie, { authMode: "cookie" });
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "../api/apiClient.js";
import {
  ImportWorldCupOptions,
  ImportWorldCupResult,
  ReferenceMarketCandidate,
  ReferenceMarketMapping,
  ReferenceMarketSnapshot,
} from "./types.js";
import { PolymarketClobClient } from "./polymarketClobClient.js";
import { PolymarketGammaClient } from "./polymarketGammaClient.js";
import { readReferenceMappings, upsertReferenceMappings, writeReferenceMappings } from "./mappingStore.js";

const DEFAULT_QUERIES = [
  "world cup",
  "fifa world cup",
  "2026 world cup",
  "world cup winner",
  "world cup group",
  "world cup final",
];

export async function importPolymarketWorldCupMarkets(
  options: ImportWorldCupOptions,
  deps: {
    gamma?: PolymarketGammaClient;
    clob?: PolymarketClobClient;
    fetchImpl?: typeof fetch;
    adminApi?: Pick<ApiClient, "importAdminReferenceMarket">;
  } = {},
): Promise<ImportWorldCupResult> {
  const gamma = deps.gamma ?? new PolymarketGammaClient(undefined, deps.fetchImpl);
  const clob = deps.clob ?? new PolymarketClobClient(undefined, deps.fetchImpl);
  const candidates = await fetchCandidates(gamma, options);

  const snapshots: ReferenceMarketSnapshot[] = [];
  for (const candidate of candidates) {
    const quotes = await Promise.all(
      candidate.outcomes
        .filter((outcome) => outcome.tokenId)
        .map((outcome) => clob.getReferenceQuote(outcome.tokenId!, outcome.label)),
    );
    snapshots.push({
      candidate,
      quotes,
      capturedAt: new Date().toISOString(),
    });
  }

  let mappingsWritten: ReferenceMarketMapping[] = [];
  const localMarketsCreated: ImportWorldCupResult["localMarketsCreated"] = [];
  if (options.createLocalMarkets && !options.dryRun) {
    const api = deps.adminApi ?? buildAdminApiClient(options);
    const existingMappings = await readReferenceMappings(options.mappingPath);
    const newMappings: ReferenceMarketMapping[] = [];

    for (const snapshot of snapshots) {
      const response = await api.importAdminReferenceMarket(
        buildAdminImportPayload(snapshot, options),
      );

      localMarketsCreated.push({
        localMarketId: response.marketId,
        externalMarketId: snapshot.candidate.externalMarketId,
        question: snapshot.candidate.question,
        created: response.marketCreated,
      });

      snapshot.candidate.outcomes.forEach((outcome, index) => {
        if (!outcome.tokenId) {
          return;
        }
        newMappings.push({
          localMarketId: response.marketId,
          localOutcome: normalizeLocalOutcomeName(outcome.label, snapshot.candidate.outcomes.length),
          source: "polymarket",
          externalMarketId: snapshot.candidate.externalMarketId,
          conditionId: snapshot.candidate.conditionId,
          polymarketSlug: snapshot.candidate.slug,
          polymarketTokenId: outcome.tokenId,
          polymarketOutcome: outcome.label,
          enabled: true,
          notes: response.outcomeIds[index]
            ? `Imported from Polymarket via admin metadata import.`
            : "Imported from Polymarket.",
        });
      });
    }

    mappingsWritten = upsertReferenceMappings(existingMappings, newMappings);
    await writeReferenceMappings(options.mappingPath, mappingsWritten);
  }

  const result: ImportWorldCupResult = {
    fetchedAt: new Date().toISOString(),
    queriesUsed: options.slug ? [options.slug] : options.query ? [options.query] : DEFAULT_QUERIES,
    totalCandidatesFetched: candidates.length,
    totalCandidatesSelected: snapshots.length,
    selectedCandidates: candidates,
    snapshots,
    mappingsWritten,
    localMarketsCreated,
    outputPath: options.outputPath,
    mappingPath: options.mappingPath,
    dryRun: options.dryRun,
    createLocalMarkets: options.createLocalMarkets,
    createEvents: options.createEvents,
    status: options.status,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function fetchCandidates(
  gamma: PolymarketGammaClient,
  options: ImportWorldCupOptions,
): Promise<ReferenceMarketCandidate[]> {
  if (options.slug) {
    const candidate = await gamma.getMarketBySlug(options.slug);
    return candidate ? [candidate] : [];
  }

  const queries = options.query ? [options.query] : DEFAULT_QUERIES;
  return gamma.searchWorldCupMarkets({
    queries,
    limit: options.limit,
  });
}

function buildAdminApiClient(options: ImportWorldCupOptions) {
  if (!options.adminSessionCookie) {
    throw new Error("Create-local-markets mode requires POLY_SIM_SESSION_COOKIE or equivalent admin session cookie.");
  }
  return new ApiClient(options.baseUrl, options.adminSessionCookie, {
    authMode: "cookie",
  });
}

function buildAdminImportPayload(
  snapshot: ReferenceMarketSnapshot,
  options: ImportWorldCupOptions,
) {
  const candidate = snapshot.candidate;
  const marketType = candidate.outcomes.length > 2 ? "MULTI_WINNER" : "BINARY";

  return {
    createEvents: options.createEvents,
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
      description: buildLocalDescription(candidate),
      category: candidate.category,
      resolveTime: candidate.endDate,
      type: marketType,
      desiredStatus: options.status,
      externalMarketId: candidate.externalMarketId,
      conditionId: candidate.conditionId,
      externalSlug: candidate.slug,
      referenceSource: "polymarket",
      referenceMetadata: {
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
        image: candidate.image,
        icon: candidate.icon,
        outcomePrices: candidate.outcomePrices,
        selectedRawFields: {
          active: candidate.active,
          closed: candidate.closed,
          archived: candidate.archived,
          eventSlug: candidate.eventSlug,
          resolutionSource: candidate.resolutionSource,
          tags: candidate.tags,
        },
      },
      outcomes: candidate.outcomes.map((outcome) => ({
        name: outcome.label,
        displayOrder: outcome.index,
        isTradable: false,
        referenceTokenId: outcome.tokenId,
        referenceOutcomeLabel: outcome.label,
        referenceMetadata: {
          outcomePrice: outcome.outcomePrice,
          tokenId: outcome.tokenId,
          clobValidation: snapshot.quotes.find((quote) => quote.tokenId === outcome.tokenId) ?? null,
        },
      })),
    },
  } as const;
}

function buildLocalDescription(candidate: ReferenceMarketCandidate): string {
  const lines = [
    candidate.description ?? candidate.question,
    "",
    "Imported from Polymarket reference market.",
    `Polymarket market id: ${candidate.externalMarketId}`,
    candidate.conditionId ? `Condition ID: ${candidate.conditionId}` : null,
    candidate.slug ? `Slug: ${candidate.slug}` : null,
    candidate.resolutionSource ? `Resolution source: ${candidate.resolutionSource}` : null,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);

  return lines.join("\n");
}

function normalizeLocalOutcomeName(label: string, outcomeCount: number) {
  if (outcomeCount === 2 && label.toLowerCase() === "yes") {
    return "YES";
  }
  if (outcomeCount === 2 && label.toLowerCase() === "no") {
    return "NO";
  }
  return label;
}

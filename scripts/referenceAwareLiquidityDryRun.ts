import { writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api/apiClient.js";
import { AdminImportReferenceMarketRequest, AdminReferenceMarketItem } from "../src/api/types.js";
import { PolymarketGammaClient, ReferenceMarketCandidate } from "../src/referenceMarket/polymarketGammaClient.js";
import { ReferencePriceCache } from "../src/referenceMarket/referencePriceCache.js";
import { buildReferenceMarketMapping } from "../src/referenceMarket/referenceMapping.js";
import { ReferencePriceUpdater } from "../src/referenceMarket/referencePriceUpdater.js";
import { shiftPriceByTicks } from "../src/strategies/shared/common.js";
import { sleep } from "../src/utils/sleep.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert(options.slug, "Provide --slug <polymarket-slug>.");

  process.env.SYSTEM_LIQUIDITY_DRY_RUN = "true";

  const sessionCookie = process.env.POLY_SIM_SESSION_COOKIE ?? "";
  if (!sessionCookie.trim()) {
    throw new Error("POLY_SIM_SESSION_COOKIE is required for admin import/review/list operations.");
  }

  const api = new ApiClient(options.baseUrl, sessionCookie, {
    authMode: "cookie",
    cookieName: "next-auth.session-token",
  });
  const gamma = new PolymarketGammaClient();
  const localMarket = await ensureImportedAndApproved(api, gamma, options.slug);
  const mappings = buildRealMappings(localMarket);
  await writeDryRunBotsJson(localMarket.id, options.baseUrl);

  const cache = new ReferencePriceCache();
  const updater = new ReferencePriceUpdater({
    cache,
    gamma,
    mappings,
    pollIntervalMs: options.pollIntervalMs,
    dryRunOverrideMmEligible: false,
  });

  const startedAt = Date.now();
  const deadline = startedAt + options.durationSeconds * 1000;
  let lastPlan: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    await updater.pollOnce();
    lastPlan = buildPlan(cache, mappings, options.tickSize);
    printPlan(lastPlan);
    if (Date.now() + options.pollIntervalMs >= deadline) {
      break;
    }
    await sleep(options.pollIntervalMs);
  }

  const report = {
    dryRun: true,
    systemLiquidityDryRun: process.env.SYSTEM_LIQUIDITY_DRY_RUN === "true",
    noOrdersPlaced: true,
    localMarketId: localMarket.id,
    localOutcomeIds: localMarket.outcomes.map((outcome) => outcome.id),
    polymarketTokenIds: localMarket.outcomes.map((outcome) => outcome.referenceTokenId),
    plans: lastPlan,
  };
  console.log(JSON.stringify(report, null, 2));
}

async function ensureImportedAndApproved(api: ApiClient, gamma: PolymarketGammaClient, slug: string) {
  const existing = await findBySlug(api, slug);
  const market = existing ?? (await importMarket(api, gamma, slug));
  await api.updateAdminReferenceMarket(market.id, {
    action: "approve",
    referenceOnly: true,
    tradable: false,
    mmEnabled: true,
    isListed: false,
    reviewNotes: "Approved for reference-aware system liquidity dry-run only.",
  });
  const approved = await findBySlug(api, slug);
  if (!approved) {
    throw new Error(`Imported market could not be reloaded for slug: ${slug}`);
  }
  return approved;
}

async function findBySlug(api: ApiClient, slug: string): Promise<AdminReferenceMarketItem | null> {
  const response = await api.listAdminReferenceMarkets({
    source: "polymarket",
    search: slug,
  });
  return response.items.find((item) => item.externalSlug === slug) ?? null;
}

async function importMarket(api: ApiClient, gamma: PolymarketGammaClient, slug: string) {
  const candidate = await gamma.getMarketBySlug(slug);
  if (!candidate) {
    throw new Error(`Polymarket market not found for slug: ${slug}`);
  }
  const payload = buildImportPayload(candidate);
  await api.importAdminReferenceMarket(payload);
  const imported = await findBySlug(api, slug);
  if (!imported) {
    throw new Error(`Reference market import did not create a local market for slug: ${slug}`);
  }
  return imported;
}

function buildImportPayload(candidate: ReferenceMarketCandidate): AdminImportReferenceMarketRequest {
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
      description: candidate.description,
      category: candidate.category,
      resolveTime: candidate.endDate,
      type: candidate.outcomes.length > 2 ? "MULTI_WINNER" : "BINARY",
      desiredStatus: "draft",
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
        outcomePrices: candidate.outcomePrices,
        importedFrom: "polymarket",
        importStatus: "pending_review",
        referenceOnly: true,
        tradable: false,
        mmEnabled: false,
        reviewedAt: null,
        reviewedBy: null,
        reviewNotes: "Imported for reference-aware system liquidity dry-run.",
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
        },
      })),
    },
  };
}

function buildRealMappings(localMarket: AdminReferenceMarketItem) {
  return localMarket.outcomes
    .filter((outcome) => outcome.referenceTokenId)
    .map((outcome) =>
      buildReferenceMarketMapping({
        localMarketId: localMarket.id,
        localOutcomeId: outcome.id,
        localOutcome: outcome.name,
        polymarketMarketId: localMarket.externalMarketId ?? "",
        conditionId: localMarket.conditionId,
        polymarketSlug: localMarket.externalSlug,
        polymarketTokenId: outcome.referenceTokenId!,
        polymarketOutcome: outcome.referenceOutcomeLabel ?? outcome.name,
        enabled: true,
        mmEnabled: localMarket.mmEnabled ?? false,
        reviewStatus: localMarket.importStatus === "approved" ? "approved" : "pending_review",
        notes: localMarket.reviewNotes,
      }),
    );
}

function buildPlan(
  cache: ReferencePriceCache,
  mappings: ReturnType<typeof buildRealMappings>,
  tickSize: string,
) {
  return mappings.map((mapping) => {
    const quote = cache.getQuote(mapping.localMarketId, mapping.localOutcomeId);
    const referenceBid = quote?.gammaBestBid ?? null;
    const referenceAsk = quote?.gammaBestAsk ?? null;
    const plannedBid = referenceBid != null ? clampPlanPrice(shiftPriceByTicks(referenceBid.toFixed(2), tickSize, -2)) : null;
    const plannedAsk = referenceAsk != null ? clampPlanPrice(shiftPriceByTicks(referenceAsk.toFixed(2), tickSize, 2)) : null;
    return {
      localMarketId: mapping.localMarketId,
      localOutcomeId: mapping.localOutcomeId,
      polymarketTokenId: mapping.polymarketTokenId,
      referenceBid,
      referenceAsk,
      plannedBotBid: plannedBid,
      plannedBotAsk: plannedAsk,
      mmEligible: quote?.mmEligible ?? false,
      qualityStatus: quote?.qualityStatus ?? null,
      reason: quote?.reason ?? null,
    };
  });
}

function printPlan(plan: Array<Record<string, unknown>>) {
  for (const row of plan) {
    console.log(JSON.stringify(row, null, 2));
  }
}

async function writeDryRunBotsJson(localMarketId: string, baseUrl: string) {
  const config = {
    bots: [
      {
        name: "referenceAwareSystemLiquidityDryRun",
        baseUrl,
        apiKey: "dry-run.not-used",
        strategy: "tightMarketMaker",
        marketIds: [localMarketId],
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
        dailyNotionalPauseMode: "pause_for_run",
        dailyNotionalCooldownMs: 86400000,
        pausedPollIntervalMs: 45000,
        pauseLogIntervalMs: 60000,
      },
    ],
    sim: {
      enabled: false,
      baseUrl,
      sessionCookie: "",
      intervalMs: 5000,
      orchestratorLoopIntervalMs: 5000,
      closeLoopIntervalMs: 5000,
      resolveLoopIntervalMs: 5000,
      healthLoopIntervalMs: 5000,
      failFast: false,
      runSeeder: false,
      runCloser: false,
      runResolver: false,
      runHealthChecker: false,
      targetActiveMarkets: 0,
      maxCreatePerRun: 0,
      maxClosePerRun: 0,
      maxResolvePerRun: 0,
      defaultMarketDurationMinutes: 1,
      resolveDelayMinutes: 1,
      resolverMode: "random_50_50",
      settleAfterResolve: false,
      maxClosedUnresolvedAgeMs: 900000,
      emitJsonSummary: false,
    },
  };

  await writeFile(path.resolve(process.cwd(), "bots.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function clampPlanPrice(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Number(Math.max(0.01, Math.min(0.99, numeric)).toFixed(2));
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    args.set(part.slice(2), next && !next.startsWith("--") ? next : "true");
  }

  return {
    slug: stringArg(args.get("slug")),
    durationSeconds: intArg(args.get("durationSeconds"), 60),
    pollIntervalMs: intArg(args.get("pollIntervalMs"), 5000),
    tickSize: stringArg(args.get("tickSize")) ?? "0.01",
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://localhost:3000",
  };
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

main().catch((error) => {
  console.error("Reference-aware liquidity dry-run failed.");
  console.error(error);
  process.exitCode = 1;
});

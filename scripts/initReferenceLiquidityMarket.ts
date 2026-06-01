import assert from "node:assert/strict";
import { ApiClient } from "../src/api/apiClient.js";
import { AdminReferenceMarketItem } from "../src/api/types.js";
import { loadConfig } from "../src/config/loadConfig.js";
import {
  buildBotInitializationMetadata,
  buildLivePreviewOrderPlan,
  cancelExistingOrdersForMarket,
  evaluateMarketReadiness,
  placeInitialLiveOrders,
  selectBotConfigForMarket,
} from "../src/referenceMarket/liquidityInitialization.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.SYSTEM_LIQUIDITY_DRY_RUN = options.dryRun ? "true" : process.env.SYSTEM_LIQUIDITY_DRY_RUN ?? "true";

  const sessionCookie = process.env.POLY_SIM_SESSION_COOKIE ?? "";
  const devAdminUserId = options.devAdminUserId ?? process.env.POLY_DEV_ADMIN_USER_ID ?? "";
  if (!sessionCookie.trim() && !devAdminUserId.trim()) {
    throw new Error("POLY_SIM_SESSION_COOKIE or POLY_DEV_ADMIN_USER_ID is required for admin market initialization.");
  }

  const api = new ApiClient(options.baseUrl, sessionCookie.trim() ? sessionCookie : "dev-admin",
    {
    authMode: "cookie",
    cookieName: "poly_session",
    extraHeaders: devAdminUserId.trim()
      ? { "x-dev-admin-user-id": devAdminUserId }
      : undefined,
  });
  const config = loadConfig(process.cwd(), { requireBots: false });
  const market = await loadTargetMarket(api, options);
  assert(
    market.outcomes.some((outcome) => outcome.referenceTokenId),
    `No reference outcome mappings found for market ${market.id}.`,
  );
  await api.refreshAdminReferenceMarketSnapshot(market.id);

  const reference = await api.getMarketReferencePlan(market.id);
  const botConfig = selectBotConfigForMarket(config, market.id);
  const readiness = evaluateMarketReadiness({
    market,
    reference,
    botConfig,
    dryRun: options.dryRun,
    confirmLive: options.confirmLive,
    liveOrdersEnabled: process.env.LIVE_SYSTEM_LIQUIDITY_ENABLED === "true",
    maxReferenceSpread: Number(process.env.MAX_REFERENCE_SPREAD ?? "0.10"),
  });
  const nextMetadata = buildBotInitializationMetadata({
    current: market.botInitialization ?? null,
    readiness,
  });

  await api.updateAdminReferenceMarket(market.id, {
    botInitialization: nextMetadata,
  });

  let canceledOrderIds: string[] = [];
  let liveActions: Array<Record<string, unknown>> = [];
  if (!options.dryRun && readiness.ready) {
    const livePreview = buildLivePreviewOrderPlan({
      outcome: reference.outcomes.find((entry) => entry.localOutcomeId === readiness.selectedOutcomeId) ?? null,
      quoteOffsetTicks: options.quoteOffsetTicks,
      tickSize: options.tickSize,
    });
    canceledOrderIds = await cancelExistingOrdersForMarket(api, market.id);
    liveActions = await placeInitialLiveOrders(api, {
      marketId: market.id,
      outcomeId: readiness.selectedOutcomeId!,
      bidPrice: livePreview.plannedBotBid,
      askPrice: livePreview.plannedBotAsk,
      size: options.maxInitialOrderSize,
      tickSize: options.tickSize,
    });
  }

  const result = {
    dryRun: options.dryRun,
    noOrdersPlaced: options.dryRun || liveActions.length === 0,
    readinessStatus: readiness.ready ? (options.dryRun ? "dry_run_ready" : "live_ready") : "blocked",
    marketId: market.id,
    title: market.title,
    slug: market.externalSlug,
    referenceBid: readiness.referenceBid,
    referenceAsk: readiness.referenceAsk,
    plannedBotBid: readiness.plannedBotBid,
    plannedBotAsk: readiness.plannedBotAsk,
    mmEligible: readiness.mmEligible,
    botConfigName: readiness.botConfigName,
    riskProfile: readiness.riskProfile,
    reasons: readiness.reasons,
    canceledOrderIds,
    liveActions,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function loadTargetMarket(api: ApiClient, options: Options): Promise<AdminReferenceMarketItem> {
  const response = await api.listAdminReferenceMarkets({
    source: "polymarket",
    search: options.slug ?? options.marketId ?? undefined,
  });
  const market =
    response.items.find((entry) => options.marketId && entry.id === options.marketId) ??
    response.items.find((entry) => options.slug && entry.externalSlug === options.slug) ??
    null;
  if (!market) {
    throw new Error("Target market not found.");
  }
  return market;
}

type Options = {
  marketId: string | null;
  slug: string | null;
  dryRun: boolean;
  confirmLive: boolean;
  pollMs: number;
  tickSize: string;
  quoteOffsetTicks: number;
  maxInitialOrderSize: string;
  baseUrl: string;
  devAdminUserId: string | null;
};

function parseArgs(argv: string[]): Options {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const next = argv[index + 1];
    args.set(value.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  const dryRun = boolArg(args.get("dryRun"), true);
  return {
    marketId: stringArg(args.get("marketId")),
    slug: stringArg(args.get("slug")),
    dryRun,
    confirmLive: boolArg(args.get("confirmLive"), false),
    pollMs: intArg(args.get("pollMs"), Number(process.env.REFERENCE_POLL_MS ?? "5000")),
    tickSize: stringArg(args.get("tickSize")) ?? process.env.TICK_SIZE ?? "0.01",
    quoteOffsetTicks: intArg(args.get("quoteOffsetTicks"), Number(process.env.QUOTE_OFFSET_TICKS ?? "2")),
    maxInitialOrderSize: stringArg(args.get("maxInitialOrderSize")) ?? "5.000000",
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")),
  };
}

function boolArg(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "true";
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

main().catch((error) => {
  console.error("Liquidity initialization failed.");
  console.error(error);
  process.exitCode = 1;
});

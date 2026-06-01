import { ApiClient } from "../api/apiClient.js";
import { AdminReferenceMarketItem, Balance, MarketReferencePlanResponse, Order, Position, QuoteResponse } from "../api/types.js";
import { buildDesiredQuotes, evaluateLiveReadiness, reconcileQuotes, type LiveRiskConfig } from "./liveMarketMaker.js";
import { readReferenceLiveRuntimeRecord } from "./runtimeFile.js";
import { getReferenceMarketLabel } from "./eventAdmin.js";

export type SupervisorOptions = {
  baseUrl: string;
  durationSeconds: number;
  pollMs: number;
  dryRunOverride: boolean | null;
  slug: string | null;
  marketId: string | null;
  eventSlug: string | null;
  maxMarkets: number | null;
  allowlist: string[];
  confirmLive: boolean;
  devAdminUserId: string | null;
};

export type RuntimeDecision = {
  action: "skip" | "cancel" | "quote_preview" | "manage_quotes";
  livePlacementAllowed: boolean;
  reasons: string[];
};

export type RuntimeCycleReport = {
  marketId: string;
  slug: string | null;
  status: string;
  previousLifecycleStatus: string;
  currentLifecycleStatus: string;
  lifecycleTransition: string | null;
  dryRun: boolean;
  referenceBid: number | null;
  referenceAsk: number | null;
  plannedBotBid: number | null;
  plannedBotAsk: number | null;
  reasons: string[];
  openOrderCount: number;
};

export function determineRuntimeDecision(params: {
  market: AdminReferenceMarketItem;
  readiness: ReturnType<typeof evaluateLiveReadiness>;
  dryRun: boolean;
  liveOrdersEnabled: boolean;
  confirmLive: boolean;
  runtimePresent: boolean;
  openOrders: Order[];
}) : RuntimeDecision {
  const reasons = [...params.readiness.reasons];
  const status = params.market.botInitialization?.status ?? "not_started";

  if (status === "paused") {
    return { action: "skip", livePlacementAllowed: false, reasons: [...reasons, "market_paused"] };
  }
  if (status === "blocked") {
    return { action: "skip", livePlacementAllowed: false, reasons: [...reasons, "market_blocked"] };
  }
  if (!params.runtimePresent) {
    return { action: "skip", livePlacementAllowed: false, reasons: [...reasons, "runtime_missing"] };
  }
  if (!params.readiness.ready) {
    const shouldCancel =
      !params.dryRun &&
      params.openOrders.length > 0 &&
      reasons.some((reason) =>
        [
          "reference_stale",
          "reference_spread_too_wide",
          "reference_missing_book",
          "reference_not_accepting_orders",
          "emergency_stop",
        ].includes(reason),
      );
    return { action: shouldCancel ? "cancel" : "skip", livePlacementAllowed: false, reasons };
  }
  if (
    params.dryRun ||
    !params.liveOrdersEnabled ||
    !params.confirmLive ||
    status !== "live_enabled"
  ) {
    return { action: "quote_preview", livePlacementAllowed: false, reasons };
  }
  return { action: "manage_quotes", livePlacementAllowed: true, reasons };
}

export function shouldTransitionToLiveEnabled(params: {
  market: AdminReferenceMarketItem;
  readiness: ReturnType<typeof evaluateLiveReadiness>;
  dryRun: boolean;
  liveOrdersEnabled: boolean;
  confirmLive: boolean;
  runtimePresent: boolean;
}) {
  const reasons: string[] = [];
  const status = params.market.botInitialization?.status ?? "not_started";
  if (params.dryRun) reasons.push("dry_run_enabled");
  if (!params.liveOrdersEnabled) reasons.push("live_orders_disabled");
  if (!params.confirmLive) reasons.push("confirm_live_required");
  if (!params.runtimePresent) reasons.push("runtime_missing");
  if (status !== "live_ready" && status !== "live_enabled") reasons.push("lifecycle_not_live_ready");
  if (params.market.botInitialization?.runtime?.emergencyStop) reasons.push("emergency_stop");
  if (!params.readiness.ready) reasons.push(...params.readiness.reasons);

  return {
    shouldTransition: reasons.length === 0 && status === "live_ready",
    reasons,
  };
}

export async function runRuntimeSupervisor(
  options: SupervisorOptions,
  deps: {
    adminApi: ApiClient;
    createBotApi: (token: string) => ApiClient;
    risk: LiveRiskConfig;
    cwd: string;
  },
) {
  const dryRun = options.dryRunOverride ?? (process.env.SYSTEM_LIQUIDITY_DRY_RUN !== "false");
  const liveOrdersEnabled = process.env.LIVE_SYSTEM_LIQUIDITY_ENABLED === "true";
  const startedAt = Date.now();
  const deadline = startedAt + options.durationSeconds * 1000;
  const cycleReports: RuntimeCycleReport[] = [];

  while (Date.now() < deadline) {
    const markets = await loadManagedMarkets(deps.adminApi, options);
    for (const market of markets) {
      await deps.adminApi.refreshAdminReferenceMarketSnapshot(market.id);
      let freshMarket = (await loadManagedMarkets(deps.adminApi, { ...options, marketId: market.id, slug: null }))[0] ?? market;
      const reference = await deps.adminApi.getMarketReferencePlan(market.id);
      const previousLifecycleStatus = freshMarket.botInitialization?.status ?? "not_started";

      let runtimePresent = false;
      let balance: Balance = emptyBalance();
      let positions: Position[] = [];
      let openOrders: Order[] = [];
      let localQuote: QuoteResponse = { marketId: market.id, quotes: [] };
      let botApi: ApiClient | null = null;

      try {
        const runtime = await readReferenceLiveRuntimeRecord(deps.cwd, market.id);
        runtimePresent = true;
        botApi = deps.createBotApi(runtime.botApiToken);
        const [nextBalance, nextPositions, nextOpenOrders, nextLocalQuote] = await Promise.all([
          botApi.getBalance(),
          botApi.getPositions(market.id),
          botApi.getOrders({ marketId: market.id, status: ["OPEN", "PARTIAL"], limit: 100 }),
          botApi.getQuote(market.id),
        ]);
        balance = nextBalance;
        positions = nextPositions.items;
        openOrders = nextOpenOrders.items;
        localQuote = nextLocalQuote;
      } catch {
        runtimePresent = false;
      }

      const readiness = evaluateLiveReadiness({
        market: freshMarket,
        reference,
        balance,
        positions,
        openOrders,
        confirmLive: options.confirmLive,
        liveOrdersEnabled,
        systemLiquidityDryRun: dryRun,
        runtimePresent,
        risk: deps.risk,
      });
      const transition = shouldTransitionToLiveEnabled({
        market: freshMarket,
        readiness,
        dryRun,
        liveOrdersEnabled,
        confirmLive: options.confirmLive,
        runtimePresent,
      });
      let lifecycleTransition: string | null = null;

      if (transition.shouldTransition) {
        const update = await deps.adminApi.updateAdminReferenceMarket(market.id, {
          action: "mark_live_enabled",
        });
        freshMarket = {
          ...freshMarket,
          botInitialization: {
            ...(freshMarket.botInitialization ?? {
              lastCheckedAt: null,
              reason: null,
              approvedBy: null,
              approvedAt: null,
              riskProfile: null,
              capital: null,
              runtime: null,
              readiness: null,
            }),
            ...(update.botInitialization ?? {}),
            status: "live_enabled",
          },
        };
        lifecycleTransition = "explicit_live_confirmed";
      }

      const decision = determineRuntimeDecision({
        market: freshMarket,
        readiness,
        dryRun,
        liveOrdersEnabled,
        confirmLive: options.confirmLive,
        runtimePresent,
        openOrders,
      });

      if (decision.action === "cancel" && botApi) {
        for (const order of openOrders) {
          await botApi.cancelOrder(order.id);
        }
      }

      if (decision.action === "manage_quotes" && botApi) {
        const desired = buildDesiredQuotes({
          reference,
          localQuote,
          balance,
          positions,
          openOrders,
          marketId: market.id,
          risk: deps.risk,
          cycleTs: Date.now(),
        });
        const { toCancel, toPlace } = reconcileQuotes({
          desired,
          openOrders,
          nowMs: Date.now(),
          minQuoteLifetimeMs: deps.risk.minQuoteLifetimeMs,
          requoteThresholdTicks: deps.risk.requoteThresholdTicks,
          tickSize: deps.risk.tickSize,
        });
        for (const order of toCancel) {
          await botApi.cancelOrder(order.id);
        }
        for (const quote of toPlace) {
          await botApi.placeLimitOrder(
            {
              marketId: market.id,
              outcomeId: quote.outcomeId,
              side: quote.side,
              price: quote.price,
              size: quote.size,
            },
            quote.idempotencyKey,
          );
        }
      }

      cycleReports.push({
        marketId: market.id,
        slug: market.externalSlug,
        status: decision.action,
        previousLifecycleStatus,
        currentLifecycleStatus: freshMarket.botInitialization?.status ?? "not_started",
        lifecycleTransition,
        dryRun,
        referenceBid: readiness.referenceBid,
        referenceAsk: readiness.referenceAsk,
        plannedBotBid: readiness.plannedBotBid,
        plannedBotAsk: readiness.plannedBotAsk,
        reasons: decision.reasons,
        openOrderCount: openOrders.length,
      });
    }

    await sleep(options.pollMs);
  }

  return {
    dryRun,
    liveOrdersEnabled,
    confirmLive: options.confirmLive,
    cycleReports,
  };
}

export async function loadManagedMarkets(
  api: ApiClient,
  options: Pick<SupervisorOptions, "slug" | "marketId" | "eventSlug" | "maxMarkets" | "allowlist">,
) {
  const filters: { source: string; importStatus: string; search?: string } = {
    source: "polymarket",
    importStatus: "approved",
  };
  if (options.slug) {
    filters.search = options.slug;
  }
  const response = await api.listAdminReferenceMarkets(filters);
  const allowlist = options.allowlist.map((entry: string) => entry.toLowerCase());
  return response.items
    .filter((market) => {
      if (options.marketId && market.id !== options.marketId) return false;
      if (options.eventSlug && market.event?.slug !== options.eventSlug) return false;
      if (allowlist.length && !allowlist.includes(getReferenceMarketLabel(market).toLowerCase())) return false;
      if (!market.externalSlug) return false;
      if (market.referenceSource !== "polymarket") return false;
      const status = market.botInitialization?.status ?? "not_started";
      return ["dry_run_running", "live_ready", "live_enabled"].includes(status);
    })
    .slice(0, options.maxMarkets && options.maxMarkets > 0 ? options.maxMarkets : undefined);
}

function emptyBalance(): Balance {
  return {
    availableUSDC: "0.000000",
    lockedUSDC: "0.000000",
    totalUSDC: "0.000000",
    updatedAt: new Date(0).toISOString(),
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

import { ApiClient } from "../src/api/apiClient.js";
import { AdminReferenceMarketItem } from "../src/api/types.js";
import { buildDesiredQuotes, evaluateLiveReadiness, reconcileQuotes, type LiveRiskConfig } from "../src/referenceMarket/liveMarketMaker.js";
import { readReferenceLiveRuntimeRecord } from "../src/referenceMarket/runtimeFile.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adminApi = createAdminApi(options.baseUrl, options.devAdminUserId);
  const market = await loadTargetMarket(adminApi, options.marketId, options.slug);
  const runtime = await readReferenceLiveRuntimeRecord(process.cwd(), market.id);
  const botApi = new ApiClient(options.baseUrl, runtime.botApiToken);
  const risk = buildRiskConfig(options);
  const dryRun = process.env.SYSTEM_LIQUIDITY_DRY_RUN !== "false";
  const liveOrdersEnabled = process.env.LIVE_SYSTEM_LIQUIDITY_ENABLED === "true";

  const startedAt = Date.now();
  const deadline = startedAt + options.durationSeconds * 1000;
  const placedOrderIds: string[] = [];
  const canceledOrderIds: string[] = [];
  const cycleReports: Array<Record<string, unknown>> = [];

  if (!dryRun && liveOrdersEnabled && options.confirmLive) {
    await adminApi.updateAdminReferenceMarket(market.id, {
      botInitialization: {
        status: "live_enabled",
        runtime: {
          liveOrdersEnabled: true,
          emergencyStop: false,
          lastLiveRunAt: new Date().toISOString(),
        },
      },
    });
  }

  while (Date.now() < deadline) {
    await adminApi.refreshAdminReferenceMarketSnapshot(market.id);
    const freshMarket = await loadTargetMarket(adminApi, market.id, null);
    const reference = await adminApi.getMarketReferencePlan(market.id);
    const [balance, positions, openOrders, localQuote] = await Promise.all([
      botApi.getBalance(),
      botApi.getPositions(market.id),
      botApi.getOrders({ marketId: market.id, status: ["OPEN", "PARTIAL"], limit: 100 }),
      botApi.getQuote(market.id),
    ]);

    const readiness = evaluateLiveReadiness({
      market: freshMarket,
      reference,
      balance,
      positions: positions.items,
      openOrders: openOrders.items,
      confirmLive: options.confirmLive,
      liveOrdersEnabled,
      systemLiquidityDryRun: dryRun,
      runtimePresent: true,
      risk,
    });

    if (!readiness.ready || freshMarket.botInitialization?.runtime?.cancelRequestedAt) {
      for (const order of openOrders.items) {
        if (!dryRun) {
          await botApi.cancelOrder(order.id);
        }
        canceledOrderIds.push(order.id);
      }
      cycleReports.push({
        marketId: market.id,
        status: "skipped",
        dryRun,
        reasons: freshMarket.botInitialization?.runtime?.cancelRequestedAt
          ? [...readiness.reasons, "cancel_requested"]
          : readiness.reasons,
      });
      await sleep(options.cycleMs);
      continue;
    }

    const desired = buildDesiredQuotes({
      reference,
      localQuote,
      balance,
      positions: positions.items,
      openOrders: openOrders.items,
      marketId: market.id,
      risk,
      cycleTs: Date.now(),
    });
    const { toCancel, toPlace } = reconcileQuotes({
      desired,
      openOrders: openOrders.items,
      nowMs: Date.now(),
      minQuoteLifetimeMs: risk.minQuoteLifetimeMs,
      requoteThresholdTicks: risk.requoteThresholdTicks,
      tickSize: risk.tickSize,
    });

    for (const order of toCancel) {
      if (!dryRun) {
        await botApi.cancelOrder(order.id);
      }
      canceledOrderIds.push(order.id);
    }
    for (const quote of toPlace) {
      if (!dryRun) {
        const response = await botApi.placeLimitOrder(
          {
            marketId: market.id,
            outcomeId: quote.outcomeId,
            side: quote.side,
            price: quote.price,
            size: quote.size,
          },
          quote.idempotencyKey,
        );
        placedOrderIds.push(response.order.id);
      }
    }

    cycleReports.push({
      marketId: market.id,
      dryRun,
      referenceBid: readiness.referenceBid,
      referenceAsk: readiness.referenceAsk,
      plannedBotBid: readiness.plannedBotBid,
      plannedBotAsk: readiness.plannedBotAsk,
      reasons: readiness.reasons,
      desiredQuotes: desired,
      cancelCount: toCancel.length,
      placeCount: toPlace.length,
    });

    await sleep(options.cycleMs);
  }

  if (!options.leaveQuotes) {
    const orders = await botApi.getOrders({ marketId: market.id, status: ["OPEN", "PARTIAL"], limit: 100 });
    for (const order of orders.items) {
      if (!dryRun) {
        await botApi.cancelOrder(order.id);
      }
      canceledOrderIds.push(order.id);
    }
    if (!dryRun) {
      await adminApi.updateAdminReferenceMarket(market.id, {
        botInitialization: {
          status: "live_ready",
          runtime: {
            liveOrdersEnabled,
            emergencyStop: false,
            cancelRequestedAt: null,
            lastLiveRunAt: new Date().toISOString(),
            lastRuntimeSyncAt: new Date().toISOString(),
          },
        },
      });
    }
  }

  const [finalBalance, finalPositions, finalOpenOrders] = await Promise.all([
    botApi.getBalance(),
    botApi.getPositions(market.id),
    botApi.getOrders({ marketId: market.id, status: ["OPEN", "PARTIAL"], limit: 100 }),
  ]);

  console.log(JSON.stringify({
    dryRun,
    confirmLive: options.confirmLive,
    marketId: market.id,
    slug: market.externalSlug,
    durationSeconds: options.durationSeconds,
    placedOrderIds,
    canceledOrderIds,
    finalBotCash: finalBalance.availableUSDC,
    finalBotLockedCash: finalBalance.lockedUSDC,
    finalPositions: finalPositions.items.map((position) => ({
      outcomeId: position.outcomeId,
      outcomeName: position.outcomeName,
      shares: position.shares,
      reservedShares: position.reservedShares,
      realizedPnl: position.realizedPnl,
    })),
    openOrderNotional: finalOpenOrders.items.reduce((sum, order) => sum + Number(order.reservedNotional), 0).toFixed(6),
    openOrders: finalOpenOrders.items.map((order) => ({
      id: order.id,
      outcomeId: order.outcomeId,
      side: order.side,
      price: order.price,
      remaining: order.remaining,
      status: order.status,
    })),
    cycleReports,
  }, null, 2));
}

function buildRiskConfig(options: ReturnType<typeof parseArgs>): LiveRiskConfig {
  return {
    referenceStaleMs: intEnv("REFERENCE_STALE_MS", 15000),
    maxReferenceSpread: numberEnv("MAX_REFERENCE_SPREAD", 0.1),
    quoteOffsetTicks: intEnv("QUOTE_OFFSET_TICKS", 2),
    tickSize: process.env.TICK_SIZE?.trim() || "0.01",
    maxSingleOrderNotionalCents: intEnv("MAX_SINGLE_ORDER_NOTIONAL_CENTS", 1000),
    maxOpenOrderNotionalCents: intEnv("MAX_OPEN_ORDER_NOTIONAL_CENTS", 10000),
    maxDailyLossCents: intEnv("MAX_DAILY_LOSS_CENTS", 10000),
    maxInventoryPerOutcome: intEnv("MAX_INVENTORY_PER_OUTCOME", 300),
    minOutcomeInventory: intEnv("MIN_OUTCOME_INVENTORY", 20),
    minCashReserveCents: intEnv("MIN_CASH_RESERVE_CENTS", 20000),
    maxShareSize: numberEnv("MAX_SINGLE_ORDER_SIZE_SHARES", 10),
    minQuoteLifetimeMs: intEnv("MIN_QUOTE_LIFETIME_MS", 5000),
    requoteThresholdTicks: intEnv("REQUOTE_THRESHOLD_TICKS", 1),
  };
}

function createAdminApi(baseUrl: string, devAdminUserId: string | null) {
  const sessionCookie = process.env.POLY_SIM_SESSION_COOKIE ?? "";
  if (!sessionCookie.trim() && !devAdminUserId?.trim()) {
    throw new Error("POLY_SIM_SESSION_COOKIE or POLY_DEV_ADMIN_USER_ID is required.");
  }
  return new ApiClient(baseUrl, sessionCookie.trim() ? sessionCookie : "dev-admin", {
    authMode: "cookie",
    cookieName: "poly_session",
    extraHeaders: devAdminUserId?.trim() ? { "x-dev-admin-user-id": devAdminUserId.trim() } : undefined,
  });
}

async function loadTargetMarket(api: ApiClient, marketId: string | null, slug: string | null): Promise<AdminReferenceMarketItem> {
  const response = await api.listAdminReferenceMarkets({
    source: "polymarket",
    search: slug ?? undefined,
  });
  const market =
    response.items.find((entry) => marketId && entry.id === marketId) ??
    response.items.find((entry) => slug && entry.externalSlug === slug) ??
    null;
  if (!market) {
    throw new Error("Target market not found.");
  }
  return market;
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const next = argv[index + 1];
    args.set(value.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    marketId: stringArg(args.get("marketId")),
    slug: stringArg(args.get("slug")),
    durationSeconds: intArg(args.get("durationSeconds"), 60),
    confirmLive: boolArg(args.get("confirmLive"), false),
    leaveQuotes: boolArg(args.get("leaveQuotes"), false),
    cycleMs: intArg(args.get("cycleMs"), intEnv("LIQUIDITY_BOT_CYCLE_MS", 1500)),
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
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

function intEnv(key: string, fallback: number) {
  const parsed = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberEnv(key: string, fallback: number) {
  const raw = process.env[key];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("Live reference liquidity runner failed.");
  console.error(error);
  process.exitCode = 1;
});

import { ApiClient } from "../src/api/apiClient.js";
import type { AdminReferenceMarketItem, Balance, Order, Position, QuoteResponse } from "../src/api/types.js";
import { createAdminApi, loadEventReferenceMarkets, parseAllowlist, boolArg, stringArg, intArg } from "../src/referenceMarket/eventAdmin.js";
import { evaluateLiveReadiness, type LiveRiskConfig } from "../src/referenceMarket/liveMarketMaker.js";
import { readReferenceLiveRuntimeRecord } from "../src/referenceMarket/runtimeFile.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.eventSlug) {
    throw new Error("--eventSlug is required.");
  }

  const adminApi = createAdminApi(options.baseUrl, options.devAdminUserId);
  const markets = await loadEventReferenceMarkets(adminApi, {
    eventSlug: options.eventSlug,
    maxMarkets: options.maxMarkets,
    allowlist: options.allowlist,
  });

  const results = [];
  for (const market of markets) {
    const reference = await adminApi.getMarketReferencePlan(market.id);
    const runtime = await tryLoadRuntime(process.cwd(), market.id);
    let balance: Balance = emptyBalance();
    let positions: Position[] = [];
    let openOrders: Order[] = [];
    if (runtime) {
      const botApi = new ApiClient(options.baseUrl, runtime.botApiToken);
      const [nextBalance, nextPositions, nextOpenOrders] = await Promise.all([
        botApi.getBalance(),
        botApi.getPositions(market.id),
        botApi.getOrders({ marketId: market.id, status: ["OPEN", "PARTIAL"], limit: 100 }),
      ]);
      balance = nextBalance;
      positions = nextPositions.items;
      openOrders = nextOpenOrders.items;
    }
    const readiness = evaluateLiveReadiness({
      market,
      reference,
      balance,
      positions,
      openOrders,
      confirmLive: options.confirmLive,
      liveOrdersEnabled: options.liveOrdersEnabled,
      systemLiquidityDryRun: options.systemLiquidityDryRun,
      runtimePresent: Boolean(runtime),
      risk: buildRiskConfig(),
    });
    results.push({
      marketId: market.id,
      slug: market.externalSlug,
      title: market.title,
      status: market.botInitialization?.status ?? "not_started",
      ready: readiness.ready,
      reasons: readiness.reasons,
      referenceBid: readiness.referenceBid,
      referenceAsk: readiness.referenceAsk,
      plannedBotBid: readiness.plannedBotBid,
      plannedBotAsk: readiness.plannedBotAsk,
      openOrderNotionalCents: readiness.openOrderNotionalCents,
      dailyLossCents: readiness.dailyLossCents,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    eventSlug: options.eventSlug,
    confirmLive: options.confirmLive,
    liveOrdersEnabled: options.liveOrdersEnabled,
    systemLiquidityDryRun: options.systemLiquidityDryRun,
    readyMarkets: results.filter((item) => item.ready).length,
    blockedMarkets: results.filter((item) => !item.ready).length,
    results,
  }, null, 2));
}

function buildRiskConfig(): LiveRiskConfig {
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

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    eventSlug: stringArg(args.get("eventSlug")),
    confirmLive: boolArg(args.get("confirmLive"), false),
    maxMarkets: intArg(args.get("maxMarkets"), 0) || null,
    allowlist: parseAllowlist(stringArg(args.get("allowlist"))),
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
    liveOrdersEnabled: process.env.LIVE_SYSTEM_LIQUIDITY_ENABLED === "true",
    systemLiquidityDryRun: process.env.SYSTEM_LIQUIDITY_DRY_RUN !== "false",
  };
}

async function tryLoadRuntime(cwd: string, marketId: string) {
  try {
    return await readReferenceLiveRuntimeRecord(cwd, marketId);
  } catch {
    return null;
  }
}

function emptyBalance(): Balance {
  return {
    availableUSDC: "0.000000",
    lockedUSDC: "0.000000",
    totalUSDC: "0.000000",
    updatedAt: new Date(0).toISOString(),
  };
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

main().catch((error) => {
  console.error("Reference event readiness check failed.");
  console.error(error);
  process.exitCode = 1;
});

import { ApiClient } from "../src/api/apiClient.js";
import { createAdminApi, parseAllowlist, stringArg, boolArg, intArg } from "../src/referenceMarket/eventAdmin.js";
import { runRuntimeSupervisor, type SupervisorOptions } from "../src/referenceMarket/runtimeSupervisor.js";
import type { LiveRiskConfig } from "../src/referenceMarket/liveMarketMaker.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.eventSlug) {
    throw new Error("--eventSlug is required.");
  }

  const adminApi = createAdminApi(options.baseUrl, options.devAdminUserId);
  const result = await runRuntimeSupervisor(options, {
    adminApi,
    createBotApi: (token) => new ApiClient(options.baseUrl, token),
    risk: buildRiskConfig(),
    cwd: process.cwd(),
  });
  console.log(JSON.stringify(result, null, 2));
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

function parseArgs(argv: string[]): SupervisorOptions {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    dryRunOverride: args.has("dryRun") ? boolArg(args.get("dryRun"), true) : null,
    marketId: null,
    slug: null,
    eventSlug: stringArg(args.get("eventSlug")),
    maxMarkets: intArg(args.get("maxMarketsPerRun"), 0) || intArg(args.get("maxMarkets"), 5) || 5,
    allowlist: parseAllowlist(stringArg(args.get("allowlist"))),
    durationSeconds: intArg(args.get("durationSeconds"), 300),
    pollMs: intArg(args.get("pollMs"), 5000),
    confirmLive: boolArg(args.get("confirmLive"), false),
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
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
  console.error("Reference event live runner failed.");
  console.error(error);
  process.exitCode = 1;
});

import { ApiClient } from "../src/api/apiClient.js";
import { PolyApiError } from "../src/api/apiClient.js";
import { AdminReferenceMarketItem } from "../src/api/types.js";
import { canPlaceLiveInternalOrders, loadBotSafetyPolicy } from "../src/config/botSafety.js";
import { createAdminApi } from "../src/referenceMarket/eventAdmin.js";
import { writeReferenceLiveRuntimeRecord } from "../src/referenceMarket/runtimeFile.js";

type Mode = "dryRun" | "liveInternal";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = loadBotSafetyPolicy();
  if (options.mode === "liveInternal") {
    const gate = canPlaceLiveInternalOrders(policy);
    if (!gate.allowed) {
      throw new Error(`Live internal liquidity seeding blocked: ${gate.reason}`);
    }
    if (!options.confirmSeed) {
      throw new Error("--confirmSeed true is required for liveInternal liquidity seeding.");
    }
  }

  const adminApi = createAdminApi(options.baseUrl, options.devAdminUserId);
  const markets = await loadMarkets(adminApi, options);
  const results = [];
  for (const market of markets) {
    try {
      const result = await adminApi.seedAdminReferenceMarketBot(market.id, {
        capitalDollars: Math.min(options.capitalDollars, policy.maxSystemLiquidityPerMarketCents / 100),
        mintDollars: options.mintDollars,
        dryRun: options.mode !== "liveInternal",
        confirmSeed: options.confirmSeed,
      });
      let runtimePath: string | null = null;
      if (options.mode === "liveInternal" && result.botApiToken && result.botUserId && result.botApiCredentialId) {
        runtimePath = await writeReferenceLiveRuntimeRecord(process.cwd(), {
          marketId: result.marketId,
          slug: market.externalSlug,
          botUserId: result.botUserId,
          botUsername: result.botUsername,
          botApiCredentialId: result.botApiCredentialId,
          botApiKeyId: result.botApiKeyId,
          botApiToken: result.botApiToken,
          seededAt: new Date().toISOString(),
          capitalCents: result.capitalCents,
          mintBudgetCents: result.mintBudgetCents,
          cashReserveCents: result.cashReserveCents,
          mintedCompleteSets: result.mintedCompleteSets,
        });
      }
      results.push({
        marketId: market.id,
        title: market.title,
        externalSlug: market.externalSlug,
        ok: true,
        dryRun: result.dryRun,
        alreadySeeded: result.alreadySeeded,
        seeded: result.seeded,
        capitalCents: result.capitalCents,
        mintBudgetCents: result.mintBudgetCents,
        runtimePath,
      });
    } catch (error) {
      results.push({
        marketId: market.id,
        title: market.title,
        externalSlug: market.externalSlug,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details: error instanceof PolyApiError ? error.details : null,
      });
    }
  }
  console.log(JSON.stringify({
    ok: results.every((item) => item.ok),
    mode: options.mode,
    checked: markets.length,
    seeded: results.filter((item) => item.ok && item.seeded).length,
    failed: results.filter((item) => !item.ok).length,
    allocatedCents: results.reduce((total, item) => total + (item.ok ? item.capitalCents : 0), 0),
    results,
  }, null, 2));
}

async function loadMarkets(api: ApiClient, options: ReturnType<typeof parseArgs>): Promise<AdminReferenceMarketItem[]> {
  const response = await api.listAdminReferenceMarkets({ source: "polymarket", search: options.search ?? undefined });
  return response.items
    .filter((market) => !options.marketId || market.id === options.marketId)
    .filter((market) => !options.slug || market.externalSlug === options.slug)
    .filter((market) => market.importStatus === "approved")
    .filter((market) => market.tradable === true || market.mmEnabled === true)
    .slice(0, options.maxMarkets);
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
    mode: modeArg(args.get("mode")),
    marketId: stringArg(args.get("marketId")),
    slug: stringArg(args.get("slug")),
    search: stringArg(args.get("search")),
    maxMarkets: intArg(args.get("maxMarkets"), 5),
    capitalDollars: numberArg(args.get("capitalDollars"), 1000),
    mintDollars: numberArg(args.get("mintDollars"), 200),
    confirmSeed: args.get("confirmSeed") === "true",
    baseUrl: stringArg(args.get("baseUrl")) ?? process.env.POLY_BOT_BASE_URL ?? "http://127.0.0.1:3001",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
  };
}

function modeArg(value: string | undefined): Mode {
  return value === "liveInternal" ? "liveInternal" : "dryRun";
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error("Market liquidity seeding failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

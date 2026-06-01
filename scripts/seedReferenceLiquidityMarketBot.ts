import { ApiClient } from "../src/api/apiClient.js";
import { AdminReferenceMarketItem } from "../src/api/types.js";
import { writeReferenceLiveRuntimeRecord } from "../src/referenceMarket/runtimeFile.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adminApi = createAdminApi(options.baseUrl, options.devAdminUserId);
  const market = await loadTargetMarket(adminApi, options.marketId, options.slug);
  const result = await adminApi.seedAdminReferenceMarketBot(market.id, {
    capitalDollars: options.capitalDollars,
    mintDollars: options.mintDollars,
    dryRun: options.dryRun,
    confirmSeed: options.confirmSeed,
  });

  let runtimePath: string | null = null;
  if (!options.dryRun && result.botApiToken && result.botUserId && result.botApiCredentialId) {
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

  console.log(JSON.stringify({ ...result, runtimePath }, null, 2));
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
    capitalDollars: numberArg(args.get("capitalDollars"), 1000),
    mintDollars: numberArg(args.get("mintDollars"), 200),
    dryRun: boolArg(args.get("dryRun"), true),
    confirmSeed: boolArg(args.get("confirmSeed"), false),
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
  };
}

function boolArg(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "true";
}

function numberArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

main().catch((error) => {
  console.error("Reference liquidity market seeding failed.");
  console.error(error);
  process.exitCode = 1;
});

import { createAdminApi, loadEventReferenceMarkets, parseAllowlist, boolArg, numberArg, stringArg, intArg } from "../src/referenceMarket/eventAdmin.js";
import { writeReferenceLiveRuntimeRecord } from "../src/referenceMarket/runtimeFile.js";

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
    try {
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
      results.push({
        marketId: market.id,
        slug: market.externalSlug,
        title: market.title,
        importStatus: market.importStatus,
        mmEnabled: market.mmEnabled,
        tradable: market.tradable,
        ok: true,
        runtimePath,
        result,
      });
    } catch (error) {
      results.push({
        marketId: market.id,
        slug: market.externalSlug,
        title: market.title,
        importStatus: market.importStatus,
        mmEnabled: market.mmEnabled,
        tradable: market.tradable,
        ok: false,
        error: error instanceof Error ? error.message : "Seed failed",
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: options.dryRun,
    eventSlug: options.eventSlug,
    marketCount: markets.length,
    seededOrChecked: results.filter((entry) => entry.ok).length,
    blocked: results.filter((entry) => !entry.ok).length,
    results,
  }, null, 2));
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
    capitalDollars: numberArg(args.get("capitalDollars"), 1000),
    mintDollars: numberArg(args.get("mintDollars"), 200),
    dryRun: boolArg(args.get("dryRun"), true),
    confirmSeed: boolArg(args.get("confirmSeed"), false),
    maxMarkets: intArg(args.get("maxMarkets"), 0) || null,
    allowlist: parseAllowlist(stringArg(args.get("allowlist"))),
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
  };
}

main().catch((error) => {
  console.error("Reference event preparation failed.");
  console.error(error);
  process.exitCode = 1;
});

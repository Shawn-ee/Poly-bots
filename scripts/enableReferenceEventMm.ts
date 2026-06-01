import { createAdminApi, loadEventReferenceMarkets, parseAllowlist, boolArg, stringArg, intArg } from "../src/referenceMarket/eventAdmin.js";

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
    await adminApi.refreshAdminReferenceMarketSnapshot(market.id);
    const reference = await adminApi.getMarketReferencePlan(market.id);
    const primary = reference.outcomes.find((item) => item.outcomeName.trim().toUpperCase() === "YES") ?? reference.outcomes[0] ?? null;
    const safe =
      market.importStatus === "approved" &&
      market.isListed &&
      Boolean(primary?.hasSnapshot) &&
      Boolean(primary?.isFresh) &&
      primary?.gammaSpread != null &&
      primary.gammaSpread <= 0.1 &&
      primary.acceptingOrders;

    let updated = null;
    if (!options.dryRun && options.confirmEnable && safe) {
      updated = await adminApi.updateAdminReferenceMarket(market.id, { mmEnabled: true });
    }

    results.push({
      marketId: market.id,
      slug: market.externalSlug,
      title: market.title,
      safe,
      reason: safe ? null : primary?.reason ?? "reference_not_ready",
      updated,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: options.dryRun,
    eventSlug: options.eventSlug,
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
    dryRun: boolArg(args.get("dryRun"), true),
    confirmEnable: boolArg(args.get("confirmEnable"), false),
    maxMarkets: intArg(args.get("maxMarkets"), 0) || null,
    allowlist: parseAllowlist(stringArg(args.get("allowlist"))),
    baseUrl: stringArg(args.get("baseUrl")) ?? "http://127.0.0.1:3000",
    devAdminUserId: stringArg(args.get("devAdminUserId")) ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null,
  };
}

main().catch((error) => {
  console.error("Reference event MM enablement failed.");
  console.error(error);
  process.exitCode = 1;
});

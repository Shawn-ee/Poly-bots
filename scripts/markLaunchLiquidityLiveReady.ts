import { createAdminApi } from "../src/referenceMarket/eventAdmin.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adminApi = createAdminApi(args.baseUrl, args.devAdminUserId ?? process.env.POLY_DEV_ADMIN_USER_ID ?? null);
  const markets = (await adminApi.listAdminReferenceMarkets({ source: "polymarket", importStatus: "approved" }))
    .items
    .filter((market) => market.mmEnabled && market.tradable)
    .slice(0, args.maxMarkets);

  const results = [];
  for (const market of markets) {
    const previousStatus = market.botInitialization?.status ?? "not_started";
    let dryRunAction: boolean | null = null;
    let liveReadyAction = false;
    let liveReadyError: string | null = null;

    if (previousStatus === "dry_run_ready") {
      try {
        await adminApi.updateAdminReferenceMarket(market.id, { action: "mark_dry_run_running" } as never);
        dryRunAction = true;
      } catch {
        dryRunAction = false;
      }
    }

    try {
      await adminApi.updateAdminReferenceMarket(market.id, { action: "mark_live_ready" } as never);
      liveReadyAction = true;
    } catch (error) {
      liveReadyError = error instanceof Error ? error.message : String(error);
    }

    results.push({
      id: market.id,
      title: market.title,
      previousStatus,
      dryRunAction,
      liveReadyAction,
      liveReadyError,
    });
  }

  process.stdout.write(`${JSON.stringify({ checked: markets.length, results }, null, 2)}\n`);
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
    baseUrl: args.get("baseUrl") ?? "http://127.0.0.1:3001",
    devAdminUserId: args.get("devAdminUserId") ?? null,
    maxMarkets: Number.parseInt(args.get("maxMarkets") ?? "9", 10) || 9,
  };
}

main().catch((error) => {
  console.error("Failed to mark launch liquidity live-ready.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

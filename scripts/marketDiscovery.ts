import path from "node:path";
import { runMarketDiscovery } from "../src/referenceMarket/marketDiscovery.js";
import { DiscoveryVertical, MarketDiscoveryOptions } from "../src/referenceMarket/types.js";

async function main() {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv[0]);
  const options = parseOptions(argv);

  if (mode === "watch") {
    console.log("Market discovery watch started.");
    console.log(`dryRun=${options.dryRun} enabled=${options.enabled} intervalMs=${intervalMs()}`);
    while (true) {
      await runOnce(options);
      await sleep(intervalMs());
    }
  }

  await runOnce(options);
}

async function runOnce(options: MarketDiscoveryOptions) {
  const result = await runMarketDiscovery(options);
  console.log("");
  console.log(`Market discovery completed at ${result.fetchedAt}`);
  console.log(`Enabled: ${result.enabled}`);
  console.log(`Dry run: ${result.dryRun}`);
  console.log(`Allowed verticals: ${result.allowedVerticals.join(",")}`);
  console.log(`Fetched: ${result.totalFetched}`);
  console.log(`Accepted: ${result.totalAccepted}`);
  console.log(`Rejected: ${result.totalRejected}`);
  console.log(`Imported count cap: ${result.currentImportedCount}/${result.maxImportedMarkets}`);
  console.log(`Output: ${result.outputPath}`);
  console.log("");
  console.table(
    result.candidates.slice(0, 25).map((item) => ({
      score: item.score,
      vertical: item.vertical,
      accepted: item.accepted,
      reason: item.rejectedReason ?? "",
      quality: item.qualityStatus,
      liquidity: item.candidate.liquidity ?? "",
      volume: item.candidate.volume ?? "",
      spread: item.candidate.spread ?? "",
      title: item.candidate.question.length > 72
        ? `${item.candidate.question.slice(0, 69)}...`
        : item.candidate.question,
      url: item.sourceUrl,
      draft: item.draftCreationStatus,
    })),
  );
}

function parseMode(value: string | undefined) {
  if (value === "once" || value === "watch" || value === "dry-run") {
    return value;
  }
  return "dry-run";
}

function parseOptions(argv: string[]): MarketDiscoveryOptions {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }

  const cwd = process.cwd();
  return {
    enabled: boolValue(args.get("enabled"), envBool("POLYMARKET_DISCOVERY_ENABLED", false)),
    dryRun: boolValue(args.get("dry-run"), envBool("POLYMARKET_DISCOVERY_DRY_RUN", true)),
    topN: intValue(args.get("top-n"), envInt("POLYMARKET_DISCOVERY_TOP_N", 10)),
    maxImportedMarkets: intValue(args.get("max-imported-markets"), envInt("MAX_IMPORTED_MARKETS", 300)),
    maxNewImportsPerRun: intValue(args.get("max-new-imports"), envInt("MAX_NEW_IMPORTS_PER_RUN", 10)),
    allowedVerticals: verticalsValue(args.get("allowed-verticals") ?? process.env.DISCOVERY_ALLOWED_VERTICALS),
    minReferenceLiquidity: optionalNumber(args.get("min-liquidity") ?? process.env.MIN_REFERENCE_LIQUIDITY),
    minReferenceVolume: optionalNumber(args.get("min-volume") ?? process.env.MIN_REFERENCE_VOLUME),
    maxReferenceSpread: numberValue(args.get("max-spread"), envNumber("MAX_REFERENCE_SPREAD", 0.1)),
    outputPath: path.resolve(cwd, args.get("output") ?? "test-logs/market-discovery.json"),
    mappingPath: path.resolve(cwd, args.get("mapping") ?? "reference-mappings/polymarket-discovery.json"),
    baseUrl: process.env.POLY_BOT_BASE_URL ?? "http://127.0.0.1:3001",
    adminSessionCookie: process.env.POLY_SIM_SESSION_COOKIE ?? null,
    createDrafts: boolValue(args.get("create-drafts"), false),
    createEvents: boolValue(args.get("create-events"), true),
  };
}

function verticalsValue(value: string | undefined): DiscoveryVertical[] {
  const parsed = (value ?? "nba,world_cup")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const verticals = parsed.filter((item): item is DiscoveryVertical => item === "nba" || item === "world_cup");
  return verticals.length > 0 ? verticals : ["nba", "world_cup"];
}

function intervalMs() {
  return envInt("POLYMARKET_DISCOVERY_INTERVAL_MS", 1_800_000);
}

function envBool(name: string, fallback: boolean) {
  return boolValue(process.env[name], fallback);
}

function envInt(name: string, fallback: number) {
  return intValue(process.env[name], fallback);
}

function envNumber(name: string, fallback: number) {
  return numberValue(process.env[name], fallback);
}

function boolValue(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function intValue(value: string | undefined, fallback: number) {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function numberValue(value: string | undefined, fallback: number) {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: string | undefined) {
  if (value == null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("Market discovery failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

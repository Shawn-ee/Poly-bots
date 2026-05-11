import path from "node:path";
import { importPolymarketWorldCupMarkets } from "../src/referenceMarket/importWorldCupMarkets.js";
import { ImportWorldCupOptions } from "../src/referenceMarket/types.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.slug) {
    throw new Error("Single-market import requires --slug.");
  }

  const result = await importPolymarketWorldCupMarkets(options);
  const snapshot = result.snapshots[0] ?? null;

  console.log("");
  console.log(`Polymarket single-market import completed at ${result.fetchedAt}`);
  console.log(`Candidates selected: ${result.totalCandidatesSelected}`);
  console.log(`Output: ${result.outputPath}`);
  console.log(`Mappings: ${result.mappingPath}`);
  console.log("");

  if (snapshot) {
    console.table(
      snapshot.quotes.map((quote) => ({
        outcome: quote.outcome,
        tokenId: quote.tokenId,
        bestBid: quote.bestBid ?? "n/a",
        bestAsk: quote.bestAsk ?? "n/a",
        midpoint: quote.midpoint ?? "n/a",
        spread: quote.spread ?? "n/a",
      })),
    );
  }

  if (result.createLocalMarkets) {
    console.log("");
    console.table(result.localMarketsCreated);
  }
}

function parseArgs(argv: string[]): ImportWorldCupOptions {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }

  const slug = stringArg(args.get("slug"));
  const cwd = process.cwd();
  const safeSlug = slug ? slug.replace(/[^a-z0-9-]/gi, "-") : "market";
  const defaultOutput = path.resolve(cwd, `../Poly/test-logs/polymarket-market-import-${safeSlug}.json`);
  const defaultMapping = path.resolve(cwd, "reference-mappings/polymarket-worldcup.json");

  return {
    limit: intArg(args.get("limit"), 1),
    dryRun: boolArg(args.get("dry-run"), true),
    createLocalMarkets: boolArg(args.get("create-local-markets"), false),
    createEvents: boolArg(args.get("create-events"), true),
    status: statusArg(args.get("status")),
    query: null,
    slug,
    outputPath: path.resolve(cwd, args.get("output") ?? defaultOutput),
    mappingPath: path.resolve(cwd, args.get("mapping") ?? defaultMapping),
    baseUrl: process.env.POLY_BOT_BASE_URL ?? "http://127.0.0.1:3000",
    adminSessionCookie: process.env.POLY_SIM_SESSION_COOKIE ?? null,
  };
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolArg(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function statusArg(value: string | undefined): "draft" | "paused" | "live" {
  if (value === "live") {
    return "live";
  }
  if (value === "paused") {
    return "paused";
  }
  return "draft";
}

main().catch((error) => {
  console.error("Polymarket single-market import failed.");
  console.error(error);
  process.exitCode = 1;
});

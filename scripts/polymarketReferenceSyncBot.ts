import { PolymarketGammaClient } from "../src/referenceMarket/polymarketGammaClient.js";
import { ReferencePriceCache } from "../src/referenceMarket/referencePriceCache.js";
import { buildDryRunMappingsForCandidate } from "../src/referenceMarket/referenceMapping.js";
import { ReferencePriceUpdater } from "../src/referenceMarket/referencePriceUpdater.js";
import { sleep } from "../src/utils/sleep.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.slug) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      skipped: true,
      reason: "provide --slug <polymarket-slug> to sync a public reference market",
    }, null, 2));
    return;
  }

  const gamma = new PolymarketGammaClient();
  const candidate = await gamma.getMarketBySlug(options.slug);
  if (!candidate) throw new Error(`Polymarket market not found for slug: ${options.slug}`);

  const mappings = buildDryRunMappingsForCandidate(candidate, {
    enabled: true,
    mmEnabled: false,
    reviewStatus: "synthetic",
  });
  const cache = new ReferencePriceCache();
  const updater = new ReferencePriceUpdater({
    cache,
    gamma,
    mappings,
    pollIntervalMs: options.pollMs,
    dryRunOverrideMmEligible: true,
  });

  const cycles = options.loop ? Math.max(1, options.cycles) : 1;
  for (let index = 0; index < cycles; index += 1) {
    await updater.pollOnce();
    if (index + 1 < cycles) await sleep(options.pollMs);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    source: "polymarket",
    slug: options.slug,
    quotes: cache.getMarketQuotes(mappings[0]?.localMarketId ?? "").map((quote) => ({
      outcome: quote.polymarketOutcome,
      tokenId: quote.polymarketTokenId,
      bestBid: quote.gammaBestBid,
      bestAsk: quote.gammaBestAsk,
      midpoint: quote.displayProbability,
      qualityStatus: quote.qualityStatus,
      mmEligible: quote.mmEligible,
      reason: quote.reason,
      fetchedAt: quote.fetchedAt,
    })),
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
    slug: stringArg(args.get("slug")),
    loop: args.get("loop") === "true",
    cycles: intArg(args.get("cycles"), 1),
    pollMs: intArg(args.get("pollMs"), 5000),
  };
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

main().catch((error) => {
  console.error("Polymarket reference sync bot failed.");
  console.error(error);
  process.exitCode = 1;
});

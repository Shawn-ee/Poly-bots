import assert from "node:assert/strict";
import { PolymarketGammaClient } from "../src/referenceMarket/polymarketGammaClient.js";
import { ReferencePriceCache } from "../src/referenceMarket/referencePriceCache.js";
import { buildDryRunMappingsForCandidate } from "../src/referenceMarket/referenceMapping.js";
import { ReferencePriceUpdater } from "../src/referenceMarket/referencePriceUpdater.js";
import { sleep } from "../src/utils/sleep.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assert(options.slug, "Provide --slug <polymarket-slug>.");

  const gamma = new PolymarketGammaClient();
  const candidate = await gamma.getMarketBySlug(options.slug);
  if (!candidate) {
    throw new Error(`Polymarket market not found for slug: ${options.slug}`);
  }

  const mappings = buildDryRunMappingsForCandidate(candidate, {
    mmEnabled: false,
    enabled: true,
    reviewStatus: "synthetic",
  });
  const cache = new ReferencePriceCache();
  const updater = new ReferencePriceUpdater({
    cache,
    gamma,
    mappings,
    pollIntervalMs: options.pollIntervalMs,
    dryRunOverrideMmEligible: true,
  });

  const deadline = Date.now() + options.durationSeconds * 1000;
  while (Date.now() < deadline) {
    await updater.pollOnce();
    printQuotes(cache, mappings[0]?.localMarketId ?? "");
    if (Date.now() + options.pollIntervalMs >= deadline) {
      break;
    }
    await sleep(options.pollIntervalMs);
  }
}

function printQuotes(cache: ReferencePriceCache, localMarketId: string) {
  const quotes = cache.getMarketQuotes(localMarketId);
  for (const quote of quotes) {
    console.log(
      JSON.stringify(
        {
          slug: quote.polymarketSlug,
          outcome: quote.polymarketOutcome,
          outcomePrice: quote.gammaOutcomePrice,
          bestBid: quote.gammaBestBid,
          bestAsk: quote.gammaBestAsk,
          spread: quote.spread,
          lastTradePrice: quote.lastTradePrice,
          isFresh: quote.isFresh,
          qualityStatus: quote.qualityStatus,
          mmEligible: quote.mmEligible,
          reason: quote.reason,
        },
        null,
        2,
      ),
    );
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    args.set(part.slice(2), next && !next.startsWith("--") ? next : "true");
  }

  return {
    slug: stringArg(args.get("slug")),
    durationSeconds: intArg(args.get("durationSeconds"), 60),
    pollIntervalMs: intArg(args.get("pollIntervalMs"), 5000),
  };
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

main().catch((error) => {
  console.error("Reference cache dry-run failed.");
  console.error(error);
  process.exitCode = 1;
});

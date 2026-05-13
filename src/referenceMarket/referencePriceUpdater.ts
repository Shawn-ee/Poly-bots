import { PolymarketGammaClient } from "./polymarketGammaClient.js";
import { ReferencePriceCache } from "./referencePriceCache.js";
import { buildReferencePriceQuote } from "./referenceQuality.js";
import { ReferenceMarketMapping } from "./types.js";

export class ReferencePriceUpdater {
  private mappings: ReferenceMarketMapping[];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      cache: ReferencePriceCache;
      gamma?: PolymarketGammaClient;
      mappings: ReferenceMarketMapping[];
      pollIntervalMs?: number;
      staleTimeoutMs?: number;
      dryRunOverrideMmEligible?: boolean;
      logger?: Pick<Console, "warn" | "error">;
      now?: () => number;
    },
  ) {
    this.mappings = options.mappings;
  }

  start() {
    if (this.timer) {
      return;
    }
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.options.pollIntervalMs ?? 5_000);
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  setMappings(mappings: ReferenceMarketMapping[]) {
    this.mappings = mappings;
  }

  async pollOnce() {
    const gamma = this.options.gamma ?? new PolymarketGammaClient();
    const groups = groupMappingsByMarket(this.mappings);
    const fetchedAt = new Date((this.options.now ?? Date.now)()).toISOString();

    for (const group of groups) {
      try {
        const candidate = group.slug
          ? await gamma.getMarketBySlug(group.slug)
          : null;
        if (!candidate) {
          this.markGroupUnavailable(group.mappings, fetchedAt);
          continue;
        }

        for (const mapping of group.mappings) {
          const matchedOutcome = candidate.outcomes.find(
            (outcome) =>
              outcome.tokenId === mapping.polymarketTokenId ||
              outcome.label.toLowerCase() === mapping.polymarketOutcome.toLowerCase(),
          );
          const receivedAt = new Date((this.options.now ?? Date.now)()).toISOString();
          const quote = buildReferencePriceQuote(
            {
              localMarketId: mapping.localMarketId,
              localOutcomeId: mapping.localOutcomeId,
              polymarketMarketId: mapping.polymarketMarketId,
              conditionId: mapping.conditionId,
              polymarketSlug: mapping.polymarketSlug,
              polymarketOutcome: mapping.polymarketOutcome,
              polymarketTokenId: mapping.polymarketTokenId,
              gammaOutcomePrice: matchedOutcome?.outcomePrice ?? null,
              gammaBestBid: candidate.bestBid,
              gammaBestAsk: candidate.bestAsk,
              gammaSpread: candidate.spread,
              lastTradePrice: candidate.lastTradePrice,
              volume: candidate.volume,
              volume24hr: candidate.volume24hr,
              liquidity: candidate.liquidity,
              liquidityClob: candidate.liquidityClob,
              acceptingOrders: candidate.acceptingOrders,
              competitive: candidate.competitive,
              updatedAt: candidate.updatedAt,
              fetchedAt,
              receivedAt,
            },
            mapping,
            buildQuoteOptions(this.options),
          );
          this.options.cache.setQuote(
            { localMarketId: mapping.localMarketId, localOutcomeId: mapping.localOutcomeId },
            quote,
          );
        }
      } catch (error) {
        this.options.logger?.warn?.(
          `ReferencePriceUpdater poll failed for ${group.slug ?? group.polymarketMarketId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.markGroupUnavailable(group.mappings, fetchedAt);
      }
    }

    this.options.cache.markStale();
  }

  private markGroupUnavailable(mappings: ReferenceMarketMapping[], fetchedAt: string) {
    for (const mapping of mappings) {
      const existing = this.options.cache.getQuote(mapping.localMarketId, mapping.localOutcomeId);
      if (!existing) {
        continue;
      }
      this.options.cache.setQuote(
        { localMarketId: mapping.localMarketId, localOutcomeId: mapping.localOutcomeId },
        {
          ...existing,
          fetchedAt,
          receivedAt: existing.receivedAt,
          isFresh: false,
          isStale: true,
          mmEligible: false,
          qualityStatus: "stale",
          reason: "reference_stale",
        },
      );
    }
  }
}

function buildQuoteOptions(options: {
  staleTimeoutMs?: number;
  dryRunOverrideMmEligible?: boolean;
  now?: () => number;
}) {
  const built: {
    staleTimeoutMs?: number;
    dryRunOverrideMmEligible?: boolean;
    now: number;
  } = {
    now: (options.now ?? Date.now)(),
  };
  if (options.staleTimeoutMs != null) {
    built.staleTimeoutMs = options.staleTimeoutMs;
  }
  if (options.dryRunOverrideMmEligible != null) {
    built.dryRunOverrideMmEligible = options.dryRunOverrideMmEligible;
  }
  return built;
}

function groupMappingsByMarket(mappings: ReferenceMarketMapping[]) {
  const groups = new Map<string, { slug: string | null; polymarketMarketId: string; mappings: ReferenceMarketMapping[] }>();
  for (const mapping of mappings) {
    const key = mapping.polymarketSlug ?? mapping.polymarketMarketId;
    const current = groups.get(key);
    if (current) {
      current.mappings.push(mapping);
      continue;
    }
    groups.set(key, {
      slug: mapping.polymarketSlug,
      polymarketMarketId: mapping.polymarketMarketId,
      mappings: [mapping],
    });
  }
  return Array.from(groups.values());
}

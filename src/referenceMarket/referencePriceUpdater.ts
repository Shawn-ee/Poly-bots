import { BotLogger } from "../logging/logger.js";
import { sleep } from "../utils/sleep.js";
import { LocalReferenceMarket } from "./localReferenceMarkets.js";
import { PolymarketGammaClient } from "./polymarketGammaClient.js";
import { ReferencePriceCache } from "./referencePriceCache.js";

export class ReferencePriceUpdater {
  private markets: LocalReferenceMarket[] = [];

  constructor(
    private readonly gammaClient: PolymarketGammaClient,
    private readonly cache: ReferencePriceCache,
    private readonly logger: BotLogger,
    private readonly pollMs: number,
  ) {}

  setMarkets(markets: LocalReferenceMarket[]) {
    this.markets = [...markets];
  }

  async start(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.refreshOnce();
      await sleep(this.pollMs, signal).catch(() => undefined);
    }
  }

  async refreshOnce() {
    const trackable = this.markets.filter(
      (market) =>
        market.referenceSource === "polymarket" &&
        market.importStatus === "approved" &&
        typeof market.externalSlug === "string" &&
        market.externalSlug.length > 0,
    );
    const bySlug = new Map<string, LocalReferenceMarket[]>();
    for (const market of trackable) {
      const slug = market.externalSlug!;
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), market]);
    }

    for (const [slug, slugMarkets] of bySlug.entries()) {
      try {
        const candidate = await this.gammaClient.getMarketBySlug(slug);
        if (!candidate) {
          this.logger.warn("reference_price_missing_market", {
            slug,
            localMarketIds: slugMarkets.map((market) => market.id),
          });
          continue;
        }

        const receivedAt = new Date().toISOString();
        for (const market of slugMarkets) {
          this.cache.updateMarket(market, candidate, receivedAt);
        }

        this.logger.info("reference_price_refresh", {
          slug,
          localMarketIds: slugMarkets.map((market) => market.id),
          bestBid: candidate.bestBid,
          bestAsk: candidate.bestAsk,
          spread: candidate.spread,
          volume24hr: candidate.volume24hr,
          liquidity: candidate.liquidity,
          updatedAt:
            candidate.raw && typeof candidate.raw === "object"
              ? ((candidate.raw as Record<string, unknown>).updatedAt ?? null)
              : null,
        });
      } catch (error) {
        for (const market of slugMarkets) {
          this.cache.noteMarketPollError(market.id, error);
        }
        this.logger.warn("reference_price_refresh_failed", {
          slug,
          localMarketIds: slugMarkets.map((market) => market.id),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

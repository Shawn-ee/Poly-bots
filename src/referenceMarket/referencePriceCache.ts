import { ReferencePriceQuote, ReferenceQualityStatus, ReferenceSource } from "./types.js";

export class ReferencePriceCache {
  private readonly quotes = new Map<string, ReferencePriceQuote>();

  constructor(
    private readonly staleTimeoutMs = 15_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setQuote(key: { localMarketId: string; localOutcomeId: string }, quote: ReferencePriceQuote) {
    this.quotes.set(this.cacheKey(key.localMarketId, key.localOutcomeId), quote);
  }

  getQuote(localMarketId: string, localOutcomeId: string): ReferencePriceQuote | null {
    const quote = this.quotes.get(this.cacheKey(localMarketId, localOutcomeId)) ?? null;
    return quote ? this.withFreshness(quote) : null;
  }

  getMarketQuotes(localMarketId: string): ReferencePriceQuote[] {
    return Array.from(this.quotes.values())
      .filter((quote) => quote.localMarketId === localMarketId)
      .map((quote) => this.withFreshness(quote));
  }

  getQuotesBySource(source: ReferenceSource): ReferencePriceQuote[] {
    return Array.from(this.quotes.values())
      .filter((quote) => quote.source === source)
      .map((quote) => this.withFreshness(quote));
  }

  markStale() {
    for (const [key, quote] of this.quotes.entries()) {
      this.quotes.set(key, this.withFreshness(quote));
    }
  }

  isFresh(localMarketId: string, localOutcomeId: string) {
    return this.getQuote(localMarketId, localOutcomeId)?.isFresh ?? false;
  }

  getQualityStatus(localMarketId: string, localOutcomeId: string): ReferenceQualityStatus | null {
    return this.getQuote(localMarketId, localOutcomeId)?.qualityStatus ?? null;
  }

  clear() {
    this.quotes.clear();
  }

  private withFreshness(quote: ReferencePriceQuote): ReferencePriceQuote {
    const freshnessTime = Date.parse(quote.receivedAt);
    if (!Number.isFinite(freshnessTime)) {
      return { ...quote, isFresh: false, isStale: true };
    }
    const isFresh = this.now() - freshnessTime <= this.staleTimeoutMs;
    if (quote.isFresh === isFresh && quote.isStale === !isFresh) {
      return quote;
    }
    return {
      ...quote,
      isFresh,
      isStale: !isFresh,
    };
  }

  private cacheKey(localMarketId: string, localOutcomeId: string) {
    return `${localMarketId}:${localOutcomeId}`;
  }
}

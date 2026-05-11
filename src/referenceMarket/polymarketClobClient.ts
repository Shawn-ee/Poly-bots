import { ReferenceQuote } from "./types.js";

type BookLevel = {
  price?: string | number;
};

type BookResponse = {
  bids?: BookLevel[];
  asks?: BookLevel[];
};

const DEFAULT_CLOB_BASE_URL = "https://clob.polymarket.com";

export class PolymarketClobClient {
  constructor(
    private readonly baseUrl: string = DEFAULT_CLOB_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getReferenceQuote(tokenId: string, outcome: string): Promise<ReferenceQuote> {
    const receivedAt = new Date().toISOString();

    const [bookResult, buyPriceResult, sellPriceResult, midpointResult] = await Promise.allSettled([
      this.getJson<BookResponse>(`/book?token_id=${encodeURIComponent(tokenId)}`),
      this.getJson<{ price?: number | string }>(`/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`),
      this.getJson<{ price?: number | string }>(`/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`),
      this.getJson<{ mid_price?: number | string }>(`/midpoint?token_id=${encodeURIComponent(tokenId)}`),
    ]);

    const book = bookResult.status === "fulfilled" ? bookResult.value : null;
    const bestBid =
      firstFinitePrice(book?.bids) ??
      (buyPriceResult.status === "fulfilled" ? normalizePrice(buyPriceResult.value.price ?? null) : null);
    const bestAsk =
      firstFinitePrice(book?.asks) ??
      (sellPriceResult.status === "fulfilled" ? normalizePrice(sellPriceResult.value.price ?? null) : null);
    const midpoint =
      (midpointResult.status === "fulfilled"
        ? normalizePrice(midpointResult.value.mid_price ?? null)
        : null) ??
      (bestBid != null && bestAsk != null ? roundPrice((bestBid + bestAsk) / 2) : null);
    const spread = bestBid != null && bestAsk != null ? roundPrice(bestAsk - bestBid) : null;
    const isAvailable = bestBid != null || bestAsk != null || midpoint != null;

    return {
      source: "polymarket",
      tokenId,
      outcome,
      bestBid,
      bestAsk,
      midpoint,
      spread,
      receivedAt,
      isAvailable,
      isStale: !isAvailable,
      raw: {
        book: bookResult.status === "fulfilled" ? bookResult.value : { error: settledReason(bookResult) },
        buyPrice: buyPriceResult.status === "fulfilled" ? buyPriceResult.value : { error: settledReason(buyPriceResult) },
        sellPrice: sellPriceResult.status === "fulfilled" ? sellPriceResult.value : { error: settledReason(sellPriceResult) },
        midpoint: midpointResult.status === "fulfilled" ? midpointResult.value : { error: settledReason(midpointResult) },
      },
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await this.fetchImpl(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (response.status === 404) {
      return {} as T;
    }
    if (!response.ok) {
      throw new Error(`CLOB request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }
}

function settledReason(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") {
    return "ok";
  }
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function firstFinitePrice(levels: BookLevel[] | undefined): number | null {
  if (!levels || levels.length === 0) {
    return null;
  }
  return normalizePrice(levels[0]?.price ?? null);
}

function normalizePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 && value <= 1 ? roundPrice(value) : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? roundPrice(parsed) : null;
  }
  return null;
}

function roundPrice(value: number) {
  return Number(value.toFixed(6));
}


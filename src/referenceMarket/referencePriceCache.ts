import { LocalReferenceMarket, normalizeOutcomeLabel } from "./localReferenceMarkets.js";
import { ReferenceMarketCandidate } from "./types.js";

export type ReferenceQuoteQualityReason =
  | "ok"
  | "missing_quote"
  | "reference_stale"
  | "reference_missing_book"
  | "reference_spread_too_wide"
  | "reference_bad_price_range"
  | "reference_accepting_orders_false"
  | "reference_liquidity_too_low"
  | "reference_volume_too_low"
  | "reference_outcome_unsupported";

export type CachedReferenceQuote = {
  localMarketId: string;
  outcomeId: string;
  outcomeName: string;
  referenceOutcomeLabel: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  midpoint: string | null;
  spread: string | null;
  lastTradePrice: string | null;
  outcomePrice: string | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  liquidityClob: number | null;
  acceptingOrders: boolean;
  competitive: boolean | null;
  sourceUpdatedAt: string | null;
  receivedAt: string;
  isComplementDerived: boolean;
};

export type ReferenceQualityStatus = {
  eligible: boolean;
  fresh: boolean;
  reason: ReferenceQuoteQualityReason;
  quote: CachedReferenceQuote | null;
};

type CachedMarketQuotes = {
  localMarketId: string;
  marketTitle: string;
  quotes: Map<string, CachedReferenceQuote>;
  lastUpdatedAt: string | null;
  lastError: string | null;
};

type QualityOptions = {
  staleMs?: number;
  minReferenceSpread?: number;
  maxReferenceSpread?: number;
  minReferenceLiquidity?: number | null;
  minVolume24hr?: number | null;
};

export class ReferencePriceCache {
  private readonly markets = new Map<string, CachedMarketQuotes>();

  constructor(private readonly defaultStaleMs: number = 15_000) {}

  updateMarket(
    market: LocalReferenceMarket,
    candidate: ReferenceMarketCandidate,
    receivedAt: string,
  ) {
    const quotes = new Map<string, CachedReferenceQuote>();
    for (const outcome of market.outcomes) {
      const next = buildOutcomeQuote(market, outcome, candidate, receivedAt);
      if (next) {
        quotes.set(outcome.id, next);
      }
    }

    const existing = this.markets.get(market.id);
    this.markets.set(market.id, {
      localMarketId: market.id,
      marketTitle: market.title,
      quotes,
      lastUpdatedAt: receivedAt,
      lastError: existing?.lastError ?? null,
    });
  }

  noteMarketPollError(localMarketId: string, error: unknown) {
    const entry = this.markets.get(localMarketId);
    if (!entry) {
      return;
    }
    entry.lastError = error instanceof Error ? error.message : String(error);
  }

  getQuote(localMarketId: string, outcomeId: string): CachedReferenceQuote | null {
    return this.markets.get(localMarketId)?.quotes.get(outcomeId) ?? null;
  }

  getMarketQuotes(localMarketId: string): CachedReferenceQuote[] {
    return Array.from(this.markets.get(localMarketId)?.quotes.values() ?? []);
  }

  isFresh(localMarketId: string, outcomeId: string, staleMs: number = this.defaultStaleMs): boolean {
    const quote = this.getQuote(localMarketId, outcomeId);
    if (!quote) {
      return false;
    }
    return Date.now() - Date.parse(quote.receivedAt) <= staleMs;
  }

  getQualityStatus(
    localMarketId: string,
    outcomeId: string,
    options: QualityOptions = {},
  ): ReferenceQualityStatus {
    const quote = this.getQuote(localMarketId, outcomeId);
    if (!quote) {
      return {
        eligible: false,
        fresh: false,
        reason: "missing_quote",
        quote: null,
      };
    }

    const staleMs = options.staleMs ?? this.defaultStaleMs;
    const fresh = this.isFresh(localMarketId, outcomeId, staleMs);
    if (!fresh) {
      return {
        eligible: false,
        fresh: false,
        reason: "reference_stale",
        quote,
      };
    }

    if (!quote.bestBid || !quote.bestAsk) {
      return {
        eligible: false,
        fresh: true,
        reason: "reference_missing_book",
        quote,
      };
    }

    const bestBid = Number(quote.bestBid);
    const bestAsk = Number(quote.bestAsk);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid < 0.01 || bestAsk > 0.99 || bestBid >= bestAsk) {
      return {
        eligible: false,
        fresh: true,
        reason: "reference_bad_price_range",
        quote,
      };
    }

    if (!quote.acceptingOrders) {
      return {
        eligible: false,
        fresh: true,
        reason: "reference_accepting_orders_false",
        quote,
      };
    }

    const spread = Number(quote.spread ?? `${bestAsk - bestBid}`);
    const minSpread = options.minReferenceSpread ?? 0;
    const maxSpread = options.maxReferenceSpread ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(spread) || spread < minSpread || spread > maxSpread) {
      return {
        eligible: false,
        fresh: true,
        reason: "reference_spread_too_wide",
        quote,
      };
    }

    if (
      options.minReferenceLiquidity !== undefined &&
      options.minReferenceLiquidity !== null &&
      (quote.liquidity === null || quote.liquidity < options.minReferenceLiquidity)
    ) {
      return {
        eligible: false,
        fresh: true,
        reason: "reference_liquidity_too_low",
        quote,
      };
    }

    if (
      options.minVolume24hr !== undefined &&
      options.minVolume24hr !== null &&
      (quote.volume24hr === null || quote.volume24hr < options.minVolume24hr)
    ) {
      return {
        eligible: false,
        fresh: true,
        reason: "reference_volume_too_low",
        quote,
      };
    }

    return {
      eligible: true,
      fresh: true,
      reason: "ok",
      quote,
    };
  }
}

function buildOutcomeQuote(
  market: LocalReferenceMarket,
  outcome: LocalReferenceMarket["outcomes"][number],
  candidate: ReferenceMarketCandidate,
  receivedAt: string,
): CachedReferenceQuote | null {
  const normalizedLabel = normalizeOutcomeLabel(outcome.referenceOutcomeLabel ?? outcome.name);
  if (normalizedLabel === "OTHER") {
    return {
      localMarketId: market.id,
      outcomeId: outcome.id,
      outcomeName: outcome.name,
      referenceOutcomeLabel: outcome.referenceOutcomeLabel,
      bestBid: null,
      bestAsk: null,
      midpoint: null,
      spread: null,
      lastTradePrice: null,
      outcomePrice: null,
      volume: candidate.volume,
      volume24hr: candidate.volume24hr,
      liquidity: candidate.liquidity,
      liquidityClob: candidate.liquidityClob,
      acceptingOrders: candidate.acceptingOrders,
      competitive: candidate.competitive,
      sourceUpdatedAt: extractSourceUpdatedAt(candidate.raw),
      receivedAt,
      isComplementDerived: false,
    };
  }

  const yesPrice = candidate.outcomePrices[0] ?? candidate.outcomes[0]?.outcomePrice ?? null;
  const outcomePrice =
    normalizedLabel === "YES"
      ? yesPrice
      : yesPrice === null
        ? null
        : 1 - yesPrice;
  const bestBid =
    normalizedLabel === "YES"
      ? candidate.bestBid
      : candidate.bestAsk === null
        ? null
        : 1 - candidate.bestAsk;
  const bestAsk =
    normalizedLabel === "YES"
      ? candidate.bestAsk
      : candidate.bestBid === null
        ? null
        : 1 - candidate.bestBid;
  const lastTradePrice =
    normalizedLabel === "YES"
      ? candidate.lastTradePrice
      : candidate.lastTradePrice === null
        ? null
        : 1 - candidate.lastTradePrice;
  const midpoint =
    outcomePrice ?? (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null);

  return {
    localMarketId: market.id,
    outcomeId: outcome.id,
    outcomeName: outcome.name,
    referenceOutcomeLabel: outcome.referenceOutcomeLabel,
    bestBid: formatNullablePrice(bestBid),
    bestAsk: formatNullablePrice(bestAsk),
    midpoint: formatNullablePrice(midpoint),
    spread: formatNullablePrice(candidate.spread),
    lastTradePrice: formatNullablePrice(lastTradePrice),
    outcomePrice: formatNullablePrice(outcomePrice),
    volume: candidate.volume,
    volume24hr: candidate.volume24hr,
    liquidity: candidate.liquidity,
    liquidityClob: candidate.liquidityClob,
    acceptingOrders: candidate.acceptingOrders,
    competitive: candidate.competitive,
    sourceUpdatedAt: extractSourceUpdatedAt(candidate.raw),
    receivedAt,
    isComplementDerived: normalizedLabel === "NO",
  };
}

function formatNullablePrice(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return value.toFixed(6);
}

function extractSourceUpdatedAt(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const updatedAt = (raw as Record<string, unknown>).updatedAt;
  return typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null;
}

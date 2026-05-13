import {
  ReferenceIneligibilityReason,
  ReferenceMarketMapping,
  ReferencePriceQuote,
  ReferenceQualityStatus,
} from "./types.js";

export type EvaluateReferenceQuoteInput = {
  localMarketId: string;
  localOutcomeId: string;
  polymarketMarketId: string;
  conditionId: string | null;
  polymarketSlug: string | null;
  polymarketOutcome: string;
  polymarketTokenId: string;
  gammaOutcomePrice: number | null;
  gammaBestBid: number | null;
  gammaBestAsk: number | null;
  gammaSpread: number | null;
  lastTradePrice: number | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  liquidityClob: number | null;
  acceptingOrders: boolean;
  competitive: boolean | null;
  updatedAt: string | null;
  fetchedAt: string;
  receivedAt: string;
};

export function buildReferencePriceQuote(
  input: EvaluateReferenceQuoteInput,
  mapping: ReferenceMarketMapping,
  options: {
    staleTimeoutMs?: number;
    now?: number;
    dryRunOverrideMmEligible?: boolean;
  } = {},
): ReferencePriceQuote {
  const staleTimeoutMs = options.staleTimeoutMs ?? 15_000;
  const now = options.now ?? Date.now();
  const freshnessTime = timestampOf(input.receivedAt) ?? timestampOf(input.fetchedAt) ?? now;
  const isFresh = now - freshnessTime <= staleTimeoutMs;
  const isAvailable =
    input.gammaOutcomePrice != null ||
    input.gammaBestBid != null ||
    input.gammaBestAsk != null ||
    input.lastTradePrice != null;
  const spread = input.gammaSpread ?? computeSpread(input.gammaBestBid, input.gammaBestAsk);
  const reason = determineReason(
    input,
    mapping,
    isFresh,
    spread,
    options.dryRunOverrideMmEligible ?? false,
  );
  const mmEligible = reason == null;
  const qualityStatus = determineQualityStatus(reason, mmEligible, isAvailable);

  return {
    source: "polymarket",
    localMarketId: input.localMarketId,
    localOutcomeId: input.localOutcomeId,
    polymarketMarketId: input.polymarketMarketId,
    conditionId: input.conditionId,
    polymarketSlug: input.polymarketSlug,
    polymarketOutcome: input.polymarketOutcome,
    polymarketTokenId: input.polymarketTokenId,
    gammaOutcomePrice: input.gammaOutcomePrice,
    gammaBestBid: input.gammaBestBid,
    gammaBestAsk: input.gammaBestAsk,
    gammaSpread: input.gammaSpread,
    lastTradePrice: input.lastTradePrice,
    volume: input.volume,
    volume24hr: input.volume24hr,
    liquidity: input.liquidity,
    liquidityClob: input.liquidityClob,
    acceptingOrders: input.acceptingOrders,
    competitive: input.competitive,
    updatedAt: input.updatedAt,
    fetchedAt: input.fetchedAt,
    receivedAt: input.receivedAt,
    displayProbability: input.gammaOutcomePrice,
    executableBid: input.gammaBestBid,
    executableAsk: input.gammaBestAsk,
    spread,
    isFresh,
    isAvailable,
    isStale: !isFresh,
    qualityStatus,
    mmEligible,
    reason,
  };
}

function determineReason(
  input: EvaluateReferenceQuoteInput,
  mapping: ReferenceMarketMapping,
  isFresh: boolean,
  spread: number | null,
  dryRunOverrideMmEligible: boolean,
): ReferenceIneligibilityReason | null {
  if (!isFresh) {
    return "reference_stale";
  }
  if (input.gammaBestBid == null || input.gammaBestAsk == null) {
    return "reference_missing_book";
  }
  if (!isValidExecutablePrice(input.gammaBestBid) || !isValidExecutablePrice(input.gammaBestAsk)) {
    return "reference_invalid_price";
  }
  if (spread == null || spread > 0.1) {
    return "reference_spread_too_wide";
  }
  if (!mapping.enabled) {
    return "reference_not_approved";
  }
  if (!dryRunOverrideMmEligible && mapping.reviewStatus !== "approved") {
    return "reference_not_approved";
  }
  if (!dryRunOverrideMmEligible && !mapping.mmEnabled) {
    return "reference_not_mm_enabled";
  }
  if (!input.acceptingOrders) {
    return "reference_missing_book";
  }
  return null;
}

function determineQualityStatus(
  reason: ReferenceIneligibilityReason | null,
  mmEligible: boolean,
  isAvailable: boolean,
): ReferenceQualityStatus {
  if (mmEligible) {
    return "high_quality";
  }
  if (reason === "reference_stale") {
    return "stale";
  }
  if (reason === "reference_spread_too_wide") {
    return "wide";
  }
  if (reason === "reference_missing_book") {
    return "missing_book";
  }
  if (reason === "reference_invalid_price") {
    return "invalid_price";
  }
  if (reason === "reference_not_approved") {
    return "not_approved";
  }
  if (reason === "reference_not_mm_enabled") {
    return "not_mm_enabled";
  }
  return isAvailable ? "available" : "missing_book";
}

function isValidExecutablePrice(value: number | null) {
  return value != null && value >= 0.01 && value <= 0.99;
}

function computeSpread(bestBid: number | null, bestAsk: number | null) {
  if (bestBid == null || bestAsk == null) {
    return null;
  }
  return Number((bestAsk - bestBid).toFixed(6));
}

function timestampOf(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

import { AdminReferenceQuoteSnapshotInput } from "../api/types.js";
import { shiftPriceByTicks } from "../strategies/shared/common.js";
import { ReferencePriceCache } from "./referencePriceCache.js";
import { ReferenceMarketMapping } from "./types.js";

export type DryRunReferencePlanRow = {
  localMarketId: string;
  localOutcomeId: string;
  polymarketSlug: string | null;
  polymarketTokenId: string;
  referenceBid: number | null;
  referenceAsk: number | null;
  plannedBotBid: number | null;
  plannedBotAsk: number | null;
  mmEligible: boolean;
  qualityStatus: string | null;
  reason: string | null;
  dryRun: true;
};

export function buildDryRunReferencePlan(
  cache: ReferencePriceCache,
  mappings: ReferenceMarketMapping[],
  tickSize: string,
): DryRunReferencePlanRow[] {
  return mappings.map((mapping) => {
    const quote = cache.getQuote(mapping.localMarketId, mapping.localOutcomeId);
    const referenceBid = quote?.gammaBestBid ?? null;
    const referenceAsk = quote?.gammaBestAsk ?? null;
    return {
      localMarketId: mapping.localMarketId,
      localOutcomeId: mapping.localOutcomeId,
      polymarketSlug: mapping.polymarketSlug,
      polymarketTokenId: mapping.polymarketTokenId,
      referenceBid,
      referenceAsk,
      plannedBotBid:
        referenceBid != null ? clampPlanPrice(shiftPriceByTicks(referenceBid.toFixed(2), tickSize, -2)) : null,
      plannedBotAsk:
        referenceAsk != null ? clampPlanPrice(shiftPriceByTicks(referenceAsk.toFixed(2), tickSize, 2)) : null,
      mmEligible: quote?.mmEligible ?? false,
      qualityStatus: quote?.qualityStatus ?? null,
      reason: quote?.reason ?? null,
      dryRun: true,
    };
  });
}

export function buildSnapshotPayload(
  cache: ReferencePriceCache,
  mappings: ReferenceMarketMapping[],
): AdminReferenceQuoteSnapshotInput[] {
  return mappings.flatMap((mapping) => {
    const quote = cache.getQuote(mapping.localMarketId, mapping.localOutcomeId);
    if (!quote) {
      return [];
    }
    return [
      {
        marketId: mapping.localMarketId,
        outcomeId: mapping.localOutcomeId,
        source: quote.source,
        externalSlug: quote.polymarketSlug,
        externalMarketId: quote.polymarketMarketId,
        conditionId: quote.conditionId,
        tokenId: quote.polymarketTokenId,
        outcomeLabel: quote.polymarketOutcome,
        outcomePrice: quote.gammaOutcomePrice,
        bestBid: quote.gammaBestBid,
        bestAsk: quote.gammaBestAsk,
        spread: quote.gammaSpread,
        lastTradePrice: quote.lastTradePrice,
        volume: quote.volume,
        volume24hr: quote.volume24hr,
        liquidity: quote.liquidity,
        liquidityClob: quote.liquidityClob,
        acceptingOrders: quote.acceptingOrders,
        qualityStatus: quote.qualityStatus,
        mmEligible: quote.mmEligible,
        reason: quote.reason,
        fetchedAt: quote.fetchedAt,
      },
    ];
  });
}

function clampPlanPrice(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Number(Math.max(0.01, Math.min(0.99, numeric)).toFixed(2));
}

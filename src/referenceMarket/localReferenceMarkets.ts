import { GetMarketResponse, MarketDetail } from "../api/types.js";

export type LocalReferenceOutcome = {
  id: string;
  name: string;
  displayOrder: number;
  isTradable: boolean;
  referenceTokenId: string | null;
  referenceOutcomeLabel: string | null;
};

export type LocalReferenceMarket = {
  id: string;
  title: string;
  status: string;
  type: string;
  mechanism: string;
  visibility: string;
  isListed: boolean;
  resolveTime: string | null;
  externalMarketId: string | null;
  conditionId: string | null;
  referenceSource: string | null;
  externalSlug: string | null;
  importStatus: string | null;
  referenceOnly: boolean | null;
  tradable: boolean | null;
  mmEnabled: boolean | null;
  outcomes: LocalReferenceOutcome[];
};

export function normalizeLocalReferenceMarket(response: GetMarketResponse): LocalReferenceMarket {
  const market = response.market;
  return normalizeMarketDetail(market);
}

export function normalizeMarketDetail(market: MarketDetail): LocalReferenceMarket {
  return {
    id: market.id,
    title: market.title,
    status: market.status,
    type: market.type ?? "BINARY",
    mechanism: market.mechanism,
    visibility: market.visibility,
    isListed: market.isListed ?? false,
    resolveTime: market.resolveTime ?? null,
    externalMarketId: market.externalMarketId ?? null,
    conditionId: market.conditionId ?? null,
    referenceSource: market.referenceSource ?? null,
    externalSlug: market.externalSlug ?? null,
    importStatus: market.importStatus ?? null,
    referenceOnly: market.referenceOnly ?? null,
    tradable: market.tradable ?? null,
    mmEnabled: market.mmEnabled ?? null,
    outcomes: market.outcomes
      .map((outcome, index) => ({
        id: outcome.id,
        name: outcome.name,
        displayOrder: outcome.displayOrder ?? index,
        isTradable: outcome.isTradable ?? false,
        referenceTokenId: outcome.referenceTokenId ?? null,
        referenceOutcomeLabel: outcome.referenceOutcomeLabel ?? null,
      }))
      .sort((left, right) => left.displayOrder - right.displayOrder),
  };
}

export function findBinaryOutcome(
  market: LocalReferenceMarket,
  side: "YES" | "NO",
): LocalReferenceOutcome | null {
  return (
    market.outcomes.find((outcome) => normalizeOutcomeLabel(outcome.referenceOutcomeLabel ?? outcome.name) === side) ??
    null
  );
}

export function normalizeOutcomeLabel(value: string): "YES" | "NO" | "OTHER" {
  const normalized = value.trim().toUpperCase();
  if (normalized === "YES") {
    return "YES";
  }
  if (normalized === "NO") {
    return "NO";
  }
  return "OTHER";
}

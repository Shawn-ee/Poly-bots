import { ReferenceMarketCandidate, ReferenceMarketMapping, ReferenceReviewStatus } from "./types.js";

type BuildMappingInput = {
  localMarketId: string;
  localOutcomeId: string;
  localOutcome: string;
  polymarketMarketId: string;
  conditionId: string | null;
  polymarketSlug: string | null;
  polymarketTokenId: string;
  polymarketOutcome: string;
  enabled?: boolean;
  mmEnabled?: boolean;
  reviewStatus?: ReferenceReviewStatus;
  lastMappedAt?: string;
  notes?: string | null;
};

export function buildReferenceMarketMapping(input: BuildMappingInput): ReferenceMarketMapping {
  return {
    localMarketId: input.localMarketId,
    localOutcomeId: input.localOutcomeId,
    localOutcome: input.localOutcome,
    source: "polymarket",
    polymarketMarketId: input.polymarketMarketId,
    conditionId: input.conditionId,
    polymarketSlug: input.polymarketSlug,
    polymarketTokenId: input.polymarketTokenId,
    polymarketOutcome: input.polymarketOutcome,
    enabled: input.enabled ?? true,
    mmEnabled: input.mmEnabled ?? false,
    reviewStatus: input.reviewStatus ?? "pending_review",
    lastMappedAt: input.lastMappedAt ?? new Date().toISOString(),
    notes: input.notes ?? null,
  };
}

export function buildDryRunMappingsForCandidate(
  candidate: ReferenceMarketCandidate,
  options: {
    localMarketId?: string;
    reviewStatus?: ReferenceReviewStatus;
    mmEnabled?: boolean;
    enabled?: boolean;
  } = {},
): ReferenceMarketMapping[] {
  const localMarketId = options.localMarketId ?? buildSyntheticLocalMarketId(candidate.slug, candidate.externalMarketId);
  return candidate.outcomes
    .filter((outcome) => outcome.tokenId)
    .map((outcome) =>
      buildReferenceMarketMapping({
        localMarketId,
        localOutcomeId: buildSyntheticLocalOutcomeId(localMarketId, outcome.tokenId!, outcome.index),
        localOutcome: normalizeLocalOutcomeName(outcome.label, candidate.outcomes.length),
        polymarketMarketId: candidate.externalMarketId,
        conditionId: candidate.conditionId,
        polymarketSlug: candidate.slug,
        polymarketTokenId: outcome.tokenId!,
        polymarketOutcome: outcome.label,
        enabled: options.enabled ?? true,
        mmEnabled: options.mmEnabled ?? false,
        reviewStatus: options.reviewStatus ?? "synthetic",
        notes: "Synthetic dry-run reference mapping.",
      }),
    );
}

export function normalizeLocalOutcomeName(label: string, outcomeCount: number) {
  if (outcomeCount === 2 && label.toLowerCase() === "yes") {
    return "YES";
  }
  if (outcomeCount === 2 && label.toLowerCase() === "no") {
    return "NO";
  }
  return label;
}

export function mappingKey(mapping: ReferenceMarketMapping) {
  return [
    mapping.source,
    mapping.polymarketMarketId,
    mapping.conditionId ?? "",
    mapping.polymarketTokenId,
    mapping.localMarketId,
    mapping.localOutcomeId,
  ].join(":");
}

export function buildSyntheticLocalMarketId(slug: string | null, polymarketMarketId: string) {
  return `dry-run:${slug ?? polymarketMarketId}`;
}

export function buildSyntheticLocalOutcomeId(localMarketId: string, polymarketTokenId: string, outcomeIndex: number) {
  return `${localMarketId}:outcome:${polymarketTokenId || outcomeIndex}`;
}

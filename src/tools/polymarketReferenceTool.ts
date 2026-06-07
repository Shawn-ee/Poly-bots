import {
  buildDraftImportPayload,
  evaluateCandidate,
  runMarketDiscovery,
} from "../referenceMarket/marketDiscovery.js";
import { PolymarketGammaClient } from "../referenceMarket/polymarketGammaClient.js";
import {
  MarketDiscoveryCandidate,
  MarketDiscoveryOptions,
  MarketDiscoveryResult,
  ReferenceMarketCandidate,
} from "../referenceMarket/types.js";
import { AgentRunContext, AgentToolResult } from "../agents/types.js";

export type PolymarketReferenceTool = {
  discoverReferenceMarkets(options?: Partial<MarketDiscoveryOptions>): Promise<AgentToolResult<MarketDiscoveryResult>>;
  getReferenceMarket(slug: string): Promise<AgentToolResult<ReferenceMarketCandidate | null>>;
  getReferencePrices(candidate: ReferenceMarketCandidate): AgentToolResult<Array<{ outcome: string; price: number | null }>>;
  evaluateReferenceFreshness(candidate: ReferenceMarketCandidate): AgentToolResult<{ stale: boolean; ageMs: number | null }>;
  filterAllowedReferenceMarkets(candidates: ReferenceMarketCandidate[]): AgentToolResult<MarketDiscoveryCandidate[]>;
  rejectGenericSoccerUnlessWorldCup(candidate: ReferenceMarketCandidate): AgentToolResult<{ accepted: boolean; reason: string | null }>;
  summarizeReferenceMarketQuality(candidate: ReferenceMarketCandidate): AgentToolResult<MarketDiscoveryCandidate>;
};

export function createPolymarketReferenceTool(context: AgentRunContext, gamma = new PolymarketGammaClient()): PolymarketReferenceTool {
  const defaults = defaultDiscoveryOptions(context);
  return {
    async discoverReferenceMarkets(options = {}) {
      const result = await runMarketDiscovery({
        ...defaults,
        ...options,
        enabled: false,
        dryRun: true,
        createDrafts: false,
        maxImportedMarkets: Math.min(options.maxImportedMarkets ?? defaults.maxImportedMarkets, context.maxImportedMarketsPerRun),
      });
      return {
        ok: true,
        dryRun: true,
        action: "DISCOVER_MARKETS",
        summary: `Discovered ${result.totalFetched} reference candidates in dry-run mode.`,
        data: result,
        findings: [],
        blockedActions: [],
      };
    },

    async getReferenceMarket(slug) {
      return {
        ok: true,
        dryRun: true,
        action: "GENERATE_REPORT",
        summary: `Fetched Polymarket reference market ${slug}.`,
        data: await gamma.getMarketBySlug(slug),
        findings: [],
        blockedActions: [],
      };
    },

    getReferencePrices(candidate) {
      return {
        ok: true,
        dryRun: true,
        action: "GENERATE_REPORT",
        summary: "Summarized reference outcome prices.",
        data: candidate.outcomes.map((outcome) => ({ outcome: outcome.label, price: outcome.outcomePrice })),
        findings: [],
        blockedActions: [],
      };
    },

    evaluateReferenceFreshness(candidate) {
      const updatedAt = candidate.updatedAt ? Date.parse(candidate.updatedAt) : null;
      const ageMs = updatedAt && Number.isFinite(updatedAt) ? context.now.getTime() - updatedAt : null;
      return {
        ok: ageMs != null && ageMs <= 24 * 60 * 60 * 1000,
        dryRun: true,
        action: "REVIEW_RISK",
        summary: "Evaluated reference freshness.",
        data: { stale: ageMs == null || ageMs > 24 * 60 * 60 * 1000, ageMs },
        findings: ageMs == null || ageMs > 24 * 60 * 60 * 1000
          ? [{ severity: "warning", code: "stale_reference", message: "Reference market data is stale or missing." }]
          : [],
        blockedActions: [],
      };
    },

    filterAllowedReferenceMarkets(candidates) {
      const evaluated = candidates.map((candidate) => evaluateCandidate(candidate, defaults));
      return {
        ok: true,
        dryRun: true,
        action: "DISCOVER_MARKETS",
        summary: "Filtered reference markets to allowed NBA/FIFA World Cup candidates.",
        data: evaluated,
        findings: evaluated
          .filter((item) => !item.accepted)
          .map((item) => ({
            severity: "info" as const,
            code: item.rejectedReason ?? "rejected",
            message: `Rejected ${item.candidate.question}`,
            targetId: item.candidate.externalMarketId,
          })),
        blockedActions: [],
      };
    },

    rejectGenericSoccerUnlessWorldCup(candidate) {
      const evaluated = evaluateCandidate(candidate, defaults);
      return {
        ok: evaluated.accepted,
        dryRun: true,
        action: "REVIEW_RISK",
        summary: evaluated.accepted ? "Candidate passed reference filter." : "Candidate rejected by reference filter.",
        data: { accepted: evaluated.accepted, reason: evaluated.rejectedReason },
        findings: evaluated.accepted
          ? []
          : [{ severity: "warning", code: evaluated.rejectedReason ?? "rejected", message: "Candidate is not allowed for discovery." }],
        blockedActions: [],
      };
    },

    summarizeReferenceMarketQuality(candidate) {
      const evaluated = evaluateCandidate(candidate, defaults);
      return {
        ok: evaluated.accepted,
        dryRun: true,
        action: "REVIEW_RISK",
        summary: `Reference quality: ${evaluated.qualityStatus}; score ${evaluated.score}.`,
        data: evaluated,
        findings: [],
        blockedActions: [],
      };
    },
  };
}

export function defaultDiscoveryOptions(context: AgentRunContext): MarketDiscoveryOptions {
  return {
    enabled: false,
    dryRun: true,
    topN: 10,
    maxImportedMarkets: context.maxImportedMarketsPerRun,
    maxNewImportsPerRun: context.maxDraftMarketsPerRun,
    allowedVerticals: ["nba", "world_cup"],
    minReferenceLiquidity: null,
    minReferenceVolume: null,
    maxReferenceSpread: 0.1,
    outputPath: "test-logs/agent-market-discovery.json",
    mappingPath: "reference-mappings/polymarket-discovery.json",
    baseUrl: context.baseUrl ?? "http://127.0.0.1:3001",
    adminSessionCookie: null,
    createDrafts: false,
    createEvents: true,
  };
}

export function buildDraftRecommendation(candidate: MarketDiscoveryCandidate) {
  return buildDraftImportPayload(candidate);
}


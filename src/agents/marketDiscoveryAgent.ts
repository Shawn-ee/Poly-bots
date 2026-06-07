import { buildDraftRecommendation, defaultDiscoveryOptions } from "../tools/polymarketReferenceTool.js";
import { evaluateCandidate, runMarketDiscovery } from "../referenceMarket/marketDiscovery.js";
import { MarketDiscoveryCandidate, ReferenceMarketCandidate } from "../referenceMarket/types.js";
import { buildAgentAction, blockedAction } from "./policies.js";
import {
  AgentDecision,
  AgentFinding,
  AgentRecommendation,
  AgentRunContext,
  AgentRunResult,
} from "./types.js";

export type MarketDiscoveryAgentData = {
  candidatesFound: number;
  candidatesAccepted: number;
  candidatesRejected: number;
  rejectionReasons: Record<string, number>;
  draftImportRecommendations: unknown[];
  safetySummary: string;
};

export type MarketDiscoveryAgentDeps = {
  candidates?: ReferenceMarketCandidate[];
  allowNetworkDiscovery?: boolean;
};

export async function runMarketDiscoveryAgent(
  context: AgentRunContext,
  deps: MarketDiscoveryAgentDeps = {},
): Promise<AgentRunResult<MarketDiscoveryAgentData>> {
  const startedAt = new Date().toISOString();
  const options = defaultDiscoveryOptions(context);
  const evaluated = deps.candidates
    ? deps.candidates.map((candidate) => evaluateCandidate(candidate, options))
    : deps.allowNetworkDiscovery
      ? (await runMarketDiscovery(options)).candidates
      : [];

  const accepted = evaluated.filter((item) => item.accepted).slice(0, context.maxDraftMarketsPerRun);
  const rejectionReasons = summarizeRejections(evaluated);
  const draftImportRecommendations = accepted.map((candidate) => buildDraftRecommendation(candidate));
  const findings = buildFindings(evaluated, deps.allowNetworkDiscovery === true);
  const recommendations: AgentRecommendation[] = accepted.map((candidate) => ({
    actionType: "RECOMMEND_MARKET_CREATION",
    summary: `Recommend draft import: ${candidate.candidate.question}`,
    rationale: `Candidate matched ${candidate.vertical} with score ${candidate.score}.`,
    approvalRequirement: "adminApproval",
    safetyLevel: "approvalRequired",
    dryRun: true,
    metadata: {
      externalMarketId: candidate.candidate.externalMarketId,
      vertical: candidate.vertical,
      score: candidate.score,
      desiredStatus: "draft",
    },
  }));
  const plannedActions = [
    buildAgentAction("DISCOVER_MARKETS", "Discover NBA and FIFA World Cup reference markets", context),
    ...accepted.map((candidate) =>
      buildAgentAction("RECOMMEND_MARKET_CREATION", `Recommend draft import for ${candidate.candidate.externalMarketId}`, context, {
        vertical: candidate.vertical,
      }),
    ),
  ];
  const blockedActions = [
    blockedAction("ACTIVATE_MARKET", "Activate discovered market", context, "discovery agents may recommend or draft only"),
    blockedAction("PLACE_ORDER", "Trade discovered market", context, "agents cannot place live trades"),
    blockedAction("RESOLVE_MARKET", "Resolve discovered market", context, "agents cannot execute resolution"),
  ];
  const data: MarketDiscoveryAgentData = {
    candidatesFound: evaluated.length,
    candidatesAccepted: accepted.length,
    candidatesRejected: evaluated.filter((item) => !item.accepted).length,
    rejectionReasons,
    draftImportRecommendations,
    safetySummary: "Discovery is dry-run/recommendation only. Draft imports require admin approval and remain non-tradable.",
  };
  const decision = buildDecision(context, findings, recommendations, plannedActions, blockedActions);
  return {
    agentName: "marketDiscovery",
    mode: context.mode,
    dryRun: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: findings.some((finding) => finding.severity === "critical") ? "blocked" : "reviewRequired",
    summary: `MarketDiscoveryAgent reviewed ${evaluated.length} candidates and recommended ${accepted.length} draft imports.`,
    decision,
    findings,
    recommendations,
    blockedActions,
    data,
  };
}

function summarizeRejections(candidates: MarketDiscoveryCandidate[]) {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    if (!candidate.rejectedReason) continue;
    counts[candidate.rejectedReason] = (counts[candidate.rejectedReason] ?? 0) + 1;
  }
  return counts;
}

function buildFindings(candidates: MarketDiscoveryCandidate[], networkEnabled: boolean): AgentFinding[] {
  const findings: AgentFinding[] = [];
  if (!networkEnabled && candidates.length === 0) {
    findings.push({
      severity: "info",
      code: "offline_discovery",
      message: "Network discovery was not requested; agent produced a safe empty dry-run review.",
    });
  }
  for (const candidate of candidates.filter((item) => !item.accepted)) {
    findings.push({
      severity: candidate.rejectedReason === "generic_soccer" ? "warning" : "info",
      code: candidate.rejectedReason ?? "rejected",
      message: `Rejected ${candidate.candidate.question}`,
      targetId: candidate.candidate.externalMarketId,
    });
  }
  return findings;
}

function buildDecision(
  context: AgentRunContext,
  findings: AgentFinding[],
  recommendations: AgentRecommendation[],
  plannedActions: AgentDecision["plannedActions"],
  blockedActions: AgentDecision["blockedActions"],
): AgentDecision {
  return {
    agentName: "marketDiscovery",
    mode: context.mode,
    actionType: "DISCOVER_MARKETS",
    summary: "Dry-run market discovery review completed.",
    findings,
    recommendations,
    plannedActions,
    blockedActions,
    requiresApproval: recommendations.length > 0,
    approvalReason: recommendations.length > 0 ? "Draft imports require admin review before any listing/trading." : null,
    safetyLevel: "review",
    dryRun: true,
    createdAt: new Date().toISOString(),
  };
}


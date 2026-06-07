import { AdminImportReferenceMarketRequest } from "../api/types.js";
import { ReferenceMarketCandidate } from "../referenceMarket/types.js";
import { buildDraftImportPayload, evaluateCandidate } from "../referenceMarket/marketDiscovery.js";
import { forceDraftReferencePayload, validateDraftPayload } from "../tools/marketApiTool.js";
import { defaultDiscoveryOptions } from "../tools/polymarketReferenceTool.js";
import { buildAgentAction, blockedAction } from "./policies.js";
import { AgentDecision, AgentRunContext, AgentRunResult } from "./types.js";

export async function runMarketCreationAgent(
  context: AgentRunContext,
  candidate: ReferenceMarketCandidate | null = null,
): Promise<AgentRunResult<{ draftPayload: AdminImportReferenceMarketRequest | null; missingFields: string[] }>> {
  const startedAt = new Date().toISOString();
  const evaluated = candidate ? evaluateCandidate(candidate, defaultDiscoveryOptions(context)) : null;
  const payload = evaluated?.accepted ? forceDraftReferencePayload(buildDraftImportPayload(evaluated)) : null;
  const validation = payload ? validateDraftPayload(payload) : [];
  const missingFields = payload ? [] : ["reference market candidate"];
  const findings = [
    ...validation,
    ...(evaluated && !evaluated.accepted
      ? [{ severity: "critical" as const, code: evaluated.rejectedReason ?? "candidate_rejected", message: "Reference candidate is not eligible for draft creation." }]
      : []),
  ];
  const blockedActions = [
    blockedAction("ACTIVATE_MARKET", "Create active market", context, "market creation agents produce drafts only"),
    blockedAction("PLACE_ORDER", "Seed or trade market", context, "market creation does not trade"),
  ];
  const decision: AgentDecision = {
    agentName: "marketCreation",
    mode: context.mode,
    actionType: payload ? "CREATE_DRAFT_MARKET" : "RECOMMEND_MARKET_CREATION",
    summary: payload ? "Draft-only market payload prepared." : "No candidate supplied; draft creation not prepared.",
    findings,
    recommendations: payload
      ? [
          {
            actionType: "CREATE_DRAFT_MARKET",
            summary: "Review draft market payload for admin approval.",
            rationale: "Agents only prepare draft payloads; activation requires admin workflow.",
            approvalRequirement: "adminApproval",
            safetyLevel: "approvalRequired",
            dryRun: true,
          },
        ]
      : [],
    plannedActions: [buildAgentAction("RECOMMEND_MARKET_CREATION", "Prepare draft market proposal", context)],
    blockedActions,
    requiresApproval: payload != null,
    approvalReason: payload ? "Draft creation/import requires admin review." : null,
    safetyLevel: findings.some((finding) => finding.severity === "critical") ? "blocked" : "approvalRequired",
    dryRun: true,
    createdAt: new Date().toISOString(),
  };
  return {
    agentName: "marketCreation",
    mode: context.mode,
    dryRun: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: findings.some((finding) => finding.severity === "critical") ? "blocked" : "reviewRequired",
    summary: "MarketCreationAgent prepared a draft-only proposal and made no API mutation.",
    decision,
    findings,
    recommendations: decision.recommendations,
    blockedActions,
    data: { draftPayload: payload, missingFields },
  };
}


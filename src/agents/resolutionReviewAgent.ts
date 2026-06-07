import { evaluateResolutionRisk } from "../tools/riskTool.js";
import { buildAgentAction, blockedAction } from "./policies.js";
import { AgentDecision, AgentRunContext, AgentRunResult, ResolutionReviewInput } from "./types.js";

export async function runResolutionReviewAgent(
  context: AgentRunContext,
  input: ResolutionReviewInput = {
    marketId: "unspecified",
    marketTitle: "Unspecified market",
    candidateWinningOutcomeId: null,
    evidence: [],
    confidence: 0,
    approvedByAdmin: false,
  },
): Promise<AgentRunResult<{ recommendedWinningOutcomeId: string | null; confidence: number; evidence: string[] }>> {
  const startedAt = new Date().toISOString();
  const findings = evaluateResolutionRisk(input, context);
  const blockedActions = [
    blockedAction("RESOLVE_MARKET", "Execute real market resolution", context, "agents may only recommend resolution"),
    blockedAction("MOVE_FUNDS", "Settle or move funds", context, "fund movement is forbidden"),
  ];
  const decision: AgentDecision = {
    agentName: "resolutionReview",
    mode: context.mode,
    actionType: "REVIEW_RESOLUTION",
    summary: "Resolution reviewed; execution remains blocked.",
    findings,
    recommendations: [
      {
        actionType: "REVIEW_RESOLUTION",
        summary: input.candidateWinningOutcomeId
          ? `Recommend outcome ${input.candidateWinningOutcomeId} only after admin approval.`
          : "No resolution recommendation due to missing outcome or confidence.",
        rationale: "Resolution review agents never execute settlement.",
        approvalRequirement: "adminApproval",
        safetyLevel: findings.some((finding) => finding.hardBlocker) ? "blocked" : "approvalRequired",
        dryRun: true,
      },
    ],
    plannedActions: [buildAgentAction("REVIEW_RESOLUTION", "Review resolution evidence", context)],
    blockedActions,
    requiresApproval: true,
    approvalReason: "Resolution requires explicit admin approval and deterministic settlement path.",
    safetyLevel: "blocked",
    dryRun: true,
    createdAt: new Date().toISOString(),
  };
  return {
    agentName: "resolutionReview",
    mode: context.mode,
    dryRun: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: "blocked",
    summary: "ResolutionReviewAgent produced recommendation only and executed nothing.",
    decision,
    findings,
    recommendations: decision.recommendations,
    blockedActions,
    data: {
      recommendedWinningOutcomeId: input.confidence >= 0.9 ? input.candidateWinningOutcomeId : null,
      confidence: input.confidence,
      evidence: input.evidence,
    },
  };
}


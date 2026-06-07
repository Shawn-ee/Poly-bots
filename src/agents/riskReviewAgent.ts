import { buildRiskReport, evaluateOrderIntentRisk, evaluateResolutionRisk } from "../tools/riskTool.js";
import { buildAgentAction, blockedAction } from "./policies.js";
import { AgentDecision, AgentRunContext, AgentRunResult, OrderIntent, ResolutionReviewInput } from "./types.js";

export type RiskReviewInput = {
  orderIntent?: OrderIntent;
  resolution?: ResolutionReviewInput;
};

export async function runRiskReviewAgent(
  context: AgentRunContext,
  input: RiskReviewInput = {},
): Promise<AgentRunResult<{ riskScore: number; recommendation: string }>> {
  const startedAt = new Date().toISOString();
  const findings = [
    ...(input.orderIntent ? evaluateOrderIntentRisk(input.orderIntent, context) : []),
    ...(input.resolution ? evaluateResolutionRisk(input.resolution, context) : []),
  ];
  if (!input.orderIntent && !input.resolution) {
    findings.push({
      severity: "info",
      code: "no_plan_supplied",
      message: "No concrete order or resolution plan was supplied; generated baseline safety report.",
      riskScore: 0,
      hardBlocker: false,
      approvalRequired: false,
    });
  }
  const report = buildRiskReport(findings);
  const blockedActions = [
    blockedAction("MOVE_FUNDS", "Move funds from risk agent", context, "fund movement is forbidden"),
    blockedAction("APPROVE_WITHDRAWAL", "Approve withdrawal from risk agent", context, "withdrawal approval is forbidden"),
    blockedAction("DEPLOY_PRODUCTION", "Deploy from risk agent", context, "agent deploys are forbidden"),
    blockedAction("RESTART_PRODUCTION_SERVICE", "Restart production service from risk agent", context, "agent service restarts are forbidden"),
    blockedAction("WRITE_PRODUCTION_DB", "Write production balances, ledger, or orders from risk agent", context, "agent production financial writes are forbidden"),
  ];
  const decision: AgentDecision = {
    agentName: "riskReview",
    mode: context.mode,
    actionType: "REVIEW_RISK",
    summary: `Risk review result: ${report.recommendation}.`,
    findings,
    recommendations: [
      {
        actionType: "REVIEW_RISK",
        summary: report.recommendation,
        rationale: `Risk score ${report.score}; ${report.hardBlockers.length} hard blockers.`,
        approvalRequirement: report.hardBlockers.length ? "adminApproval" : "none",
        safetyLevel: report.hardBlockers.length ? "blocked" : "safe",
        dryRun: true,
      },
    ],
    plannedActions: [buildAgentAction("REVIEW_RISK", "Review proposed bot/market action", context)],
    blockedActions,
    requiresApproval: report.requiredApprovals.length > 0,
    approvalReason: report.requiredApprovals.length ? report.requiredApprovals.join(", ") : null,
    safetyLevel: report.recommendation === "blocked" ? "blocked" : "safe",
    dryRun: true,
    createdAt: new Date().toISOString(),
  };
  return {
    agentName: "riskReview",
    mode: context.mode,
    dryRun: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: report.recommendation === "blocked" ? "blocked" : "passed",
    summary: "RiskReviewAgent completed dry-run safety review.",
    decision,
    findings,
    recommendations: decision.recommendations,
    blockedActions,
    data: { riskScore: report.score, recommendation: report.recommendation },
  };
}

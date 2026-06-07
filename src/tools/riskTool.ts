import { AgentFinding, AgentRiskFinding, AgentRunContext, OrderIntent, ResolutionReviewInput } from "../agents/types.js";
import { validateOrderIntent } from "./orderApiTool.js";

export type RiskReport = {
  score: number;
  severity: "low" | "medium" | "high" | "critical";
  findings: AgentRiskFinding[];
  hardBlockers: AgentRiskFinding[];
  softWarnings: AgentRiskFinding[];
  requiredApprovals: string[];
  recommendation: "allow_dry_run" | "review_required" | "blocked";
};

export function evaluateMarketRisk(input: {
  category: string | null;
  active: boolean;
  resolved: boolean;
  approved: boolean;
}, context: AgentRunContext): AgentRiskFinding[] {
  const findings: AgentRiskFinding[] = [];
  if (input.category && !context.allowedCategories.includes(input.category)) {
    findings.push(risk("unsupported_category", "Unsupported market category.", 70, true));
  }
  if (input.active && !input.approved) {
    findings.push(risk("missing_admin_approval", "Active market actions require admin approval.", 90, true));
  }
  if (input.resolved) {
    findings.push(risk("market_resolved", "Resolved markets cannot be modified by agents.", 90, true));
  }
  return findings;
}

export function evaluateBotRisk(input: {
  enabled: boolean;
  dryRun: boolean;
  repeatedErrors: number;
  repeatedOrderFailures: number;
  staleQuotes: number;
}): AgentRiskFinding[] {
  const findings: AgentRiskFinding[] = [];
  if (input.enabled && !input.dryRun) findings.push(risk("live_bot_review", "Live bot operation requires explicit operator review.", 50, false));
  if (input.repeatedErrors >= 3) findings.push(risk("bot_error_loop", "Bot appears to be in an error loop.", 80, true));
  if (input.repeatedOrderFailures >= 3) findings.push(risk("repeated_order_failures", "Bot has repeated order failures.", 75, true));
  if (input.staleQuotes > 0) findings.push(risk("stale_quotes", "Bot is seeing stale quote data.", 45, false));
  return findings;
}

export function evaluateOrderIntentRisk(intent: OrderIntent, context: AgentRunContext): AgentRiskFinding[] {
  const findings = validateOrderIntent(intent).map((finding) =>
    risk(finding.code, finding.message, finding.severity === "critical" ? 100 : 50, finding.severity === "critical"),
  );
  if (!context.allowLiveTradingActions) {
    findings.push(risk("live_trading_disabled", "Agents cannot place live orders by default.", 100, true));
  }
  return findings;
}

export function evaluateReferencePriceRisk(input: {
  stale: boolean;
  spread: number | null;
  localReferenceMismatch: number | null;
}): AgentRiskFinding[] {
  const findings: AgentRiskFinding[] = [];
  if (input.stale) findings.push(risk("stale_reference_data", "Reference data is stale.", 65, false));
  if (input.spread != null && input.spread > 0.1) findings.push(risk("wide_external_spread", "External spread is too wide.", 70, true));
  if (input.localReferenceMismatch != null && input.localReferenceMismatch > 0.15) {
    findings.push(risk("local_reference_mismatch", "Local/reference prices diverge materially.", 70, true));
  }
  return findings;
}

export function evaluateInventoryRisk(input: {
  yesShares: number;
  noShares: number;
  maxShares: number;
}): AgentRiskFinding[] {
  const maxSide = Math.max(Math.abs(input.yesShares), Math.abs(input.noShares));
  return maxSide > input.maxShares
    ? [risk("inventory_limit_exceeded", "Inventory exceeds configured max shares.", 80, true)]
    : [];
}

export function evaluateDailyNotionalRisk(input: {
  usedCents: number;
  maxCents: number;
}): AgentRiskFinding[] {
  return input.usedCents >= input.maxCents
    ? [risk("daily_notional_exhausted", "Daily notional limit is exhausted.", 85, true)]
    : [];
}

export function evaluateStaleDataRisk(input: { ageMs: number | null; maxAgeMs: number }): AgentRiskFinding[] {
  return input.ageMs == null || input.ageMs > input.maxAgeMs
    ? [risk("stale_data", "Required data is stale or missing.", 65, false)]
    : [];
}

export function evaluateResolutionRisk(input: ResolutionReviewInput, context: AgentRunContext): AgentRiskFinding[] {
  const findings: AgentRiskFinding[] = [];
  if (!input.approvedByAdmin || context.requireAdminApproval) {
    findings.push(risk("resolution_requires_admin_approval", "Resolution requires explicit admin approval.", 100, true));
  }
  if (!context.allowResolutionExecution) {
    findings.push(risk("resolution_execution_disabled", "Agents may recommend resolution only.", 100, true));
  }
  if (input.confidence < 0.9) {
    findings.push(risk("insufficient_resolution_confidence", "Resolution confidence is below threshold.", 75, true));
  }
  if (!input.candidateWinningOutcomeId) {
    findings.push(risk("missing_resolution_outcome", "No candidate winning outcome was provided.", 75, true));
  }
  return findings;
}

export function buildRiskReport(findings: Array<AgentRiskFinding | AgentFinding>): RiskReport {
  const normalized = findings.map((finding) =>
    "riskScore" in finding
      ? finding
      : risk(finding.code, finding.message, finding.severity === "critical" ? 100 : 40, finding.severity === "critical"),
  );
  const score = Math.max(0, ...normalized.map((finding) => finding.riskScore));
  const hardBlockers = normalized.filter((finding) => finding.hardBlocker);
  const softWarnings = normalized.filter((finding) => !finding.hardBlocker);
  return {
    score,
    severity: score >= 90 ? "critical" : score >= 70 ? "high" : score >= 40 ? "medium" : "low",
    findings: normalized,
    hardBlockers,
    softWarnings,
    requiredApprovals: normalized.filter((finding) => finding.approvalRequired).map((finding) => finding.code),
    recommendation: hardBlockers.length > 0 ? "blocked" : softWarnings.length > 0 ? "review_required" : "allow_dry_run",
  };
}

function risk(code: string, message: string, riskScore: number, hardBlocker: boolean): AgentRiskFinding {
  return {
    severity: riskScore >= 90 ? "critical" : riskScore >= 70 ? "high" : riskScore >= 40 ? "warning" : "info",
    code,
    message,
    riskScore,
    hardBlocker,
    approvalRequired: hardBlocker,
  };
}


import { AgentDecision, AgentFinding, AgentRecommendation, AgentRunResult } from "../agents/types.js";

export function logAgentStart(agentName: string, runId: string) {
  console.log(formatLog("agent_start", agentName, { runId }));
}

export function logAgentDecision(decision: AgentDecision) {
  console.log(formatLog("agent_decision", decision.agentName, decision));
}

export function logAgentFinding(agentName: string, finding: AgentFinding) {
  console.log(formatLog("agent_finding", agentName, finding));
}

export function logAgentRecommendation(agentName: string, recommendation: AgentRecommendation) {
  console.log(formatLog("agent_recommendation", agentName, recommendation));
}

export function logAgentBlockedAction(agentName: string, action: unknown) {
  console.log(formatLog("agent_blocked_action", agentName, action));
}

export function logAgentFinish(result: AgentRunResult) {
  console.log(formatLog("agent_finish", result.agentName, formatAgentRunSummary(result)));
}

export function logRiskReport(agentName: string, report: unknown) {
  console.log(formatLog("risk_report", agentName, report));
}

export function formatAgentRunSummary(result: AgentRunResult) {
  return {
    agentName: result.agentName,
    mode: result.mode,
    status: result.status,
    dryRun: result.dryRun,
    summary: result.summary,
    findings: result.findings.length,
    recommendations: result.recommendations.length,
    blockedActions: result.blockedActions.length,
  };
}

function formatLog(event: string, agentName: string, payload: unknown) {
  return `${new Date().toISOString()} [AGENT] [${agentName}] ${event} ${safeStringify(redact(payload))}`;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /secret|token|cookie|key|password/i.test(key) ? "[REDACTED]" : redact(item);
  }
  return output;
}


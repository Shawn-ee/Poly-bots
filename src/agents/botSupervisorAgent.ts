import { BotConfig } from "../config/loadConfig.js";
import { evaluateBotRisk, buildRiskReport } from "../tools/riskTool.js";
import { buildAgentAction, blockedAction } from "./policies.js";
import { AgentDecision, AgentRecommendation, AgentRunContext, AgentRunResult, BotHealthSnapshot } from "./types.js";

export async function runBotSupervisorAgent(
  context: AgentRunContext,
  bots: BotConfig[] = [],
): Promise<AgentRunResult<{ botsReviewed: number; health: BotHealthSnapshot[] }>> {
  const startedAt = new Date().toISOString();
  const health = bots.map((bot) => buildHealthSnapshot(bot));
  const findings = health.flatMap((snapshot) =>
    evaluateBotRisk({
      enabled: true,
      dryRun: botStrategyDryRun(snapshot.strategy),
      repeatedErrors: snapshot.recentErrorCount,
      repeatedOrderFailures: snapshot.recentOrderFailureCount,
      staleQuotes: snapshot.staleQuoteCount,
    }),
  );
  const report = buildRiskReport(findings);
  const recommendations: AgentRecommendation[] = report.hardBlockers.length > 0
    ? [
        {
          actionType: "RECOMMEND_BOT_PAUSE",
          summary: "Recommend pausing affected deterministic bots.",
          rationale: "Risk review found hard blockers in bot health signals.",
          approvalRequirement: "operatorApproval",
          safetyLevel: "approvalRequired",
          dryRun: true,
          metadata: { blockers: report.hardBlockers.map((finding) => finding.code) },
        },
      ]
    : [
        {
          actionType: "GENERATE_REPORT",
          summary: "Bots reviewed; no automatic action taken.",
          rationale: "Supervisor agents only recommend changes.",
          approvalRequirement: "none",
          safetyLevel: "safe",
          dryRun: true,
        },
      ];
  const blockedActions = [
    blockedAction("PLACE_ORDER", "Supervisor direct order placement", context, "bot supervisor cannot trade"),
    blockedAction("RECOMMEND_BOT_RESUME", "Force resume bot", context, "resume requires operator approval"),
  ];
  const decision: AgentDecision = {
    agentName: "botSupervisor",
    mode: context.mode,
    actionType: "SUPERVISE_BOT",
    summary: `Reviewed ${health.length} deterministic bot configs.`,
    findings,
    recommendations,
    plannedActions: [buildAgentAction("SUPERVISE_BOT", "Review bot health and recommend changes", context)],
    blockedActions,
    requiresApproval: recommendations.some((item) => item.approvalRequirement !== "none"),
    approvalReason: "Bot pause/resume/config changes require operator review.",
    safetyLevel: report.recommendation === "blocked" ? "approvalRequired" : "safe",
    dryRun: true,
    createdAt: new Date().toISOString(),
  };
  return {
    agentName: "botSupervisor",
    mode: context.mode,
    dryRun: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: report.recommendation === "blocked" ? "reviewRequired" : "passed",
    summary: `BotSupervisorAgent reviewed ${health.length} bot configs and made no runtime changes.`,
    decision,
    findings,
    recommendations,
    blockedActions,
    data: { botsReviewed: health.length, health },
  };
}

function buildHealthSnapshot(bot: BotConfig): BotHealthSnapshot {
  return {
    botName: bot.name,
    strategy: bot.strategy,
    marketIds: bot.marketIds,
    enabled: true,
    dryRun: bot.strategy === "referenceArbitrageRebalancer" ? bot.referenceArbitrageRebalancer.dryRun : false,
    recentErrorCount: 0,
    recentOrderFailureCount: 0,
    staleQuoteCount: 0,
    dailyNotionalUsedCents: 0,
    maxDailyNotionalCents: bot.risk.maxDailySubmittedNotionalCents,
  };
}

function botStrategyDryRun(strategy: string) {
  return strategy === "referenceArbitrageRebalancer";
}


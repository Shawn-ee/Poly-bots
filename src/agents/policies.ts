import {
  AgentAction,
  AgentActionType,
  AgentApprovalRequirement,
  AgentRunContext,
  AgentSafetyLevel,
} from "./types.js";

export const AGENT_POLICY_DEFAULTS = {
  agentsDefaultDryRun: true,
  canAgentCreateActiveMarket: false,
  canAgentPlaceLiveOrders: false,
  canAgentMoveFunds: false,
  canAgentResolveMarket: false,
  canAgentDeploy: false,
  canAgentWriteProductionDb: false,
  maxDraftMarketsPerRun: 10,
  maxImportedMarketsPerRun: 300,
  allowedReferenceCategories: ["NBA", "FIFA World Cup", "Sports"],
  requireAdminApproval: true,
} as const;

const ALWAYS_BLOCKED_ACTIONS = new Set<AgentActionType>([
  "MOVE_FUNDS",
  "APPROVE_WITHDRAWAL",
  "DEPLOY_PRODUCTION",
  "RESTART_PRODUCTION_SERVICE",
  "WRITE_PRODUCTION_DB",
]);

export function createDefaultAgentContext(
  agentName: AgentRunContext["agentName"],
  mode: AgentRunContext["mode"] = "dryRun",
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext {
  const dryRun = mode === "dryRun" || mode === "reviewOnly" || mode === "liveDisabled";
  return {
    runId: `agent_${Date.now()}`,
    agentName,
    mode,
    dryRun,
    now: new Date(),
    allowedCategories: [...AGENT_POLICY_DEFAULTS.allowedReferenceCategories],
    maxDraftMarketsPerRun: AGENT_POLICY_DEFAULTS.maxDraftMarketsPerRun,
    maxImportedMarketsPerRun: AGENT_POLICY_DEFAULTS.maxImportedMarketsPerRun,
    allowDraftMarketCreation: true,
    allowActiveMarketCreation: false,
    allowLiveTradingActions: false,
    allowFundMovement: false,
    allowResolutionExecution: false,
    requireAdminApproval: true,
    ...overrides,
  };
}

export function requiresAdminApproval(actionType: AgentActionType): boolean {
  return [
    "CREATE_DRAFT_MARKET",
    "ACTIVATE_MARKET",
    "PLACE_ORDER",
    "CANCEL_ORDER",
    "RESOLVE_MARKET",
    "RECOMMEND_BOT_RESUME",
  ].includes(actionType);
}

export function approvalRequirementFor(actionType: AgentActionType): AgentApprovalRequirement {
  if (ALWAYS_BLOCKED_ACTIONS.has(actionType)) {
    return "forbidden";
  }
  if (requiresAdminApproval(actionType)) {
    return "adminApproval";
  }
  return "none";
}

export function safetyLevelFor(actionType: AgentActionType, context: AgentRunContext): AgentSafetyLevel {
  if (!isAgentActionAllowed(actionType, context)) {
    return "blocked";
  }
  if (requiresAdminApproval(actionType)) {
    return "approvalRequired";
  }
  return context.dryRun ? "safe" : "review";
}

export function buildAgentAction(
  type: AgentActionType,
  description: string,
  context: AgentRunContext,
  metadata: Record<string, unknown> = {},
): AgentAction {
  const allowed = isAgentActionAllowed(type, context);
  return {
    type,
    description,
    dryRun: context.dryRun || !allowed,
    requiresApproval: requiresAdminApproval(type) || !allowed,
    approvalRequirement: allowed ? approvalRequirementFor(type) : "forbidden",
    safetyLevel: allowed ? safetyLevelFor(type, context) : "blocked",
    metadata,
  };
}

export function isAgentActionAllowed(actionType: AgentActionType, context: AgentRunContext): boolean {
  if (ALWAYS_BLOCKED_ACTIONS.has(actionType)) {
    return false;
  }
  if (context.dryRun && ["PLACE_ORDER", "CANCEL_ORDER", "ACTIVATE_MARKET", "RESOLVE_MARKET"].includes(actionType)) {
    return false;
  }
  if (actionType === "CREATE_DRAFT_MARKET") {
    return context.allowDraftMarketCreation && !context.allowActiveMarketCreation;
  }
  if (actionType === "ACTIVATE_MARKET") {
    return context.allowActiveMarketCreation && !context.requireAdminApproval;
  }
  if (actionType === "PLACE_ORDER" || actionType === "CANCEL_ORDER") {
    return context.allowLiveTradingActions && !context.dryRun;
  }
  if (actionType === "RESOLVE_MARKET") {
    return context.allowResolutionExecution && !context.requireAdminApproval;
  }
  return true;
}

export function assertAgentActionAllowed(action: AgentAction, context: AgentRunContext): void {
  if (!isAgentActionAllowed(action.type, context)) {
    throw new Error(`Agent action blocked by policy: ${action.type}`);
  }
}

export function blockedAction(
  type: AgentActionType,
  description: string,
  context: AgentRunContext,
  reason: string,
): AgentAction {
  return {
    type,
    description,
    dryRun: true,
    requiresApproval: true,
    approvalRequirement: "forbidden",
    safetyLevel: "blocked",
    metadata: { reason, mode: context.mode },
  };
}

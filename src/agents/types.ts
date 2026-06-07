export type AgentName =
  | "marketDiscovery"
  | "botSupervisor"
  | "riskReview"
  | "marketCreation"
  | "resolutionReview";

export type AgentMode = "dryRun" | "reviewOnly" | "simulation" | "liveDisabled";

export type AgentActionType =
  | "DISCOVER_MARKETS"
  | "RECOMMEND_MARKET_CREATION"
  | "CREATE_DRAFT_MARKET"
  | "REVIEW_RISK"
  | "SUPERVISE_BOT"
  | "RECOMMEND_BOT_PAUSE"
  | "RECOMMEND_BOT_RESUME"
  | "REVIEW_RESOLUTION"
  | "GENERATE_REPORT"
  | "PLACE_ORDER"
  | "CANCEL_ORDER"
  | "MOVE_FUNDS"
  | "APPROVE_WITHDRAWAL"
  | "RESOLVE_MARKET"
  | "ACTIVATE_MARKET"
  | "DEPLOY_PRODUCTION"
  | "RESTART_PRODUCTION_SERVICE"
  | "WRITE_PRODUCTION_DB";

export type AgentSafetyLevel = "safe" | "review" | "approvalRequired" | "blocked";

export type AgentApprovalRequirement =
  | "none"
  | "adminApproval"
  | "operatorApproval"
  | "riskCommitteeApproval"
  | "forbidden";

export type AgentSeverity = "info" | "warning" | "high" | "critical";

export type AgentAction = {
  type: AgentActionType;
  description: string;
  targetType?: "market" | "order" | "bot" | "funds" | "resolution" | "reference" | "report";
  targetId?: string | null;
  dryRun: boolean;
  requiresApproval: boolean;
  approvalRequirement: AgentApprovalRequirement;
  safetyLevel: AgentSafetyLevel;
  metadata?: Record<string, unknown>;
};

export type AgentFinding = {
  severity: AgentSeverity;
  code: string;
  message: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

export type AgentRiskFinding = AgentFinding & {
  riskScore: number;
  hardBlocker: boolean;
  approvalRequired: boolean;
};

export type AgentRecommendation = {
  actionType: AgentActionType;
  summary: string;
  rationale: string;
  approvalRequirement: AgentApprovalRequirement;
  safetyLevel: AgentSafetyLevel;
  dryRun: boolean;
  metadata?: Record<string, unknown>;
};

export type AgentDecision = {
  agentName: AgentName;
  mode: AgentMode;
  actionType: AgentActionType;
  summary: string;
  findings: AgentFinding[];
  recommendations: AgentRecommendation[];
  plannedActions: AgentAction[];
  blockedActions: AgentAction[];
  requiresApproval: boolean;
  approvalReason: string | null;
  safetyLevel: AgentSafetyLevel;
  dryRun: boolean;
  createdAt: string;
};

export type AgentRunContext = {
  runId: string;
  agentName: AgentName;
  mode: AgentMode;
  dryRun: boolean;
  now: Date;
  baseUrl?: string;
  allowedCategories: string[];
  maxDraftMarketsPerRun: number;
  maxImportedMarketsPerRun: number;
  allowDraftMarketCreation: boolean;
  allowActiveMarketCreation: boolean;
  allowLiveTradingActions: boolean;
  allowFundMovement: boolean;
  allowResolutionExecution: boolean;
  requireAdminApproval: boolean;
  metadata?: Record<string, unknown>;
};

export type AgentToolResult<T = unknown> = {
  ok: boolean;
  dryRun: boolean;
  action: AgentActionType;
  summary: string;
  data: T | null;
  findings: AgentFinding[];
  blockedActions: AgentAction[];
};

export type AgentRunResult<T = unknown> = {
  agentName: AgentName;
  mode: AgentMode;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "reviewRequired" | "blocked" | "failed";
  summary: string;
  decision: AgentDecision;
  findings: AgentFinding[];
  recommendations: AgentRecommendation[];
  blockedActions: AgentAction[];
  data: T;
};

export type BotHealthSnapshot = {
  botName: string;
  strategy: string;
  marketIds: string[];
  enabled: boolean;
  dryRun: boolean;
  recentErrorCount: number;
  recentOrderFailureCount: number;
  staleQuoteCount: number;
  dailyNotionalUsedCents: number;
  maxDailyNotionalCents: number;
};

export type OrderIntent = {
  marketId: string;
  outcomeId: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  reason: string;
  clientOrderId?: string;
};

export type ResolutionReviewInput = {
  marketId: string;
  marketTitle: string;
  candidateWinningOutcomeId: string | null;
  evidence: string[];
  confidence: number;
  approvedByAdmin: boolean;
};

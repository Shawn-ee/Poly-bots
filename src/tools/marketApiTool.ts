import { ApiClient } from "../api/apiClient.js";
import {
  AdminImportReferenceMarketRequest,
  AdminImportReferenceMarketResponse,
  MarketDiscoveryResponse,
  MarketSummary,
} from "../api/types.js";
import { AgentRunContext, AgentToolResult } from "../agents/types.js";
import { blockedAction, buildAgentAction, isAgentActionAllowed } from "../agents/policies.js";

export type MarketApiTool = {
  listMarkets(filters?: Parameters<ApiClient["listMarkets"]>[0]): Promise<AgentToolResult<MarketDiscoveryResponse>>;
  getMarket(marketId: string): Promise<AgentToolResult<MarketSummary | null>>;
  listEvents(): Promise<AgentToolResult<unknown[]>>;
  getEvent(eventId: string): Promise<AgentToolResult<unknown | null>>;
  prepareCreateDraftMarketPayload(input: AdminImportReferenceMarketRequest): AgentToolResult<AdminImportReferenceMarketRequest>;
  validateMarketDraftPayload(input: AdminImportReferenceMarketRequest): AgentToolResult<{ valid: boolean }>;
  recommendMarketImport(input: AdminImportReferenceMarketRequest): AgentToolResult<AdminImportReferenceMarketRequest>;
  createDraftMarket(input: AdminImportReferenceMarketRequest): Promise<AgentToolResult<AdminImportReferenceMarketResponse | null>>;
  approveMarket(marketId: string): AgentToolResult<null>;
  activateMarket(marketId: string): AgentToolResult<null>;
};

export function createMarketApiTool(client: ApiClient | null, context: AgentRunContext): MarketApiTool {
  return {
    async listMarkets(filters = {}) {
      if (!client) {
        return missingClientResult("list markets", context);
      }
      return {
        ok: true,
        dryRun: context.dryRun,
        action: "GENERATE_REPORT",
        summary: "Listed markets through existing API client.",
        data: await client.listMarkets(filters),
        findings: [],
        blockedActions: [],
      };
    },

    async getMarket(marketId) {
      if (!client) {
        return missingClientResult("get market", context);
      }
      const page = await client.listMarkets({ view: "all" });
      return {
        ok: true,
        dryRun: context.dryRun,
        action: "GENERATE_REPORT",
        summary: `Fetched market ${marketId} from market list.`,
        data: page.markets.find((market) => market.id === marketId) ?? null,
        findings: [],
        blockedActions: [],
      };
    },

    async listEvents() {
      return {
        ok: true,
        dryRun: true,
        action: "GENERATE_REPORT",
        summary: "Event listing is not exposed by the current bot API client; no request was made.",
        data: [],
        findings: [
          {
            severity: "info",
            code: "events_api_not_configured",
            message: "No event listing method exists in the current ApiClient.",
          },
        ],
        blockedActions: [],
      };
    },

    async getEvent(eventId) {
      return {
        ok: true,
        dryRun: true,
        action: "GENERATE_REPORT",
        summary: `Event ${eventId} was not fetched because the current ApiClient has no event getter.`,
        data: null,
        findings: [
          {
            severity: "info",
            code: "event_api_not_configured",
            message: "No event getter exists in the current ApiClient.",
            targetId: eventId,
          },
        ],
        blockedActions: [],
      };
    },

    prepareCreateDraftMarketPayload(input) {
      const payload = forceDraftReferencePayload(input);
      return {
        ok: true,
        dryRun: true,
        action: "RECOMMEND_MARKET_CREATION",
        summary: "Prepared draft-only market payload.",
        data: payload,
        findings: [],
        blockedActions: [],
      };
    },

    validateMarketDraftPayload(input) {
      const findings = validateDraftPayload(input);
      return {
        ok: findings.every((finding) => finding.severity !== "critical"),
        dryRun: true,
        action: "REVIEW_RISK",
        summary: findings.length ? "Draft payload requires review." : "Draft payload is safe to review.",
        data: { valid: findings.every((finding) => finding.severity !== "critical") },
        findings,
        blockedActions: [],
      };
    },

    recommendMarketImport(input) {
      const payload = forceDraftReferencePayload(input);
      return {
        ok: true,
        dryRun: true,
        action: "RECOMMEND_MARKET_CREATION",
        summary: "Recommended draft-only reference market import.",
        data: payload,
        findings: validateDraftPayload(payload),
        blockedActions: [],
      };
    },

    async createDraftMarket(input) {
      const payload = forceDraftReferencePayload(input);
      const validation = validateDraftPayload(payload);
      if (!isAgentActionAllowed("CREATE_DRAFT_MARKET", context) || context.dryRun || !client) {
        return {
          ok: validation.every((finding) => finding.severity !== "critical"),
          dryRun: true,
          action: "CREATE_DRAFT_MARKET",
          summary: "Draft market creation was prepared only; no API mutation was made.",
          data: null,
          findings: validation,
          blockedActions: [
            blockedAction(
              "CREATE_DRAFT_MARKET",
              "Create draft market through admin reference import API",
              context,
              context.dryRun ? "agent mode is dry-run/review" : "API client missing or draft creation disabled",
            ),
          ],
        };
      }
      return {
        ok: true,
        dryRun: false,
        action: "CREATE_DRAFT_MARKET",
        summary: "Created draft market through existing admin reference import API.",
        data: await client.importAdminReferenceMarket(payload),
        findings: validation,
        blockedActions: [],
      };
    },

    approveMarket(marketId) {
      return blockedOnly("ACTIVATE_MARKET", `Approve market ${marketId}`, context);
    },

    activateMarket(marketId) {
      return blockedOnly("ACTIVATE_MARKET", `Activate market ${marketId}`, context);
    },
  };
}

export function forceDraftReferencePayload(input: AdminImportReferenceMarketRequest): AdminImportReferenceMarketRequest {
  return {
    ...input,
    market: {
      ...input.market,
      desiredStatus: "draft",
      referenceMetadata: {
        ...(isRecord(input.market.referenceMetadata) ? input.market.referenceMetadata : {}),
        importStatus: "pending_review",
        listed: false,
        tradable: false,
        mmEnabled: false,
        referenceOnly: true,
        autoPublish: false,
        autoResolve: false,
      },
      outcomes: input.market.outcomes.map((outcome) => ({
        ...outcome,
        isTradable: false,
      })),
    },
  };
}

export function validateDraftPayload(input: AdminImportReferenceMarketRequest) {
  const findings = [];
  if (!input.market.title.trim()) {
    findings.push({ severity: "critical" as const, code: "missing_title", message: "Draft market title is required." });
  }
  if (!input.market.outcomes.length) {
    findings.push({ severity: "critical" as const, code: "missing_outcomes", message: "Draft market outcomes are required." });
  }
  if (input.market.desiredStatus && input.market.desiredStatus !== "draft") {
    findings.push({ severity: "critical" as const, code: "active_market_blocked", message: "Agents may create draft markets only." });
  }
  if (input.market.outcomes.some((outcome) => outcome.isTradable === true)) {
    findings.push({ severity: "critical" as const, code: "tradable_outcome_blocked", message: "Draft import outcomes must not be tradable." });
  }
  return findings;
}

function missingClientResult<T>(operation: string, context: AgentRunContext): AgentToolResult<T> {
  return {
    ok: false,
    dryRun: true,
    action: "GENERATE_REPORT",
    summary: `Cannot ${operation}; no API client was provided.`,
    data: null,
    findings: [
      {
        severity: "warning",
        code: "api_client_missing",
        message: "Tool ran without an ApiClient and made no network request.",
      },
    ],
    blockedActions: [buildAgentAction("GENERATE_REPORT", `Missing client for ${operation}`, context)],
  };
}

function blockedOnly(action: "ACTIVATE_MARKET", description: string, context: AgentRunContext): AgentToolResult<null> {
  return {
    ok: false,
    dryRun: true,
    action,
    summary: `${description} is blocked by agent policy.`,
    data: null,
    findings: [
      {
        severity: "critical",
        code: "action_blocked",
        message: "Agents cannot approve or activate markets by default.",
      },
    ],
    blockedActions: [blockedAction(action, description, context, "market activation requires explicit admin workflow")],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}


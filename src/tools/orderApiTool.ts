import { ApiClient } from "../api/apiClient.js";
import { CursorPage, Fill, Order, PlaceOrderResponse, QuoteResponse } from "../api/types.js";
import { blockedAction } from "../agents/policies.js";
import { AgentRunContext, AgentToolResult, OrderIntent } from "../agents/types.js";

export type OrderApiTool = {
  getOrderBook(marketId: string): Promise<AgentToolResult<QuoteResponse | null>>;
  getOpenOrders(marketId?: string): Promise<AgentToolResult<CursorPage<Order> | null>>;
  getRecentTrades(marketId?: string): Promise<AgentToolResult<CursorPage<Fill> | null>>;
  estimateOrderImpact(intent: OrderIntent): AgentToolResult<{ estimatedNotional: number; warnings: string[] }>;
  prepareOrderIntent(intent: OrderIntent): AgentToolResult<OrderIntent>;
  validateOrderIntent(intent: OrderIntent): AgentToolResult<{ valid: boolean }>;
  placeOrderDryRun(intent: OrderIntent): AgentToolResult<OrderIntent>;
  cancelOrderDryRun(orderId: string): AgentToolResult<{ orderId: string }>;
  placeOrderLive(intent: OrderIntent): Promise<AgentToolResult<PlaceOrderResponse | null>>;
};

export function createOrderApiTool(client: ApiClient | null, context: AgentRunContext): OrderApiTool {
  return {
    async getOrderBook(marketId) {
      if (!client) return missingClient("get order book");
      return {
        ok: true,
        dryRun: context.dryRun,
        action: "GENERATE_REPORT",
        summary: `Fetched order book quote for market ${marketId}.`,
        data: await client.getQuote(marketId),
        findings: [],
        blockedActions: [],
      };
    },

    async getOpenOrders(marketId) {
      if (!client) return missingClient("get open orders");
      return {
        ok: true,
        dryRun: context.dryRun,
        action: "GENERATE_REPORT",
        summary: "Fetched open orders through existing API client.",
        data: await client.getOrders({
          ...(marketId ? { marketId } : {}),
          status: ["OPEN", "PARTIAL"],
        }),
        findings: [],
        blockedActions: [],
      };
    },

    async getRecentTrades(marketId) {
      if (!client) return missingClient("get recent trades");
      return {
        ok: true,
        dryRun: context.dryRun,
        action: "GENERATE_REPORT",
        summary: "Fetched recent fills through existing API client.",
        data: await client.getFills({
          ...(marketId ? { marketId } : {}),
          limit: 50,
        }),
        findings: [],
        blockedActions: [],
      };
    },

    estimateOrderImpact(intent) {
      const estimatedNotional = Number(intent.price) * Number(intent.size);
      const warnings = [];
      if (!Number.isFinite(estimatedNotional)) warnings.push("invalid numeric price or size");
      if (estimatedNotional > 100) warnings.push("order notional exceeds conservative agent review threshold");
      return {
        ok: warnings.length === 0,
        dryRun: true,
        action: "REVIEW_RISK",
        summary: "Estimated order impact without placing an order.",
        data: { estimatedNotional: Number.isFinite(estimatedNotional) ? estimatedNotional : 0, warnings },
        findings: warnings.map((message) => ({ severity: "warning" as const, code: "order_impact_warning", message })),
        blockedActions: [],
      };
    },

    prepareOrderIntent(intent) {
      return {
        ok: true,
        dryRun: true,
        action: "PLACE_ORDER",
        summary: "Prepared order intent for deterministic risk review only.",
        data: intent,
        findings: [],
        blockedActions: [],
      };
    },

    validateOrderIntent(intent) {
      const findings = validateOrderIntent(intent);
      return {
        ok: findings.length === 0,
        dryRun: true,
        action: "REVIEW_RISK",
        summary: findings.length ? "Order intent is not safe." : "Order intent is structurally valid for dry-run review.",
        data: { valid: findings.length === 0 },
        findings,
        blockedActions: [],
      };
    },

    placeOrderDryRun(intent) {
      return {
        ok: validateOrderIntent(intent).length === 0,
        dryRun: true,
        action: "PLACE_ORDER",
        summary: "Dry-run order placement only; no API request was made.",
        data: intent,
        findings: validateOrderIntent(intent),
        blockedActions: [blockedAction("PLACE_ORDER", "Live order placement", context, "agents cannot place live orders by default")],
      };
    },

    cancelOrderDryRun(orderId) {
      return {
        ok: true,
        dryRun: true,
        action: "CANCEL_ORDER",
        summary: "Dry-run order cancellation only; no API request was made.",
        data: { orderId },
        findings: [],
        blockedActions: [blockedAction("CANCEL_ORDER", "Live order cancellation", context, "agents cannot cancel live orders by default")],
      };
    },

    async placeOrderLive(intent) {
      const findings = validateOrderIntent(intent);
      if (!client || !context.allowLiveTradingActions || context.dryRun) {
        return {
          ok: false,
          dryRun: true,
          action: "PLACE_ORDER",
          summary: "Live order placement blocked by agent policy.",
          data: null,
          findings,
          blockedActions: [blockedAction("PLACE_ORDER", "Live order placement", context, "live trading flag is disabled")],
        };
      }
      return {
        ok: true,
        dryRun: false,
        action: "PLACE_ORDER",
        summary: "Live order submitted through existing API client.",
        data: await client.placeLimitOrder(
          {
            marketId: intent.marketId,
            outcomeId: intent.outcomeId,
            side: intent.side,
            price: intent.price,
            size: intent.size,
            ...(intent.clientOrderId ? { clientOrderId: intent.clientOrderId } : {}),
          },
          intent.clientOrderId ?? `agent-${Date.now()}`,
        ),
        findings,
        blockedActions: [],
      };
    },
  };
}

export function validateOrderIntent(intent: OrderIntent) {
  const findings = [];
  if (!intent.marketId) findings.push({ severity: "critical" as const, code: "missing_market", message: "Order intent requires a market id." });
  if (!intent.outcomeId) findings.push({ severity: "critical" as const, code: "missing_outcome", message: "Order intent requires an outcome id." });
  if (!["BUY", "SELL"].includes(intent.side)) findings.push({ severity: "critical" as const, code: "invalid_side", message: "Order side must be BUY or SELL." });
  if (!Number.isFinite(Number(intent.price)) || Number(intent.price) <= 0 || Number(intent.price) >= 1) {
    findings.push({ severity: "critical" as const, code: "invalid_price", message: "Order price must be between 0 and 1." });
  }
  if (!Number.isFinite(Number(intent.size)) || Number(intent.size) <= 0) {
    findings.push({ severity: "critical" as const, code: "invalid_size", message: "Order size must be positive." });
  }
  return findings;
}

function missingClient<T>(operation: string): AgentToolResult<T> {
  return {
    ok: false,
    dryRun: true,
    action: "GENERATE_REPORT",
    summary: `Cannot ${operation}; no API client was provided.`,
    data: null,
    findings: [{ severity: "warning", code: "api_client_missing", message: "No network request was made." }],
    blockedActions: [],
  };
}

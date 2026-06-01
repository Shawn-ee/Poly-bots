import { ApiClient } from "../api/apiClient.js";
import {
  AdminReferenceMarketItem,
  BotInitializationMetadata,
  MarketReferencePlanOutcome,
  MarketReferencePlanResponse,
} from "../api/types.js";
import { AppConfig, BotConfig } from "../config/loadConfig.js";
import { shiftPriceByTicks } from "../strategies/shared/common.js";

export type MarketReadinessResult = {
  ready: boolean;
  dryRun: boolean;
  liveRequested: boolean;
  reasons: string[];
  riskProfile: string | null;
  referenceBid: number | null;
  referenceAsk: number | null;
  plannedBotBid: number | null;
  plannedBotAsk: number | null;
  mmEligible: boolean;
  checkedAt: string;
  botConfigName: string | null;
  selectedOutcomeId: string | null;
  selectedOutcomeName: string | null;
};

export type LiveInitializationAction = {
  action: "place";
  outcomeId: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
};

export function selectBotConfigForMarket(config: AppConfig, marketId: string): BotConfig | null {
  return config.bots.find((bot) => bot.marketIds.includes(marketId)) ?? config.bots[0] ?? null;
}

export function evaluateMarketReadiness(params: {
  market: AdminReferenceMarketItem;
  reference: MarketReferencePlanResponse;
  botConfig: BotConfig | null;
  dryRun: boolean;
  confirmLive: boolean;
  liveOrdersEnabled: boolean;
  maxReferenceSpread?: number;
}) : MarketReadinessResult {
  const checkedAt = new Date().toISOString();
  const reasons: string[] = [];
  const market = params.market;
  const outcome = selectPrimaryOutcome(params.reference.outcomes);
  const riskProfile = params.botConfig?.name ?? null;
  const maxReferenceSpread = params.maxReferenceSpread ?? 0.1;

  if (market.referenceSource !== "polymarket") {
    reasons.push("not_polymarket_reference");
  }
  if (market.importStatus !== "approved") {
    reasons.push("market_not_approved");
  }
  if (!market.isListed) {
    reasons.push("market_not_listed");
  }
  if (!market.externalSlug) {
    reasons.push("missing_external_slug");
  }
  if (market.outcomes.some((entry) => !entry.referenceTokenId)) {
    reasons.push("missing_reference_token_id");
  }
  if (market.outcomes.length !== 2) {
    reasons.push("market_not_binary");
  }
  if (!params.botConfig) {
    reasons.push("missing_bot_risk_config");
  }
  if (!outcome || !outcome.hasSnapshot) {
    reasons.push("missing_reference_snapshot");
  } else {
    if (!outcome.isFresh) {
      reasons.push("reference_stale");
    }
    if (outcome.gammaBestBid == null || outcome.gammaBestAsk == null) {
      reasons.push("reference_missing_book");
    }
    if (outcome.gammaSpread == null || outcome.gammaSpread > maxReferenceSpread) {
      reasons.push("reference_spread_too_wide");
    }
    if (!outcome.acceptingOrders) {
      reasons.push("reference_not_accepting_orders");
    }
    if (outcome.qualityStatus !== "high_quality" && outcome.qualityStatus !== "available") {
      reasons.push("reference_quality_not_acceptable");
    }
  }

  if (params.dryRun) {
    if (process.env.SYSTEM_LIQUIDITY_DRY_RUN === "false") {
      reasons.push("dry_run_disabled");
    }
  } else {
    if (!params.confirmLive) {
      reasons.push("confirm_live_required");
    }
    if (!market.tradable) {
      reasons.push("market_not_tradable");
    }
    if (market.outcomes.some((entry) => !entry.isTradable)) {
      reasons.push("outcome_not_tradable");
    }
    if (!market.mmEnabled) {
      reasons.push("market_mm_disabled");
    }
    if (!params.liveOrdersEnabled) {
      reasons.push("live_orders_disabled");
    }
    if (!params.botConfig?.risk.botUserId) {
      reasons.push("missing_system_bot_account");
    }
    if (!params.botConfig || params.botConfig.apiKey === "dry-run.not-used") {
      reasons.push("missing_live_bot_credentials");
    }
  }

  return {
    ready: reasons.length === 0,
    dryRun: params.dryRun,
    liveRequested: !params.dryRun,
    reasons,
    riskProfile,
    referenceBid: outcome?.referenceBid ?? null,
    referenceAsk: outcome?.referenceAsk ?? null,
    plannedBotBid: outcome?.plannedBotBid ?? null,
    plannedBotAsk: outcome?.plannedBotAsk ?? null,
    mmEligible: outcome?.mmEligible ?? false,
    checkedAt,
    botConfigName: params.botConfig?.name ?? null,
    selectedOutcomeId: outcome?.localOutcomeId ?? null,
    selectedOutcomeName: outcome?.outcomeName ?? null,
  };
}

export function buildBotInitializationMetadata(input: {
  current: BotInitializationMetadata | null | undefined;
  readiness: MarketReadinessResult;
}): Partial<BotInitializationMetadata> {
  const status = input.readiness.ready
    ? input.readiness.dryRun
      ? "dry_run_ready"
      : "live_ready"
    : input.readiness.referenceBid != null || input.readiness.referenceAsk != null
      ? "reference_verified"
      : "blocked";

  return {
    status,
    lastCheckedAt: input.readiness.checkedAt,
    reason: input.readiness.reasons[0] ?? null,
    approvedBy: input.current?.approvedBy ?? null,
    approvedAt: input.current?.approvedAt ?? null,
    riskProfile: input.readiness.riskProfile,
    readiness: {
      ready: input.readiness.ready,
      dryRun: input.readiness.dryRun,
      liveRequested: input.readiness.liveRequested,
      reasons: input.readiness.reasons,
      referenceBid: input.readiness.referenceBid,
      referenceAsk: input.readiness.referenceAsk,
      plannedBotBid: input.readiness.plannedBotBid,
      plannedBotAsk: input.readiness.plannedBotAsk,
      riskProfile: input.readiness.riskProfile,
      checkedAt: input.readiness.checkedAt,
    },
  };
}

export async function cancelExistingOrdersForMarket(
  api: ApiClient,
  marketId: string,
): Promise<string[]> {
  const orders = await api.getOrders({
    marketId,
    status: ["OPEN", "PARTIAL"],
    limit: 100,
  });
  const canceled: string[] = [];
  for (const order of orders.items) {
    await api.cancelOrder(order.id);
    canceled.push(order.id);
  }
  return canceled;
}

export async function placeInitialLiveOrders(
  api: ApiClient,
  params: {
    marketId: string;
    outcomeId: string;
    bidPrice: number | null;
    askPrice: number | null;
    size: string;
    tickSize: string;
  },
): Promise<LiveInitializationAction[]> {
  const actions: LiveInitializationAction[] = [];
  if (params.bidPrice != null) {
    const price = clampPriceString(params.bidPrice.toFixed(2), params.tickSize);
    await api.placeLimitOrder(
      {
        marketId: params.marketId,
        outcomeId: params.outcomeId,
        side: "BUY",
        price,
        size: params.size,
      },
      `init-${params.marketId}-${params.outcomeId}-buy`,
    );
    actions.push({ action: "place", outcomeId: params.outcomeId, side: "BUY", price, size: params.size });
  }
  if (params.askPrice != null) {
    const price = clampPriceString(params.askPrice.toFixed(2), params.tickSize);
    await api.placeLimitOrder(
      {
        marketId: params.marketId,
        outcomeId: params.outcomeId,
        side: "SELL",
        price,
        size: params.size,
      },
      `init-${params.marketId}-${params.outcomeId}-sell`,
    );
    actions.push({ action: "place", outcomeId: params.outcomeId, side: "SELL", price, size: params.size });
  }
  return actions;
}

export function buildLivePreviewOrderPlan(params: {
  outcome: MarketReferencePlanOutcome | null;
  quoteOffsetTicks: number;
  tickSize: string;
}) {
  if (!params.outcome) {
    return { plannedBotBid: null, plannedBotAsk: null };
  }
  return {
    plannedBotBid:
      params.outcome.referenceBid != null
        ? clampNumber(shiftPriceByTicks(params.outcome.referenceBid.toFixed(2), params.tickSize, -params.quoteOffsetTicks))
        : null,
    plannedBotAsk:
      params.outcome.referenceAsk != null
        ? clampNumber(shiftPriceByTicks(params.outcome.referenceAsk.toFixed(2), params.tickSize, params.quoteOffsetTicks))
        : null,
  };
}

function selectPrimaryOutcome(outcomes: MarketReferencePlanResponse["outcomes"]) {
  return outcomes.find((entry) => entry.outcomeName.trim().toUpperCase() === "YES") ?? outcomes[0] ?? null;
}

function clampPriceString(price: string, tickSize: string) {
  return shiftPriceByTicks(String(Math.max(0.01, Math.min(0.99, Number(price))).toFixed(2)), tickSize, 0);
}

function clampNumber(price: string) {
  const numeric = Number(price);
  return Number.isFinite(numeric) ? Number(Math.max(0.01, Math.min(0.99, numeric)).toFixed(2)) : null;
}

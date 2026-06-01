import { AdminReferenceMarketItem, Balance, MarketReferencePlanOutcome, MarketReferencePlanResponse, Order, Position, QuoteResponse } from "../api/types.js";
import { shiftPriceByTicks } from "../strategies/shared/common.js";

export type LiveRiskConfig = {
  referenceStaleMs: number;
  maxReferenceSpread: number;
  quoteOffsetTicks: number;
  tickSize: string;
  maxSingleOrderNotionalCents: number;
  maxOpenOrderNotionalCents: number;
  maxDailyLossCents: number;
  maxInventoryPerOutcome: number;
  minOutcomeInventory: number;
  minCashReserveCents: number;
  maxShareSize: number;
  minQuoteLifetimeMs: number;
  requoteThresholdTicks: number;
};

export type LiveReadinessResult = {
  ready: boolean;
  reasons: string[];
  referenceBid: number | null;
  referenceAsk: number | null;
  plannedBotBid: number | null;
  plannedBotAsk: number | null;
  mmEligible: boolean;
  openOrderNotionalCents: number;
  dailyLossCents: number;
};

export type DesiredQuote = {
  outcomeId: string;
  outcomeName: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  idempotencyKey: string;
};

export function evaluateLiveReadiness(params: {
  market: AdminReferenceMarketItem;
  reference: MarketReferencePlanResponse;
  balance: Balance;
  positions: Position[];
  openOrders: Order[];
  confirmLive: boolean;
  liveOrdersEnabled: boolean;
  systemLiquidityDryRun: boolean;
  runtimePresent: boolean;
  risk: LiveRiskConfig;
  now?: number;
}) : LiveReadinessResult {
  const now = params.now ?? Date.now();
  const reasons: string[] = [];
  const yesOutcome =
    params.reference.outcomes.find((outcome) => outcome.outcomeName.trim().toUpperCase() === "YES") ??
    params.reference.outcomes[0] ??
    null;

  if (params.market.referenceSource !== "polymarket") reasons.push("not_polymarket_reference");
  if (params.market.importStatus !== "approved") reasons.push("market_not_approved");
  if (!params.market.isListed) reasons.push("market_not_listed");
  if (params.market.status !== "LIVE") reasons.push("market_not_live");
  if (!params.market.externalSlug) reasons.push("missing_external_slug");
  if (params.market.outcomes.length !== 2) reasons.push("market_not_binary");
  if (params.market.outcomes.some((outcome) => !outcome.referenceTokenId)) reasons.push("missing_reference_token_id");
  if (params.market.tradable !== true) reasons.push("market_not_tradable");
  if (params.market.mmEnabled !== true) reasons.push("market_mm_disabled");
  if (params.market.outcomes.some((outcome) => !outcome.isTradable)) reasons.push("outcome_not_tradable");
  if (!params.confirmLive) reasons.push("confirm_live_required");
  if (!params.liveOrdersEnabled) reasons.push("live_orders_disabled");
  if (params.systemLiquidityDryRun) reasons.push("dry_run_enabled");
  if (!params.runtimePresent) reasons.push("bot_not_seeded");
  if (!params.market.botInitialization?.capital?.botUserId) reasons.push("missing_system_bot_account");
  if (!params.market.botInitialization?.capital?.botApiCredentialId) reasons.push("missing_live_bot_credentials");
  if (params.market.botInitialization?.capital?.autoReplenish) reasons.push("auto_replenish_enabled");
  if (
    !params.market.botInitialization?.capital?.budgetCents ||
    !params.market.botInitialization?.capital?.mintBudgetCents ||
    !params.market.botInitialization?.capital?.cashReserveCents ||
    !params.market.botInitialization?.capital?.maxSingleOrderNotionalCents ||
    !params.market.botInitialization?.capital?.maxOpenOrderNotionalCents ||
    !params.market.botInitialization?.capital?.maxDailyLossCents
  ) {
    reasons.push("missing_risk_caps");
  }
  if (params.market.botInitialization?.status !== "live_ready" && params.market.botInitialization?.status !== "live_enabled") {
    reasons.push("lifecycle_not_live_ready");
  }
  if (params.market.botInitialization?.runtime?.emergencyStop) reasons.push("emergency_stop");

  if (!yesOutcome || !yesOutcome.hasSnapshot) {
    reasons.push("missing_reference_snapshot");
  } else {
    const ageMs = yesOutcome.ageMs ?? (yesOutcome.fetchedAt ? Math.max(0, now - Date.parse(yesOutcome.fetchedAt)) : null);
    if (!ageMs || ageMs > params.risk.referenceStaleMs || !yesOutcome.isFresh) reasons.push("reference_stale");
    if (yesOutcome.gammaBestBid == null || yesOutcome.gammaBestAsk == null) reasons.push("reference_missing_book");
    if (yesOutcome.gammaSpread == null || yesOutcome.gammaSpread > params.risk.maxReferenceSpread) reasons.push("reference_spread_too_wide");
    if (!yesOutcome.acceptingOrders) reasons.push("reference_not_accepting_orders");
    if (yesOutcome.qualityStatus !== "high_quality" && yesOutcome.qualityStatus !== "available") {
      reasons.push("reference_quality_not_acceptable");
    }
  }

  const openOrderNotionalCents = params.openOrders.reduce(
    (sum, order) => sum + Math.round(Number(order.reservedNotional) * 100),
    0,
  );
  const dailyLossCents = Math.max(
    0,
    Math.round(params.positions.reduce((sum, position) => sum + Math.min(0, Number(position.realizedPnl ?? 0)), 0) * -100),
  );
  if (openOrderNotionalCents >= params.risk.maxOpenOrderNotionalCents) reasons.push("max_open_order_notional_reached");
  if (dailyLossCents >= params.risk.maxDailyLossCents) reasons.push("daily_loss_limit_reached");

  return {
    ready: reasons.length === 0,
    reasons,
    referenceBid: yesOutcome?.referenceBid ?? null,
    referenceAsk: yesOutcome?.referenceAsk ?? null,
    plannedBotBid: yesOutcome?.plannedBotBid ?? null,
    plannedBotAsk: yesOutcome?.plannedBotAsk ?? null,
    mmEligible: yesOutcome?.mmEligible ?? false,
    openOrderNotionalCents,
    dailyLossCents,
  };
}

export function buildDesiredQuotes(params: {
  reference: MarketReferencePlanResponse;
  localQuote: QuoteResponse;
  balance: Balance;
  positions: Position[];
  openOrders: Order[];
  marketId: string;
  risk: LiveRiskConfig;
  cycleTs: number;
}) : DesiredQuote[] {
  const byOutcomeQuote = new Map(params.localQuote.quotes.map((quote) => [quote.outcomeId, quote]));
  const byOutcomePosition = new Map(params.positions.map((position) => [position.outcomeId, position]));
  const availableCash = Number(params.balance.availableUSDC);
  const availableCashAboveReserve = Math.max(0, availableCash - params.risk.minCashReserveCents / 100);
  const desired: DesiredQuote[] = [];
  const yesOutcome =
    params.reference.outcomes.find((outcome) => outcome.outcomeName.trim().toUpperCase() === "YES") ??
    params.reference.outcomes[0] ??
    null;

  for (const outcome of params.reference.outcomes) {
    const referencePair = deriveReferencePair(outcome, yesOutcome);
    if (!outcome.quotePreviewAvailable || referencePair.referenceBid == null || referencePair.referenceAsk == null) {
      continue;
    }
    const local = byOutcomeQuote.get(outcome.localOutcomeId);
    const position = byOutcomePosition.get(outcome.localOutcomeId);
    const desiredBid = clampPrice(referencePair.referenceBid, params.risk.tickSize, -params.risk.quoteOffsetTicks);
    const desiredAsk = clampPrice(referencePair.referenceAsk, params.risk.tickSize, params.risk.quoteOffsetTicks);
    const nonCrossBid = local?.bestAsk ? Math.min(desiredBid, Math.max(0.01, Number(local.bestAsk) - Number(params.risk.tickSize))) : desiredBid;
    const nonCrossAsk = local?.bestBid ? Math.max(desiredAsk, Math.min(0.99, Number(local.bestBid) + Number(params.risk.tickSize))) : desiredAsk;
    if (nonCrossBid >= nonCrossAsk) {
      continue;
    }

    const bidSize = computeOrderSize({
      price: nonCrossBid,
      maxSingleOrderNotionalCents: params.risk.maxSingleOrderNotionalCents,
      maxShareSize: params.risk.maxShareSize,
      hardCapShares: availableCashAboveReserve > 0 ? availableCashAboveReserve / nonCrossBid : 0,
    });
    if (bidSize > 0) {
      desired.push({
        outcomeId: outcome.localOutcomeId,
        outcomeName: outcome.outcomeName,
        side: "BUY",
        price: nonCrossBid.toFixed(2),
        size: bidSize.toFixed(6),
        idempotencyKey: `ref-live-${params.marketId}-${outcome.localOutcomeId}-buy-${nonCrossBid.toFixed(2)}-${Math.floor(params.cycleTs / 1000)}`,
      });
    }

    const shares = Number(position?.shares ?? "0");
    const reservedShares = Number(position?.reservedShares ?? "0");
    const availableShares = Math.max(0, shares - reservedShares - params.risk.minOutcomeInventory);
    const askSize = computeOrderSize({
      price: nonCrossAsk,
      maxSingleOrderNotionalCents: params.risk.maxSingleOrderNotionalCents,
      maxShareSize: params.risk.maxShareSize,
      hardCapShares: Math.min(availableShares, params.risk.maxInventoryPerOutcome),
    });
    if (askSize > 0) {
      desired.push({
        outcomeId: outcome.localOutcomeId,
        outcomeName: outcome.outcomeName,
        side: "SELL",
        price: nonCrossAsk.toFixed(2),
        size: askSize.toFixed(6),
        idempotencyKey: `ref-live-${params.marketId}-${outcome.localOutcomeId}-sell-${nonCrossAsk.toFixed(2)}-${Math.floor(params.cycleTs / 1000)}`,
      });
    }
  }

  return desired;
}

function deriveReferencePair(
  outcome: MarketReferencePlanOutcome,
  yesOutcome: MarketReferencePlanOutcome | null,
) {
  if (outcome.outcomeName.trim().toUpperCase() !== "NO" || !yesOutcome || yesOutcome.referenceBid == null || yesOutcome.referenceAsk == null) {
    return {
      referenceBid: outcome.referenceBid,
      referenceAsk: outcome.referenceAsk,
    };
  }

  const looksMirrored =
    outcome.referenceBid != null &&
    outcome.referenceAsk != null &&
    Math.abs(outcome.referenceBid - yesOutcome.referenceBid) < 0.000001 &&
    Math.abs(outcome.referenceAsk - yesOutcome.referenceAsk) < 0.000001;

  if (!looksMirrored) {
    return {
      referenceBid: outcome.referenceBid,
      referenceAsk: outcome.referenceAsk,
    };
  }

  return {
    referenceBid: Number((1 - yesOutcome.referenceAsk).toFixed(3)),
    referenceAsk: Number((1 - yesOutcome.referenceBid).toFixed(3)),
  };
}

export function reconcileQuotes(params: {
  desired: DesiredQuote[];
  openOrders: Order[];
  nowMs: number;
  minQuoteLifetimeMs: number;
  requoteThresholdTicks: number;
  tickSize: string;
}) {
  const desiredByKey = new Map(params.desired.map((entry) => [`${entry.outcomeId}:${entry.side}`, entry]));
  const toCancel: Order[] = [];
  const toPlace: DesiredQuote[] = [];

  for (const order of params.openOrders) {
    const desired = desiredByKey.get(`${order.outcomeId}:${order.side}`);
    if (!desired) {
      toCancel.push(order);
      continue;
    }
    const ageMs = params.nowMs - Date.parse(order.createdAt ?? new Date(0).toISOString());
    const tickDelta = Math.abs(Number(desired.price) - Number(order.price)) / Number(params.tickSize);
    const sizeChanged = Math.abs(Number(desired.size) - Number(order.remaining)) > 0.000001;
    if (Number(order.price) === Number(desired.price) && !sizeChanged) {
      desiredByKey.delete(`${order.outcomeId}:${order.side}`);
      continue;
    }
    if (ageMs >= params.minQuoteLifetimeMs && (tickDelta >= params.requoteThresholdTicks || sizeChanged)) {
      toCancel.push(order);
      desiredByKey.delete(`${order.outcomeId}:${order.side}`);
      toPlace.push(desired);
      continue;
    }
    desiredByKey.delete(`${order.outcomeId}:${order.side}`);
  }

  for (const desired of desiredByKey.values()) {
    toPlace.push(desired);
  }

  return { toCancel, toPlace };
}

function computeOrderSize(params: {
  price: number;
  maxSingleOrderNotionalCents: number;
  maxShareSize: number;
  hardCapShares: number;
}) {
  if (!(params.price > 0) || !(params.hardCapShares > 0)) {
    return 0;
  }
  const notionalCapShares = params.maxSingleOrderNotionalCents / 100 / params.price;
  const size = Math.min(params.maxShareSize, params.hardCapShares, notionalCapShares);
  return size >= 0.000001 ? Number(size.toFixed(6)) : 0;
}

function clampPrice(referencePrice: number, tickSize: string, ticks: number) {
  const shifted = shiftPriceByTicks(referencePrice.toFixed(2), tickSize, ticks);
  return Number(Math.max(0.01, Math.min(0.99, Number(shifted))).toFixed(2));
}

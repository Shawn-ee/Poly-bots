import { PolyApiError, ApiClient } from "../api/apiClient.js";
import { Balance, Fill, MarketSummary, Order, Position, Quote, QuoteResponse } from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { StrategyAction, StrategyCategory } from "../strategies/shared/types.js";
import { BotControlFileStore, BotControlOverride, BotRuntimeState } from "./botControlFile.js";

type FreshnessLike = {
  marketStateAgeMs: number | null;
  accountStateAgeMs: number | null;
  staleStateDetectedCount: number;
};

type MarketExposureSnapshot = {
  marketId: string;
  exposureCents: number;
  openOrderNotionalCents: number;
  yesShares: number;
  noShares: number;
  nearResolution: boolean;
  resolveTime: string | null;
};

export type RiskEvaluation = {
  state: BotRuntimeState;
  reason: string | null;
  market: MarketExposureSnapshot;
  totalExposureCents: number;
  openOrderNotionalCents: number;
  lossCheckPnlCents: number;
};

export type PlacementRiskContext = {
  marketId: string;
  outcomeId: string;
  action: Extract<StrategyAction, { type: "place" }>;
  balance: Balance;
  positions: Position[];
  openOrders: Order[];
  quote: Quote;
  marketQuotes: QuoteResponse["quotes"];
  freshness: FreshnessLike;
  evaluation: RiskEvaluation;
};

export type PlacementRiskDecision =
  | {
      allow: true;
    }
  | {
      allow: false;
      reason: string;
      details: Record<string, unknown>;
    };

type RiskMetrics = {
  currentState: BotRuntimeState;
  stateReason: string | null;
  totalExposureCents: number;
  perMarketExposureCents: Record<string, number>;
  openOrderNotionalCents: number;
  inventory: Record<string, { yesShares: string; noShares: string }>;
  reservedBalanceCents: number;
  fillsSeen: number;
  cancellations: number;
  realizedPnlCents: number;
  unrealizedPnlCents: number;
  dailyPnlCents: number;
  riskSkipCounts: Record<string, number>;
  emergencyStopCount: number;
  staleStateCount: number;
  apiErrorCount: number;
  repeatedApiErrorCount: number;
};

export class BotRiskManager {
  private readonly controlStore = new BotControlFileStore();
  private readonly recentApiErrors: Array<{ ts: number; code: string | null; stage: string }> = [];
  private readonly recentCancelConflicts: number[] = [];
  private readonly recentStaleSkips: number[] = [];
  private readonly riskSkipCounts = new Map<string, number>();
  private readonly perMarketExposureCents = new Map<string, number>();
  private readonly inventoryByMarket = new Map<string, { yesShares: string; noShares: string }>();
  private readonly marketMetadata = new Map<string, MarketSummary>();
  private currentState: BotRuntimeState = "running";
  private stateReason: string | null = null;
  private repeatedErrorPausedUntil: number | null = null;
  private emergencyCancelRequested = false;
  private lastMarketMetadataSyncAt = 0;
  private lastMetricsLogAt = 0;
  private fillsSeen = 0;
  private cancellations = 0;
  private emergencyStopCount = 0;
  private apiErrorCount = 0;
  private staleStateCount = 0;
  private lastRealizedPnlCents = 0;
  private lastUnrealizedPnlCents = 0;
  private lastOpenOrderNotionalCents = 0;
  private lastReservedBalanceCents = 0;

  constructor(
    private readonly bot: BotConfig,
    private readonly strategyCategory: StrategyCategory,
    private readonly api: ApiClient,
    private readonly logger: BotLogger,
  ) {}

  isSystemLiquidityBot() {
    return this.strategyCategory === "systemLiquidity";
  }

  async evaluateMarket(params: {
    marketId: string;
    balance: Balance;
    positions: Position[];
    openOrders: Order[];
    quoteResponse: QuoteResponse;
    freshness: FreshnessLike;
  }): Promise<RiskEvaluation> {
    await this.refreshMarketMetadataIfNeeded();

    const marketMeta = this.marketMetadata.get(params.marketId) ?? null;
    const market = this.buildMarketExposure(params.marketId, params.positions, params.openOrders, params.quoteResponse.quotes, marketMeta);
    const { totalExposureCents, openOrderNotionalCents } = this.buildExposureTotals(
      params.positions,
      params.openOrders,
      new Map([[params.marketId, params.quoteResponse.quotes]]),
    );
    this.perMarketExposureCents.set(params.marketId, market.exposureCents);
    this.inventoryByMarket.set(params.marketId, {
      yesShares: market.yesShares.toFixed(6),
      noShares: market.noShares.toFixed(6),
    });

    const pnl = this.computePnlCents(params.positions, params.quoteResponse.quotes);
    this.lastOpenOrderNotionalCents = openOrderNotionalCents;
    this.lastReservedBalanceCents = decimalCents(params.balance.lockedUSDC);
    const control = this.controlStore.read(this.isSystemLiquidityBot(), this.bot.name);
    const nextState = this.determineState({
      marketId: params.marketId,
      market,
      balance: params.balance,
      freshness: params.freshness,
      lossCheckPnlCents: pnl.lossCheckPnlCents,
      control,
      invariantErrorCount: this.countRecentApiErrors((entry) => /INVARIANT/i.test(entry.code ?? "")),
    });

    this.transitionState(nextState.state, nextState.reason, control);
    this.maybeLogMetrics({
      totalExposureCents,
      openOrderNotionalCents,
      reservedBalanceCents: decimalCents(params.balance.lockedUSDC),
      lossCheckPnlCents: pnl.lossCheckPnlCents,
    });

    return {
      state: this.currentState,
      reason: this.stateReason,
      market,
      totalExposureCents,
      openOrderNotionalCents,
      lossCheckPnlCents: pnl.lossCheckPnlCents,
    };
  }

  checkPlacement(context: PlacementRiskContext): PlacementRiskDecision {
    if (!this.bot.risk.enabled || !this.isSystemLiquidityBot()) {
      return { allow: true };
    }

    const notionalCents = decimalCents(multiplyDecimalString(context.action.price, context.action.size));
    const marketOpenOrders = context.openOrders.filter((order) => order.marketId === context.marketId);
    const marketStateAgeMs = context.freshness.marketStateAgeMs ?? Number.MAX_SAFE_INTEGER;
    const accountStateAgeMs = context.freshness.accountStateAgeMs ?? Number.MAX_SAFE_INTEGER;

    if (this.currentState === "paused") {
      return this.reject("paused", context, { state: this.currentState, stateReason: this.stateReason });
    }
    if (this.currentState === "emergency_stop") {
      return this.reject("emergency_stop", context, { state: this.currentState, stateReason: this.stateReason });
    }
    if (marketStateAgeMs > this.bot.risk.staleDataMaxAgeMs || accountStateAgeMs > this.bot.risk.staleDataMaxAgeMs) {
      this.noteRiskSkip("stale_state_skip");
      return this.reject("stale_state_skip", context, {
        marketStateAgeMs,
        accountStateAgeMs,
        staleDataMaxAgeMs: this.bot.risk.staleDataMaxAgeMs,
      });
    }
    if (notionalCents > this.bot.risk.maxOrderSizeCents) {
      this.noteRiskSkip("max_order_size");
      return this.reject("max_order_size", context, { notionalCents, maxOrderSizeCents: this.bot.risk.maxOrderSizeCents });
    }
    if (this.currentState === "reduce_only" && context.action.side === "BUY") {
      this.noteRiskSkip("reduce_only");
      return this.reject("reduce_only", context, { stateReason: this.stateReason });
    }
    if (marketOpenOrders.length >= this.bot.risk.maxOrdersPerMarket) {
      this.noteRiskSkip("max_orders_per_market");
      return this.reject("max_orders_per_market", context, {
        marketOpenOrders: marketOpenOrders.length,
        maxOrdersPerMarket: this.bot.risk.maxOrdersPerMarket,
      });
    }
    if (context.evaluation.openOrderNotionalCents + notionalCents > this.bot.risk.maxOpenOrderNotionalCents) {
      this.noteRiskSkip("max_open_order_notional");
      return this.reject("max_open_order_notional", context, {
        openOrderNotionalCents: context.evaluation.openOrderNotionalCents,
        projectedOpenOrderNotionalCents: context.evaluation.openOrderNotionalCents + notionalCents,
        maxOpenOrderNotionalCents: this.bot.risk.maxOpenOrderNotionalCents,
      });
    }
    if (context.action.side === "BUY") {
      if (context.evaluation.market.exposureCents + notionalCents > this.bot.risk.maxCapitalPerMarketCents) {
        this.noteRiskSkip("max_per_market_exposure");
        return this.reject("max_per_market_exposure", context, {
          exposureCents: context.evaluation.market.exposureCents,
          projectedExposureCents: context.evaluation.market.exposureCents + notionalCents,
          maxCapitalPerMarketCents: this.bot.risk.maxCapitalPerMarketCents,
        });
      }
      if (context.evaluation.totalExposureCents + notionalCents > this.bot.risk.maxTotalCapitalCents) {
        this.noteRiskSkip("max_total_capital");
        return this.reject("max_total_capital", context, {
          totalExposureCents: context.evaluation.totalExposureCents,
          projectedExposureCents: context.evaluation.totalExposureCents + notionalCents,
          maxTotalCapitalCents: this.bot.risk.maxTotalCapitalCents,
        });
      }
      const projectedShares = context.evaluation.market.yesShares + (context.outcomeId === this.marketYesOutcomeId(context.marketQuotes) ? Number(context.action.size) : 0);
      const projectedNoShares = context.evaluation.market.noShares + (context.outcomeId === this.marketNoOutcomeId(context.marketQuotes) ? Number(context.action.size) : 0);
      if (projectedShares > Number(this.bot.risk.maxYesSharesPerMarket)) {
        this.noteRiskSkip("max_yes_inventory");
        return this.reject("max_yes_inventory", context, {
          projectedYesShares: projectedShares.toFixed(6),
          maxYesSharesPerMarket: this.bot.risk.maxYesSharesPerMarket,
        });
      }
      if (projectedNoShares > Number(this.bot.risk.maxNoSharesPerMarket)) {
        this.noteRiskSkip("max_no_inventory");
        return this.reject("max_no_inventory", context, {
          projectedNoShares: projectedNoShares.toFixed(6),
          maxNoSharesPerMarket: this.bot.risk.maxNoSharesPerMarket,
        });
      }
    }

    return { allow: true };
  }

  noteApiError(error: unknown, context: { stage: string; marketId?: string | null }) {
    this.apiErrorCount += 1;
    const now = Date.now();
    let code: string | null = null;
    if (error instanceof PolyApiError) {
      code = error.code;
      if (context.stage === "cancel_order" && /cannot be canceled/i.test(error.message)) {
        this.recentCancelConflicts.push(now);
      }
      if (this.bot.risk.emergencyStopOnInvariantViolation && /INVARIANT/i.test(error.code)) {
        this.transitionState("emergency_stop", "invariant_violation_api_error", null, true);
      }
    }
    this.recentApiErrors.push({ ts: now, code, stage: context.stage });
    this.pruneRecentErrorWindows(now);
    if (this.bot.risk.emergencyStopOnRepeatedApiErrors && this.recentApiErrors.length >= this.bot.risk.repeatedApiErrorThreshold) {
      this.transitionState("emergency_stop", "repeated_api_errors", null, true);
      this.logger.warn("emergency_stop_entered", {
        botUserId: this.bot.risk.botUserId,
        marketId: context.marketId ?? null,
        reason: "repeated_api_errors",
        repeatedApiErrorCount: this.recentApiErrors.length,
      });
      return;
    }
    if (this.recentApiErrors.length >= this.bot.risk.repeatedApiErrorThreshold) {
      this.repeatedErrorPausedUntil = now + this.bot.risk.repeatedErrorPauseMs;
      this.logger.warn("repeated_api_error_pause", {
        botUserId: this.bot.risk.botUserId,
        marketId: context.marketId ?? null,
        repeatedApiErrorCount: this.recentApiErrors.length,
        pauseUntil: new Date(this.repeatedErrorPausedUntil).toISOString(),
      });
    }
  }

  noteRiskSkip(reason: string) {
    this.riskSkipCounts.set(reason, (this.riskSkipCounts.get(reason) ?? 0) + 1);
    if (reason.includes("stale")) {
      const now = Date.now();
      this.staleStateCount += 1;
      this.recentStaleSkips.push(now);
      this.pruneRecentErrorWindows(now);
      if (this.recentStaleSkips.length >= this.bot.risk.repeatedStaleStateThreshold) {
        this.repeatedErrorPausedUntil = now + this.bot.risk.repeatedErrorPauseMs;
      }
    }
  }

  noteFill(_fill: Fill) {
    this.fillsSeen += 1;
  }

  noteCancel() {
    this.cancellations += 1;
  }

  shouldCancelAllOpenOrders() {
    if (!this.emergencyCancelRequested) {
      return false;
    }
    this.emergencyCancelRequested = false;
    return true;
  }

  getMetrics(): RiskMetrics {
    return {
      currentState: this.currentState,
      stateReason: this.stateReason,
      totalExposureCents: sum(Array.from(this.perMarketExposureCents.values())),
      perMarketExposureCents: Object.fromEntries(this.perMarketExposureCents.entries()),
      openOrderNotionalCents: this.lastOpenOrderNotionalCents,
      inventory: Object.fromEntries(this.inventoryByMarket.entries()),
      reservedBalanceCents: this.lastReservedBalanceCents,
      fillsSeen: this.fillsSeen,
      cancellations: this.cancellations,
      realizedPnlCents: this.lastRealizedPnlCents,
      unrealizedPnlCents: this.lastUnrealizedPnlCents,
      dailyPnlCents: this.lastRealizedPnlCents + this.lastUnrealizedPnlCents,
      riskSkipCounts: Object.fromEntries(this.riskSkipCounts.entries()),
      emergencyStopCount: this.emergencyStopCount,
      staleStateCount: this.staleStateCount,
      apiErrorCount: this.apiErrorCount,
      repeatedApiErrorCount: this.recentApiErrors.length,
    };
  }

  private async refreshMarketMetadataIfNeeded() {
    const now = Date.now();
    if (now - this.lastMarketMetadataSyncAt < 60_000) {
      return;
    }
    this.lastMarketMetadataSyncAt = now;
    try {
      const response = await this.api.listMarkets({ view: "all" });
      for (const market of response.markets) {
        if (this.bot.marketIds.includes(market.id)) {
          this.marketMetadata.set(market.id, market);
        }
      }
      const missing = this.bot.marketIds.filter((marketId) => !this.marketMetadata.has(marketId));
      for (const marketId of missing) {
        try {
          const detail = await this.api.getMarket(marketId);
          this.marketMetadata.set(marketId, detail.market);
        } catch (error) {
          this.logger.warn("risk_market_detail_refresh_failed", {
            marketId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn("risk_market_metadata_refresh_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private determineState(params: {
    marketId: string;
    market: MarketExposureSnapshot;
    balance: Balance;
    freshness: FreshnessLike;
    lossCheckPnlCents: number;
    control: BotControlOverride | null;
    invariantErrorCount: number;
  }) {
    if (!this.bot.risk.enabled || !this.isSystemLiquidityBot()) {
      return { state: "running" as const, reason: null };
    }
    if (params.control) {
      return {
        state: params.control.state,
        reason: params.control.reason ?? "manual_control_override",
      };
    }
    if (this.currentState === "emergency_stop") {
      return {
        state: "emergency_stop" as const,
        reason: this.stateReason ?? "emergency_stop_persisted",
      };
    }
    if (this.bot.risk.emergencyStopOnBalanceMismatch && !balanceIsConsistent(params.balance)) {
      return { state: "emergency_stop" as const, reason: "balance_mismatch" };
    }
    if (params.lossCheckPnlCents <= -Math.abs(this.bot.risk.maxDailyLossCents)) {
      return { state: "emergency_stop" as const, reason: "max_daily_loss_exceeded" };
    }
    if (params.market.nearResolution) {
      return { state: "paused" as const, reason: "near_resolution_pause" };
    }
    if (
      (params.freshness.marketStateAgeMs ?? 0) > this.bot.risk.staleDataMaxAgeMs ||
      (params.freshness.accountStateAgeMs ?? 0) > this.bot.risk.staleDataMaxAgeMs
    ) {
      return { state: "paused" as const, reason: "stale_state_pause" };
    }
    if (this.repeatedErrorPausedUntil && this.repeatedErrorPausedUntil > Date.now()) {
      return { state: "paused" as const, reason: "repeated_api_error_pause" };
    }
    if (this.recentCancelConflicts.length >= this.bot.risk.repeatedCancelConflictThreshold) {
      return { state: "paused" as const, reason: "repeated_cancel_conflicts_pause" };
    }
    if (params.invariantErrorCount > 0 && this.bot.risk.emergencyStopOnInvariantViolation) {
      return { state: "emergency_stop" as const, reason: "invariant_violation_api_error" };
    }

    const yesUsage = Number(this.bot.risk.maxYesSharesPerMarket) > 0
      ? params.market.yesShares / Number(this.bot.risk.maxYesSharesPerMarket)
      : 0;
    const noUsage = Number(this.bot.risk.maxNoSharesPerMarket) > 0
      ? params.market.noShares / Number(this.bot.risk.maxNoSharesPerMarket)
      : 0;
    const maxUsage = Math.max(yesUsage, noUsage);
    if (maxUsage >= this.bot.risk.inventoryStopThreshold) {
      return { state: "emergency_stop" as const, reason: "inventory_stop_threshold" };
    }
    if (maxUsage >= this.bot.risk.inventoryReduceOnlyThreshold) {
      return { state: "reduce_only" as const, reason: "inventory_reduce_only_threshold" };
    }
    return { state: "running" as const, reason: null };
  }

  private transitionState(
    nextState: BotRuntimeState,
    reason: string | null,
    control: BotControlOverride | null,
    forceCancel = false,
  ) {
    if (this.currentState === nextState && this.stateReason === reason) {
      return;
    }

    const previousState = this.currentState;
    this.currentState = nextState;
    this.stateReason = reason;

    if (nextState === "reduce_only") {
      this.logger.warn("reduce_only_entered", {
        botUserId: this.bot.risk.botUserId,
        reason,
      });
    }
    if (nextState === "paused") {
      if (this.bot.risk.cancelOpenOrdersOnPause || control?.cancelOpenOrders) {
        this.emergencyCancelRequested = true;
      }
      this.logger.warn("near_resolution_pause", {
        botUserId: this.bot.risk.botUserId,
        reason,
      });
    }
    if (nextState === "emergency_stop") {
      this.emergencyStopCount += 1;
      if (forceCancel || this.bot.risk.cancelOpenOrdersOnEmergencyStop || control?.cancelOpenOrders) {
        this.emergencyCancelRequested = true;
      }
      this.logger.error("emergency_stop_entered", {
        botUserId: this.bot.risk.botUserId,
        reason,
      });
    }
    if (previousState === "emergency_stop" && nextState !== "emergency_stop") {
      this.logger.warn("emergency_stop_recovered", {
        botUserId: this.bot.risk.botUserId,
        nextState,
        reason,
      });
    }
  }

  private maybeLogMetrics(params: {
    totalExposureCents: number;
    openOrderNotionalCents: number;
    reservedBalanceCents: number;
    lossCheckPnlCents: number;
  }) {
    const now = Date.now();
    if (now - this.lastMetricsLogAt < this.bot.pauseLogIntervalMs) {
      return;
    }
    this.lastMetricsLogAt = now;
    const metrics = this.getMetrics();
    this.logger.info("risk_metrics", {
      ...metrics,
      totalExposureCents: params.totalExposureCents,
      openOrderNotionalCents: params.openOrderNotionalCents,
      reservedBalanceCents: params.reservedBalanceCents,
      lossCheckPnlCents: params.lossCheckPnlCents,
    });
  }

  private buildMarketExposure(
    marketId: string,
    positions: Position[],
    openOrders: Order[],
    quotes: Quote[],
    marketMeta: MarketSummary | null,
  ): MarketExposureSnapshot {
    const marketPositions = positions.filter((position) => position.marketId === marketId);
    const marketOrders = openOrders.filter((order) => order.marketId === marketId);
    const quoteByOutcome = new Map(quotes.map((quote) => [quote.outcomeId, quote]));
    let inventoryExposureCents = 0;
    let yesShares = 0;
    let noShares = 0;

    for (const position of marketPositions) {
      const shares = Number(position.shares);
      const mark = quoteByOutcome.get(position.outcomeId)?.midPrice
        ?? quoteByOutcome.get(position.outcomeId)?.lastPrice
        ?? position.avgCost;
      inventoryExposureCents += decimalCents(multiplyDecimalString(String(mark), position.shares));
      if (/yes/i.test(position.outcomeName)) {
        yesShares += shares;
      } else if (/no/i.test(position.outcomeName)) {
        noShares += shares;
      }
    }

    const openOrderNotionalCents = marketOrders.reduce((sum, order) => sum + openOrderExposureCents(order), 0);
    const resolveTime = marketMeta?.resolveTime ?? null;
    const nearResolution =
      resolveTime !== null &&
      this.bot.risk.pauseNearResolutionMinutes > 0 &&
      Date.parse(resolveTime) - Date.now() <= this.bot.risk.pauseNearResolutionMinutes * 60_000;

    return {
      marketId,
      exposureCents: inventoryExposureCents + openOrderNotionalCents,
      openOrderNotionalCents,
      yesShares,
      noShares,
      nearResolution,
      resolveTime,
    };
  }

  private buildExposureTotals(
    positions: Position[],
    openOrders: Order[],
    quoteResponses: Map<string, QuoteResponse["quotes"]>,
  ) {
    const perMarket = new Map<string, number>();
    for (const position of positions) {
      const quotes = quoteResponses.get(position.marketId) ?? [];
      const quote = quotes.find((item) => item.outcomeId === position.outcomeId);
      const mark = quote?.midPrice ?? quote?.lastPrice ?? position.avgCost;
      const current = perMarket.get(position.marketId) ?? 0;
      perMarket.set(
        position.marketId,
        current + decimalCents(multiplyDecimalString(String(mark), position.shares)),
      );
    }
    let openOrderNotionalCents = 0;
    for (const order of openOrders) {
      const notional = openOrderExposureCents(order);
      openOrderNotionalCents += notional;
      perMarket.set(order.marketId, (perMarket.get(order.marketId) ?? 0) + notional);
    }
    return {
      totalExposureCents: sum(Array.from(perMarket.values())),
      openOrderNotionalCents,
    };
  }

  private computePnlCents(positions: Position[], quotes: Quote[]) {
    const quoteByOutcome = new Map(quotes.map((quote) => [quote.outcomeId, quote]));
    let realized = 0;
    let unrealized = 0;
    for (const position of positions) {
      realized += decimalCents(position.realizedPnl);
      const quote = quoteByOutcome.get(position.outcomeId);
      const mark = quote?.midPrice ?? quote?.lastPrice ?? position.avgCost;
      unrealized += decimalCents(
        multiplyDecimalString(String(Number(mark) - Number(position.avgCost)), position.shares),
      );
    }
    this.lastRealizedPnlCents = realized;
    this.lastUnrealizedPnlCents = unrealized;
    return {
      realizedPnlCents: realized,
      unrealizedPnlCents: unrealized,
      lossCheckPnlCents: realized,
    };
  }

  private countRecentApiErrors(predicate: (entry: { ts: number; code: string | null; stage: string }) => boolean) {
    this.pruneRecentErrorWindows(Date.now());
    return this.recentApiErrors.filter(predicate).length;
  }

  private pruneRecentErrorWindows(now: number) {
    const windowStart = now - this.bot.risk.repeatedApiErrorWindowMs;
    pruneArray(this.recentApiErrors, (entry) => entry.ts >= windowStart);
    pruneArray(this.recentCancelConflicts, (ts) => ts >= windowStart);
    pruneArray(this.recentStaleSkips, (ts) => ts >= windowStart);
  }

  private marketYesOutcomeId(quotes: QuoteResponse["quotes"]) {
    return quotes.find((quote) => /yes/i.test(quote.outcomeName))?.outcomeId ?? "__missing_yes__";
  }

  private marketNoOutcomeId(quotes: QuoteResponse["quotes"]) {
    return quotes.find((quote) => /no/i.test(quote.outcomeName))?.outcomeId ?? "__missing_no__";
  }

  private reject(reason: string, context: PlacementRiskContext, details: Record<string, unknown>): PlacementRiskDecision {
    return {
      allow: false,
      reason,
      details: {
        marketId: context.marketId,
        botUserId: this.bot.risk.botUserId,
        inventory: {
          yesShares: context.evaluation.market.yesShares.toFixed(6),
          noShares: context.evaluation.market.noShares.toFixed(6),
        },
        exposureCents: context.evaluation.market.exposureCents,
        totalExposureCents: context.evaluation.totalExposureCents,
        openOrderNotionalCents: context.evaluation.openOrderNotionalCents,
        marketStateAgeMs: context.freshness.marketStateAgeMs,
        accountStateAgeMs: context.freshness.accountStateAgeMs,
        ...details,
      },
    };
  }
}

function decimalCents(value: string) {
  return Math.round(Number(value) * 100);
}

function multiplyDecimalString(a: string, b: string) {
  return (Number(a) * Number(b)).toFixed(6);
}

function openOrderExposureCents(order: Order) {
  if (Number(order.reservedNotional) > 0) {
    return decimalCents(order.reservedNotional);
  }
  return decimalCents((Number(order.price) * Number(order.remaining)).toFixed(6));
}

function balanceIsConsistent(balance: Balance) {
  return Math.abs(Number(balance.availableUSDC) + Number(balance.lockedUSDC) - Number(balance.totalUSDC)) <= 0.01;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function pruneArray<T>(items: T[], predicate: (item: T) => boolean) {
  let writeIndex = 0;
  for (const item of items) {
    if (predicate(item)) {
      items[writeIndex++] = item;
    }
  }
  items.length = writeIndex;
}

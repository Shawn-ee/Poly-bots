import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { MarketReferencePlanResponse, Order, Quote } from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import {
  dynamicMarketMakerStrategy,
  planDynamicMarketMakerMintReplenishment,
} from "../strategies/liquidity/dynamicMarketMaker.js";
import { inventoryAwareMakerStrategy } from "../strategies/liquidity/inventoryAwareMaker.js";
import {
  collectReferenceArbitrageCleanupActions,
  referenceArbitrageRebalancerStrategy,
} from "../strategies/referenceArbitrageRebalancer.js";
import { noiseTraderStrategy } from "../strategies/userSimulation/noiseTrader.js";
import {
  collectStaleCleanupActions,
  getStrategyCategory,
  sampleLoopDelayMs,
  StrategyAction,
  StrategyContext,
} from "../strategies/shared/common.js";
import { tightMarketMakerStrategy } from "../strategies/liquidity/tightMarketMaker.js";
import { sleep } from "../utils/sleep.js";
import {
  BotBlockState,
  classifyPlacementError,
  nextTransportBackoffMs,
  resetTransportBackoff,
} from "./errorHandling.js";
import { decimalToUnits, unitsToDecimal } from "../utils/decimal.js";
import { RuntimeStateSync } from "./runtimeStateSync.js";
import { BotRiskManager, PlacementRiskContext, RiskEvaluation } from "./botRiskManager.js";

type StrategyFn = (context: StrategyContext) => StrategyAction[];

export class BotRunner {
  private readonly api: ApiClient;
  private readonly logger: BotLogger;
  private readonly strategyCategory: ReturnType<typeof getStrategyCategory>;
  private readonly stateSync: RuntimeStateSync;
  private readonly riskManager: BotRiskManager;
  private runtimeController: AbortController | null = null;
  private runtimeInitPromise: Promise<void> | null = null;
  private readonly seenFillIds = new Set<string>();
  private readonly lastPlacementByKey = new Map<string, number>();
  private readonly marketMintHistory = new Map<string, Array<{ ts: number; amount: string }>>();
  private readonly marketQuoteLagHistory = new Map<string, number[]>();
  private readonly marketSubmittedNotionalHistory = new Map<string, Array<{ ts: number; cents: number }>>();
  private readonly lastReferenceArbitrageDecisionAt = new Map<string, number>();
  private placementBlock: BotBlockState = { kind: "none" };
  private transportBackoffMs = 0;
  private lastPauseSkipLogAt = 0;

  constructor(private readonly bot: BotConfig, logsDir: string) {
    this.api = new ApiClient(bot.baseUrl, bot.apiKey);
    this.logger = new BotLogger(bot.name, logsDir);
    this.strategyCategory = getStrategyCategory(bot.strategy);
    this.stateSync = new RuntimeStateSync(bot, this.api, this.logger);
    this.riskManager = new BotRiskManager(bot, this.strategyCategory, this.api, this.logger);
  }

  async run(signal: AbortSignal): Promise<void> {
    this.logger.info("bot_starting", {
      strategy: this.bot.strategy,
      strategyCategory: this.strategyCategory,
      marketIds: this.bot.marketIds,
      baseUrl: this.bot.baseUrl,
    });

    await this.ensureRuntimeState(signal);

    while (!signal.aborted) {
      try {
        await this.runCycle(signal);
      } catch (error) {
        this.logger.error("error", {
          stage: "run_cycle",
          ...serializeError(error),
        });
      }

      try {
        await sleep(this.nextLoopDelayMs(), signal);
      } catch {
        break;
      }
    }

    this.logger.info("bot_stopping");
    this.shutdown();
  }

  async runOnce(signal: AbortSignal): Promise<void> {
    await this.runCycle(signal);
  }

  shutdown() {
    this.runtimeController?.abort();
    this.logger.close();
  }

  private async runCycle(signal: AbortSignal) {
    await this.ensureRuntimeState(signal);

    if (signal.aborted) {
      return;
    }

    if (this.isDailyNotionalPlacementBlock()) {
      this.logPauseHeartbeat();
      return;
    }

    let { balance, positions, fillsPage, openOrdersPage } = await this.stateSync.getAccountSnapshot(signal);
    let openOrders = openOrdersPage.items;

    for (const fill of fillsPage.items) {
      if (!this.seenFillIds.has(fill.id)) {
        this.seenFillIds.add(fill.id);
        this.logger.info("fill_seen", fill);
        this.riskManager.noteFill(fill);
      }
    }

    for (const marketId of this.bot.marketIds) {
      let quoteResponse = await this.stateSync.getMarketQuote(marketId);
      const freshness = this.stateSync.getFreshnessMetrics(marketId);
      if (!quoteResponse.quotes.length) {
        this.riskManager.noteRiskSkip("stale_state_unavailable_skip");
        this.logger.warn("order_submit_skipped", {
          marketId,
          reason: "stale_state_unavailable_skip",
          strategyCategory: this.strategyCategory,
          freshness,
        });
        continue;
      }
      if (this.bot.strategy === "dynamicMarketMaker") {
        const refreshed = await this.maybeReplenishDynamicMarketMakerInventory({
          marketId,
          quoteResponse,
          balance,
          positions,
        });
        if (refreshed) {
          balance = refreshed.balance;
          positions = refreshed.positions;
          quoteResponse = refreshed.quoteResponse;
        }
      }

      const marketOpenOrders = openOrders.filter((order) => order.marketId === marketId);
      const riskEvaluation = await this.riskManager.evaluateMarket({
        marketId,
        balance,
        positions: positions.items,
        openOrders,
        quoteResponse,
        freshness,
      });
      if (this.riskManager.shouldCancelAllOpenOrders()) {
        openOrders = await this.cancelAllOpenOrders(openOrders);
      }
      if (this.bot.strategy === "referenceArbitrageRebalancer") {
        openOrders = await this.runReferenceArbitrageMarket({
          marketId,
          quoteResponse,
          balance,
          positions: positions.items,
          openOrders,
          marketOpenOrders,
          freshness,
          riskEvaluation,
          signal,
        });
        continue;
      }

      for (const quote of quoteResponse.quotes) {
        const marketOpenOrders = openOrders.filter((order) => order.marketId === marketId);
        const outcomeOpenOrders = marketOpenOrders.filter((order) => order.outcomeId === quote.outcomeId);
        const context: StrategyContext = {
          bot: this.bot,
          marketId,
          quote,
          marketQuotes: quoteResponse.quotes,
          balance,
          positions: positions.items,
          totalOpenOrders: openOrders,
          marketOpenOrders,
          outcomeOpenOrders,
          now: new Date(),
          recentQuoteLagEvents: this.getRecentQuoteLagEvents(marketId),
        };

        this.logger.info("quote_seen", {
          marketId,
          outcomeId: quote.outcomeId,
          bestBid: quote.bestBid,
          bestAsk: quote.bestAsk,
          midPrice: quote.midPrice,
          lastPrice: quote.lastPrice,
          totalOpenOrders: openOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
          freshness,
        });

        const activeBlock = this.resolvePlacementBlock(Date.now());
        const actions =
          activeBlock || riskEvaluation.state === "paused" || riskEvaluation.state === "emergency_stop"
            ? collectStaleCleanupActions(context)
            : this.selectStrategy()(context);

        if (activeBlock) {
          this.logPlacementBlockSkip(marketId, quote.outcomeId, activeBlock, openOrders.length);
        }
        if (riskEvaluation.state === "paused") {
          this.logger.warn("order_submit_skipped", {
            marketId,
            outcomeId: quote.outcomeId,
            reason: "near_resolution_pause",
            riskState: riskEvaluation.state,
            riskReason: riskEvaluation.reason,
          });
        }
        if (riskEvaluation.state === "reduce_only") {
          this.logger.warn("reduce_only_entered", {
            marketId,
            botUserId: this.bot.risk.botUserId,
            inventory: {
              yesShares: riskEvaluation.market.yesShares.toFixed(6),
              noShares: riskEvaluation.market.noShares.toFixed(6),
            },
            exposure: riskEvaluation.market.exposureCents,
            openOrderNotional: riskEvaluation.market.openOrderNotionalCents,
            reason: riskEvaluation.reason,
          });
        }

        openOrders = await this.executeActions(
          actions,
          marketId,
          quoteResponse,
          { balance, positions: positions.items, freshness, riskEvaluation },
          openOrders,
          signal,
        );
      }
    }
  }

  private async maybeReplenishDynamicMarketMakerInventory(params: {
    marketId: string;
    quoteResponse: Awaited<ReturnType<ApiClient["getQuote"]>>;
    balance: Awaited<ReturnType<ApiClient["getBalance"]>>;
    positions: Awaited<ReturnType<ApiClient["getPositions"]>>;
  }) {
    const mintedLastHour = this.getMintedLastHour(params.marketId);
    const plan = planDynamicMarketMakerMintReplenishment({
      bot: this.bot,
      marketId: params.marketId,
      marketQuotes: params.quoteResponse.quotes,
      positions: params.positions.items,
      availableUSDC: params.balance.availableUSDC,
      mintedLastHour,
    });

    if (!plan.shouldConsider) {
      return null;
    }

    this.logger.info("mint_replenishment_considered", plan);

    if (!plan.shouldMint) {
      this.logger.info("mint_replenishment_skipped", plan);
      return null;
    }

    try {
      const result = await this.api.mintCompleteSet(params.marketId, plan.finalMintAmount);
      this.recordMint(params.marketId, plan.finalMintAmount);
      this.logger.info("mint_replenishment_success", {
        ...plan,
        response: result,
      });

      const [balance, positions, quoteResponse] = await Promise.all([
        this.api.getBalance(),
        this.api.getPositions(),
        this.api.getQuote(params.marketId),
      ]);

      return {
        balance,
        positions,
        quoteResponse,
      };
    } catch (error) {
      const serialized = serializeError(error);
      this.logger.warn("mint_replenishment_failed", {
        ...plan,
        ...serialized,
      });
      return null;
    }
  }

  private async executeActions(
    actions: StrategyAction[],
    marketId: string,
    quoteResponse: Awaited<ReturnType<ApiClient["getQuote"]>>,
    runtimeState: {
      balance: Awaited<ReturnType<ApiClient["getBalance"]>>;
      positions: Awaited<ReturnType<ApiClient["getPositions"]>>["items"];
      freshness: ReturnType<RuntimeStateSync["getFreshnessMetrics"]>;
      riskEvaluation: RiskEvaluation;
    },
    openOrders: Order[],
    signal: AbortSignal,
  ): Promise<Order[]> {
    let nextOpenOrders = openOrders;
    let pauseSkipLogged = false;

    for (const action of actions) {
      if (signal.aborted) {
        return nextOpenOrders;
      }

      if (action.type === "cancel") {
        try {
          const result = await this.api.cancelOrder(action.orderId);
          nextOpenOrders = nextOpenOrders.filter((order) => order.id !== action.orderId);
          this.riskManager.noteCancel();
          if (action.reason === "stale_order_cleanup" || action.reason === "side_order_limit_cleanup") {
            this.recordQuoteLag(marketId);
          }
          this.logger.info("order_canceled", {
            orderId: action.orderId,
            reason: action.reason,
            totalOpenOrders: nextOpenOrders.length,
            ...(action.details ? action.details : {}),
            order: result.order,
          });
        } catch (error) {
          this.logger.error("error", {
            stage: "cancel_order",
            orderId: action.orderId,
            reason: action.reason,
            ...serializeError(error),
          });
          this.riskManager.noteApiError(error, {
            stage: "cancel_order",
            marketId,
          });
        }
        continue;
      }

      if (action.type === "skip") {
        this.logger.info("order_submit_skipped", {
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: action.reason,
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
          capBackoffUntil: this.placementBlock.kind === "cooldown" ? new Date(this.placementBlock.until).toISOString() : null,
          ...(action.details ? action.details : {}),
        });
        continue;
      }

      const now = Date.now();
      const blockReason = this.resolvePlacementBlock(now);
      const actionQuote =
        quoteResponse.quotes.find((candidate) => candidate.outcomeId === action.outcomeId) ?? quoteResponse.quotes[0];
      if (blockReason) {
        if (!pauseSkipLogged && now - this.lastPauseSkipLogAt >= this.bot.pauseLogIntervalMs) {
          this.lastPauseSkipLogAt = now;
          pauseSkipLogged = true;
          this.logger.info("order_submit_skipped", {
            marketId,
            outcomeId: action.outcomeId,
            side: action.side,
            reason: blockReason.reason,
            totalOpenOrders: nextOpenOrders.length,
            maxOpenOrders: this.bot.maxOpenOrders,
            capBackoffUntil:
              this.placementBlock.kind === "cooldown" ? new Date(this.placementBlock.until).toISOString() : null,
            code: blockReason.code ?? null,
          });
        }
        continue;
      }

      if (!actionQuote) {
        this.logger.warn("order_submit_skipped", {
          marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: "missing_outcome_quote_skip",
        });
        continue;
      }

      const placementKey = `${marketId}:${action.outcomeId}:${action.side}`;
      const lastPlacementAt = this.lastPlacementByKey.get(placementKey) ?? 0;
      if (lastPlacementAt + this.bot.decisionCooldownMs > now) {
        this.logger.info("order_submit_skipped", {
          marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: "cooldown_skip",
          cooldownType: "decision",
          nextAllowedAt: new Date(lastPlacementAt + this.bot.decisionCooldownMs).toISOString(),
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
        });
        continue;
      }

      this.logger.info("decision_made", {
        marketId,
        outcomeId: action.outcomeId,
        side: action.side,
        reason: action.reason,
        price: action.price,
        size: action.size,
        totalOpenOrders: nextOpenOrders.length,
        ...(action.details ? action.details : {}),
      });

      const placementDecision = this.riskManager.checkPlacement({
        marketId,
        outcomeId: action.outcomeId,
        action,
        balance: runtimeState.balance,
        positions: runtimeState.positions,
        openOrders: nextOpenOrders,
        quote: actionQuote,
        marketQuotes: quoteResponse.quotes,
        freshness: runtimeState.freshness,
        evaluation: runtimeState.riskEvaluation,
      } satisfies PlacementRiskContext);
      if (!placementDecision.allow) {
        this.riskManager.noteRiskSkip(placementDecision.reason);
        this.logger.warn("risk_check_failed", {
          marketId,
          botUserId: this.bot.risk.botUserId,
          side: action.side,
          reason: placementDecision.reason,
          ...placementDecision.details,
        });
        if (placementDecision.reason === "max_per_market_exposure" || placementDecision.reason === "max_total_capital") {
          this.logger.warn("max_exposure_reached", placementDecision.details);
        }
        if (placementDecision.reason === "reduce_only") {
          this.logger.warn("inventory_limit_hit", placementDecision.details);
        }
        if (placementDecision.reason === "max_yes_inventory" || placementDecision.reason === "max_no_inventory") {
          this.logger.warn("inventory_limit_hit", placementDecision.details);
        }
        if (placementDecision.reason.includes("stale")) {
          this.logger.warn("stale_state_skip", placementDecision.details);
        }
        continue;
      }

      try {
        this.logger.info("order_submission", {
          idempotencyKey: action.idempotencyKey,
          clientOrderId: action.clientOrderId,
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
        });
        const result = await this.api.placeLimitOrder(
          {
            marketId: action.marketId,
            outcomeId: action.outcomeId,
            side: action.side,
            price: action.price,
            size: action.size,
            clientOrderId: action.clientOrderId,
          },
          action.idempotencyKey,
        );

        this.lastPlacementByKey.set(placementKey, now);
        this.placementBlock = { kind: "none" };
        this.transportBackoffMs = resetTransportBackoff();
        nextOpenOrders = upsertOpenOrder(nextOpenOrders, result.order);
        this.recordSubmittedNotional(marketId, action.price, action.size);
        this.logger.info("order_submitted", {
          order: result.order,
          totalOpenOrders: nextOpenOrders.length,
          ...(action.details ? action.details : {}),
        });
      } catch (error) {
        const classification = classifyPlacementError(error, this.bot, now, nextTransportBackoffMs(this.transportBackoffMs));
        if (classification.category === "transport") {
          this.transportBackoffMs = nextTransportBackoffMs(this.transportBackoffMs);
        }

        if (classification.blockState.kind !== "none") {
          const enteringPause =
            classification.blockState.kind === "paused" &&
            (this.placementBlock.kind !== "paused" || this.placementBlock.reason !== classification.blockState.reason);
          this.placementBlock = classification.blockState;
          if (enteringPause) {
            this.logger.warn("bot_paused", {
              reason: classification.blockState.reason,
              code: classification.blockState.code ?? null,
            });
          }
        }

        const serialized = serializeError(error);
        const logPayload = {
          stage: "place_order",
          marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          idempotencyKey: action.idempotencyKey,
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
          blockState: serializeBlockState(this.placementBlock),
          ...serialized,
        };

        if (error instanceof PolyApiError) {
          this.logger.warn("error", logPayload);
        } else {
          this.logger.error("error", logPayload);
        }
        this.riskManager.noteApiError(error, {
          stage: "place_order",
          marketId,
        });
      }
    }

    return nextOpenOrders;
  }

  private async runReferenceArbitrageMarket(params: {
    marketId: string;
    quoteResponse: Awaited<ReturnType<ApiClient["getQuote"]>>;
    balance: Awaited<ReturnType<ApiClient["getBalance"]>>;
    positions: Awaited<ReturnType<ApiClient["getPositions"]>>["items"];
    openOrders: Order[];
    marketOpenOrders: Order[];
    freshness: ReturnType<RuntimeStateSync["getFreshnessMetrics"]>;
    riskEvaluation: RiskEvaluation;
    signal: AbortSignal;
  }): Promise<Order[]> {
    let referencePlan: MarketReferencePlanResponse;
    try {
      referencePlan = await this.api.getMarketReferencePlan(params.marketId);
    } catch (error) {
      this.logger.warn("reference_arbitrage_reference_fetch_failed", {
        marketId: params.marketId,
        ...serializeError(error),
      });
      return params.openOrders;
    }

    const nowMs = Date.now();
    const liveGate = this.resolveReferenceArbitrageLiveGate(params.marketId);
    const activeBlock = this.resolvePlacementBlock(nowMs);
    const cooldownActive =
      nowMs - (this.lastReferenceArbitrageDecisionAt.get(params.marketId) ?? 0) <
      this.bot.referenceArbitrageRebalancer.cooldownMs;
    const context = {
      bot: this.bot,
      marketId: params.marketId,
      marketQuotes: params.quoteResponse.quotes,
      referencePlan,
      balance: params.balance,
      positions: params.positions,
      totalOpenOrders: params.openOrders,
      marketOpenOrders: params.openOrders.filter((order) => order.marketId === params.marketId),
      now: new Date(nowMs),
      recentQuoteLagEvents: this.getRecentQuoteLagEvents(params.marketId),
      recentSubmittedNotionalCents: this.getSubmittedNotionalLast24h(params.marketId),
      cooldownActive,
    };

    this.logger.info("reference_arbitrage_market_seen", {
      marketId: params.marketId,
      referenceOutcomeCount: referencePlan.outcomes.length,
      totalOpenOrders: context.totalOpenOrders.length,
      marketOpenOrders: context.marketOpenOrders.length,
      freshness: params.freshness,
      cooldownActive,
      dryRun: this.bot.referenceArbitrageRebalancer.dryRun,
      liveGateAllowed: liveGate.allowed,
      liveGateReason: liveGate.reason,
    });

    const plan =
      !liveGate.allowed
        ? {
            actions: this.bot.referenceArbitrageRebalancer.dryRun
              ? []
              : collectReferenceArbitrageCleanupActions(context, liveGate.reason ?? "reference_arbitrage_live_gate"),
            opportunities: [],
          }
        : activeBlock || params.riskEvaluation.state === "paused" || params.riskEvaluation.state === "emergency_stop"
        ? {
            actions: this.bot.referenceArbitrageRebalancer.dryRun
              ? collectReferenceArbitrageCleanupActions(
                  context,
                  activeBlock?.reason ?? params.riskEvaluation.reason ?? "reference_arbitrage_risk_cleanup",
                ).map((action) => {
                  if (action.type !== "cancel") {
                    return action;
                  }
                  return {
                    type: "skip" as const,
                    reason: "reference_arbitrage_dry_run_cancel",
                    marketId: params.marketId,
                    outcomeId:
                      referencePlan.outcomes[0]?.localOutcomeId ??
                      params.quoteResponse.quotes[0]?.outcomeId ??
                      "__reference__",
                    details: {
                      ...action.details,
                      strategy: "referenceArbitrageRebalancer",
                      intendedAction: "cancel",
                      intendedOrderId: action.orderId,
                      cancelReason: action.reason,
                    },
                  };
                })
              : collectReferenceArbitrageCleanupActions(
                  context,
                  activeBlock?.reason ?? params.riskEvaluation.reason ?? "reference_arbitrage_risk_cleanup",
                ),
            opportunities: [],
          }
        : referenceArbitrageRebalancerStrategy(context);

    if (!liveGate.allowed) {
      this.logger.warn("reference_arbitrage_live_market_blocked", {
        marketId: params.marketId,
        reason: liveGate.reason,
        allowedMarketIds: this.bot.referenceArbitrageRebalancer.allowedMarketIds,
        maxLiveMarkets: this.bot.referenceArbitrageRebalancer.maxLiveMarkets,
      });
    } else if (activeBlock) {
      this.logPlacementBlockSkip(
        params.marketId,
        referencePlan.outcomes[0]?.localOutcomeId ?? params.quoteResponse.quotes[0]?.outcomeId ?? "__reference__",
        activeBlock,
        params.openOrders.length,
      );
    }
    if (plan.opportunities.length > 0) {
      this.lastReferenceArbitrageDecisionAt.set(params.marketId, nowMs);
      this.logger.info("reference_arbitrage_opportunities_detected", {
        marketId: params.marketId,
        opportunities: plan.opportunities.map((opportunity) => ({
          outcomeId: opportunity.outcomeId,
          outcomeName: opportunity.outcomeName,
          side: opportunity.side,
          edge: opportunity.edge,
          fairPrice: opportunity.fairPrice,
          limitPrice: opportunity.limitPrice,
        })),
      });
    }

    return this.executeActions(
      plan.actions,
      params.marketId,
      params.quoteResponse,
      {
        balance: params.balance,
        positions: params.positions,
        freshness: params.freshness,
        riskEvaluation: params.riskEvaluation,
      },
      params.openOrders,
      params.signal,
    );
  }

  private async cancelAllOpenOrders(openOrders: Order[]): Promise<Order[]> {
    if (openOrders.length === 0) {
      return openOrders;
    }
    let remaining = [...openOrders];
    for (const order of openOrders) {
      try {
        const result = await this.api.cancelOrder(order.id);
        remaining = remaining.filter((item) => item.id !== order.id);
        this.riskManager.noteCancel();
        this.logger.warn("order_canceled", {
          orderId: order.id,
          reason: "emergency_stop_cancel_all",
          totalOpenOrders: remaining.length,
          order: result.order,
        });
      } catch (error) {
        this.logger.warn("error", {
          stage: "cancel_order",
          orderId: order.id,
          reason: "emergency_stop_cancel_all",
          ...serializeError(error),
        });
        this.riskManager.noteApiError(error, {
          stage: "cancel_order",
          marketId: order.marketId,
        });
      }
    }
    return remaining;
  }

  private resolvePlacementBlock(now: number): { reason: string; code?: string } | null {
    if (this.placementBlock.kind === "paused") {
      return {
        reason: this.placementBlock.reason,
        ...(this.placementBlock.code ? { code: this.placementBlock.code } : {}),
      };
    }

    if (this.placementBlock.kind === "cooldown") {
      if (this.placementBlock.until > now) {
        return {
          reason: this.placementBlock.reason,
          ...(this.placementBlock.code ? { code: this.placementBlock.code } : {}),
        };
      }

      this.placementBlock = { kind: "none" };
    }

    return null;
  }

  private isDailyNotionalPlacementBlock(): boolean {
    return this.placementBlock.kind !== "none" && this.placementBlock.reason === "daily_notional_exhausted";
  }

  private nextLoopDelayMs(): number {
    if (this.isDailyNotionalPlacementBlock()) {
      return this.bot.pausedPollIntervalMs;
    }
    return sampleLoopDelayMs(this.bot);
  }

  private logPlacementBlockSkip(
    marketId: string,
    outcomeId: string,
    blockReason: { reason: string; code?: string },
    totalOpenOrders: number,
  ) {
    const now = Date.now();
    if (now - this.lastPauseSkipLogAt < this.bot.pauseLogIntervalMs) {
      return;
    }

    this.lastPauseSkipLogAt = now;
    this.logger.info("order_submit_skipped", {
      marketId,
      outcomeId,
      reason: blockReason.reason,
      totalOpenOrders,
      maxOpenOrders: this.bot.maxOpenOrders,
      capBackoffUntil: this.placementBlock.kind === "cooldown" ? new Date(this.placementBlock.until).toISOString() : null,
      code: blockReason.code ?? null,
    });
  }

  private logPauseHeartbeat() {
    const now = Date.now();
    if (now - this.lastPauseSkipLogAt < this.bot.pauseLogIntervalMs) {
      return;
    }

    this.lastPauseSkipLogAt = now;
    this.logger.info("bot_paused_heartbeat", {
      reason: this.placementBlock.kind === "paused" ? this.placementBlock.reason : "unknown_pause",
      code: this.placementBlock.kind === "paused" ? this.placementBlock.code ?? null : null,
      pausedPollIntervalMs: this.bot.pausedPollIntervalMs,
    });
  }

  private selectStrategy(): StrategyFn {
    switch (this.bot.strategy) {
      case "tightMarketMaker":
        return tightMarketMakerStrategy;
      case "noiseTrader":
        return noiseTraderStrategy;
      case "inventoryAwareMaker":
        return inventoryAwareMakerStrategy;
      case "dynamicMarketMaker":
        return dynamicMarketMakerStrategy;
      case "referenceArbitrageRebalancer":
        throw new Error("referenceArbitrageRebalancer is handled at market scope.");
    }
  }

  private getMintedLastHour(marketId: string): string {
    const now = Date.now();
    const retained = (this.marketMintHistory.get(marketId) ?? []).filter(
      (entry) => entry.ts > now - 60 * 60 * 1000,
    );
    this.marketMintHistory.set(marketId, retained);
    let total = 0n;
    for (const entry of retained) {
      total += decimalToUnits(entry.amount);
    }
    return unitsToDecimal(total);
  }

  private recordMint(marketId: string, amount: string) {
    const retained = (this.marketMintHistory.get(marketId) ?? []).filter(
      (entry) => entry.ts > Date.now() - 60 * 60 * 1000,
    );
    retained.push({ ts: Date.now(), amount });
    this.marketMintHistory.set(marketId, retained);
  }

  private recordQuoteLag(marketId: string) {
    const now = Date.now();
    const history = this.marketQuoteLagHistory.get(marketId) ?? [];
    history.push(now);
    this.marketQuoteLagHistory.set(
      marketId,
      history.filter((ts) => now - ts <= 5 * 60_000),
    );
  }

  private getRecentQuoteLagEvents(marketId: string): number {
    const now = Date.now();
    const history = (this.marketQuoteLagHistory.get(marketId) ?? []).filter((ts) => now - ts <= 5 * 60_000);
    this.marketQuoteLagHistory.set(marketId, history);
    return history.length;
  }

  private recordSubmittedNotional(marketId: string, price: string, size: string) {
    const retained = (this.marketSubmittedNotionalHistory.get(marketId) ?? []).filter(
      (entry) => entry.ts > Date.now() - 24 * 60 * 60 * 1000,
    );
    retained.push({
      ts: Date.now(),
      cents: Math.round(Number(price) * Number(size) * 100),
    });
    this.marketSubmittedNotionalHistory.set(marketId, retained);
  }

  private getSubmittedNotionalLast24h(marketId: string): number {
    const now = Date.now();
    const retained = (this.marketSubmittedNotionalHistory.get(marketId) ?? []).filter(
      (entry) => entry.ts > now - 24 * 60 * 60 * 1000,
    );
    this.marketSubmittedNotionalHistory.set(marketId, retained);
    return retained.reduce((sum, entry) => sum + entry.cents, 0);
  }

  private resolveReferenceArbitrageLiveGate(
    marketId: string,
  ): { allowed: boolean; reason: string | null } {
    const config = this.bot.referenceArbitrageRebalancer;
    if (config.dryRun) {
      return { allowed: true, reason: null };
    }

    if (config.allowedMarketIds.length > 0 && !config.allowedMarketIds.includes(marketId)) {
      return { allowed: false, reason: "market_not_in_allowed_live_list" };
    }

    const orderedLiveMarkets = this.bot.marketIds.filter((id) =>
      config.allowedMarketIds.length > 0 ? config.allowedMarketIds.includes(id) : true,
    );
    const maxLiveMarkets = Math.max(1, config.maxLiveMarkets);
    if (!orderedLiveMarkets.slice(0, maxLiveMarkets).includes(marketId)) {
      return { allowed: false, reason: "market_outside_max_live_markets_window" };
    }

    return { allowed: true, reason: null };
  }

  private async ensureRuntimeState(signal: AbortSignal) {
    if (this.runtimeInitPromise) {
      return this.runtimeInitPromise;
    }

    this.runtimeController = new AbortController();
    signal.addEventListener("abort", () => this.runtimeController?.abort(), { once: true });
    this.runtimeInitPromise = this.stateSync.start(this.runtimeController.signal);
    return this.runtimeInitPromise;
  }
}

function upsertOpenOrder(openOrders: Order[], order: Order): Order[] {
  const withoutOrder = openOrders.filter((item) => item.id !== order.id);
  if (order.status === "OPEN" || order.status === "PARTIAL") {
    withoutOrder.push(order);
  }
  return withoutOrder;
}

function serializeBlockState(state: BotBlockState) {
  switch (state.kind) {
    case "none":
      return { kind: "none" };
    case "paused":
      return { kind: "paused", reason: state.reason, code: state.code ?? null };
    case "cooldown":
      return {
        kind: "cooldown",
        reason: state.reason,
        code: state.code ?? null,
        until: new Date(state.until).toISOString(),
      };
  }
}

function serializeError(error: unknown) {
  if (error instanceof PolyApiError) {
    return {
      name: error.name,
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

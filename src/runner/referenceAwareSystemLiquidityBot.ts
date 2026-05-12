import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { Order } from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { normalizeLocalReferenceMarket, LocalReferenceMarket } from "../referenceMarket/localReferenceMarkets.js";
import { PolymarketGammaClient } from "../referenceMarket/polymarketGammaClient.js";
import { ReferencePriceCache } from "../referenceMarket/referencePriceCache.js";
import { ReferencePriceUpdater } from "../referenceMarket/referencePriceUpdater.js";
import { buildReferenceAwareQuotePlan } from "../strategies/liquidity/quotePlanner.js";
import { StrategyAction } from "../strategies/shared/types.js";
import { sleep } from "../utils/sleep.js";
import {
  BotBlockState,
  classifyPlacementError,
  nextTransportBackoffMs,
  resetTransportBackoff,
} from "./errorHandling.js";
import { BotRiskManager, PlacementRiskContext, RiskEvaluation } from "./botRiskManager.js";
import { RuntimeStateSync } from "./runtimeStateSync.js";

export class ReferenceAwareSystemLiquidityBot {
  private readonly api: ApiClient;
  private readonly logger: BotLogger;
  private readonly stateSync: RuntimeStateSync;
  private readonly riskManager: BotRiskManager;
  private readonly referenceCache: ReferencePriceCache;
  private readonly referenceUpdater: ReferencePriceUpdater;
  private runtimeController: AbortController | null = null;
  private runtimeInitPromise: Promise<void> | null = null;
  private localMarkets = new Map<string, LocalReferenceMarket>();
  private lastMarketRefreshAt = 0;
  private readonly seenFillIds = new Set<string>();
  private readonly lastPlacementByKey = new Map<string, number>();
  private placementBlock: BotBlockState = { kind: "none" };
  private transportBackoffMs = 0;
  private lastPauseSkipLogAt = 0;

  constructor(bot: BotConfig, logsDir: string) {
    this.api = new ApiClient(bot.baseUrl, bot.apiKey);
    this.logger = new BotLogger(bot.name, logsDir);
    this.stateSync = new RuntimeStateSync(bot, this.api, this.logger);
    this.riskManager = new BotRiskManager(bot, "systemLiquidity", this.api, this.logger);
    this.referenceCache = new ReferencePriceCache(bot.referenceAwareSystemLiquidity.referenceStaleMs);
    this.referenceUpdater = new ReferencePriceUpdater(
      new PolymarketGammaClient(),
      this.referenceCache,
      this.logger,
      bot.referenceAwareSystemLiquidity.referencePollMs,
    );
    this.bot = bot;
  }

  private readonly bot: BotConfig;

  async run(signal: AbortSignal): Promise<void> {
    this.logger.info("reference_system_bot_starting", {
      botType: "system_liquidity",
      strategy: this.bot.strategy,
      marketIds: this.bot.marketIds,
      dryRun: this.bot.referenceAwareSystemLiquidity.dryRun,
    });

    await this.ensureRuntimeState(signal);

    while (!signal.aborted) {
      try {
        await this.runCycle(signal);
      } catch (error) {
        this.logger.error("error", {
          stage: "reference_system_cycle",
          ...serializeError(error),
        });
      }

      await sleep(this.bot.referenceAwareSystemLiquidity.liquidityBotCycleMs, signal).catch(() => undefined);
    }

    this.logger.info("reference_system_bot_stopping");
    this.shutdown();
  }

  shutdown() {
    this.runtimeController?.abort();
    this.logger.close();
  }

  private async runCycle(signal: AbortSignal) {
    await this.ensureRuntimeState(signal);
    await this.refreshLocalMarketsIfNeeded();

    if (this.isDailyNotionalPlacementBlock()) {
      this.logPauseHeartbeat();
      return;
    }

    let { balance, positions, fillsPage, openOrdersPage } = await this.stateSync.getAccountSnapshot(signal);
    let openOrders = openOrdersPage.items;

    for (const fill of fillsPage.items) {
      if (!this.seenFillIds.has(fill.id)) {
        this.seenFillIds.add(fill.id);
        this.riskManager.noteFill(fill);
        this.logger.info("fill_seen", fill);
      }
    }

    for (const marketId of this.bot.marketIds) {
      const market = this.localMarkets.get(marketId);
      if (!market) {
        this.logger.warn("reference_market_missing_local_metadata", { marketId });
        continue;
      }

      const quoteResponse = await this.stateSync.getMarketQuote(marketId);
      const freshness = this.stateSync.getFreshnessMetrics(marketId);
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

      const plan = buildReferenceAwareQuotePlan({
        bot: this.bot,
        market,
        quoteResponse,
        balanceAvailableUSDC: balance.availableUSDC,
        positions: positions.items,
        openOrders,
        now: new Date(),
        referenceCache: this.referenceCache,
        riskState: riskEvaluation.state,
      });

      this.logger.info("reference_quote_plan", {
        botId: this.bot.name,
        botType: "system_liquidity",
        marketId,
        marketTitle: market.title,
        dryRun: this.bot.referenceAwareSystemLiquidity.dryRun,
        outcomes: plan.outcomes,
      });

      openOrders = await this.executeActions(
        plan.actions,
        marketId,
        quoteResponse,
        {
          balance,
          positions: positions.items,
          freshness,
          riskEvaluation,
        },
        openOrders,
        signal,
      );
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

    for (const action of actions) {
      if (signal.aborted) {
        return nextOpenOrders;
      }

      if (action.type === "skip") {
        this.logger.info("order_submit_skipped", {
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: action.reason,
          ...(action.details ?? {}),
        });
        continue;
      }

      if (action.type === "cancel") {
        if (this.bot.referenceAwareSystemLiquidity.dryRun) {
          nextOpenOrders = nextOpenOrders.filter((order) => order.id !== action.orderId);
          this.logger.info("dry_run_cancel", {
            orderId: action.orderId,
            reason: action.reason,
            ...(action.details ?? {}),
          });
          continue;
        }

        try {
          const result = await this.api.cancelOrder(action.orderId);
          nextOpenOrders = nextOpenOrders.filter((order) => order.id !== action.orderId);
          this.riskManager.noteCancel();
          this.logger.info("order_canceled", {
            orderId: action.orderId,
            reason: action.reason,
            order: result.order,
            ...(action.details ?? {}),
          });
        } catch (error) {
          this.logger.error("error", {
            stage: "cancel_order",
            orderId: action.orderId,
            reason: action.reason,
            ...serializeError(error),
          });
          this.riskManager.noteApiError(error, { stage: "cancel_order", marketId });
        }
        continue;
      }

      const quote = quoteResponse.quotes.find((item) => item.outcomeId === action.outcomeId);
      if (!quote) {
        continue;
      }

      const now = Date.now();
      const blockReason = this.resolvePlacementBlock(now);
      if (blockReason) {
        this.logPlacementBlockSkip(marketId, action.outcomeId, blockReason, nextOpenOrders.length);
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
          nextAllowedAt: new Date(lastPlacementAt + this.bot.decisionCooldownMs).toISOString(),
        });
        continue;
      }

      const placementDecision = this.riskManager.checkPlacement({
        marketId,
        outcomeId: action.outcomeId,
        action,
        balance: runtimeState.balance,
        positions: runtimeState.positions,
        openOrders: nextOpenOrders,
        quote,
        marketQuotes: quoteResponse.quotes,
        freshness: runtimeState.freshness,
        evaluation: runtimeState.riskEvaluation,
      } satisfies PlacementRiskContext);
      if (!placementDecision.allow) {
        this.riskManager.noteRiskSkip(placementDecision.reason);
        this.logger.warn("risk_check_failed", {
          marketId,
          side: action.side,
          reason: placementDecision.reason,
          ...placementDecision.details,
        });
        continue;
      }

      if (this.bot.referenceAwareSystemLiquidity.dryRun) {
        nextOpenOrders = upsertOpenOrder(nextOpenOrders, {
          id: `dry-run:${action.clientOrderId}`,
          clientOrderId: action.clientOrderId,
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          type: "LIMIT",
          status: "OPEN",
          apiKeyId: null,
          price: action.price,
          size: action.size,
          remaining: action.size,
          reservedNotional:
            action.side === "BUY"
              ? (Number(action.price) * Number(action.size)).toFixed(6)
              : "0",
          createdAt: new Date(now).toISOString(),
        });
        this.logger.info("dry_run_place", {
          marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          price: action.price,
          size: action.size,
          ...(action.details ?? {}),
        });
        continue;
      }

      try {
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
        this.logger.info("order_submitted", {
          order: result.order,
          ...(action.details ?? {}),
        });
      } catch (error) {
        const classification = classifyPlacementError(
          error,
          this.bot,
          now,
          nextTransportBackoffMs(this.transportBackoffMs),
        );
        if (classification.category === "transport") {
          this.transportBackoffMs = nextTransportBackoffMs(this.transportBackoffMs);
        }
        if (classification.blockState.kind !== "none") {
          this.placementBlock = classification.blockState;
        }
        this.logger.error("error", {
          stage: "place_order",
          marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          ...serializeError(error),
        });
        this.riskManager.noteApiError(error, { stage: "place_order", marketId });
      }
    }

    return nextOpenOrders;
  }

  private async cancelAllOpenOrders(openOrders: Order[]) {
    if (this.bot.referenceAwareSystemLiquidity.dryRun) {
      for (const order of openOrders) {
        this.logger.info("dry_run_cancel", {
          orderId: order.id,
          reason: "emergency_stop_cancel_all",
        });
      }
      return openOrders;
    }

    let remaining = [...openOrders];
    for (const order of openOrders) {
      try {
        await this.api.cancelOrder(order.id);
        remaining = remaining.filter((item) => item.id !== order.id);
        this.riskManager.noteCancel();
      } catch (error) {
        this.riskManager.noteApiError(error, { stage: "cancel_order", marketId: order.marketId });
      }
    }
    return remaining;
  }

  private async ensureRuntimeState(signal: AbortSignal) {
    if (this.runtimeInitPromise) {
      return this.runtimeInitPromise;
    }
    this.runtimeController = new AbortController();
    signal.addEventListener("abort", () => this.runtimeController?.abort(), { once: true });
    this.runtimeInitPromise = (async () => {
      await this.refreshLocalMarketsIfNeeded(true);
      await this.stateSync.start(this.runtimeController!.signal);
      this.referenceUpdater.setMarkets(Array.from(this.localMarkets.values()));
      void this.referenceUpdater.start(this.runtimeController!.signal);
    })();
    return this.runtimeInitPromise;
  }

  private async refreshLocalMarketsIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now - this.lastMarketRefreshAt < 60_000) {
      return;
    }

    const fetched = await Promise.all(
      this.bot.marketIds.map(async (marketId) => {
        try {
          const response = await this.api.getMarket(marketId);
          return normalizeLocalReferenceMarket(response);
        } catch (error) {
          this.logger.warn("reference_market_metadata_refresh_failed", {
            marketId,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );

    this.localMarkets = new Map(
      fetched
        .filter((market): market is LocalReferenceMarket => market !== null)
        .map((market) => [market.id, market]),
    );
    this.referenceUpdater.setMarkets(Array.from(this.localMarkets.values()));
    this.lastMarketRefreshAt = now;
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
    });
  }
}

function upsertOpenOrder(openOrders: Order[], order: Order): Order[] {
  const withoutOrder = openOrders.filter((item) => item.id !== order.id);
  if (order.status === "OPEN" || order.status === "PARTIAL") {
    withoutOrder.push(order);
  }
  return withoutOrder;
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

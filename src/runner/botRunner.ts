import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { Order, Quote } from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { inventoryAwareMakerStrategy } from "../strategies/inventoryAwareMaker.js";
import { noiseTraderStrategy } from "../strategies/noiseTrader.js";
import {
  collectStaleCleanupActions,
  sampleLoopDelayMs,
  StrategyAction,
  StrategyContext,
} from "../strategies/common.js";
import { tightMarketMakerStrategy } from "../strategies/tightMarketMaker.js";
import { sleep } from "../utils/sleep.js";
import {
  BotBlockState,
  classifyPlacementError,
  nextTransportBackoffMs,
  resetTransportBackoff,
} from "./errorHandling.js";

type StrategyFn = (context: StrategyContext) => StrategyAction[];

export class BotRunner {
  private readonly api: ApiClient;
  private readonly logger: BotLogger;
  private readonly seenFillIds = new Set<string>();
  private readonly lastPlacementByKey = new Map<string, number>();
  private placementBlock: BotBlockState = { kind: "none" };
  private transportBackoffMs = 0;
  private lastPauseSkipLogAt = 0;

  constructor(private readonly bot: BotConfig, logsDir: string) {
    this.api = new ApiClient(bot.baseUrl, bot.apiKey);
    this.logger = new BotLogger(bot.name, logsDir);
  }

  async run(signal: AbortSignal): Promise<void> {
    this.logger.info("bot_starting", {
      strategy: this.bot.strategy,
      marketIds: this.bot.marketIds,
      baseUrl: this.bot.baseUrl,
    });

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
    this.logger.close();
  }

  private async runCycle(signal: AbortSignal) {
    if (signal.aborted) {
      return;
    }

    if (this.isDailyNotionalPlacementBlock()) {
      this.logPauseHeartbeat();
      return;
    }

    const [balance, positions, fillsPage, openOrdersPage] = await Promise.all([
      this.api.getBalance(),
      this.api.getPositions(),
      this.api.getFills({ limit: 25 }),
      this.api.getOrders({
        status: ["OPEN", "PARTIAL"],
        limit: 100,
      }),
    ]);
    let openOrders = openOrdersPage.items;

    for (const fill of fillsPage.items) {
      if (!this.seenFillIds.has(fill.id)) {
        this.seenFillIds.add(fill.id);
        this.logger.info("fill_seen", fill);
      }
    }

    for (const marketId of this.bot.marketIds) {
      const quoteResponse = await this.api.getQuote(marketId);

      for (const quote of quoteResponse.quotes) {
        const marketOpenOrders = openOrders.filter((order) => order.marketId === marketId);
        const outcomeOpenOrders = marketOpenOrders.filter((order) => order.outcomeId === quote.outcomeId);
        const context: StrategyContext = {
          bot: this.bot,
          marketId,
          quote,
          balance,
          positions: positions.items,
          totalOpenOrders: openOrders,
          marketOpenOrders,
          outcomeOpenOrders,
          now: new Date(),
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
        });

        const activeBlock = this.resolvePlacementBlock(Date.now());
        const actions = activeBlock
          ? collectStaleCleanupActions(context)
          : this.selectStrategy()(context);

        if (activeBlock) {
          this.logPlacementBlockSkip(marketId, quote.outcomeId, activeBlock, openOrders.length);
        }

        openOrders = await this.executeActions(actions, marketId, quote, openOrders, signal);
      }
    }
  }

  private async executeActions(
    actions: StrategyAction[],
    marketId: string,
    quote: Quote,
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
      if (blockReason) {
        if (!pauseSkipLogged && now - this.lastPauseSkipLogAt >= this.bot.pauseLogIntervalMs) {
          this.lastPauseSkipLogAt = now;
          pauseSkipLogged = true;
          this.logger.info("order_submit_skipped", {
            marketId,
            outcomeId: quote.outcomeId,
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

      const placementKey = `${marketId}:${quote.outcomeId}:${action.side}`;
      const lastPlacementAt = this.lastPlacementByKey.get(placementKey) ?? 0;
      if (lastPlacementAt + this.bot.decisionCooldownMs > now) {
        this.logger.info("order_submit_skipped", {
          marketId,
          outcomeId: quote.outcomeId,
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
        outcomeId: quote.outcomeId,
        side: action.side,
        reason: action.reason,
        price: action.price,
        size: action.size,
        totalOpenOrders: nextOpenOrders.length,
        ...(action.details ? action.details : {}),
      });

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
          outcomeId: quote.outcomeId,
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
      }
    }

    return nextOpenOrders;
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
    }
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

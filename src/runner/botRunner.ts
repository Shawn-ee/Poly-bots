import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { Order, Quote } from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { getStaleOrders } from "../strategies/common.js";
import { passiveBuyerStrategy, StrategyAction, StrategyContext } from "../strategies/passiveBuyer.js";
import { passiveSellerStrategy } from "../strategies/passiveSeller.js";
import { randomMakerStrategy } from "../strategies/randomMaker.js";
import { sleep } from "../utils/sleep.js";

type StrategyFn = (context: StrategyContext) => StrategyAction[];

export class BotRunner {
  private readonly api: ApiClient;
  private readonly apiKeyId: string;
  private readonly logger: BotLogger;
  private readonly seenFillIds = new Set<string>();
  private readonly lastPlacementByKey = new Map<string, number>();
  private capBackoffUntil = 0;
  private consecutiveCapRejections = 0;

  constructor(private readonly bot: BotConfig, logsDir: string) {
    this.api = new ApiClient(bot.baseUrl, bot.apiKey);
    this.apiKeyId = bot.apiKey.split(".", 1)[0] ?? "";
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
        await sleep(this.bot.pollIntervalMs, signal);
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

    let [balance, positions, fillsPage, openOrders] = await Promise.all([
      this.api.getBalance(),
      this.api.getPositions(),
      this.api.getFills({ limit: 25 }),
      this.loadKeyScopedOpenOrders(),
    ]);

    for (const fill of fillsPage.items) {
      if (!this.seenFillIds.has(fill.id)) {
        this.seenFillIds.add(fill.id);
        this.logger.info("fill_seen", fill);
      }
    }

    const cleanup = await this.cancelStaleOrders(openOrders, signal);
    openOrders = cleanup.openOrders;

    if (cleanup.canceledAny) {
      [balance, positions, openOrders] = await Promise.all([
        this.api.getBalance(),
        this.api.getPositions(),
        this.loadKeyScopedOpenOrders(),
      ]);

      if (openOrders.length < this.bot.maxOpenOrders) {
        this.consecutiveCapRejections = 0;
        this.capBackoffUntil = 0;
      }
    }

    for (const marketId of this.bot.marketIds) {
      const quoteResponse = await this.api.getQuote(marketId);

      for (const quote of quoteResponse.quotes) {
        const marketOpenOrders = openOrders.filter((order) => order.marketId === marketId);
        const outcomeOpenOrders = marketOpenOrders.filter((order) => order.outcomeId === quote.outcomeId);

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

        const actions = this.selectStrategy()({
          bot: this.bot,
          marketId,
          quote,
          balance,
          positions: positions.items,
          totalOpenOrders: openOrders,
          marketOpenOrders,
          outcomeOpenOrders,
          now: new Date(),
        });

        openOrders = await this.executeActions(actions, openOrders, signal);
      }
    }
  }

  private async loadKeyScopedOpenOrders(): Promise<Order[]> {
    const page = await this.api.getOrders({
      status: ["OPEN", "PARTIAL"],
      limit: 100,
    });
    return page.items.filter((order) => order.apiKeyId === this.apiKeyId);
  }

  private async cancelStaleOrders(openOrders: Order[], signal: AbortSignal): Promise<{
    openOrders: Order[];
    canceledAny: boolean;
  }> {
    const staleOrders = getStaleOrders(openOrders, this.bot.staleOrderMs, new Date()).sort((left, right) =>
      (left.createdAt ?? "").localeCompare(right.createdAt ?? ""),
    );

    if (staleOrders.length === 0) {
      return { openOrders, canceledAny: false };
    }

    let nextOpenOrders = openOrders;
    let canceledAny = false;

    for (const order of staleOrders) {
      if (signal.aborted) {
        break;
      }

      try {
        const result = await this.api.cancelOrder(order.id);
        nextOpenOrders = nextOpenOrders.filter((item) => item.id !== order.id);
        canceledAny = true;
        this.logger.info("order_canceled", {
          orderId: order.id,
          reason: "stale_order_cleanup",
          totalOpenOrders: nextOpenOrders.length,
          order: result.order,
        });
      } catch (error) {
        this.logger.error("error", {
          stage: "cancel_stale_order",
          orderId: order.id,
          reason: "stale_order_cleanup",
          ...serializeError(error),
        });
      }
    }

    return { openOrders: nextOpenOrders, canceledAny };
  }

  private async executeActions(
    actions: StrategyAction[],
    openOrders: Order[],
    signal: AbortSignal,
  ): Promise<Order[]> {
    let nextOpenOrders = openOrders;

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
          capBackoffUntil:
            this.capBackoffUntil > Date.now() ? new Date(this.capBackoffUntil).toISOString() : null,
          ...action.details,
        });
        continue;
      }

      const now = Date.now();
      const placementKey = `${action.marketId}:${action.outcomeId}:${action.side}`;

      if (nextOpenOrders.length >= this.bot.maxOpenOrders) {
        this.logger.info("order_submit_skipped", {
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: "at_total_open_order_cap_skip",
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
        });
        continue;
      }

      if (this.capBackoffUntil > now) {
        this.logger.info("order_submit_skipped", {
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: "cooldown_skip",
          cooldownType: "cap_backoff",
          capBackoffUntil: new Date(this.capBackoffUntil).toISOString(),
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
        });
        continue;
      }

      const lastPlacementAt = this.lastPlacementByKey.get(placementKey) ?? 0;
      if (lastPlacementAt + this.bot.decisionCooldownMs > now) {
        this.logger.info("order_submit_skipped", {
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          reason: "cooldown_skip",
          cooldownType: "decision",
          nextAllowedAt: new Date(lastPlacementAt + this.bot.decisionCooldownMs).toISOString(),
        });
        continue;
      }

      this.logger.info("decision_made", {
        marketId: action.marketId,
        outcomeId: action.outcomeId,
        side: action.side,
        reason: action.reason,
        price: action.price,
        size: action.size,
        totalOpenOrders: nextOpenOrders.length,
      });

      try {
        const totalOpenOrdersBefore = nextOpenOrders.length;
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
        this.consecutiveCapRejections = 0;
        this.capBackoffUntil = 0;
        nextOpenOrders = upsertOpenOrder(nextOpenOrders, result.order);

        this.logger.info("order_submitted", {
          order: result.order,
          idempotencyKey: action.idempotencyKey,
          totalOpenOrdersBefore,
          totalOpenOrdersAfter: nextOpenOrders.length,
        });
      } catch (error) {
        const serialized = serializeError(error);
        if (error instanceof PolyApiError && error.code === "OPEN_ORDER_LIMIT_EXCEEDED") {
          this.consecutiveCapRejections += 1;
          const backoffMultiplier = Math.min(this.consecutiveCapRejections, 3);
          this.capBackoffUntil = now + this.bot.capBackoffMs * backoffMultiplier;
        }

        this.logger.warn("error", {
          stage: "place_order",
          marketId: action.marketId,
          outcomeId: action.outcomeId,
          side: action.side,
          idempotencyKey: action.idempotencyKey,
          totalOpenOrders: nextOpenOrders.length,
          maxOpenOrders: this.bot.maxOpenOrders,
          consecutiveCapRejections: this.consecutiveCapRejections,
          capBackoffUntil:
            this.capBackoffUntil > now ? new Date(this.capBackoffUntil).toISOString() : null,
          ...serialized,
        });
      }
    }

    return nextOpenOrders;
  }

  private selectStrategy(): StrategyFn {
    switch (this.bot.strategy) {
      case "passiveBuyer":
        return passiveBuyerStrategy;
      case "passiveSeller":
        return passiveSellerStrategy;
      case "randomMaker":
        return randomMakerStrategy;
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

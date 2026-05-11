import { ApiClient } from "../api/apiClient.js";
import { SseClient } from "../api/sseClient.js";
import {
  AccountStreamEvent,
  Balance,
  CursorPage,
  Fill,
  MarketStreamEvent,
  Order,
  Position,
  PositionsResponse,
  Quote,
  QuoteResponse,
} from "../api/types.js";
import { BotConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { compareDecimal, multiplyDecimal } from "../utils/decimal.js";

type AccountSnapshot = {
  balance: Balance;
  positions: PositionsResponse;
  fillsPage: CursorPage<Fill>;
  openOrdersPage: CursorPage<Order>;
};

export type FreshnessMetrics = {
  lastMarketEventAt: string | null;
  lastAccountEventAt: string | null;
  lastPollingSyncAt: string | null;
  marketStateAgeMs: number | null;
  accountStateAgeMs: number | null;
  sseReconnectCount: number;
  staleStateDetectedCount: number;
};

type MarketCacheEntry = {
  quoteResponse: QuoteResponse | null;
  outcomeNames: Map<string, string>;
  lastEventAt: number | null;
  lastPolledAt: number | null;
  streamHealthy: boolean;
};

export class RuntimeStateSync {
  private readonly accountStream: SseClient;
  private readonly marketStreams = new Map<string, SseClient>();
  private readonly marketCache = new Map<string, MarketCacheEntry>();
  private balance: Balance | null = null;
  private openOrdersPage: CursorPage<Order> = { items: [], nextCursor: null };
  private fillsPage: CursorPage<Fill> = { items: [], nextCursor: null };
  private positions: PositionsResponse = { items: [] };
  private lastAccountEventAt: number | null = null;
  private lastPollingSyncAt: number | null = null;
  private lastPositionsPolledAt: number | null = null;
  private sseReconnectCount = 0;
  private staleStateDetectedCount = 0;
  private readonly staleStateThresholdMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly positionsPollIntervalMs: number;

  constructor(
    private readonly bot: BotConfig,
    private readonly api: ApiClient,
    private readonly logger: BotLogger,
  ) {
    this.accountStream = this.api.createAccountStreamClient();
    this.staleStateThresholdMs = Math.max(15_000, bot.loopIntervalMaxMs * 3);
    this.reconcileIntervalMs = Math.max(15_000, bot.pollIntervalMs * 5);
    this.positionsPollIntervalMs = Math.max(2_500, bot.pollIntervalMs);

    for (const marketId of bot.marketIds) {
      this.marketStreams.set(marketId, this.api.createMarketStreamClient(marketId));
      this.marketCache.set(marketId, {
        quoteResponse: null,
        outcomeNames: new Map<string, string>(),
        lastEventAt: null,
        lastPolledAt: null,
        streamHealthy: false,
      });
    }
  }

  async start(signal: AbortSignal) {
    await this.reconcileAll("startup");
    this.startAccountStream(signal);
    for (const marketId of this.bot.marketIds) {
      this.startMarketStream(marketId, signal);
    }
  }

  async getAccountSnapshot(signal?: AbortSignal): Promise<AccountSnapshot> {
    await this.ensureAccountCache(signal);
    await this.ensurePositions(signal);

    if (!this.balance) {
      await this.reconcileAccountCache("missing_balance_cache");
    }

    return {
      balance: this.balance!,
      positions: this.positions,
      fillsPage: this.fillsPage,
      openOrdersPage: this.openOrdersPage,
    };
  }

  async getMarketQuote(marketId: string): Promise<QuoteResponse> {
    await this.ensureMarketCache(marketId);
    const entry = this.marketCache.get(marketId);
    if (!entry?.quoteResponse) {
      const quoteResponse = await this.api.getQuote(marketId);
      this.updateMarketQuoteCacheFromPoll(marketId, quoteResponse);
      return quoteResponse;
    }
    return entry.quoteResponse;
  }

  getFreshnessMetrics(marketId: string): FreshnessMetrics {
    const marketEntry = this.marketCache.get(marketId);
    const now = Date.now();
    const marketFreshAt = latestTimestamp(marketEntry?.lastEventAt ?? null, marketEntry?.lastPolledAt ?? null);
    const accountFreshAt = latestTimestamp(this.lastAccountEventAt, this.lastPollingSyncAt);
    return {
      lastMarketEventAt: marketEntry?.lastEventAt ? new Date(marketEntry.lastEventAt).toISOString() : null,
      lastAccountEventAt: this.lastAccountEventAt ? new Date(this.lastAccountEventAt).toISOString() : null,
      lastPollingSyncAt: this.lastPollingSyncAt ? new Date(this.lastPollingSyncAt).toISOString() : null,
      marketStateAgeMs: marketFreshAt ? now - marketFreshAt : null,
      accountStateAgeMs: accountFreshAt ? now - accountFreshAt : null,
      sseReconnectCount: this.sseReconnectCount,
      staleStateDetectedCount: this.staleStateDetectedCount,
    };
  }

  private async reconcileAll(reason: string) {
    await Promise.all([
      this.reconcileAccountCache(reason),
      this.reconcilePositions(reason),
      ...this.bot.marketIds.map((marketId) => this.reconcileMarketCache(marketId, reason)),
    ]);
  }

  private async ensureAccountCache(signal?: AbortSignal) {
    const now = Date.now();
    const accountFreshAt = latestTimestamp(this.lastAccountEventAt, this.lastPollingSyncAt);
    const ageMs = accountFreshAt ? now - accountFreshAt : null;
    const missing = !this.balance;
    const stale = ageMs !== null && ageMs > this.staleStateThresholdMs;
    const periodic = this.lastPollingSyncAt === null || now - this.lastPollingSyncAt > this.reconcileIntervalMs;

    if (missing || stale || periodic) {
      if (stale) {
        this.recordStaleState("account", null, ageMs);
      }
      await this.reconcileAccountCache(missing ? "missing_account_cache" : stale ? "stale_account_cache" : "periodic_account_reconciliation");
    }
  }

  private async ensurePositions(signal?: AbortSignal) {
    const now = Date.now();
    const periodic =
      this.lastPositionsPolledAt === null || now - this.lastPositionsPolledAt > this.positionsPollIntervalMs;
    if (periodic) {
      await this.reconcilePositions("positions_poll");
    }
  }

  private async ensureMarketCache(marketId: string) {
    const entry = this.marketCache.get(marketId);
    const now = Date.now();
    const baseTs = latestTimestamp(entry?.lastEventAt ?? null, entry?.lastPolledAt ?? null);
    const ageMs = baseTs ? now - baseTs : null;
    const missing = !entry?.quoteResponse;
    const stale = ageMs !== null && ageMs > this.staleStateThresholdMs;
    const periodic = !entry?.lastPolledAt || now - entry.lastPolledAt > this.reconcileIntervalMs;

    if (missing || stale || periodic) {
      if (stale) {
        this.recordStaleState("market", marketId, ageMs);
      }
      await this.reconcileMarketCache(
        marketId,
        missing ? "missing_market_cache" : stale ? "stale_market_cache" : "periodic_market_reconciliation",
      );
    }
  }

  private startAccountStream(signal: AbortSignal) {
    void this.accountStream.stream<AccountStreamEvent>({
      signal,
      onStatus: (status) => this.handleStreamStatus("account", null, status),
      onMessage: async (event) => {
        this.lastAccountEventAt = Date.now();
        this.applyAccountEvent(event);
      },
    });
  }

  private startMarketStream(marketId: string, signal: AbortSignal) {
    const client = this.marketStreams.get(marketId);
    if (!client) {
      return;
    }

    void client.stream<MarketStreamEvent>({
      signal,
      onStatus: (status) => this.handleStreamStatus("market", marketId, status),
      onMessage: async (event) => {
        const entry = this.getMarketEntry(marketId);
        entry.lastEventAt = Date.now();
        entry.streamHealthy = true;
        this.applyMarketEvent(marketId, event);
      },
    });
  }

  private async reconcileAccountCache(reason: string) {
    this.logger.info("polling_reconciliation", {
      scope: "account",
      reason,
    });
    const [balance, fillsPage, openOrdersPage] = await Promise.all([
      this.api.getBalance(),
      this.api.getFills({ limit: 25 }),
      this.api.getOrders({
        status: ["OPEN", "PARTIAL"],
        limit: 100,
      }),
    ]);

    this.balance = balance;
    this.fillsPage = fillsPage;
    this.openOrdersPage = openOrdersPage;
    this.lastPollingSyncAt = Date.now();
  }

  private async reconcilePositions(reason: string) {
    this.logger.info("polling_reconciliation", {
      scope: "positions",
      reason,
    });
    this.positions = await this.api.getPositions();
    this.lastPositionsPolledAt = Date.now();
    this.lastPollingSyncAt = Date.now();
  }

  private async reconcileMarketCache(marketId: string, reason: string) {
    this.logger.info("polling_reconciliation", {
      scope: "market",
      marketId,
      reason,
    });
    const quoteResponse = await this.api.getQuote(marketId);
    this.updateMarketQuoteCacheFromPoll(marketId, quoteResponse);
    const entry = this.getMarketEntry(marketId);
    entry.lastPolledAt = Date.now();
    this.lastPollingSyncAt = Date.now();
  }

  private applyAccountEvent(event: AccountStreamEvent) {
    const payload = event.payload;
    if (payload.balance) {
      this.balance = {
        availableUSDC: payload.balance.availableUSDC,
        lockedUSDC: payload.balance.lockedUSDC,
        totalUSDC: payload.balance.totalUSDC,
        updatedAt: event.ts,
      };
    }

    this.openOrdersPage = {
      items: payload.orders.map((order) => ({
        id: order.id,
        clientOrderId: order.clientOrderId,
        marketId: order.marketId,
        outcomeId: order.outcomeId,
        outcomeName: order.outcomeName,
        side: order.side,
        type: "LIMIT",
        status: normalizeOrderStatus(order.status),
        apiKeyId: order.apiKeyId,
        price: order.price,
        size: order.amount,
        remaining: order.remaining,
        reservedNotional: "0",
        createdAt: order.createdAt,
      })),
      nextCursor: null,
    };

    this.fillsPage = {
      items: payload.fills.map((fill) => ({
        id: fill.id,
        orderId: `stream:${fill.id}`,
        marketId: fill.marketId,
        outcomeId: fill.outcomeId,
        side: fill.side,
        liquidityRole: "STREAM",
        price: fill.price,
        size: fill.size,
        notionalUSDC: multiplyDecimal(fill.price, fill.size),
        feeUSDC: fill.feeUSDC,
        createdAt: fill.createdAt,
      })),
      nextCursor: null,
    };
  }

  private applyMarketEvent(marketId: string, event: MarketStreamEvent) {
    const entry = this.getMarketEntry(marketId);
    const priorQuotes = entry.quoteResponse?.quotes ?? [];

    for (const quote of priorQuotes) {
      entry.outcomeNames.set(quote.outcomeId, quote.outcomeName);
    }
    for (const trade of event.payload.recentTrades) {
      entry.outcomeNames.set(trade.outcomeId, trade.outcomeName);
    }

    const outcomeIds = new Set<string>();
    for (const level of event.payload.topLevels.bids) outcomeIds.add(level.outcomeId);
    for (const level of event.payload.topLevels.asks) outcomeIds.add(level.outcomeId);
    for (const trade of event.payload.recentTrades) outcomeIds.add(trade.outcomeId);
    for (const quote of priorQuotes) outcomeIds.add(quote.outcomeId);

    const nextQuotes: Quote[] = Array.from(outcomeIds).map((outcomeId) => {
      const bestBid = maxPrice(event.payload.topLevels.bids, outcomeId);
      const bestAsk = minPrice(event.payload.topLevels.asks, outcomeId);
      const lastTrade = event.payload.recentTrades.find((trade) => trade.outcomeId === outcomeId) ?? null;
      const previous = priorQuotes.find((quote) => quote.outcomeId === outcomeId) ?? null;
      const midPrice =
        bestBid && bestAsk
          ? midpoint(bestBid, bestAsk)
          : previous?.midPrice ?? bestBid ?? bestAsk ?? null;

      return {
        outcomeId,
        outcomeName: entry.outcomeNames.get(outcomeId) ?? previous?.outcomeName ?? outcomeId,
        bestBid,
        bestAsk,
        midPrice,
        lastPrice: lastTrade?.price ?? previous?.lastPrice ?? null,
        lastTradeAt: lastTrade?.createdAt ?? previous?.lastTradeAt ?? null,
      };
    });

    entry.quoteResponse = {
      marketId,
      quotes: nextQuotes.sort((a, b) => a.outcomeName.localeCompare(b.outcomeName)),
    };
  }

  private updateMarketQuoteCacheFromPoll(marketId: string, quoteResponse: QuoteResponse) {
    const entry = this.getMarketEntry(marketId);
    for (const quote of quoteResponse.quotes) {
      entry.outcomeNames.set(quote.outcomeId, quote.outcomeName);
    }
    entry.quoteResponse = quoteResponse;
  }

  private getMarketEntry(marketId: string): MarketCacheEntry {
    const existing = this.marketCache.get(marketId);
    if (existing) {
      return existing;
    }
    const created: MarketCacheEntry = {
      quoteResponse: null,
      outcomeNames: new Map<string, string>(),
      lastEventAt: null,
      lastPolledAt: null,
      streamHealthy: false,
    };
    this.marketCache.set(marketId, created);
    return created;
  }

  private async handleStreamStatus(
    stream: "market" | "account",
    marketId: string | null,
    status: Parameters<NonNullable<Parameters<SseClient["stream"]>[0]["onStatus"]>>[0],
  ) {
    if (status.phase === "reconnecting") {
      this.sseReconnectCount += 1;
    }
    if (stream === "market" && marketId) {
      this.getMarketEntry(marketId).streamHealthy = status.phase === "connected";
    }
    this.logger.info(`sse_${status.phase}`, {
      stream,
      marketId,
      attempt: status.attempt,
      lastEventId: status.lastEventId,
      ...(status.error ? { error: status.error.message } : {}),
    });
  }

  private recordStaleState(scope: "market" | "account", marketId: string | null, ageMs: number | null) {
    this.staleStateDetectedCount += 1;
    this.logger.warn("stale_state_detected", {
      scope,
      marketId,
      ageMs,
      lastMarketEventAt: marketId ? this.getFreshnessMetrics(marketId).lastMarketEventAt : null,
      lastAccountEventAt: this.lastAccountEventAt ? new Date(this.lastAccountEventAt).toISOString() : null,
      lastPollingSyncAt: this.lastPollingSyncAt ? new Date(this.lastPollingSyncAt).toISOString() : null,
      staleStateDetectedCount: this.staleStateDetectedCount,
    });
  }
}

function latestTimestamp(a: number | null, b: number | null) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function normalizeOrderStatus(status: string): Order["status"] {
  return status === "PARTIAL" || status === "FILLED" || status === "CANCELED" ? status : "OPEN";
}

function maxPrice(levels: Array<{ outcomeId: string; price: string }>, outcomeId: string): string | null {
  const matches = levels.filter((level) => level.outcomeId === outcomeId);
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((best, current) => (compareDecimal(current.price, best) > 0 ? current.price : best), matches[0]!.price);
}

function minPrice(levels: Array<{ outcomeId: string; price: string }>, outcomeId: string): string | null {
  const matches = levels.filter((level) => level.outcomeId === outcomeId);
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((best, current) => (compareDecimal(current.price, best) < 0 ? current.price : best), matches[0]!.price);
}

function midpoint(a: string, b: string): string {
  return multiplyDecimal(String((Number(a) + Number(b)) / 2), "1");
}

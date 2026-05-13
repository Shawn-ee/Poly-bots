import {
  AccountStreamEvent,
  AdminCreateMarketRequest,
  AdminCreateMarketResponse,
  AdminImportReferenceMarketRequest,
  AdminImportReferenceMarketResponse,
  AdminReferenceMarketsResponse,
  AdminUpdateReferenceMarketRequest,
  AdminUpdateReferenceMarketResponse,
  AdminMarketInvariantState,
  AdminResolveMarketResponse,
  AdminMarketStatus,
  AdminMarketStatusResponse,
  ApiErrorEnvelope,
  Balance,
  CancelOrderResponse,
  CursorPage,
  EventStreamEnvelope,
  Fill,
  GetOrderResponse,
  LedgerEntry,
  MarketStreamEvent,
  MarketDiscoveryResponse,
  MintCompleteSetResponse,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PositionsResponse,
  QuoteResponse,
} from "./types.js";
import { SseClient } from "./sseClient.js";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
};

type ApiClientOptions = {
  authMode?: "bearer" | "cookie";
  cookieName?: string;
  extraHeaders?: Record<string, string>;
};

export type OrdersFilter = {
  marketId?: string;
  status?: Array<"OPEN" | "PARTIAL" | "FILLED" | "CANCELED">;
  cursor?: string;
  limit?: number;
};

export type MarketsFilter = {
  status?: string;
  view?: "resolved" | "all";
  search?: string;
  category?: string;
  tags?: string;
};

export type FillsFilter = {
  marketId?: string;
  cursor?: string;
  limit?: number;
};

export class PolyApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PolyApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly credential: string;
  private readonly authMode: "bearer" | "cookie";
  private readonly cookieName: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(baseUrl: string, credential: string, options: ApiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.credential = credential;
    this.authMode = options.authMode ?? "bearer";
    this.cookieName = options.cookieName ?? "poly_session";
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async listMarkets(filters: MarketsFilter = {}): Promise<MarketDiscoveryResponse> {
    return this.request("/api/markets", {
      query: {
        status: filters.status,
        view: filters.view,
        search: filters.search,
        category: filters.category,
        tags: filters.tags,
      },
    });
  }

  async getQuote(marketId: string, outcomeId?: string): Promise<QuoteResponse> {
    return this.request(
      `/api/markets/${encodeURIComponent(marketId)}/quote`,
      outcomeId ? { query: { outcomeId } } : {},
    );
  }

  async getBalance(): Promise<Balance> {
    return this.request("/api/account/balance");
  }

  async getPositions(marketId?: string): Promise<PositionsResponse> {
    return this.request("/api/account/positions", marketId ? { query: { marketId } } : {});
  }

  async getLedger(cursor?: string, limit?: number): Promise<CursorPage<LedgerEntry>> {
    return this.request("/api/account/ledger", {
      query: { cursor, limit },
    });
  }

  async getOrders(filters: OrdersFilter = {}): Promise<CursorPage<Order>> {
    return this.request("/api/orders", {
      query: {
        marketId: filters.marketId,
        status: filters.status?.join(","),
        cursor: filters.cursor,
        limit: filters.limit,
      },
    });
  }

  async getOrder(orderId: string): Promise<GetOrderResponse> {
    return this.request(`/api/orders/${encodeURIComponent(orderId)}`);
  }

  async getFills(filters: FillsFilter = {}): Promise<CursorPage<Fill>> {
    return this.request("/api/fills", {
      query: {
        marketId: filters.marketId,
        cursor: filters.cursor,
        limit: filters.limit,
      },
    });
  }

  async placeLimitOrder(
    input: Omit<PlaceOrderRequest, "type">,
    idempotencyKey: string,
  ): Promise<PlaceOrderResponse> {
    return this.request("/api/orders", {
      method: "POST",
      idempotencyKey,
      body: {
        ...input,
        type: "LIMIT",
      },
    });
  }

  async cancelOrder(orderId: string): Promise<CancelOrderResponse> {
    return this.request(`/api/orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE",
    });
  }

  async mintCompleteSet(marketId: string, quantity: string): Promise<MintCompleteSetResponse> {
    return this.request(`/api/orderbook/${encodeURIComponent(marketId)}/mint`, {
      method: "POST",
      body: { quantity },
    });
  }

  async createAdminMarket(input: AdminCreateMarketRequest): Promise<AdminCreateMarketResponse> {
    return this.request("/api/admin/markets/create", {
      method: "POST",
      body: input,
    });
  }

  async importAdminReferenceMarket(
    input: AdminImportReferenceMarketRequest,
  ): Promise<AdminImportReferenceMarketResponse> {
    return this.request("/api/admin/reference-markets/polymarket/import", {
      method: "POST",
      body: input,
    });
  }

  async listAdminReferenceMarkets(filters: {
    source?: string;
    importStatus?: string;
    search?: string;
  } = {}): Promise<AdminReferenceMarketsResponse> {
    return this.request("/api/admin/reference-markets", {
      query: {
        source: filters.source,
        importStatus: filters.importStatus,
        search: filters.search,
      },
    });
  }

  async updateAdminReferenceMarket(
    marketId: string,
    input: AdminUpdateReferenceMarketRequest,
  ): Promise<AdminUpdateReferenceMarketResponse> {
    return this.request(`/api/admin/reference-markets/${encodeURIComponent(marketId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  async updateAdminMarketStatus(
    marketId: string,
    status: AdminMarketStatus,
  ): Promise<AdminMarketStatusResponse> {
    return this.request("/api/admin/markets/pause", {
      method: "POST",
      body: { marketId, status },
    });
  }

  async resolveAdminMarket(
    marketId: string,
    winningOutcomeId: string,
  ): Promise<AdminResolveMarketResponse> {
    return this.request("/api/admin/markets/resolve", {
      method: "POST",
      body: { marketId, winningOutcomeId },
    });
  }

  async getAdminMarketInvariant(marketId: string): Promise<AdminMarketInvariantState> {
    return this.request(`/api/admin/markets/${encodeURIComponent(marketId)}/invariants`);
  }

  createMarketStreamClient(marketId: string, outcomeId?: string): SseClient {
    return new SseClient(
      this.buildUrl(`/api/stream/market/${encodeURIComponent(marketId)}`, outcomeId ? { outcomeId } : undefined),
      this.authHeaders(),
    );
  }

  createAccountStreamClient(marketId?: string): SseClient {
    return new SseClient(
      this.buildUrl("/api/stream/me/orders", marketId ? { marketId } : undefined),
      this.authHeaders(),
    );
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...this.authHeaders(),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...this.extraHeaders,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    const parsed = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const envelope = parsed as ApiErrorEnvelope | null;
      const code = envelope?.error?.code ?? "HTTP_ERROR";
      const message = envelope?.error?.message ?? `Request failed with status ${response.status}`;
      throw new PolyApiError(response.status, code, message, parsed);
    }

    return parsed as T;
  }

  private authHeaders(): Record<string, string> {
    if (this.authMode === "cookie") {
      const cookieValue = this.credential.startsWith(`${this.cookieName}=`)
        ? this.credential
        : `${this.cookieName}=${this.credential}`;
      return {
        Cookie: cookieValue,
      };
    }

    return {
      Authorization: `Bearer ${this.credential}`,
    };
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PolyApiError(500, "INVALID_JSON", "Failed to parse JSON response.", {
      text,
      cause: error,
    });
  }
}

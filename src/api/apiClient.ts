import {
  ApiErrorEnvelope,
  Balance,
  CancelOrderResponse,
  CursorPage,
  Fill,
  GetOrderResponse,
  LedgerEntry,
  MarketDiscoveryResponse,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PositionsResponse,
  QuoteResponse,
} from "./types.js";

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
};

export type OrdersFilter = {
  marketId?: string;
  status?: Array<"OPEN" | "PARTIAL" | "FILLED" | "CANCELED">;
  cursor?: string;
  limit?: number;
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
  private readonly authHeader: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authHeader = `Bearer ${apiKey}`;
  }

  async listMarkets(): Promise<MarketDiscoveryResponse> {
    return this.request("/api/markets");
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

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: this.authHeader,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
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

export type DecimalString = string;

export type MarketDiscoveryResponse = {
  markets: MarketSummary[];
};

export type MarketSummary = {
  id: string;
  title: string;
  status: string;
  mechanism: string;
  visibility: string;
  outcomes: Array<{ id: string; name: string }>;
  prices?: Record<string, number>;
  pricesByOutcome?: Record<string, number>;
};

export type QuoteResponse = {
  marketId: string;
  quotes: Quote[];
};

export type Quote = {
  outcomeId: string;
  outcomeName: string;
  bestBid: DecimalString | null;
  bestAsk: DecimalString | null;
  midPrice: DecimalString | null;
  lastPrice: DecimalString | null;
  lastTradeAt: string | null;
};

export type Balance = {
  availableUSDC: DecimalString;
  lockedUSDC: DecimalString;
  totalUSDC: DecimalString;
  updatedAt: string;
};

export type Position = {
  marketId: string;
  marketTitle: string;
  marketStatus: string;
  outcomeId: string;
  outcomeName: string;
  shares: DecimalString;
  reservedShares: DecimalString;
  avgCost: DecimalString;
  realizedPnl: DecimalString;
  updatedAt: string;
};

export type PositionsResponse = {
  items: Position[];
};

export type LedgerEntry = {
  id: string;
  operation: string;
  reason: string;
  currency: string;
  amountDelta: DecimalString;
  deltaAvailableUSDC: DecimalString;
  deltaLockedUSDC: DecimalString;
  referenceType: string | null;
  referenceId: string | null;
  txHash: string | null;
  chainId: number | null;
  logIndex: number | null;
  tokenAddress: string | null;
  createdAt: string;
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELED";
export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT";

export type Order = {
  id: string;
  clientOrderId: string | null;
  marketId: string;
  marketTitle?: string;
  outcomeId: string;
  outcomeName?: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  apiKeyId: string | null;
  canceledByApiKeyId?: string | null;
  price: DecimalString;
  size: DecimalString;
  remaining: DecimalString;
  reservedNotional: DecimalString;
  createdAt?: string;
  updatedAt?: string;
};

export type Fill = {
  id: string;
  orderId: string;
  marketId: string;
  outcomeId: string;
  side: OrderSide;
  liquidityRole: string;
  price: DecimalString;
  size: DecimalString;
  notionalUSDC: DecimalString;
  feeUSDC: DecimalString;
  createdAt: string;
};

export type GetOrderResponse = {
  order: Order;
  fills: Fill[];
};

export type PlaceOrderRequest = {
  marketId: string;
  outcomeId: string;
  side: OrderSide;
  type: OrderType;
  price: DecimalString;
  size: DecimalString;
  clientOrderId?: string;
};

export type PlaceOrderResponse = {
  order: Order;
  fills: Fill[];
  balance: {
    availableUSDC: DecimalString;
    lockedUSDC: DecimalString;
  };
  position: Position | null;
};

export type CancelOrderResponse = {
  order: Order;
  balance: {
    availableUSDC: DecimalString;
    lockedUSDC: DecimalString;
  };
  position: Position | null;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

export type EventStreamEnvelope = {
  id: string;
  sequence: string;
  type: string;
  ts: string;
  stream: string;
  marketId: string | null;
  outcomeId: string | null;
  userId: string | null;
  payload: unknown;
};

export type DecimalString = string;

export type MarketDiscoveryResponse = {
  markets: MarketSummary[];
};

export type MarketTag = {
  id: string;
  name: string;
  slug: string;
  group: string | null;
};

export type MarketSummary = {
  id: string;
  title: string;
  description?: string;
  status: string;
  mechanism: string;
  visibility: string;
  resolveTime?: string | null;
  resolvedOutcomeId?: string | null;
  createdAt?: string;
  tags?: MarketTag[];
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

export type AdminCreateMarketRequest = {
  title: string;
  description: string;
  resolveTime?: string | null;
  categoryId?: string | null;
  tags?: string[];
  type?: "BINARY" | "MULTI_WINNER";
  outcomes?: string[];
  visibility?: "PUBLIC" | "PRIVATE";
  mechanism?: "ORDERBOOK" | "POOL";
  isSimulated?: boolean;
};

export type AdminCreateMarketResponse = {
  marketId: string;
};

export type AdminMarketStatus = "UPCOMING" | "LIVE" | "CLOSED" | "RESOLVED" | "ACTIVE" | "PAUSED" | "CANCELED";

export type AdminMarketStatusResponse = {
  status: string;
};

export type AdminResolveMarketRequest = {
  marketId: string;
  winningOutcomeId: string;
};

export type AdminResolveMarketResponse = {
  ok: boolean;
  marketId: string;
  winningOutcomeId: string;
  totalPoolPayout?: DecimalString;
  totalWinningShares?: DecimalString;
  collateralDebitedUSDC?: DecimalString;
  payouts?: Array<{ userId: string; amountPaid: DecimalString }>;
};

export type AdminMarketInvariantState = {
  marketId: string;
  marketStatus: string;
  marketMechanism: string;
  marketVisibility: string;
  outcome1: { id: string; name: string };
  outcome2: { id: string; name: string };
  bestBidOutcome1: DecimalString | null;
  bestBidOutcome2: DecimalString | null;
  bestAskOutcome1: DecimalString | null;
  bestAskOutcome2: DecimalString | null;
  bidSum: DecimalString | null;
  askSum: DecimalString | null;
  bidInvariantPass: boolean;
  askInvariantPass: boolean;
  marketCollateralUSDC: DecimalString;
  outstandingSharesOutcome1: DecimalString;
  outstandingSharesOutcome2: DecimalString;
  outstandingSharesEqual: boolean;
  collateralMatchesOutstanding: boolean;
  invariantStatusSummary: string;
  timestamp: string;
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

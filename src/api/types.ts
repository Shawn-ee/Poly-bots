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

export type MintCompleteSetResponse = {
  ok: boolean;
  marketId: string;
  quantity: DecimalString;
  outcomesMinted: number;
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

export type AdminImportReferenceMarketRequest = {
  createEvents?: boolean;
  event?: {
    title: string;
    slug?: string | null;
    description?: string | null;
    category?: string | null;
    status?: string | null;
    source?: string | null;
    externalEventId?: string | null;
    externalSlug?: string | null;
    image?: string | null;
    icon?: string | null;
    metadata?: unknown;
  } | null;
  market: {
    title: string;
    description?: string | null;
    category?: string | null;
    resolveTime?: string | null;
    type?: "BINARY" | "MULTI_WINNER";
    desiredStatus?: "draft" | "paused" | "live";
    externalMarketId?: string | null;
    conditionId?: string | null;
    externalSlug?: string | null;
    referenceSource?: string | null;
    referenceMetadata?: unknown;
    outcomes: Array<{
      name: string;
      displayOrder?: number | null;
      isTradable?: boolean | null;
      referenceTokenId?: string | null;
      referenceOutcomeLabel?: string | null;
      referenceMetadata?: unknown;
    }>;
  };
};

export type AdminImportReferenceMarketResponse = {
  ok: boolean;
  eventId: string | null;
  eventCreated: boolean;
  marketId: string;
  marketCreated: boolean;
  outcomeIds: string[];
};

export type AdminReferenceMarketOutcome = {
  id: string;
  name: string;
  displayOrder: number;
  isTradable: boolean;
  referenceTokenId: string | null;
  referenceOutcomeLabel: string | null;
  referenceMetadata: unknown;
};

export type BotInitializationMetadata = {
  status: string;
  lastCheckedAt: string | null;
  reason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  riskProfile: string | null;
  capital?: {
    budgetCents: number | null;
    mintBudgetCents: number | null;
    mintedCompleteSets: number | null;
    cashReserveCents: number | null;
    autoReplenish: boolean;
    initializedAt: string | null;
    initializedBy: string | null;
    botUserId: string | null;
    botUsername: string | null;
    botApiCredentialId: string | null;
    botApiKeyId: string | null;
    maxSingleOrderNotionalCents: number | null;
    maxOpenOrderNotionalCents: number | null;
    maxDailyLossCents: number | null;
    openOrderNotionalCents?: number | null;
    dailyLossCents?: number | null;
    availableCashUSDC?: number | null;
    lockedCashUSDC?: number | null;
  } | null;
  runtime?: {
    liveOrdersEnabled: boolean;
    emergencyStop: boolean;
    cancelRequestedAt: string | null;
    lastSeededAt: string | null;
    lastLiveRunAt: string | null;
    lastRuntimeSyncAt: string | null;
  } | null;
  readiness?: {
    ready: boolean;
    dryRun: boolean;
    liveRequested: boolean;
    reasons: string[];
    referenceBid: number | null;
    referenceAsk: number | null;
    plannedBotBid: number | null;
    plannedBotAsk: number | null;
    riskProfile: string | null;
    checkedAt: string | null;
  } | null;
};

export type AdminReferenceMarketItem = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  isListed: boolean;
  event: {
    id: string;
    slug: string | null;
    title: string;
    category: string | null;
    source: string | null;
    externalEventId: string | null;
    externalSlug: string | null;
  } | null;
  externalMarketId: string | null;
  externalSlug: string | null;
  conditionId: string | null;
  referenceSource: string | null;
  importStatus: "pending_review" | "approved" | "rejected" | null;
  referenceOnly: boolean | null;
  tradable: boolean | null;
  mmEnabled: boolean | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  outcomePrices: unknown;
  bestBid: unknown;
  bestAsk: unknown;
  spread: unknown;
  lastTradePrice: unknown;
  volume24hr: unknown;
  liquidity: unknown;
  acceptingOrders: unknown;
  snapshotSummary?: {
    source: string;
    referenceBid: number | null;
    referenceAsk: number | null;
    plannedBotBid: number | null;
    plannedBotAsk: number | null;
    qualityStatus: string | null;
    isFresh: boolean;
    mmEligible: boolean;
    dryRun: boolean;
    quotePlanEnabled: boolean;
    hasSnapshot: boolean;
  } | null;
  botInitialization?: BotInitializationMetadata | null;
  referenceMetadata: unknown;
  outcomes: AdminReferenceMarketOutcome[];
};

export type AdminReferenceMarketsResponse = {
  items: AdminReferenceMarketItem[];
};

export type AdminUpdateReferenceMarketRequest = {
  action?:
    | "approve"
    | "reject"
    | "reset"
    | "refresh_snapshot"
    | "run_readiness_check"
    | "mark_dry_run_running"
    | "pause_bot"
    | "reset_bot_initialization"
    | "mark_live_ready"
    | "mark_live_enabled"
    | "emergency_stop"
    | "cancel_bot_quotes";
  importStatus?: "pending_review" | "approved" | "rejected";
  referenceOnly?: boolean;
  tradable?: boolean;
  mmEnabled?: boolean;
  isListed?: boolean;
  reviewNotes?: string;
  botInitialization?: Partial<BotInitializationMetadata> | null;
};

export type AdminUpdateReferenceMarketResponse = {
  ok: boolean;
  marketId: string;
  importStatus: "pending_review" | "approved" | "rejected";
  referenceOnly: boolean;
  tradable: boolean;
  mmEnabled: boolean;
  isListed: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  botInitialization?: BotInitializationMetadata | null;
};

export type AdminReferenceQuoteSnapshotInput = {
  marketId: string;
  outcomeId: string;
  source: string;
  externalSlug?: string | null;
  externalMarketId?: string | null;
  conditionId?: string | null;
  tokenId?: string | null;
  outcomeLabel?: string | null;
  outcomePrice?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  lastTradePrice?: number | null;
  volume?: number | null;
  volume24hr?: number | null;
  liquidity?: number | null;
  liquidityClob?: number | null;
  acceptingOrders?: boolean;
  qualityStatus?: string | null;
  mmEligible?: boolean;
  reason?: string | null;
  fetchedAt: string;
};

export type AdminUpsertReferenceQuoteSnapshotsRequest = {
  snapshots: AdminReferenceQuoteSnapshotInput[];
};

export type AdminUpsertReferenceQuoteSnapshotsResponse = {
  ok: boolean;
  updated: number;
};

export type AdminRefreshReferenceSnapshotsResponse = {
  ok: boolean;
  generatedAt: string;
  dryRun: boolean;
  liveOrdersEnabled: boolean;
  pollMs: number;
  refreshedCount: number;
  skippedCount: number;
  refreshed: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
};

export type MarketReferencePlanOutcome = {
  localMarketId: string;
  localOutcomeId: string;
  outcomeName: string;
  referenceSource: string;
  polymarketSlug: string | null;
  polymarketMarketId: string | null;
  conditionId: string | null;
  polymarketTokenId: string | null;
  gammaOutcomePrice: number | null;
  gammaBestBid: number | null;
  gammaBestAsk: number | null;
  gammaSpread: number | null;
  lastTradePrice: number | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  acceptingOrders: boolean;
  fetchedAt: string | null;
  ageMs: number | null;
  isFresh: boolean;
  hasSnapshot: boolean;
  qualityStatus: string | null;
  mmEligible: boolean;
  mmEnabled: boolean;
  reason: string | null;
  tickSize: string;
  quoteOffsetTicks: number;
  plannedBotBid: number | null;
  plannedBotAsk: number | null;
  referenceBid: number | null;
  referenceAsk: number | null;
  dryRun: boolean;
  liveOrdersEnabled: boolean;
  quotePlanEnabled: boolean;
  quotePreviewAvailable: boolean;
  activeBotBid?: number | null;
  activeBotAsk?: number | null;
  activeBidOrderId?: string | null;
  activeAskOrderId?: string | null;
  formula: string;
};

export type MarketReferencePlanResponse = {
  marketId: string;
  source: string | null;
  externalSlug: string | null;
  externalMarketId?: string | null;
  conditionId: string | null;
  hasSnapshot: boolean;
  reason: string | null;
  dryRun: boolean;
  liveOrdersEnabled: boolean;
  botInitialization?: BotInitializationMetadata | null;
  outcomes: MarketReferencePlanOutcome[];
};

export type AdminSeedReferenceBotRequest = {
  capitalDollars: number;
  mintDollars: number;
  dryRun: boolean;
  confirmSeed?: boolean;
};

export type AdminSeedReferenceBotResponse = {
  ok: boolean;
  dryRun: boolean;
  marketId: string;
  title: string;
  referenceSource: string | null;
  importStatus: string | null;
  isListed: boolean;
  binary: boolean;
  seeded: boolean;
  alreadySeeded: boolean;
  noMutation: boolean;
  capitalCents: number;
  mintBudgetCents: number;
  cashReserveCents: number;
  mintedCompleteSets: number;
  autoReplenish: boolean;
  botUserId: string | null;
  botUsername: string | null;
  botApiCredentialId: string | null;
  botApiKeyId: string | null;
  botApiToken: string | null;
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

export type EventStreamEnvelope<TPayload = unknown> = {
  id: string;
  sequence: string;
  type: string;
  ts: string;
  stream: string;
  marketId: string | null;
  outcomeId: string | null;
  userId: string | null;
  payload: TPayload;
};

export type MarketStreamTopLevel = {
  outcomeId: string;
  price: DecimalString;
  size: DecimalString;
};

export type PublicTradeStreamItem = {
  id: string;
  executionId: string;
  marketId: string;
  outcomeId: string;
  outcomeName: string;
  outcome: string;
  side: OrderSide;
  price: DecimalString;
  quantity: DecimalString;
  shares: DecimalString;
  cost: DecimalString;
  createdAt: string;
};

export type MarketStreamPayload = {
  topLevels: {
    bids: MarketStreamTopLevel[];
    asks: MarketStreamTopLevel[];
  };
  recentTrades: PublicTradeStreamItem[];
};

export type AccountStreamOrder = {
  id: string;
  clientOrderId: string | null;
  apiKeyId: string | null;
  marketId: string;
  outcomeId: string;
  outcomeName: string;
  side: OrderSide;
  price: DecimalString;
  amount: DecimalString;
  remaining: DecimalString;
  status: string;
  createdAt: string;
};

export type AccountStreamFill = {
  id: string;
  marketId: string;
  outcomeId: string;
  side: OrderSide;
  price: DecimalString;
  size: DecimalString;
  feeUSDC: DecimalString;
  createdAt: string;
};

export type AccountStreamPayload = {
  balance: {
    availableUSDC: DecimalString;
    lockedUSDC: DecimalString;
    totalUSDC: DecimalString;
  } | null;
  orders: AccountStreamOrder[];
  fills: AccountStreamFill[];
};

export type MarketStreamEvent = EventStreamEnvelope<MarketStreamPayload>;
export type AccountStreamEvent = EventStreamEnvelope<AccountStreamPayload>;

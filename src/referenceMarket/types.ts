export type ReferenceSource = "polymarket";
export type ReferenceReviewStatus = "pending_review" | "approved" | "rejected" | "synthetic";
export type ReferenceQualityStatus =
  | "high_quality"
  | "stale"
  | "wide"
  | "missing_book"
  | "invalid_price"
  | "not_approved"
  | "not_mm_enabled"
  | "available";
export type ReferenceIneligibilityReason =
  | "reference_stale"
  | "reference_spread_too_wide"
  | "reference_missing_book"
  | "reference_not_approved"
  | "reference_not_mm_enabled"
  | "reference_invalid_price";

export type ReferenceOutcome = {
  label: string;
  tokenId: string | null;
  index: number;
  outcomePrice: number | null;
};

export type ReferenceEventCandidate = {
  title: string;
  slug: string | null;
  description: string | null;
  category: string | null;
  status: string | null;
  source: ReferenceSource;
  externalEventId: string | null;
  externalSlug: string | null;
  image: string | null;
  icon: string | null;
  metadata: unknown;
};

export type ReferenceMarketCandidate = {
  source: ReferenceSource;
  externalMarketId: string;
  conditionId: string | null;
  slug: string | null;
  question: string;
  description: string | null;
  category: string | null;
  tags: string[];
  eventSlug: string | null;
  startDate: string | null;
  endDate: string | null;
  resolutionSource: string | null;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  competitive: boolean | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  liquidityClob: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  updatedAt: string | null;
  image: string | null;
  icon: string | null;
  outcomePrices: number[];
  event: ReferenceEventCandidate | null;
  outcomes: ReferenceOutcome[];
  clobTokenIds: string[];
  raw: unknown;
};

export type ReferenceQuote = {
  source: ReferenceSource;
  tokenId: string;
  outcome: string;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  receivedAt: string;
  isAvailable: boolean;
  isStale: boolean;
  raw: {
    book?: unknown;
    buyPrice?: unknown;
    sellPrice?: unknown;
    midpoint?: unknown;
  };
};

export type ReferenceMarketSnapshot = {
  candidate: ReferenceMarketCandidate;
  quotes: ReferenceQuote[];
  capturedAt: string;
};

export type ReferenceMarketMapping = {
  localMarketId: string;
  localOutcomeId: string;
  localOutcome: string;
  source: ReferenceSource;
  polymarketMarketId: string;
  conditionId: string | null;
  polymarketSlug: string | null;
  polymarketTokenId: string;
  polymarketOutcome: string;
  enabled: boolean;
  mmEnabled: boolean;
  reviewStatus: ReferenceReviewStatus;
  lastMappedAt: string;
  notes: string | null;
};

export type ReferencePriceQuote = {
  source: ReferenceSource;
  localMarketId: string;
  localOutcomeId: string;
  polymarketMarketId: string;
  conditionId: string | null;
  polymarketSlug: string | null;
  polymarketOutcome: string;
  polymarketTokenId: string;
  gammaOutcomePrice: number | null;
  gammaBestBid: number | null;
  gammaBestAsk: number | null;
  gammaSpread: number | null;
  lastTradePrice: number | null;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  liquidityClob: number | null;
  acceptingOrders: boolean;
  competitive: boolean | null;
  updatedAt: string | null;
  fetchedAt: string;
  receivedAt: string;
  displayProbability: number | null;
  executableBid: number | null;
  executableAsk: number | null;
  spread: number | null;
  isFresh: boolean;
  isAvailable: boolean;
  isStale: boolean;
  qualityStatus: ReferenceQualityStatus;
  mmEligible: boolean;
  reason: ReferenceIneligibilityReason | null;
};

export type ImportWorldCupOptions = {
  limit: number;
  dryRun: boolean;
  createLocalMarkets: boolean;
  createEvents: boolean;
  status: "draft" | "paused" | "live";
  query: string | null;
  slug: string | null;
  outputPath: string;
  mappingPath: string;
  baseUrl: string;
  adminSessionCookie: string | null;
};

export type ImportWorldCupResult = {
  fetchedAt: string;
  queriesUsed: string[];
  totalCandidatesFetched: number;
  totalCandidatesSelected: number;
  selectedCandidates: ReferenceMarketCandidate[];
  snapshots: ReferenceMarketSnapshot[];
  mappingsWritten: ReferenceMarketMapping[];
  localMarketsCreated: Array<{
    localMarketId: string;
    externalMarketId: string;
    question: string;
    created: boolean;
  }>;
  outputPath: string;
  mappingPath: string;
  dryRun: boolean;
  createLocalMarkets: boolean;
  createEvents: boolean;
  status: "draft" | "paused" | "live";
};

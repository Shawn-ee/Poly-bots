import {
  ReferenceEventCandidate,
  ReferenceMarketCandidate,
  ReferenceOutcome,
} from "./types.js";

type GammaMarketWire = Record<string, unknown>;

const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

const WORLD_CUP_TERMS = [
  "world cup",
  "fifa",
  "soccer",
  "football",
  "2026 world cup",
  "world cup winner",
  "world cup final",
  "world cup group",
];

const NEGATIVE_WORLD_CUP_TERMS = ["cricket", "rugby", "t20", "icc"];

export class PolymarketGammaClient {
  constructor(
    private readonly baseUrl: string = DEFAULT_GAMMA_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async searchWorldCupMarkets(params: {
    queries: string[];
    limit: number;
  }): Promise<ReferenceMarketCandidate[]> {
    const seen = new Map<string, ReferenceMarketCandidate>();

    for (const query of params.queries) {
      const page = await this.fetchMarketsPage(query, params.limit);
      for (const wire of page) {
        const candidate = normalizeGammaMarket(wire);
        if (!candidate) {
          continue;
        }
        if (!isRelevantWorldCupMarket(candidate)) {
          continue;
        }
        const key = candidate.externalMarketId || candidate.conditionId || candidate.slug || candidate.question;
        if (!seen.has(key)) {
          seen.set(key, candidate);
        }
      }
    }

    return Array.from(seen.values())
      .sort(compareCandidates)
      .slice(0, params.limit);
  }

  async getMarketBySlug(slug: string): Promise<ReferenceMarketCandidate | null> {
    const url = new URL("/markets", this.baseUrl);
    url.searchParams.set("slug", slug);

    const response = await this.fetchImpl(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Gamma API request failed: ${response.status} ${response.statusText}`);
    }

    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Gamma API returned unexpected payload.");
    }

    const first = parsed.find((value) => !!value && typeof value === "object") as GammaMarketWire | undefined;
    return first ? normalizeGammaMarket(first) : null;
  }

  private async fetchMarketsPage(query: string, limit: number): Promise<GammaMarketWire[]> {
    const url = new URL("/markets", this.baseUrl);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("archived", "false");
    url.searchParams.set("search", query);

    const response = await this.fetchImpl(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Gamma API request failed: ${response.status} ${response.statusText}`);
    }

    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Gamma API returned unexpected payload.");
    }

    return parsed.filter((value): value is GammaMarketWire => !!value && typeof value === "object");
  }
}

export function normalizeGammaMarket(input: GammaMarketWire): ReferenceMarketCandidate | null {
  const externalMarketId = asString(input.id) ?? asString(input.marketId) ?? asString(input.questionID);
  const question = asString(input.question) ?? asString(input.title) ?? asString(input.name);
  if (!externalMarketId || !question) {
    return null;
  }

  const clobTokenIds = parseTokenIds(input.clobTokenIds);
  const outcomePrices = parseOutcomePrices(input.outcomePrices);
  const outcomes = parseOutcomes(input, clobTokenIds, outcomePrices);

  return {
    source: "polymarket",
    externalMarketId,
    conditionId: asString(input.conditionId),
    slug: asString(input.slug),
    question,
    description: asString(input.description),
    category: asString(input.category),
    tags: parseTags(input.tags),
    eventSlug: asString(input.eventSlug),
    startDate: asIsoString(input.startDate),
    endDate: asIsoString(input.endDate ?? input.endDateIso ?? input.resolveBy),
    resolutionSource: asString(input.resolutionSource),
    active: asBoolean(input.active),
    closed: asBoolean(input.closed),
    archived: asBoolean(input.archived),
    acceptingOrders: asBoolean(input.acceptingOrders),
    competitive: asNullableBoolean(input.competitive),
    volume: asNumber(input.volume ?? input.volumeNum),
    volume24hr: asNumber(input.volume24hr ?? input.volume24Hour ?? input.volume24h),
    liquidity: asNumber(input.liquidity ?? input.liquidityNum),
    liquidityClob: asNumber(input.liquidityClob),
    bestBid: asNumber(input.bestBid),
    bestAsk: asNumber(input.bestAsk),
    spread: asNumber(input.spread),
    lastTradePrice: asNumber(input.lastTradePrice),
    updatedAt: asIsoString(input.updatedAt ?? input.updated_at),
    image: asString(input.image),
    icon: asString(input.icon),
    outcomePrices,
    event: parseEvent(input),
    outcomes,
    clobTokenIds,
    raw: input,
  };
}

export function isRelevantWorldCupMarket(candidate: ReferenceMarketCandidate): boolean {
  const haystack = [
    candidate.question,
    candidate.description ?? "",
    candidate.slug ?? "",
    candidate.category ?? "",
    candidate.eventSlug ?? "",
    ...candidate.tags,
  ]
    .join(" ")
    .toLowerCase();

  const hasPositive = WORLD_CUP_TERMS.some((term) => haystack.includes(term));
  if (!hasPositive) {
    return false;
  }

  const hasSoccerHint = haystack.includes("fifa") || haystack.includes("soccer") || haystack.includes("football");
  const hasNegative = NEGATIVE_WORLD_CUP_TERMS.some((term) => haystack.includes(term));
  if (hasNegative && !hasSoccerHint) {
    return false;
  }

  return candidate.active && !candidate.closed && !candidate.archived && candidate.clobTokenIds.length > 0;
}

function compareCandidates(left: ReferenceMarketCandidate, right: ReferenceMarketCandidate) {
  return (
    compareBool(right.active, left.active) ||
    compareBool(left.closed, right.closed) ||
    compareBool(left.archived, right.archived) ||
    compareNullableNumber(right.liquidity, left.liquidity) ||
    compareNullableNumber(right.volume, left.volume) ||
    compareNullableNumber(right.bestBid, left.bestBid) ||
    left.question.localeCompare(right.question)
  );
}

function compareBool(a: boolean, b: boolean) {
  return Number(a) - Number(b);
}

function compareNullableNumber(a: number | null, b: number | null) {
  return (a ?? -1) - (b ?? -1);
}

function parseTokenIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseTokenIds(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function parseOutcomes(
  input: GammaMarketWire,
  tokenIds: string[],
  outcomePrices: number[],
): ReferenceOutcome[] {
  const labels = parseOutcomeLabels(input.outcomes);
  if (labels.length > 0) {
    return labels.map((label, index) => ({
      label,
      tokenId: tokenIds[index] ?? null,
      index,
      outcomePrice: outcomePrices[index] ?? null,
    }));
  }

  return tokenIds.map((tokenId, index) => ({
    label: index === 0 ? "Yes" : index === 1 ? "No" : `Outcome ${index + 1}`,
    tokenId,
    index,
    outcomePrice: outcomePrices[index] ?? null,
  }));
}

function parseOutcomeLabels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseOutcomeLabels(parsed);
    } catch {
      return value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        return asString((entry as Record<string, unknown>).label) ?? asString((entry as Record<string, unknown>).name);
      }
      return null;
    })
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseOutcomePrices(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asNumber(item))
      .filter((item): item is number => typeof item === "number");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseOutcomePrices(parsed);
    } catch {
      return value
        .split(",")
        .map((part) => asNumber(part.trim()))
        .filter((item): item is number => typeof item === "number");
    }
  }
  return [];
}

function parseEvent(input: GammaMarketWire): ReferenceEventCandidate | null {
  const eventsValue = input.events;
  const seriesValue = input.series;
  const eventWire = Array.isArray(eventsValue) && eventsValue.length > 0 && typeof eventsValue[0] === "object"
    ? (eventsValue[0] as GammaMarketWire)
    : seriesValue && typeof seriesValue === "object"
      ? (seriesValue as GammaMarketWire)
      : null;

  if (!eventWire) {
    return null;
  }

  const title =
    asString(eventWire.title) ??
    asString(eventWire.name) ??
    asString(eventWire.slug);
  if (!title) {
    return null;
  }

  return {
    title,
    slug: asString(eventWire.slug),
    description: asString(eventWire.description),
    category: asString(eventWire.category),
    status: asString(eventWire.status),
    source: "polymarket",
    externalEventId: asString(eventWire.id),
    externalSlug: asString(eventWire.slug),
    image: asString(eventWire.image),
    icon: asString(eventWire.icon),
    metadata: {
      event: Array.isArray(eventsValue) ? eventsValue[0] ?? null : null,
      series: seriesValue ?? null,
    },
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function asNullableBoolean(value: unknown): boolean | null {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asIsoString(value: unknown): string | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

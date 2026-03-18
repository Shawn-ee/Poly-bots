import { AdminCreateMarketRequest, MarketSummary } from "../api/types.js";

export const SIM_MARKET_TAG = "poly-bot-sim";
export const SIM_MARKET_TITLE_PREFIX = "[SIM]";

export type SimTemplateVariant = {
  title: string;
  description: string;
  marketType: "BINARY" | "MULTI_WINNER";
  outcomes?: string[];
};

export type SimMarketTemplate = {
  type: string;
  buildVariant(index: number): SimTemplateVariant;
};

export type SimMarketDraft = {
  templateType: string;
  closeTime: string;
  resolveTime: string;
  request: AdminCreateMarketRequest;
};

export type SimMarketLifecycleInfo = {
  market: MarketSummary;
  closeTime: string;
  closeTimeMs: number;
};

export type SimResolvableMarketInfo = {
  market: MarketSummary;
  resolveTime: string;
  resolveTimeMs: number;
};

export type SimResolutionDecision = {
  chosenOutcomeId: string;
  chosenOutcomeName: string;
  resolverMode: string;
  probabilityUsed?: number;
  fallbackUsed?: boolean;
  reason: string;
};

export type SimHealthStatus = "OK" | "WARN" | "ERROR";

export type SimHealthCheckResult = {
  checkName: string;
  status: SimHealthStatus;
  affectedCount: number;
  sampleMarketIds?: string[];
  sampleOrderIds?: string[];
  thresholdUsed?: number;
  durationMs: number;
  details?: Record<string, unknown>;
};

export type SimHealthSummary = {
  ts: string;
  overallStatus: SimHealthStatus;
  checks: SimHealthCheckResult[];
};

export function isSimulatedMarket(market: MarketSummary): boolean {
  if (market.tags?.some((tag) => tag.slug === SIM_MARKET_TAG || tag.name === SIM_MARKET_TAG)) {
    return true;
  }

  return market.title.startsWith(SIM_MARKET_TITLE_PREFIX);
}

export function parseSimCloseTime(market: MarketSummary): string | null {
  const description = market.description ?? "";
  const match = description.match(/Close target:\s*([0-9T:\-\.Z]+)/i);
  if (!match?.[1]) {
    return null;
  }

  const closeTime = new Date(match[1]);
  if (Number.isNaN(closeTime.getTime())) {
    return null;
  }

  return closeTime.toISOString();
}

export function parseSimResolveTime(market: MarketSummary): string | null {
  if (!market.resolveTime) {
    return null;
  }

  const resolveTime = new Date(market.resolveTime);
  if (Number.isNaN(resolveTime.getTime())) {
    return null;
  }

  return resolveTime.toISOString();
}

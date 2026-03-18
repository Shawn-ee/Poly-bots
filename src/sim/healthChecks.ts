import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { MarketSummary } from "../api/types.js";
import { SimConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import {
  isSimulatedMarket,
  parseSimCloseTime,
  parseSimResolveTime,
  SimHealthCheckResult,
  SimHealthStatus,
  SimHealthSummary,
} from "./types.js";

export async function runSimHealthChecks(
  api: ApiClient,
  logger: BotLogger,
  sim: SimConfig,
  now: Date = new Date(),
): Promise<SimHealthSummary> {
  const startedAt = Date.now();
  logger.info("sim_health_start", {
    now: now.toISOString(),
    maxClosedUnresolvedAgeMs: sim.maxClosedUnresolvedAgeMs,
    maxAllowedActiveMarkets: sim.maxAllowedActiveMarkets,
  });

  const marketsResponse = await api.listMarkets({ view: "all" });
  const markets = marketsResponse.markets.filter(isSimulatedMarket);

  const checks = await Promise.all([
    checkClosedUnresolvedSimMarkets(markets, sim, now),
    checkOrphanOrdersOnInactiveSimMarkets(api, markets),
    checkInvalidSimLifecycleStates(markets, now),
    checkSimMarketCount(markets, sim),
  ]);

  for (const check of checks) {
    logger.info("sim_health_check_result", check);
    if (check.status !== "OK") {
      logger.warn("sim_health_issue_detected", check);
    }
  }

  const overallStatus = deriveOverallStatus(checks);
  const summary: SimHealthSummary = {
    ts: now.toISOString(),
    overallStatus,
    checks,
  };

  logger.info("sim_health_summary", {
    overallStatus,
    checkCount: checks.length,
    durationMs: Date.now() - startedAt,
  });
  logger.info("sim_health_complete", {
    overallStatus,
    durationMs: Date.now() - startedAt,
  });

  return summary;
}

async function checkClosedUnresolvedSimMarkets(
  markets: MarketSummary[],
  sim: SimConfig,
  now: Date,
): Promise<SimHealthCheckResult> {
  const startedAt = Date.now();
  const nowMs = now.getTime();
  const affected = markets.filter((market) => {
    if (market.status !== "CLOSED") {
      return false;
    }

    const closeTime = parseSimCloseTime(market);
    if (!closeTime) {
      return false;
    }

    return nowMs - new Date(closeTime).getTime() > sim.maxClosedUnresolvedAgeMs;
  });

  return {
    checkName: "closed_unresolved_markets",
    status: affected.length > 0 ? "ERROR" : "OK",
    affectedCount: affected.length,
    ...(affected.length > 0 ? { sampleMarketIds: affected.slice(0, 5).map((market) => market.id) } : {}),
    thresholdUsed: sim.maxClosedUnresolvedAgeMs,
    durationMs: Date.now() - startedAt,
  };
}

async function checkOrphanOrdersOnInactiveSimMarkets(
  api: ApiClient,
  markets: MarketSummary[],
): Promise<SimHealthCheckResult> {
  const startedAt = Date.now();
  const inactive = markets.filter((market) => market.status === "CLOSED" || market.status === "RESOLVED");
  const affectedMarketIds: string[] = [];
  let skippedInvariantChecks = 0;

  for (const market of inactive) {
    try {
      const invariant = await api.getAdminMarketInvariant(market.id);
      const hasRestingBook =
        invariant.bestBidOutcome1 !== null ||
        invariant.bestBidOutcome2 !== null ||
        invariant.bestAskOutcome1 !== null ||
        invariant.bestAskOutcome2 !== null;
      if (hasRestingBook) {
        affectedMarketIds.push(market.id);
      }
    } catch (error) {
      if (error instanceof PolyApiError && error.status === 400) {
        skippedInvariantChecks += 1;
        continue;
      }
      throw error;
    }
  }

  const status: SimHealthStatus =
    affectedMarketIds.length > 0 ? "ERROR" : skippedInvariantChecks > 0 ? "WARN" : "OK";

  return {
    checkName: "orphan_open_orders_on_inactive_markets",
    status,
    affectedCount: affectedMarketIds.length,
    ...(affectedMarketIds.length > 0 ? { sampleMarketIds: affectedMarketIds.slice(0, 5) } : {}),
    durationMs: Date.now() - startedAt,
    ...(skippedInvariantChecks > 0 ? { details: { skippedInvariantChecks } } : {}),
  };
}

async function checkInvalidSimLifecycleStates(
  markets: MarketSummary[],
  now: Date,
): Promise<SimHealthCheckResult> {
  const startedAt = Date.now();
  const nowMs = now.getTime();
  const affected = markets.filter((market) => {
    const closeTime = parseSimCloseTime(market);
    const resolveTime = parseSimResolveTime(market);

    if ((market.status === "LIVE" || market.status === "ACTIVE") && market.resolvedOutcomeId) {
      return true;
    }

    if (market.status === "RESOLVED") {
      if (closeTime && new Date(closeTime).getTime() > nowMs) {
        return true;
      }
      if (resolveTime && new Date(resolveTime).getTime() > nowMs) {
        return true;
      }
    }

    return false;
  });

  return {
    checkName: "invalid_sim_lifecycle_states",
    status: affected.length > 0 ? "ERROR" : "OK",
    affectedCount: affected.length,
    ...(affected.length > 0 ? { sampleMarketIds: affected.slice(0, 5).map((market) => market.id) } : {}),
    durationMs: Date.now() - startedAt,
  };
}

async function checkSimMarketCount(
  markets: MarketSummary[],
  sim: SimConfig,
): Promise<SimHealthCheckResult> {
  const startedAt = Date.now();
  const activeCount = markets.filter((market) => market.status === "LIVE" || market.status === "ACTIVE").length;

  if (sim.maxAllowedActiveMarkets === undefined) {
    return {
      checkName: "active_sim_market_count",
      status: "OK",
      affectedCount: 0,
      durationMs: Date.now() - startedAt,
      details: { activeCount, capConfigured: false },
    };
  }

  const exceededBy = Math.max(activeCount - sim.maxAllowedActiveMarkets, 0);
  return {
    checkName: "active_sim_market_count",
    status: exceededBy > 0 ? "WARN" : "OK",
    affectedCount: exceededBy,
    thresholdUsed: sim.maxAllowedActiveMarkets,
    durationMs: Date.now() - startedAt,
    details: { activeCount, maxAllowedActiveMarkets: sim.maxAllowedActiveMarkets },
  };
}

function deriveOverallStatus(checks: SimHealthCheckResult[]): SimHealthStatus {
  if (checks.some((check) => check.status === "ERROR")) {
    return "ERROR";
  }
  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }
  return "OK";
}

import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { SimConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { chooseSimResolution } from "./resolverStrategies.js";
import {
  isSimulatedMarket,
  parseSimCloseTime,
  parseSimResolveTime,
  SimMarketLifecycleInfo,
  SimResolvableMarketInfo,
} from "./types.js";

export async function listClosableSimMarkets(
  api: ApiClient,
  now: Date,
): Promise<SimMarketLifecycleInfo[]> {
  const response = await api.listMarkets();
  const nowMs = now.getTime();

  return response.markets
    .filter((market) => isSimulatedMarket(market) && (market.status === "LIVE" || market.status === "ACTIVE"))
    .map((market) => {
      const closeTime = parseSimCloseTime(market);
      if (!closeTime) {
        return null;
      }

      return {
        market,
        closeTime,
        closeTimeMs: new Date(closeTime).getTime(),
      };
    })
    .filter((item): item is SimMarketLifecycleInfo => item !== null && item.closeTimeMs <= nowMs)
    .sort((left, right) => left.closeTimeMs - right.closeTimeMs || left.market.id.localeCompare(right.market.id));
}

export async function runSimClosePass(
  api: ApiClient,
  logger: BotLogger,
  sim: SimConfig,
  now: Date = new Date(),
) {
  logger.info("sim_close_start", {
    maxClosePerRun: sim.maxClosePerRun,
    now: now.toISOString(),
  });

  const candidates = await listClosableSimMarkets(api, now);
  const closable = candidates.slice(0, sim.maxClosePerRun);
  logger.info("sim_close_candidates_found", {
    candidateCount: candidates.length,
    processLimit: sim.maxClosePerRun,
    processCount: closable.length,
  });

  let closedCount = 0;
  let alreadyClosedCount = 0;
  let failedCount = 0;

  for (const candidate of closable) {
    logger.info("sim_market_close_attempt", {
      marketId: candidate.market.id,
      title: candidate.market.title,
      closeTime: candidate.closeTime,
    });

    try {
      await closeSimMarket(api, candidate.market.id);
      closedCount += 1;
      logger.info("sim_market_closed", {
        marketId: candidate.market.id,
        title: candidate.market.title,
        closeTime: candidate.closeTime,
      });
    } catch (error) {
      if (isAlreadyClosedError(error)) {
        alreadyClosedCount += 1;
        logger.info("sim_market_already_closed", {
          marketId: candidate.market.id,
          title: candidate.market.title,
          closeTime: candidate.closeTime,
          error: formatLifecycleError(error),
        });
        continue;
      }

      failedCount += 1;
      logger.warn("sim_market_close_failed", {
        marketId: candidate.market.id,
        title: candidate.market.title,
        closeTime: candidate.closeTime,
        error: formatLifecycleError(error),
      });
    }
  }

  logger.info("sim_close_complete", {
    candidateCount: candidates.length,
    processedCount: closable.length,
    closedCount,
    alreadyClosedCount,
    failedCount,
  });
}

export async function closeSimMarket(api: ApiClient, marketId: string) {
  return api.updateAdminMarketStatus(marketId, "CLOSED");
}

export async function listResolvableSimMarkets(
  api: ApiClient,
  now: Date,
): Promise<SimResolvableMarketInfo[]> {
  const response = await api.listMarkets({ view: "all" });
  const nowMs = now.getTime();

  return response.markets
    .filter((market) => isSimulatedMarket(market) && market.status === "CLOSED")
    .map((market) => {
      const resolveTime = parseSimResolveTime(market);
      if (!resolveTime) {
        return null;
      }

      return {
        market,
        resolveTime,
        resolveTimeMs: new Date(resolveTime).getTime(),
      };
    })
    .filter((item): item is SimResolvableMarketInfo => item !== null && item.resolveTimeMs <= nowMs)
    .sort((left, right) => left.resolveTimeMs - right.resolveTimeMs || left.market.id.localeCompare(right.market.id));
}

export async function runSimResolvePass(
  api: ApiClient,
  logger: BotLogger,
  sim: SimConfig,
  now: Date = new Date(),
) {
  logger.info("sim_resolve_start", {
    maxResolvePerRun: sim.maxResolvePerRun,
    resolverMode: sim.resolverMode,
    now: now.toISOString(),
  });

  const candidates = await listResolvableSimMarkets(api, now);
  const resolvable = candidates.slice(0, sim.maxResolvePerRun);
  logger.info("sim_resolve_candidates_found", {
    candidateCount: candidates.length,
    processLimit: sim.maxResolvePerRun,
    processedCount: resolvable.length,
    resolverMode: sim.resolverMode,
  });

  let resolvedCount = 0;
  let alreadyResolvedCount = 0;
  let failedCount = 0;
  let settledCount = 0;
  let settleSkippedCount = 0;

  for (const candidate of resolvable) {
    try {
      const decision = await chooseSimResolution(api, candidate.market, sim);
      logger.info("sim_market_resolution_decided", {
        marketId: candidate.market.id,
        title: candidate.market.title,
        resolveTime: candidate.resolveTime,
        resolverMode: decision.resolverMode,
        chosenOutcome: decision.chosenOutcomeName,
        chosenOutcomeId: decision.chosenOutcomeId,
        probabilityUsed: decision.probabilityUsed,
        fallbackUsed: decision.fallbackUsed,
        reason: decision.reason,
      });

      logger.info("sim_market_resolve_attempt", {
        marketId: candidate.market.id,
        title: candidate.market.title,
        resolveTime: candidate.resolveTime,
        resolverMode: decision.resolverMode,
        chosenOutcome: decision.chosenOutcomeName,
        chosenOutcomeId: decision.chosenOutcomeId,
      });

      const response = await resolveSimMarket(api, candidate.market.id, decision.chosenOutcomeId);
      resolvedCount += 1;
      logger.info("sim_market_resolved", {
        marketId: candidate.market.id,
        title: candidate.market.title,
        resolveTime: candidate.resolveTime,
        chosenOutcome: decision.chosenOutcomeName,
        chosenOutcomeId: decision.chosenOutcomeId,
        resolverMode: decision.resolverMode,
        totalPoolPayout: response.totalPoolPayout,
        collateralDebitedUSDC: response.collateralDebitedUSDC,
      });

      if (sim.settleAfterResolve) {
        logger.info("sim_market_settle_attempt", {
          marketId: candidate.market.id,
          title: candidate.market.title,
          reason: "requested_by_config",
        });
        settleSkippedCount += 1;
        logger.info("sim_market_settle_skipped", {
          marketId: candidate.market.id,
          title: candidate.market.title,
          reason: "resolve_endpoint_already_settles",
        });
      } else {
        settleSkippedCount += 1;
        logger.info("sim_market_settle_skipped", {
          marketId: candidate.market.id,
          title: candidate.market.title,
          reason: "separate_settlement_not_required",
        });
      }
    } catch (error) {
      if (isAlreadyResolvedError(error)) {
        alreadyResolvedCount += 1;
        logger.info("sim_market_already_resolved", {
          marketId: candidate.market.id,
          title: candidate.market.title,
          resolveTime: candidate.resolveTime,
          error: formatLifecycleError(error),
        });
        continue;
      }

      failedCount += 1;
      logger.warn("sim_market_resolve_failed", {
        marketId: candidate.market.id,
        title: candidate.market.title,
        resolveTime: candidate.resolveTime,
        error: formatLifecycleError(error),
      });
    }
  }

  logger.info("sim_resolve_complete", {
    candidateCount: candidates.length,
    processedCount: resolvable.length,
    resolvedCount,
    alreadyResolvedCount,
    settledCount,
    settleSkippedCount,
    failedCount,
  });
}

export async function resolveSimMarket(
  api: ApiClient,
  marketId: string,
  winningOutcomeId: string,
) {
  return api.resolveAdminMarket(marketId, winningOutcomeId);
}

export function createSimAdminApi(sim: SimConfig): ApiClient {
  return new ApiClient(sim.baseUrl, sim.sessionCookie, {
    authMode: "cookie",
  });
}

export function formatLifecycleError(error: unknown) {
  if (error instanceof PolyApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

function isAlreadyClosedError(error: unknown): boolean {
  if (!(error instanceof PolyApiError)) {
    return false;
  }

  if (error.status === 404) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("invalid status transition") || message.includes("already closed");
}

function isAlreadyResolvedError(error: unknown): boolean {
  if (!(error instanceof PolyApiError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return error.status === 409 || message.includes("already been resolved") || message.includes("already resolved");
}

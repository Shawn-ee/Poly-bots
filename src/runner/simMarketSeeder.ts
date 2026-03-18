import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApiClient, PolyApiError } from "../api/apiClient.js";
import { loadConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { createSimMarketDraft } from "../sim/marketFactory.js";
import { isSimulatedMarket } from "../sim/types.js";
import { sleep } from "../utils/sleep.js";

export type SimRuntimeConfig = ReturnType<typeof loadConfig>["sim"];

export async function main() {
  const config = loadConfig(process.cwd(), { requireBots: false });
  const logsDir = path.resolve(process.cwd(), "logs");
  const logger = new BotLogger("sim-market-seeder", logsDir);
  const controller = new AbortController();

  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    if (!config.sim.enabled) {
      logger.info("sim_seed_complete", { reason: "sim_disabled" });
      return;
    }

    if (!config.sim.sessionCookie) {
      throw new Error("sim.sessionCookie or POLY_SIM_SESSION_COOKIE is required when sim seeding is enabled.");
    }

    const api = new ApiClient(config.sim.baseUrl, config.sim.sessionCookie, {
      authMode: "cookie",
    });

    do {
      await runSimSeedPass(api, logger, config.sim);
      if (controller.signal.aborted || config.sim.intervalMs <= 0) {
        break;
      }
      await sleep(config.sim.intervalMs, controller.signal).catch(() => undefined);
    } while (!controller.signal.aborted);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    logger.close();
  }
}

export async function runSimSeedPass(api: ApiClient, logger: BotLogger, sim: SimRuntimeConfig) {
  logger.info("sim_seed_start", {
    targetActiveMarkets: sim.targetActiveMarkets,
    maxCreatePerRun: sim.maxCreatePerRun,
  });

  const activeMarkets = await listActiveSimulatedMarkets(api);
  const beforeCount = activeMarkets.length;
  logger.info("sim_active_market_count", {
    activeSimulatedMarkets: beforeCount,
    targetActiveMarkets: sim.targetActiveMarkets,
  });

  const missingCount = Math.max(sim.targetActiveMarkets - beforeCount, 0);
  const createCount = Math.min(missingCount, sim.maxCreatePerRun);
  let createdCount = 0;

  for (let index = 0; index < createCount; index += 1) {
    const draft = createSimMarketDraft({
      sequence: beforeCount + createdCount + index,
      now: new Date(),
      defaultMarketDurationMinutes: sim.defaultMarketDurationMinutes,
      resolveDelayMinutes: sim.resolveDelayMinutes,
    });

    logger.info("sim_market_create_attempt", {
      templateType: draft.templateType,
      beforeCount,
      targetActiveMarkets: sim.targetActiveMarkets,
      plannedCloseTime: draft.closeTime,
      plannedResolveTime: draft.resolveTime,
      title: draft.request.title,
    });

    try {
      const created = await api.createAdminMarket(draft.request);
      await api.updateAdminMarketStatus(created.marketId, "LIVE");
      createdCount += 1;
      logger.info("sim_market_created", {
        marketId: created.marketId,
        templateType: draft.templateType,
        beforeCount,
        afterCount: beforeCount + createdCount,
      });
    } catch (error) {
      logger.warn("sim_market_create_failed", {
        templateType: draft.templateType,
        beforeCount,
        error: formatError(error),
      });
    }
  }

  logger.info("sim_seed_complete", {
    beforeCount,
    afterCount: beforeCount + createdCount,
    createdCount,
    targetActiveMarkets: sim.targetActiveMarkets,
  });
}

async function listActiveSimulatedMarkets(api: ApiClient) {
  const response = await api.listMarkets();
  return response.markets.filter((market) => {
    if (!isSimulatedMarket(market)) {
      return false;
    }

    return market.status === "LIVE" || market.status === "ACTIVE";
  });
}

function formatError(error: unknown) {
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

function isEntrypoint() {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entrypoint)).href;
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error("sim-market-seeder failed", error);
    process.exitCode = 1;
  });
}

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { createSimAdminApi, runSimResolvePass } from "../sim/lifecycle.js";
import { sleep } from "../utils/sleep.js";

export { runSimResolvePass };

export async function main() {
  const config = loadConfig(process.cwd(), { requireBots: false });
  const logsDir = path.resolve(process.cwd(), "logs");
  const logger = new BotLogger("sim-market-resolver", logsDir);
  const controller = new AbortController();

  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    if (!config.sim.enabled) {
      logger.info("sim_resolve_complete", { reason: "sim_disabled" });
      return;
    }

    if (!config.sim.sessionCookie) {
      throw new Error("sim.sessionCookie or POLY_SIM_SESSION_COOKIE is required when sim resolver is enabled.");
    }

    const api = createSimAdminApi(config.sim);

    do {
      await runSimResolvePass(api, logger, config.sim);
      if (controller.signal.aborted || config.sim.resolveLoopIntervalMs <= 0) {
        break;
      }
      await sleep(config.sim.resolveLoopIntervalMs, controller.signal).catch(() => undefined);
    } while (!controller.signal.aborted);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    logger.close();
  }
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
    console.error("sim-market-resolver failed", error);
    process.exitCode = 1;
  });
}

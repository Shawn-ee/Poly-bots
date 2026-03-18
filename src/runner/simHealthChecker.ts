import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { createSimAdminApi, formatLifecycleError } from "../sim/lifecycle.js";
import { runSimHealthChecks } from "../sim/healthChecks.js";
import { SimHealthSummary } from "../sim/types.js";
import { sleep } from "../utils/sleep.js";

export async function runSimHealthPass(
  api: ReturnType<typeof createSimAdminApi>,
  logger: BotLogger,
  sim: ReturnType<typeof loadConfig>["sim"],
): Promise<SimHealthSummary> {
  return runSimHealthChecks(api, logger, sim);
}

export async function main() {
  const args = new Set(process.argv.slice(2));
  const loopMode = args.has("--loop");
  const emitJson = args.has("--json");
  const config = loadConfig(process.cwd(), { requireBots: false });
  const logsDir = path.resolve(process.cwd(), "logs");
  const logger = new BotLogger("sim-health-checker", logsDir);
  const controller = new AbortController();

  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    if (!config.sim.enabled) {
      logger.info("sim_health_complete", { reason: "sim_disabled" });
      return;
    }

    if (!config.sim.sessionCookie) {
      throw new Error("sim.sessionCookie or POLY_SIM_SESSION_COOKIE is required when sim health checker is enabled.");
    }

    const api = createSimAdminApi(config.sim);
    let exitCode = 0;

    do {
      try {
        const summary = await runSimHealthPass(api, logger, config.sim);
        if (emitJson || config.sim.emitJsonSummary) {
          process.stdout.write(`${JSON.stringify(summary)}\n`);
        }
        if (summary.overallStatus === "ERROR") {
          exitCode = 1;
        }
      } catch (error) {
        logger.error("sim_health_run_failed", {
          error: formatLifecycleError(error),
        });
        if (!loopMode) {
          throw error;
        }
      }

      if (!loopMode || controller.signal.aborted || config.sim.healthLoopIntervalMs <= 0) {
        break;
      }
      await sleep(config.sim.healthLoopIntervalMs, controller.signal).catch(() => undefined);
    } while (!controller.signal.aborted);

    process.exitCode = exitCode;
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
    console.error("sim-health-checker failed", error);
    process.exitCode = 1;
  });
}

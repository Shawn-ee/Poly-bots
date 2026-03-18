import path from "node:path";
import { pathToFileURL } from "node:url";
import { PolyApiError } from "../api/apiClient.js";
import { loadConfig, SimConfig } from "../config/loadConfig.js";
import { BotLogger } from "../logging/logger.js";
import { createSimAdminApi, formatLifecycleError } from "../sim/lifecycle.js";
import { SimHealthSummary } from "../sim/types.js";
import { sleep } from "../utils/sleep.js";
import { runSimHealthPass } from "./simHealthChecker.js";
import { runSimClosePass } from "./simMarketCloser.js";
import { runSimResolvePass } from "./simMarketResolver.js";
import { runSimSeedPass } from "./simMarketSeeder.js";

type StepName = "market_seeder" | "market_closer" | "market_resolver" | "health_checker";
type StepStatus = "success" | "warning" | "error" | "skipped";
type CycleStatus = "success" | "warning" | "error";

type StepResult = {
  stepName: StepName;
  enabled: boolean;
  status: StepStatus;
  durationMs: number;
  error?: ReturnType<typeof formatLifecycleError>;
  errorClassification?: string;
  healthStatus?: SimHealthSummary["overallStatus"];
};

async function main() {
  const args = new Set(process.argv.slice(2));
  const loopMode = args.has("--loop");
  const config = loadConfig(process.cwd(), { requireBots: false });
  const logsDir = path.resolve(process.cwd(), "logs");
  const logger = new BotLogger("sim-orchestrator", logsDir);
  const controller = new AbortController();

  const shutdown = () => {
    logger.info("sim_orchestrator_shutdown", {
      reason: "signal_received",
    });
    controller.abort();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    if (!config.sim.enabled) {
      logger.info("sim_orchestrator_start", {
        mode: loopMode ? "loop" : "one_shot",
        enabled: false,
        reason: "sim_disabled",
      });
      return;
    }

    if (!config.sim.sessionCookie) {
      throw new Error("sim.sessionCookie or POLY_SIM_SESSION_COOKIE is required when sim orchestrator is enabled.");
    }

    const enabledSteps = getEnabledSteps(config.sim);
    const api = createSimAdminApi(config.sim);

    logger.info("sim_orchestrator_start", {
      mode: loopMode ? "loop" : "one_shot",
      enabled: true,
      enabledSteps,
      failFast: config.sim.failFast,
      orchestratorLoopIntervalMs: config.sim.orchestratorLoopIntervalMs,
    });

    let cycleNumber = 0;
    let sawSeriousFailure = false;

    do {
      cycleNumber += 1;
      const cycleResult = await runCycle({
        api,
        logger,
        sim: config.sim,
        cycleNumber,
      });

      if (cycleResult.status === "error") {
        sawSeriousFailure = true;
      }

      if (!loopMode || controller.signal.aborted) {
        break;
      }

      if (config.sim.orchestratorLoopIntervalMs <= 0) {
        break;
      }

      logger.info("sim_orchestrator_sleep", {
        cycleNumber,
        durationMs: config.sim.orchestratorLoopIntervalMs,
      });
      await sleep(config.sim.orchestratorLoopIntervalMs, controller.signal).catch(() => undefined);
    } while (!controller.signal.aborted);

    process.exitCode = sawSeriousFailure ? 1 : 0;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    logger.close();
  }
}

async function runCycle(input: {
  api: ReturnType<typeof createSimAdminApi>;
  logger: BotLogger;
  sim: SimConfig;
  cycleNumber: number;
}): Promise<{ status: CycleStatus; durationMs: number; stepResults: StepResult[] }> {
  const { api, logger, sim, cycleNumber } = input;
  const startedAt = Date.now();
  const enabledSteps = getEnabledSteps(sim);
  const stepResults: StepResult[] = [];

  logger.info("sim_orchestrator_cycle_start", {
    cycleNumber,
    enabledSteps,
    failFast: sim.failFast,
  });

  const steps: Array<{ stepName: StepName; enabled: boolean; run: () => Promise<StepResult> }> = [
    {
      stepName: "market_seeder",
      enabled: sim.runSeeder,
      run: () => runStep({ stepName: "market_seeder", cycleNumber, logger, fn: () => runSimSeedPass(api, logger, sim) }),
    },
    {
      stepName: "market_closer",
      enabled: sim.runCloser,
      run: () => runStep({ stepName: "market_closer", cycleNumber, logger, fn: () => runSimClosePass(api, logger, sim) }),
    },
    {
      stepName: "market_resolver",
      enabled: sim.runResolver,
      run: () => runStep({ stepName: "market_resolver", cycleNumber, logger, fn: () => runSimResolvePass(api, logger, sim) }),
    },
    {
      stepName: "health_checker",
      enabled: sim.runHealthChecker,
      run: () => runStep({
        stepName: "health_checker",
        cycleNumber,
        logger,
        fn: () => runSimHealthPass(api, logger, sim),
      }),
    },
  ];

  for (const step of steps) {
    if (!step.enabled) {
      const skipped: StepResult = {
        stepName: step.stepName,
        enabled: false,
        status: "skipped",
        durationMs: 0,
      };
      stepResults.push(skipped);
      logger.info("sim_orchestrator_step_complete", {
        cycleNumber,
        stepName: step.stepName,
        enabledSteps,
        durationMs: 0,
        status: skipped.status,
      });
      continue;
    }

    const result = await step.run();
    stepResults.push(result);

    if (result.status === "error" && sim.failFast) {
      break;
    }
  }

  const durationMs = Date.now() - startedAt;
  const status = summarizeCycleStatus(stepResults);

  logger.info("sim_orchestrator_cycle_complete", {
    cycleNumber,
    enabledSteps,
    durationMs,
    status,
    failFast: sim.failFast,
    stepResults,
  });

  return { status, durationMs, stepResults };
}

async function runStep(input: {
  stepName: StepName;
  cycleNumber: number;
  logger: BotLogger;
  fn: () => Promise<void | SimHealthSummary>;
}): Promise<StepResult> {
  const { stepName, cycleNumber, logger, fn } = input;
  const startedAt = Date.now();

  logger.info("sim_orchestrator_step_start", {
    cycleNumber,
    stepName,
  });

  try {
    const output = await fn();
    const durationMs = Date.now() - startedAt;
    const healthStatus = isHealthSummary(output) ? output.overallStatus : undefined;
    const status = mapStepStatus(output);
    const result: StepResult = {
      stepName,
      enabled: true,
      status,
      durationMs,
      ...(healthStatus ? { healthStatus } : {}),
    };

    logger.info("sim_orchestrator_step_complete", {
      cycleNumber,
      stepName,
      durationMs,
      status,
      ...(healthStatus ? { healthStatus } : {}),
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const result: StepResult = {
      stepName,
      enabled: true,
      status: "error",
      durationMs,
      error: formatLifecycleError(error),
      errorClassification: classifyStepError(error),
    };

    logger.error("sim_orchestrator_step_failed", {
      cycleNumber,
      stepName,
      durationMs,
      status: result.status,
      errorClassification: result.errorClassification,
      error: result.error,
    });

    return result;
  }
}

function getEnabledSteps(sim: SimConfig): StepName[] {
  const steps: StepName[] = [];
  if (sim.runSeeder) {
    steps.push("market_seeder");
  }
  if (sim.runCloser) {
    steps.push("market_closer");
  }
  if (sim.runResolver) {
    steps.push("market_resolver");
  }
  if (sim.runHealthChecker) {
    steps.push("health_checker");
  }
  return steps;
}

function classifyStepError(error: unknown): string {
  if (error instanceof PolyApiError) {
    if (error.status === 401 || error.status === 403) {
      return "auth";
    }
    if (error.status >= 500) {
      return "transport";
    }
    if (error.status >= 400) {
      return "api";
    }
  }

  if (error instanceof Error && /fetch failed|network|timeout|socket/i.test(error.message)) {
    return "transport";
  }

  if (error instanceof Error) {
    return "runtime";
  }

  return "unknown";
}

function summarizeCycleStatus(stepResults: StepResult[]): CycleStatus {
  if (stepResults.some((step) => step.status === "error")) {
    return "error";
  }
  if (stepResults.some((step) => step.status === "warning")) {
    return "warning";
  }
  return "success";
}

function mapStepStatus(output: void | SimHealthSummary): StepStatus {
  if (!isHealthSummary(output)) {
    return "success";
  }

  if (output.overallStatus === "ERROR") {
    return "error";
  }
  if (output.overallStatus === "WARN") {
    return "warning";
  }
  return "success";
}

function isHealthSummary(value: void | SimHealthSummary): value is SimHealthSummary {
  return Boolean(value) && typeof value === "object" && "overallStatus" in value;
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
    console.error("sim-orchestrator failed", error);
    process.exitCode = 1;
  });
}

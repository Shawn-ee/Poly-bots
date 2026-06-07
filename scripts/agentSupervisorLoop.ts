import { loadConfig } from "../src/config/loadConfig.js";
import {
  createDefaultAgentContext,
  runBotSupervisorAgent,
  runMarketDiscoveryAgent,
  runRiskReviewAgent,
} from "../src/agents/index.js";
import { logAgentFinish, logAgentStart } from "../src/tools/logTool.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  do {
    await runOnce();
    if (options.once) break;
    await sleep(options.intervalMs, controller.signal).catch(() => undefined);
  } while (!controller.signal.aborted);

  async function runOnce() {
    const config = loadConfig(process.cwd(), { requireBots: false });
    const runId = `agent_supervisor_${Date.now()}`;

    const botContext = createDefaultAgentContext("botSupervisor", "reviewOnly", { runId });
    logAgentStart("botSupervisor", runId);
    logAgentFinish(await runBotSupervisorAgent(botContext, config.bots));

    const discoveryContext = createDefaultAgentContext("marketDiscovery", "reviewOnly", { runId });
    logAgentStart("marketDiscovery", runId);
    logAgentFinish(await runMarketDiscoveryAgent(discoveryContext));

    const riskContext = createDefaultAgentContext("riskReview", "reviewOnly", { runId });
    logAgentStart("riskReview", runId);
    logAgentFinish(await runRiskReviewAgent(riskContext));
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    once: args.get("once") === "true",
    intervalMs: intArg(args.get("intervalMs"), 60_000),
  };
}

function intArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});


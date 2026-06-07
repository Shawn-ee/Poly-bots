import { loadConfig } from "../config/loadConfig.js";
import {
  AgentMode,
  AgentName,
  createDefaultAgentContext,
  runBotSupervisorAgent,
  runMarketCreationAgent,
  runMarketDiscoveryAgent,
  runResolutionReviewAgent,
  runRiskReviewAgent,
} from "../agents/index.js";
import { logAgentFinish, logAgentStart } from "../tools/logTool.js";

type CliOptions = {
  agent: AgentName;
  mode: AgentMode;
  allowNetworkDiscovery: boolean;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const context = createDefaultAgentContext(options.agent, options.mode, {
    runId: `agent_cli_${Date.now()}`,
    dryRun: options.mode !== "simulation",
  });
  logAgentStart(options.agent, context.runId);

  const result = await runSelectedAgent(options, context);
  logAgentFinish(result);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "blocked" && result.findings.some((finding) => finding.severity === "critical")) {
    process.exitCode = 1;
  }
}

async function runSelectedAgent(
  options: CliOptions,
  context: ReturnType<typeof createDefaultAgentContext>,
) {
  if (options.agent === "marketDiscovery") {
    return runMarketDiscoveryAgent(context, { allowNetworkDiscovery: options.allowNetworkDiscovery });
  }
  if (options.agent === "botSupervisor") {
    const config = loadConfig(process.cwd(), { requireBots: false });
    return runBotSupervisorAgent(context, config.bots);
  }
  if (options.agent === "riskReview") {
    return runRiskReviewAgent(context);
  }
  if (options.agent === "marketCreation") {
    return runMarketCreationAgent(context);
  }
  return runResolutionReviewAgent(context);
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const next = argv[index + 1];
    values.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    agent: parseAgent(values.get("agent")),
    mode: parseMode(values.get("mode")),
    allowNetworkDiscovery: values.get("allow-network-discovery") === "true",
  };
}

function parseAgent(value: string | undefined): AgentName {
  if (
    value === "marketDiscovery" ||
    value === "botSupervisor" ||
    value === "riskReview" ||
    value === "marketCreation" ||
    value === "resolutionReview"
  ) {
    return value;
  }
  return "marketDiscovery";
}

function parseMode(value: string | undefined): AgentMode {
  if (value === "dryRun" || value === "reviewOnly" || value === "simulation" || value === "liveDisabled") {
    return value;
  }
  return "dryRun";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});


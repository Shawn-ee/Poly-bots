import { loadConfig } from "./config/loadConfig.js";
import { runOrchestrator } from "./runner/orchestrator.js";

async function main() {
  const config = loadConfig();
  await runOrchestrator(config);
}

main().catch((error) => {
  console.error("poly-bot failed to start", error);
  process.exitCode = 1;
});

import { loadConfig } from "./config/loadConfig.js";
import { removeRunnerPidFile, writeRunnerPidFile } from "./runtime/pidFile.js";
import { runOrchestrator } from "./runner/orchestrator.js";

async function main() {
  const config = loadConfig();
  writeRunnerPidFile(config.configPath);
  await runOrchestrator(config);
}

main().catch((error) => {
  console.error("poly-bot failed to start", error);
  process.exitCode = 1;
}).finally(() => {
  removeRunnerPidFile(process.pid);
});

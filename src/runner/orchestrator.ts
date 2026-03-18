import { setMaxListeners } from "node:events";
import path from "node:path";
import { AppConfig } from "../config/loadConfig.js";
import { sleep } from "../utils/sleep.js";
import { BotRunner } from "./botRunner.js";

export async function runOrchestrator(config: AppConfig): Promise<void> {
  const controller = new AbortController();
  const logsDir = path.resolve(process.cwd(), "logs");
  setMaxListeners(Math.max(20, config.bots.length + 4), controller.signal);

  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const tasks = config.bots.map(async (bot, index) => {
      const runner = new BotRunner(bot, logsDir);
      if (index > 0) {
        await sleep(config.startupStaggerMs * index, controller.signal).catch(() => undefined);
      }
      return runner.run(controller.signal);
    });

    const settled = await Promise.allSettled(tasks);
    for (const result of settled) {
      if (result.status === "rejected" && !controller.signal.aborted) {
        console.error("bot runner crashed", result.reason);
      }
    }
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

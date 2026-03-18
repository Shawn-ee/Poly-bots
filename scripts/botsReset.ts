import { spawn } from "node:child_process";
import path from "node:path";
import { readRunnerPidFile, getRunnerPidFilePath, removeRunnerPidFile } from "../src/runtime/pidFile.js";

type Options = {
  dryRun: boolean;
  restart: boolean;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const polyBotRoot = process.cwd();
  const polyRoot = path.resolve(polyBotRoot, "..", "Poly");

  if (options.restart) {
    await stopExistingRunner(options.dryRun);
  }

  await runPolyReset(polyRoot, options.dryRun);

  if (!options.restart || options.dryRun) {
    return;
  }

  await startBotRunner(polyBotRoot);
}

function parseArgs(argv: string[]): Options {
  return {
    dryRun: argv.includes("--dry-run"),
    restart: argv.includes("--restart"),
  };
}

async function stopExistingRunner(dryRun: boolean) {
  const pidState = readRunnerPidFile();
  if (!pidState) {
    console.info("[bot-reset] no existing runner pid file found", {
      pidFile: getRunnerPidFilePath(),
    });
    return;
  }

  if (dryRun) {
    console.info("[bot-reset] dry-run stop existing runner", pidState);
    return;
  }

  try {
    process.kill(pidState.pid, "SIGTERM");
  } catch (error) {
    console.warn("[bot-reset] failed to signal existing runner", {
      pid: pidState.pid,
      message: error instanceof Error ? error.message : String(error),
    });
    removeRunnerPidFile(pidState.pid);
    return;
  }

  const stopped = await waitForExit(pidState.pid, 10_000);
  console.info("[bot-reset] existing runner stop result", {
    pid: pidState.pid,
    stopped,
  });
  if (!stopped) {
    throw new Error(`Existing bot runner PID ${pidState.pid} did not exit in time.`);
  }
  removeRunnerPidFile(pidState.pid);
}

async function runPolyReset(polyRoot: string, dryRun: boolean) {
  const args = ["tsx", "scripts/reset_bot_state.ts"];
  if (dryRun) {
    args.push("--dry-run");
  }

  await runCommand(process.platform === "win32" ? "npx.cmd" : "npx", args, polyRoot);
}

async function startBotRunner(polyBotRoot: string) {
  await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], polyBotRoot);
}

async function runCommand(command: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function waitForExit(pid: number, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(250);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("[bot-reset] fatal", error);
  process.exitCode = 1;
});

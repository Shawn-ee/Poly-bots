import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RunnerPidState = {
  pid: number;
  startedAt: string;
  configPath: string;
};

const PID_FILE_PATH = path.resolve(process.cwd(), ".runtime", "poly-bot.pid.json");

export function writeRunnerPidFile(configPath: string): RunnerPidState {
  const state: RunnerPidState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    configPath,
  };

  mkdirSync(path.dirname(PID_FILE_PATH), { recursive: true });
  writeFileSync(PID_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export function readRunnerPidFile(): RunnerPidState | null {
  if (!existsSync(PID_FILE_PATH)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(PID_FILE_PATH, "utf8")) as Partial<RunnerPidState>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.configPath !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      configPath: parsed.configPath,
    };
  } catch {
    return null;
  }
}

export function removeRunnerPidFile(expectedPid?: number) {
  const state = readRunnerPidFile();
  if (expectedPid !== undefined && state && state.pid !== expectedPid) {
    return;
  }
  rmSync(PID_FILE_PATH, { force: true });
}

export function getRunnerPidFilePath(): string {
  return PID_FILE_PATH;
}

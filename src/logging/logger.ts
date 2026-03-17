import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import path from "node:path";

type LogLevel = "INFO" | "WARN" | "ERROR";

export class BotLogger {
  private readonly stream: WriteStream;

  constructor(private readonly botName: string, logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    this.stream = createWriteStream(path.join(logsDir, `${sanitize(botName)}.log`), {
      flags: "a",
      encoding: "utf8",
    });
  }

  info(message: string, data?: unknown) {
    this.write("INFO", message, data);
  }

  warn(message: string, data?: unknown) {
    this.write("WARN", message, data);
  }

  error(message: string, data?: unknown) {
    this.write("ERROR", message, data);
  }

  close() {
    this.stream.end();
  }

  private write(level: LogLevel, message: string, data?: unknown) {
    const timestamp = new Date().toISOString();
    const suffix = data === undefined ? "" : ` ${safeStringify(data)}`;
    const line = `${timestamp} [${level}] [${this.botName}] ${message}${suffix}`;
    console.log(line);
    this.stream.write(`${line}\n`);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_");
}

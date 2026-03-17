import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type StrategyName = "passiveBuyer" | "passiveSeller" | "randomMaker";

export type BotConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  strategy: StrategyName;
  marketIds: string[];
  pollIntervalMs: number;
  maxOrderSize: string;
  maxOpenOrders: number;
  priceOffsetTicks: number;
  staleOrderMs: number;
  decisionCooldownMs: number;
  capBackoffMs: number;
  similarOrderTicks: number;
  maxSimilarOpenOrders: number;
  maxOrdersPerSidePerOutcome: number;
  tickSize: string;
  maxPositionShares: string;
};

export type AppConfig = {
  configPath: string;
  startupStaggerMs: number;
  bots: BotConfig[];
};

export function loadConfig(cwd: string = process.cwd()): AppConfig {
  loadEnvFile(path.join(cwd, ".env"));

  const configPath = resolveConfigPath(cwd);
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    throw new Error("Bot config file must contain a JSON array.");
  }

  const bots = raw.map((value, index) => normalizeBotConfig(value, index));
  if (bots.length === 0) {
    throw new Error("Bot config file contains no bots.");
  }

  return {
    configPath,
    startupStaggerMs: intFromEnv("POLY_BOT_STARTUP_STAGGER_MS", 750),
    bots,
  };
}

function normalizeBotConfig(input: unknown, index: number): BotConfig {
  if (!input || typeof input !== "object") {
    throw new Error(`Bot config at index ${index} must be an object.`);
  }

  const bot = input as Record<string, unknown>;
  const name = stringField(bot.name, `bots[${index}].name`);

  return {
    name,
    baseUrl: stringField(
      bot.baseUrl ?? process.env.POLY_BOT_BASE_URL ?? "http://localhost:3000",
      `${name}.baseUrl`,
    ),
    apiKey: stringField(bot.apiKey, `${name}.apiKey`),
    strategy: strategyField(bot.strategy, `${name}.strategy`),
    marketIds: stringArrayField(bot.marketIds, `${name}.marketIds`),
    pollIntervalMs: numberField(
      bot.pollIntervalMs ?? process.env.POLY_BOT_POLL_INTERVAL_MS ?? 2000,
      `${name}.pollIntervalMs`,
    ),
    maxOrderSize: stringField(
      bot.maxOrderSize ?? process.env.POLY_BOT_MAX_ORDER_SIZE ?? "1.000000",
      `${name}.maxOrderSize`,
    ),
    maxOpenOrders: numberField(
      bot.maxOpenOrders ?? process.env.POLY_BOT_MAX_OPEN_ORDERS ?? 6,
      `${name}.maxOpenOrders`,
    ),
    priceOffsetTicks: numberField(bot.priceOffsetTicks ?? 0, `${name}.priceOffsetTicks`),
    staleOrderMs: numberField(
      bot.staleOrderMs ?? process.env.POLY_BOT_STALE_ORDER_MS ?? 12000,
      `${name}.staleOrderMs`,
    ),
    decisionCooldownMs: numberField(
      bot.decisionCooldownMs ?? process.env.POLY_BOT_DECISION_COOLDOWN_MS ?? 1500,
      `${name}.decisionCooldownMs`,
    ),
    capBackoffMs: numberField(
      bot.capBackoffMs ?? process.env.POLY_BOT_CAP_BACKOFF_MS ?? 8000,
      `${name}.capBackoffMs`,
    ),
    similarOrderTicks: numberField(
      bot.similarOrderTicks ?? process.env.POLY_BOT_SIMILAR_ORDER_TICKS ?? 1,
      `${name}.similarOrderTicks`,
    ),
    maxSimilarOpenOrders: numberField(
      bot.maxSimilarOpenOrders ?? process.env.POLY_BOT_MAX_SIMILAR_OPEN_ORDERS ?? 1,
      `${name}.maxSimilarOpenOrders`,
    ),
    maxOrdersPerSidePerOutcome: numberField(
      bot.maxOrdersPerSidePerOutcome ?? process.env.POLY_BOT_MAX_ORDERS_PER_SIDE_PER_OUTCOME ?? 1,
      `${name}.maxOrdersPerSidePerOutcome`,
    ),
    tickSize: stringField(
      bot.tickSize ?? process.env.POLY_BOT_TICK_SIZE ?? "0.01",
      `${name}.tickSize`,
    ),
    maxPositionShares: stringField(bot.maxPositionShares ?? "5.000000", `${name}.maxPositionShares`),
  };
}

function resolveConfigPath(cwd: string): string {
  const configPath = process.env.POLY_BOT_CONFIG ?? "./bots.json";
  const resolved = path.resolve(cwd, configPath);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  return resolved;
}

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return;
  }

  const contents = readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected non-empty string for ${fieldName}.`);
  }
  return value.trim();
}

function stringArrayField(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected non-empty string array for ${fieldName}.`);
  }
  return value.map((item, idx) => stringField(item, `${fieldName}[${idx}]`));
}

function numberField(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative number for ${fieldName}.`);
  }
  return parsed;
}

function strategyField(value: unknown, fieldName: string): StrategyName {
  const strategy = stringField(value, fieldName);
  if (strategy !== "passiveBuyer" && strategy !== "passiveSeller" && strategy !== "randomMaker") {
    throw new Error(`Unsupported strategy for ${fieldName}: ${strategy}`);
  }
  return strategy;
}

function intFromEnv(key: string, fallback: number): number {
  return numberField(process.env[key] ?? fallback, key);
}

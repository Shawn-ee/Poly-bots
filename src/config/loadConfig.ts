import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type StrategyName = "tightMarketMaker" | "noiseTrader" | "inventoryAwareMaker";
export type DailyNotionalPauseMode = "pause_for_run" | "cooldown_until_utc_reset" | "cooldown_ms";
export type SimResolverMode =
  | "random_50_50"
  | "weighted_by_last_price"
  | "forced_yes"
  | "forced_no";
export type SimConfig = {
  enabled: boolean;
  baseUrl: string;
  sessionCookie: string;
  intervalMs: number;
  orchestratorLoopIntervalMs: number;
  closeLoopIntervalMs: number;
  resolveLoopIntervalMs: number;
  healthLoopIntervalMs: number;
  failFast: boolean;
  runSeeder: boolean;
  runCloser: boolean;
  runResolver: boolean;
  runHealthChecker: boolean;
  targetActiveMarkets: number;
  maxCreatePerRun: number;
  maxClosePerRun: number;
  maxResolvePerRun: number;
  defaultMarketDurationMinutes: number;
  resolveDelayMinutes: number;
  resolverMode: SimResolverMode;
  settleAfterResolve: boolean;
  maxClosedUnresolvedAgeMs: number;
  maxAllowedActiveMarkets?: number;
  emitJsonSummary: boolean;
};

export type BotConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  strategy: StrategyName;
  marketIds: string[];
  pollIntervalMs: number;
  loopIntervalMinMs: number;
  loopIntervalMaxMs: number;
  maxOrderSize: string;
  maxTakerSize: string;
  maxOpenOrders: number;
  staleOrderMs: number;
  minQuoteLifetimeMs: number;
  decisionCooldownMs: number;
  capBackoffMs: number;
  tickSize: string;
  maxPositionShares: string;
  inventoryTargetShares: string;
  targetSpreadTicks: number;
  quoteOffsetMinTicks: number;
  quoteOffsetMaxTicks: number;
  staleDistanceTicks: number;
  replaceThresholdTicks: number;
  replaceHysteresisTicks: number;
  maxOrdersPerSide: number;
  takerProbability: number;
  takerThresholdTicks: number;
  inventorySkewStrength: number;
  fallbackFairPrice: string;
  dailyNotionalPauseMode: DailyNotionalPauseMode;
  dailyNotionalCooldownMs: number;
  pausedPollIntervalMs: number;
  pauseLogIntervalMs: number;
};

export type AppConfig = {
  configPath: string;
  startupStaggerMs: number;
  bots: BotConfig[];
  sim: SimConfig;
};

type LoadConfigOptions = {
  requireBots?: boolean;
};

export function loadConfig(
  cwd: string = process.cwd(),
  options: LoadConfigOptions = {},
): AppConfig {
  loadEnvFile(path.join(cwd, ".env"));

  const configPath = resolveConfigPath(cwd);
  const contents = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const raw = JSON.parse(contents) as unknown;

  const requireBots = options.requireBots ?? true;
  const { botValues, simValue } = normalizeRootConfig(raw);
  const bots = botValues.map((value, index) => normalizeBotConfig(value, index));
  if (requireBots && bots.length === 0) {
    throw new Error("Bot config file contains no bots.");
  }

  return {
    configPath,
    startupStaggerMs: intFromEnv("POLY_BOT_STARTUP_STAGGER_MS", 750),
    bots,
    sim: normalizeSimConfig(simValue),
  };
}

function normalizeRootConfig(raw: unknown): { botValues: unknown[]; simValue: unknown } {
  if (Array.isArray(raw)) {
    return { botValues: raw, simValue: undefined };
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Config file must contain a JSON array or an object with bots/sim.");
  }

  const root = raw as Record<string, unknown>;
  const botValues = Array.isArray(root.bots) ? root.bots : [];
  return {
    botValues,
    simValue: root.sim,
  };
}

function normalizeBotConfig(input: unknown, index: number): BotConfig {
  if (!input || typeof input !== "object") {
    throw new Error(`Bot config at index ${index} must be an object.`);
  }

  const bot = input as Record<string, unknown>;
  const name = stringField(bot.name, `bots[${index}].name`);
  const pollIntervalMs = numberField(
    bot.pollIntervalMs ?? process.env.POLY_BOT_POLL_INTERVAL_MS ?? 2000,
    `${name}.pollIntervalMs`,
  );

  return {
    name,
    baseUrl: stringField(
      bot.baseUrl ?? process.env.POLY_BOT_BASE_URL ?? "http://localhost:3000",
      `${name}.baseUrl`,
    ),
    apiKey: stringField(bot.apiKey, `${name}.apiKey`),
    strategy: strategyField(bot.strategy, `${name}.strategy`),
    marketIds: stringArrayField(bot.marketIds, `${name}.marketIds`),
    pollIntervalMs,
    loopIntervalMinMs: numberField(
      bot.loopIntervalMinMs ?? pollIntervalMs ?? process.env.POLY_BOT_LOOP_INTERVAL_MIN_MS ?? 1500,
      `${name}.loopIntervalMinMs`,
    ),
    loopIntervalMaxMs: numberField(
      bot.loopIntervalMaxMs ?? pollIntervalMs ?? process.env.POLY_BOT_LOOP_INTERVAL_MAX_MS ?? 3500,
      `${name}.loopIntervalMaxMs`,
    ),
    maxOrderSize: stringField(
      bot.maxOrderSize ?? process.env.POLY_BOT_MAX_ORDER_SIZE ?? "1.000000",
      `${name}.maxOrderSize`,
    ),
    maxTakerSize: stringField(
      bot.maxTakerSize ?? process.env.POLY_BOT_MAX_TAKER_SIZE ?? "0.250000",
      `${name}.maxTakerSize`,
    ),
    maxOpenOrders: numberField(
      bot.maxOpenOrders ?? process.env.POLY_BOT_MAX_OPEN_ORDERS ?? 6,
      `${name}.maxOpenOrders`,
    ),
    staleOrderMs: numberField(
      bot.staleOrderMs ?? process.env.POLY_BOT_STALE_ORDER_MS ?? 12000,
      `${name}.staleOrderMs`,
    ),
    minQuoteLifetimeMs: numberField(
      bot.minQuoteLifetimeMs ?? process.env.POLY_BOT_MIN_QUOTE_LIFETIME_MS ?? 5000,
      `${name}.minQuoteLifetimeMs`,
    ),
    decisionCooldownMs: numberField(
      bot.decisionCooldownMs ?? process.env.POLY_BOT_DECISION_COOLDOWN_MS ?? 1500,
      `${name}.decisionCooldownMs`,
    ),
    capBackoffMs: numberField(
      bot.capBackoffMs ?? process.env.POLY_BOT_CAP_BACKOFF_MS ?? 8000,
      `${name}.capBackoffMs`,
    ),
    tickSize: stringField(
      bot.tickSize ?? process.env.POLY_BOT_TICK_SIZE ?? "0.01",
      `${name}.tickSize`,
    ),
    maxPositionShares: stringField(
      bot.maxPositionShares ?? process.env.POLY_BOT_MAX_POSITION_SHARES ?? "5.000000",
      `${name}.maxPositionShares`,
    ),
    inventoryTargetShares: stringField(
      bot.inventoryTargetShares ?? process.env.POLY_BOT_INVENTORY_TARGET_SHARES ?? "1.000000",
      `${name}.inventoryTargetShares`,
    ),
    targetSpreadTicks: numberField(
      bot.targetSpreadTicks ?? process.env.POLY_BOT_TARGET_SPREAD_TICKS ?? 2,
      `${name}.targetSpreadTicks`,
    ),
    quoteOffsetMinTicks: numberField(
      bot.quoteOffsetMinTicks ?? process.env.POLY_BOT_QUOTE_OFFSET_MIN_TICKS ?? 0,
      `${name}.quoteOffsetMinTicks`,
    ),
    quoteOffsetMaxTicks: numberField(
      bot.quoteOffsetMaxTicks ?? process.env.POLY_BOT_QUOTE_OFFSET_MAX_TICKS ?? 2,
      `${name}.quoteOffsetMaxTicks`,
    ),
    staleDistanceTicks: numberField(
      bot.staleDistanceTicks ?? process.env.POLY_BOT_STALE_DISTANCE_TICKS ?? 4,
      `${name}.staleDistanceTicks`,
    ),
    replaceThresholdTicks: numberField(
      bot.replaceThresholdTicks ?? bot.replaceHysteresisTicks ?? process.env.POLY_BOT_REPLACE_THRESHOLD_TICKS ?? 2,
      `${name}.replaceThresholdTicks`,
    ),
    replaceHysteresisTicks: numberField(
      bot.replaceHysteresisTicks ?? bot.replaceThresholdTicks ?? process.env.POLY_BOT_REPLACE_HYSTERESIS_TICKS ?? 2,
      `${name}.replaceHysteresisTicks`,
    ),
    maxOrdersPerSide: numberField(
      bot.maxOrdersPerSide ?? process.env.POLY_BOT_MAX_ORDERS_PER_SIDE ?? 1,
      `${name}.maxOrdersPerSide`,
    ),
    takerProbability: probabilityField(
      bot.takerProbability ?? process.env.POLY_BOT_TAKER_PROBABILITY ?? 0.08,
      `${name}.takerProbability`,
    ),
    takerThresholdTicks: numberField(
      bot.takerThresholdTicks ?? process.env.POLY_BOT_TAKER_THRESHOLD_TICKS ?? 1,
      `${name}.takerThresholdTicks`,
    ),
    inventorySkewStrength: numberField(
      bot.inventorySkewStrength ?? process.env.POLY_BOT_INVENTORY_SKEW_STRENGTH ?? 3,
      `${name}.inventorySkewStrength`,
    ),
    fallbackFairPrice: stringField(
      bot.fallbackFairPrice ?? process.env.POLY_BOT_FALLBACK_FAIR_PRICE ?? "0.50",
      `${name}.fallbackFairPrice`,
    ),
    dailyNotionalPauseMode: pauseModeField(
      bot.dailyNotionalPauseMode ?? process.env.POLY_BOT_DAILY_NOTIONAL_PAUSE_MODE ?? "pause_for_run",
      `${name}.dailyNotionalPauseMode`,
    ),
    dailyNotionalCooldownMs: numberField(
      bot.dailyNotionalCooldownMs ?? process.env.POLY_BOT_DAILY_NOTIONAL_COOLDOWN_MS ?? 86_400_000,
      `${name}.dailyNotionalCooldownMs`,
    ),
    pausedPollIntervalMs: numberField(
      bot.pausedPollIntervalMs ?? process.env.POLY_BOT_PAUSED_POLL_INTERVAL_MS ?? 45_000,
      `${name}.pausedPollIntervalMs`,
    ),
    pauseLogIntervalMs: numberField(
      bot.pauseLogIntervalMs ?? process.env.POLY_BOT_PAUSE_LOG_INTERVAL_MS ?? 60_000,
      `${name}.pauseLogIntervalMs`,
    ),
  };
}

function normalizeSimConfig(input: unknown): SimConfig {
  const sim = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  return {
    enabled: booleanField(sim.enabled ?? process.env.POLY_SIM_ENABLED ?? false, "sim.enabled"),
    baseUrl: stringField(
      sim.baseUrl ?? process.env.POLY_SIM_BASE_URL ?? process.env.POLY_BOT_BASE_URL ?? "http://localhost:3000",
      "sim.baseUrl",
    ),
    sessionCookie: optionalStringField(
      sim.sessionCookie ?? process.env.POLY_SIM_SESSION_COOKIE ?? "",
      "sim.sessionCookie",
    ),
    intervalMs: numberField(
      sim.intervalMs ?? process.env.POLY_SIM_INTERVAL_MS ?? 60_000,
      "sim.intervalMs",
    ),
    orchestratorLoopIntervalMs: numberField(
      sim.orchestratorLoopIntervalMs ?? process.env.POLY_SIM_ORCHESTRATOR_LOOP_INTERVAL_MS ?? sim.intervalMs ?? process.env.POLY_SIM_INTERVAL_MS ?? 60_000,
      "sim.orchestratorLoopIntervalMs",
    ),
    closeLoopIntervalMs: numberField(
      sim.closeLoopIntervalMs ?? process.env.POLY_SIM_CLOSE_LOOP_INTERVAL_MS ?? sim.intervalMs ?? process.env.POLY_SIM_INTERVAL_MS ?? 60_000,
      "sim.closeLoopIntervalMs",
    ),
    resolveLoopIntervalMs: numberField(
      sim.resolveLoopIntervalMs ?? process.env.POLY_SIM_RESOLVE_LOOP_INTERVAL_MS ?? sim.intervalMs ?? process.env.POLY_SIM_INTERVAL_MS ?? 60_000,
      "sim.resolveLoopIntervalMs",
    ),
    healthLoopIntervalMs: numberField(
      sim.healthLoopIntervalMs ?? process.env.POLY_SIM_HEALTH_LOOP_INTERVAL_MS ?? sim.intervalMs ?? process.env.POLY_SIM_INTERVAL_MS ?? 60_000,
      "sim.healthLoopIntervalMs",
    ),
    failFast: booleanField(
      sim.failFast ?? process.env.POLY_SIM_FAIL_FAST ?? false,
      "sim.failFast",
    ),
    runSeeder: booleanField(
      sim.runSeeder ?? process.env.POLY_SIM_RUN_SEEDER ?? true,
      "sim.runSeeder",
    ),
    runCloser: booleanField(
      sim.runCloser ?? process.env.POLY_SIM_RUN_CLOSER ?? true,
      "sim.runCloser",
    ),
    runResolver: booleanField(
      sim.runResolver ?? process.env.POLY_SIM_RUN_RESOLVER ?? true,
      "sim.runResolver",
    ),
    runHealthChecker: booleanField(
      sim.runHealthChecker ?? process.env.POLY_SIM_RUN_HEALTH_CHECKER ?? true,
      "sim.runHealthChecker",
    ),
    targetActiveMarkets: numberField(
      sim.targetActiveMarkets ?? process.env.POLY_SIM_TARGET_ACTIVE_MARKETS ?? 8,
      "sim.targetActiveMarkets",
    ),
    maxCreatePerRun: numberField(
      sim.maxCreatePerRun ?? process.env.POLY_SIM_MAX_CREATE_PER_RUN ?? 2,
      "sim.maxCreatePerRun",
    ),
    maxClosePerRun: numberField(
      sim.maxClosePerRun ?? process.env.POLY_SIM_MAX_CLOSE_PER_RUN ?? 4,
      "sim.maxClosePerRun",
    ),
    maxResolvePerRun: numberField(
      sim.maxResolvePerRun ?? process.env.POLY_SIM_MAX_RESOLVE_PER_RUN ?? 4,
      "sim.maxResolvePerRun",
    ),
    defaultMarketDurationMinutes: numberField(
      sim.defaultMarketDurationMinutes ?? process.env.POLY_SIM_DEFAULT_MARKET_DURATION_MINUTES ?? 180,
      "sim.defaultMarketDurationMinutes",
    ),
    resolveDelayMinutes: numberField(
      sim.resolveDelayMinutes ?? process.env.POLY_SIM_RESOLVE_DELAY_MINUTES ?? 30,
      "sim.resolveDelayMinutes",
    ),
    resolverMode: simResolverModeField(
      sim.resolverMode ?? process.env.POLY_SIM_RESOLVER_MODE ?? "random_50_50",
      "sim.resolverMode",
    ),
    settleAfterResolve: booleanField(
      sim.settleAfterResolve ?? process.env.POLY_SIM_SETTLE_AFTER_RESOLVE ?? false,
      "sim.settleAfterResolve",
    ),
    maxClosedUnresolvedAgeMs: numberField(
      sim.maxClosedUnresolvedAgeMs ?? process.env.POLY_SIM_MAX_CLOSED_UNRESOLVED_AGE_MS ?? 15 * 60_000,
      "sim.maxClosedUnresolvedAgeMs",
    ),
    ...(sim.maxAllowedActiveMarkets !== undefined || process.env.POLY_SIM_MAX_ALLOWED_ACTIVE_MARKETS !== undefined
      ? {
          maxAllowedActiveMarkets: numberField(
            sim.maxAllowedActiveMarkets ?? process.env.POLY_SIM_MAX_ALLOWED_ACTIVE_MARKETS ?? 0,
            "sim.maxAllowedActiveMarkets",
          ),
        }
      : {}),
    emitJsonSummary: booleanField(
      sim.emitJsonSummary ?? process.env.POLY_SIM_EMIT_JSON_SUMMARY ?? false,
      "sim.emitJsonSummary",
    ),
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

function optionalStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string for ${fieldName}.`);
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

function probabilityField(value: unknown, fieldName: string): number {
  const parsed = numberField(value, fieldName);
  if (parsed > 1) {
    throw new Error(`Expected probability between 0 and 1 for ${fieldName}.`);
  }
  return parsed;
}

function booleanField(value: unknown, fieldName: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  throw new Error(`Expected boolean for ${fieldName}.`);
}

function strategyField(value: unknown, fieldName: string): StrategyName {
  const strategy = stringField(value, fieldName);
  if (
    strategy !== "tightMarketMaker" &&
    strategy !== "noiseTrader" &&
    strategy !== "inventoryAwareMaker"
  ) {
    throw new Error(`Unsupported strategy for ${fieldName}: ${strategy}`);
  }
  return strategy;
}

function pauseModeField(value: unknown, fieldName: string): DailyNotionalPauseMode {
  const mode = stringField(value, fieldName);
  if (mode !== "pause_for_run" && mode !== "cooldown_until_utc_reset" && mode !== "cooldown_ms") {
    throw new Error(`Unsupported daily-notional pause mode for ${fieldName}: ${mode}`);
  }
  return mode;
}

function simResolverModeField(value: unknown, fieldName: string): SimResolverMode {
  const mode = stringField(value, fieldName);
  if (
    mode !== "random_50_50" &&
    mode !== "weighted_by_last_price" &&
    mode !== "forced_yes" &&
    mode !== "forced_no"
  ) {
    throw new Error(`Unsupported sim resolver mode for ${fieldName}: ${mode}`);
  }
  return mode;
}

function intFromEnv(key: string, fallback: number): number {
  return numberField(process.env[key] ?? fallback, key);
}

export type BotExecutionMode = "dryRun" | "simulation" | "liveInternal";

export type BotSafetyPolicy = {
  mode: BotExecutionMode;
  botsEnabled: boolean;
  liveTradingEnabled: boolean;
  globalKillSwitch: boolean;
  allowRiskReducingCancels: boolean;
  maxOrderSize: string;
  /** [DEPRECATED] Replaced by maxGlobalExposureCents and maxPerMarketExposureCents.
   *  Kept for backward compat. This was the old $1,000/day cap that caused
   *  DAILY_NOTIONAL_LIMIT_EXCEEDED from normal quote maintenance. */
  maxDailyNotionalCents: number;
  /** Per-market liquidity cap (open orders + inventory). Default $200. */
  maxPerMarketExposureCents: number;
  /** Global exposure cap across all markets. Default $60,000 for 300-market scale. */
  maxGlobalExposureCents: number;
  /** Anti-spam daily submitted-notional guard. NOT an exposure limit.
   *  Set high ($500,000) — only catches runaway loops. */
  maxDailySubmittedNotionalCents: number;
  maxSystemLiquidityPerMarketCents: number;
};

export function loadBotSafetyPolicy(): BotSafetyPolicy {
  return {
    mode: executionModeFromEnv(),
    botsEnabled: boolEnv("POLY_BOTS_ENABLED", false),
    liveTradingEnabled: boolEnv("POLY_BOTS_LIVE_TRADING", false),
    globalKillSwitch: boolEnv("POLY_BOTS_GLOBAL_KILL_SWITCH", true),
    allowRiskReducingCancels: boolEnv("POLY_BOTS_ALLOW_RISK_REDUCING_CANCELS", true),
    maxOrderSize: process.env.MAX_BOT_ORDER_SIZE?.trim() || process.env.POLY_BOT_MAX_ORDER_SIZE?.trim() || "1.000000",
    /** Old cap: $1,000/day. Now used only as a fallback if the new limits aren't configured. */
    maxDailyNotionalCents: centsFromEnv("MAX_BOT_DAILY_NOTIONAL", 500_000_00),
    /** Per-market max exposure: $200 for beta. */
    maxPerMarketExposureCents: centsFromEnv("MAX_LIQUIDITY_PER_MARKET_USD", 200_00),
    /** Global max exposure: $60,000 for 300-market scale. */
    maxGlobalExposureCents: centsFromEnv("MAX_GLOBAL_EXPOSURE_USD", 60_000_00),
    /** Anti-spam guard: $500,000/day submitted notional. Only catches runaway loops. */
    maxDailySubmittedNotionalCents: centsFromEnv("MAX_DAILY_SUBMITTED_NOTIONAL_USD", 500_000_00),
    maxSystemLiquidityPerMarketCents: centsFromEnv("MAX_SYSTEM_LIQUIDITY_PER_MARKET", 20_000),
  };
}

export function canPlaceLiveInternalOrders(policy: BotSafetyPolicy) {
  if (!policy.botsEnabled) return { allowed: false, reason: "poly_bots_disabled" };
  if (policy.globalKillSwitch) return { allowed: false, reason: "global_kill_switch" };
  if (policy.mode !== "liveInternal") return { allowed: false, reason: "not_live_internal_mode" };
  if (!policy.liveTradingEnabled) return { allowed: false, reason: "live_trading_disabled" };
  if (process.env.LIVE_SYSTEM_LIQUIDITY_ENABLED === "false") return { allowed: false, reason: "legacy_live_system_liquidity_disabled" };
  if (process.env.SYSTEM_LIQUIDITY_DRY_RUN === "true") return { allowed: false, reason: "legacy_system_liquidity_dry_run" };
  return { allowed: true, reason: "allowed" };
}

export function canCancelLiveInternalOrders(policy: BotSafetyPolicy) {
  const placement = canPlaceLiveInternalOrders(policy);
  if (placement.allowed) return placement;
  if (
    policy.globalKillSwitch &&
    policy.allowRiskReducingCancels &&
    policy.botsEnabled &&
    policy.liveTradingEnabled &&
    policy.mode === "liveInternal"
  ) {
    return { allowed: true, reason: "risk_reducing_cancel_allowed_during_kill_switch" };
  }
  return placement;
}

export function assertOrderWithinGlobalCaps(policy: BotSafetyPolicy, size: string) {
  const requested = Number(size);
  const max = Number(policy.maxOrderSize);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { allowed: false, reason: "invalid_order_size" };
  }
  if (Number.isFinite(max) && requested > max) {
    return { allowed: false, reason: "global_max_order_size" };
  }
  return { allowed: true, reason: "allowed" };
}

function executionModeFromEnv(): BotExecutionMode {
  const value = process.env.POLY_BOTS_MODE ?? process.env.BOT_EXECUTION_MODE ?? "dryRun";
  if (value === "simulation" || value === "liveInternal") return value;
  return "dryRun";
}

function boolEnv(key: string, fallback: boolean) {
  const value = process.env[key];
  if (value == null || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function centsFromEnv(key: string, fallback: number) {
  const value = process.env[key];
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed * 100);
}

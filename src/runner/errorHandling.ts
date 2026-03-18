import { PolyApiError } from "../api/apiClient.js";
import { BotConfig } from "../config/loadConfig.js";

export type BotBlockState =
  | { kind: "none" }
  | { kind: "cooldown"; reason: string; until: number; code?: string }
  | { kind: "paused"; reason: string; code?: string };

export type ErrorClassification = {
  category: "open_order_cap" | "daily_notional" | "transport" | "auth" | "validation" | "api";
  blockState: BotBlockState;
  disablePlacements: boolean;
};

export function classifyPlacementError(
  error: unknown,
  bot: BotConfig,
  now: number,
  transportBackoffMs: number,
): ErrorClassification {
  if (error instanceof PolyApiError) {
    if (error.code === "OPEN_ORDER_LIMIT_EXCEEDED") {
      return {
        category: "open_order_cap",
        disablePlacements: true,
        blockState: {
          kind: "cooldown",
          reason: "open_order_limit_exceeded",
          code: error.code,
          until: now + bot.capBackoffMs,
        },
      };
    }

    if (error.code === "DAILY_NOTIONAL_LIMIT_EXCEEDED") {
      return {
        category: "daily_notional",
        disablePlacements: true,
        blockState: resolveDailyNotionalBlock(bot, now, error.code),
      };
    }

    if (error.code === "INVALID_API_KEY" || error.status === 401 || error.status === 403 && error.code === "READ_ONLY_API_KEY") {
      return {
        category: "auth",
        disablePlacements: true,
        blockState: {
          kind: "paused",
          reason: "auth_or_config_error",
          code: error.code,
        },
      };
    }

    if (error.status >= 500) {
      return {
        category: "transport",
        disablePlacements: true,
        blockState: {
          kind: "cooldown",
          reason: "server_error_backoff",
          code: error.code,
          until: now + transportBackoffMs,
        },
      };
    }

    if (error.status >= 400 && error.status < 500) {
      return {
        category: "validation",
        disablePlacements: true,
        blockState: {
          kind: "cooldown",
          reason: "validation_backoff",
          code: error.code,
          until: now + Math.max(bot.decisionCooldownMs * 4, 5000),
        },
      };
    }

    return {
      category: "api",
      disablePlacements: false,
      blockState: { kind: "none" },
    };
  }

  if (error instanceof Error && /fetch failed|network|timeout|socket/i.test(error.message)) {
    return {
      category: "transport",
      disablePlacements: true,
      blockState: {
        kind: "cooldown",
        reason: "transport_backoff",
        until: now + transportBackoffMs,
      },
    };
  }

  return {
    category: "api",
    disablePlacements: false,
    blockState: { kind: "none" },
  };
}

export function nextTransportBackoffMs(current: number): number {
  if (current <= 0) {
    return 2000;
  }
  return Math.min(current * 2, 60000);
}

export function resetTransportBackoff(): number {
  return 0;
}

function resolveDailyNotionalBlock(bot: BotConfig, now: number, code: string): BotBlockState {
  switch (bot.dailyNotionalPauseMode) {
    case "cooldown_ms":
      return {
        kind: "cooldown",
        reason: "daily_notional_exhausted",
        code,
        until: now + bot.dailyNotionalCooldownMs,
      };
    case "cooldown_until_utc_reset":
      return {
        kind: "cooldown",
        reason: "daily_notional_exhausted",
        code,
        until: nextUtcMidnight(now),
      };
    case "pause_for_run":
    default:
      return {
        kind: "paused",
        reason: "daily_notional_exhausted",
        code,
      };
  }
}

function nextUtcMidnight(now: number): number {
  const current = new Date(now);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 0, 0, 0, 0);
}

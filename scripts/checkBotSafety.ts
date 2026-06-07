import { loadBotSafetyPolicy, canPlaceLiveInternalOrders } from "../src/config/botSafety.js";

const REQUIRED_KEYS = [
  "POLY_BOTS_ENABLED",
  "POLY_BOTS_LIVE_TRADING",
  "POLY_BOTS_GLOBAL_KILL_SWITCH",
  "POLY_BOTS_MODE",
  "SYSTEM_LIQUIDITY_DRY_RUN",
  "LIVE_SYSTEM_LIQUIDITY_ENABLED",
  "MAX_BOT_ORDER_SIZE",
  "MAX_BOT_DAILY_NOTIONAL", // legacy — now anti-spam only
  "MAX_SYSTEM_LIQUIDITY_PER_MARKET",
  "MAX_LIQUIDITY_PER_MARKET_USD", // new: $200 per-market exposure cap
  "MAX_GLOBAL_EXPOSURE_USD", // new: $60,000 global exposure cap
  "MAX_DAILY_SUBMITTED_NOTIONAL_USD", // new: anti-spam guard
  "REQUOTE_THRESHOLD_TICKS", // new: min ticks before requote
  "MAX_OPEN_ORDERS_PER_MARKET", // new: max open orders per market
] as const;

function main() {
  const policy = loadBotSafetyPolicy();
  const liveGate = canPlaceLiveInternalOrders(policy);
  console.log(JSON.stringify({
    ok: true,
    keys: Object.fromEntries(REQUIRED_KEYS.map((key) => [key, process.env[key] == null ? "missing" : "present"])),
    policy: {
      mode: policy.mode,
      botsEnabled: policy.botsEnabled,
      liveTradingEnabled: policy.liveTradingEnabled,
      globalKillSwitch: policy.globalKillSwitch,
      allowRiskReducingCancels: policy.allowRiskReducingCancels,
      maxOrderSize: policy.maxOrderSize,
      maxDailyNotionalCents: policy.maxDailyNotionalCents,
      maxPerMarketExposureCents: policy.maxPerMarketExposureCents,
      maxGlobalExposureCents: policy.maxGlobalExposureCents,
      maxDailySubmittedNotionalCents: policy.maxDailySubmittedNotionalCents,
      maxSystemLiquidityPerMarketCents: policy.maxSystemLiquidityPerMarketCents,
    },
    liveInternalPlacementAllowed: liveGate.allowed,
    liveInternalPlacementReason: liveGate.reason,
  }, null, 2));
}

main();


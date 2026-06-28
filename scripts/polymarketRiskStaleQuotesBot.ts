import { loadBotSafetyPolicy, canPlaceLiveInternalOrders } from "../src/config/botSafety.js";

function main() {
  const policy = loadBotSafetyPolicy();
  const liveGate = canPlaceLiveInternalOrders(policy);
  const staleQuoteRisk = process.env.REFERENCE_STALE_MS
    ? Number.parseInt(process.env.REFERENCE_STALE_MS, 10)
    : 15000;

  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    bot: "Risk/Stale Quote Bot",
    action: liveGate.allowed ? "monitor" : "pause_or_review",
    liveInternalPlacementAllowed: liveGate.allowed,
    liveInternalPlacementReason: liveGate.reason,
    staleReferenceMs: Number.isFinite(staleQuoteRisk) ? staleQuoteRisk : 15000,
    guardedActions: [
      "pause quoting when references are stale",
      "cancel risk reducing quotes through configured bot clients",
      "require deterministic runtime for live order changes",
    ],
  }, null, 2));
}

main();

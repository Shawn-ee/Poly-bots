import { ApiClient } from "../api/apiClient.js";
import { MarketSummary, Quote } from "../api/types.js";
import { SimConfig } from "../config/loadConfig.js";
import { SimResolutionDecision } from "./types.js";

export async function chooseSimResolution(
  api: ApiClient,
  market: MarketSummary,
  sim: SimConfig,
): Promise<SimResolutionDecision> {
  switch (sim.resolverMode) {
    case "forced_yes":
      return chooseForcedOutcome(market, "YES", sim.resolverMode);
    case "forced_no":
      return chooseForcedOutcome(market, "NO", sim.resolverMode);
    case "weighted_by_last_price":
      return chooseWeightedOutcome(api, market, sim.resolverMode);
    case "random_50_50":
    default:
      return chooseRandomOutcome(market, sim.resolverMode);
  }
}

async function chooseWeightedOutcome(
  api: ApiClient,
  market: MarketSummary,
  resolverMode: SimConfig["resolverMode"],
): Promise<SimResolutionDecision> {
  const yesOutcome = findNamedOutcome(market, "YES");
  const noOutcome = findNamedOutcome(market, "NO");
  if (!yesOutcome || !noOutcome) {
    return chooseRandomOutcome(market, resolverMode, true, "binary_outcomes_missing");
  }

  try {
    const quote = await api.getQuote(market.id, yesOutcome.id);
    const yesQuote = quote.quotes.find((item) => item.outcomeId === yesOutcome.id);
    const probability = probabilityFromQuote(yesQuote);
    if (probability === null) {
      return chooseRandomOutcome(market, resolverMode, true, "quote_probability_unavailable");
    }

    const roll = Math.random();
    const winner = roll < probability ? yesOutcome : noOutcome;
    return {
      chosenOutcomeId: winner.id,
      chosenOutcomeName: winner.name,
      resolverMode,
      probabilityUsed: probability,
      fallbackUsed: false,
      reason: "weighted_by_yes_quote",
    };
  } catch {
    return chooseRandomOutcome(market, resolverMode, true, "quote_fetch_failed");
  }
}

function chooseForcedOutcome(
  market: MarketSummary,
  outcomeName: "YES" | "NO",
  resolverMode: SimConfig["resolverMode"],
): SimResolutionDecision {
  const primary = findNamedOutcome(market, outcomeName) ?? market.outcomes[0];
  if (!primary) {
    throw new Error(`No outcomes available for market ${market.id}`);
  }

  return {
    chosenOutcomeId: primary.id,
    chosenOutcomeName: primary.name,
    resolverMode,
    fallbackUsed: primary.name.toUpperCase() !== outcomeName,
    reason: primary.name.toUpperCase() === outcomeName ? "forced_named_outcome" : "forced_first_outcome_fallback",
  };
}

function chooseRandomOutcome(
  market: MarketSummary,
  resolverMode: SimConfig["resolverMode"],
  fallbackUsed = false,
  reason = "random_binary_choice",
): SimResolutionDecision {
  const yesOutcome = findNamedOutcome(market, "YES");
  const noOutcome = findNamedOutcome(market, "NO");
  const choices = yesOutcome && noOutcome ? [yesOutcome, noOutcome] : market.outcomes;
  const winner = choices[Math.floor(Math.random() * choices.length)];
  if (!winner) {
    throw new Error(`No outcomes available for market ${market.id}`);
  }

  return {
    chosenOutcomeId: winner.id,
    chosenOutcomeName: winner.name,
    resolverMode,
    fallbackUsed,
    reason,
    ...(choices.length === 2 ? { probabilityUsed: 0.5 } : {}),
  };
}

function findNamedOutcome(market: MarketSummary, name: string) {
  return market.outcomes.find((outcome) => outcome.name.trim().toUpperCase() === name);
}

function probabilityFromQuote(quote: Quote | undefined): number | null {
  const candidate = quote?.lastPrice ?? quote?.midPrice ?? quote?.bestBid ?? quote?.bestAsk ?? null;
  if (candidate === null) {
    return null;
  }

  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return null;
  }

  return parsed;
}

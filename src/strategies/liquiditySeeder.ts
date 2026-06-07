import { AgentRunContext, OrderIntent } from "../agents/types.js";
import { blockedAction } from "../agents/policies.js";

export type LiquiditySeedPlanInput = {
  marketId: string;
  outcomeIds: string[];
  midpoint?: string;
  size?: string;
  spreadTicks?: number;
  tickSize?: string;
};

export type LiquiditySeedPlan = {
  dryRun: boolean;
  marketId: string;
  intents: OrderIntent[];
  blockedActions: ReturnType<typeof blockedAction>[];
  summary: string;
};

export function planLiquiditySeed(input: LiquiditySeedPlanInput, context: AgentRunContext): LiquiditySeedPlan {
  const midpoint = Number(input.midpoint ?? "0.50");
  const tickSize = Number(input.tickSize ?? "0.01");
  const spreadTicks = input.spreadTicks ?? 2;
  const bid = Math.max(0.01, midpoint - tickSize * spreadTicks).toFixed(2);
  const ask = Math.min(0.99, midpoint + tickSize * spreadTicks).toFixed(2);
  const size = input.size ?? "1.000000";
  const intents = input.outcomeIds.flatMap((outcomeId) => [
    {
      marketId: input.marketId,
      outcomeId,
      side: "BUY" as const,
      price: bid,
      size,
      reason: "dry_run_liquidity_seed_bid",
    },
    {
      marketId: input.marketId,
      outcomeId,
      side: "SELL" as const,
      price: ask,
      size,
      reason: "dry_run_liquidity_seed_ask",
    },
  ]);
  return {
    dryRun: true,
    marketId: input.marketId,
    intents,
    blockedActions: [blockedAction("PLACE_ORDER", "Execute liquidity seed orders", context, "liquidity seeder is dry-run by default")],
    summary: `Prepared ${intents.length} dry-run liquidity seed intents; no orders were placed.`,
  };
}


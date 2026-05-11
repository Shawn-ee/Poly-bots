# Bot Architecture

This document describes the current bot architecture after the Phase 2 structure cleanup. It is an organization change only. Matching logic, private-pool logic, frontend behavior, and strategy tuning were intentionally left unchanged.

## Categories

### User Simulation
- `noiseTrader`
- Location: `poly-bot/src/strategies/userSimulation/noiseTrader.ts`
- Purpose: simulate user-like maker/taker activity in dev and soak environments

Planned but not implemented yet:
- `marketOrderUser`
- `limitOrderUser`

### System Liquidity
- `dynamicMarketMaker`
- `tightMarketMaker`
- `inventoryAwareMaker`
- Location: `poly-bot/src/strategies/liquidity/*`
- Purpose: system-owned liquidity provision using canonical trading APIs

`dynamicMarketMaker` remains the main system market maker.

### Shared Strategy Logic
- Location: `poly-bot/src/strategies/shared/*`
- Current contents:
  - `common.ts`
  - `types.ts`
- Purpose:
  - shared strategy actions and context types
  - shared quote planning and cleanup helpers
  - shared inventory and affordability helpers
  - strategy category metadata

## Compatibility

Existing strategy names are unchanged:
- `tightMarketMaker`
- `inventoryAwareMaker`
- `noiseTrader`
- `dynamicMarketMaker`

Existing config files do not need to change. The strategy loader still accepts the same names.

Legacy import paths in `poly-bot/src/strategies/*.ts` are kept as thin re-export shims so existing imports and tests continue to work.

## Strategy Category Mapping

- `noiseTrader` => `userSimulation`
- `tightMarketMaker` => `systemLiquidity`
- `inventoryAwareMaker` => `systemLiquidity`
- `dynamicMarketMaker` => `systemLiquidity`

This metadata is internal. It is used for clearer runtime structure and logging. It does not change user config shape.

## Bot Runtime

Main runtime files:
- `poly-bot/src/index.ts`
- `poly-bot/src/runner/orchestrator.ts`
- `poly-bot/src/runner/botRunner.ts`
- `poly-bot/src/config/loadConfig.ts`

`BotRunner` remains the central runtime executor. It now imports strategies from category-specific directories, but strategy behavior is unchanged.

## Canonical Trading APIs

Runtime trading bots use:
- `POST /api/orders`
- `DELETE /api/orders/:id`
- `GET /api/orders`

They also use:
- `GET /api/markets/:id/quote`
- `GET /api/account/balance`
- `GET /api/account/positions`
- `GET /api/fills`
- `POST /api/orderbook/:marketId/mint`

Authoritative runtime trading client:
- `poly-bot/src/api/apiClient.ts`

App-side helper/testing utility:
- `Poly/src/lib/botClient.ts`

The app-side helper was intentionally left in place. It is not the primary runtime trading client.

## Soak-Only Logic

Soak/reference-only actor logic still lives in:
- `Poly/scripts/soak_orderbook_bots.ts`

That script currently contains:
- reference inventory seeding
- reference book reshaping
- warmup actors
- manual pressure actors
- soak-only fair-value controllers

Those helpers are not production bot strategies. They were intentionally left in place to avoid changing current soak behavior during this structure-only phase.

## What Was Intentionally Not Changed

- matching engine logic
- private-pool logic
- frontend behavior
- strategy pricing logic
- strategy risk logic
- soak behavior and current smoke-test expectations
- canonical API usage by bots

## Follow-On Work

Safe next phases after this structure cleanup:
1. Split soak-only helpers into dedicated soak modules without changing behavior.
2. Add dedicated user-simulation strategies such as `marketOrderUser` and `limitOrderUser`.
3. Improve runtime freshness with SSE consumption once architecture cleanup is settled.
4. Refactor large strategies like `dynamicMarketMaker` into smaller planning modules while preserving behavior first.

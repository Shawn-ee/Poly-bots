# Production Risk Controls

This document covers the production-style safety layer for system liquidity bots in `poly-bot`.

## Scope

Included:
- runtime risk config for system liquidity bots
- pre-submit exposure and freshness checks
- bot runtime states
- emergency stop and reduce-only behavior
- lightweight bot control file and CLI helper

Not changed in this phase:
- matching engine logic
- private-pool logic
- canonical trading APIs
- frontend trading behavior
- market-maker pricing defaults

## Bot States

- `running`
  - normal quoting and cancellation behavior
- `paused`
  - no new orders
  - existing orders may stay open or be canceled depending on config/control override
- `reduce_only`
  - no new exposure-increasing orders
  - buy orders are blocked for system liquidity bots
  - cancellations still run
- `emergency_stop`
  - no new orders
  - cancels all open orders when configured
  - persists until manually cleared with a control override

## BotRiskConfig

`BotConfig.risk` now supports:

- `botUserId`
- `enabled`
- `maxTotalCapitalCents`
- `maxCapitalPerMarketCents`
- `maxOpenOrderNotionalCents`
- `maxOrderSizeCents`
- `maxDailyLossCents`
- `maxDailySubmittedNotionalCents`
- `maxYesSharesPerMarket`
- `maxNoSharesPerMarket`
- `maxOrdersPerMarket`
- `maxQuoteLevelsPerSide`
- `staleDataMaxAgeMs`
- `pauseNearResolutionMinutes`
- `repeatedErrorPauseMs`
- `inventoryReduceOnlyThreshold`
- `inventoryStopThreshold`
- `emergencyStopOnInvariantViolation`
- `emergencyStopOnRepeatedApiErrors`
- `emergencyStopOnBalanceMismatch`

Additional internal-safe defaults:
- `repeatedApiErrorThreshold`
- `repeatedApiErrorWindowMs`
- `repeatedCancelConflictThreshold`
- `repeatedStaleStateThreshold`
- `cancelOpenOrdersOnPause`
- `cancelOpenOrdersOnEmergencyStop`

Old configs remain compatible because the loader fills safe defaults.

## Runtime Checks

Before placing a new order, system liquidity bots now verify:

- runtime state is not `paused` or `emergency_stop`
- `reduce_only` blocks exposure-increasing buys
- market/account state age is below `staleDataMaxAgeMs`
- order notional does not exceed `maxOrderSizeCents`
- per-market open order count does not exceed `maxOrdersPerMarket`
- projected open-order notional does not exceed `maxOpenOrderNotionalCents`
- projected market exposure does not exceed `maxCapitalPerMarketCents`
- projected total exposure does not exceed `maxTotalCapitalCents`
- projected YES/NO inventory does not exceed `maxYesSharesPerMarket` / `maxNoSharesPerMarket`

If a check fails, the bot logs a structured skip and continues running.

## Emergency Controls

Runtime triggers:
- invariant-related API errors
- repeated API errors
- balance mismatch
- inventory stop threshold
- max daily loss threshold

Manual control helper:

```powershell
cd poly-bot
cmd /c npm.cmd run bots:control -- --bot my-mm --state paused --reason "manual pause"
cmd /c npm.cmd run bots:control -- --bot my-mm --state reduce_only --reason "inventory pressure"
cmd /c npm.cmd run bots:control -- --bot my-mm --state emergency_stop --reason "ops stop" --cancel-open-orders true
cmd /c npm.cmd run bots:control -- --bot my-mm --clear
cmd /c npm.cmd run bots:control -- --all-system-liquidity --state paused --reason "global pause"
```

Control file path:
- default: `poly-bot/runtime/bot-controls.json`
- override with `POLY_BOT_CONTROL_FILE`

## Structured Logs

The runtime emits:
- `risk_check_failed`
- `max_exposure_reached`
- `stale_state_skip`
- `reduce_only_entered`
- `emergency_stop_entered`
- `emergency_stop_recovered`
- `repeated_api_error_pause`
- `near_resolution_pause`
- `inventory_limit_hit`
- `risk_metrics`

Typical payload fields:
- `marketId`
- `botUserId`
- `inventory`
- `exposureCents`
- `openOrderNotionalCents`
- `marketStateAgeMs`
- `accountStateAgeMs`
- `reason`

## Runtime Metrics

`risk_metrics` includes:
- current state
- total exposure
- per-market exposure
- open order notional
- inventory by market
- reserved balance
- fill count
- cancellation count
- realized and unrealized PnL
- risk skip counts
- emergency stop count
- stale state count
- API error count

## Safe Launch Recommendations

Recommended initial production rollout:
- one `dynamicMarketMaker` only
- `baseline` MM profile
- `safe_competitive` disabled by default
- low `maxCapitalPerMarketCents`
- low `maxDailyLossCents`
- low `maxOrderSizeCents`
- small `maxQuoteLevelsPerSide`
- `pauseNearResolutionMinutes` enabled
- `cancelOpenOrdersOnEmergencyStop` enabled
- manual bot control script available to operators

Suggested conservative starting point:
- `maxCapitalPerMarketCents`: `10_000`
- `maxTotalCapitalCents`: `25_000`
- `maxOrderSizeCents`: `100`
- `maxOpenOrderNotionalCents`: `1_000`
- `maxDailyLossCents`: `2_500`
- `maxYesSharesPerMarket`: `25`
- `maxNoSharesPerMarket`: `25`
- `pauseNearResolutionMinutes`: `10`

## Still Experimental

- `safe_competitive` profile
- queue-priority metrics in heavily scaffolded soak modes
- manual/noise simulation behavior in `user_flow`

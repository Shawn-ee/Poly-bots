# World Cup Bot Inventory

Date: 2026-06-26

Scope: World Cup trading-engine completion phase. This inventory covers bot and bot-adjacent code inspected for reference sync, market-making, arbitrage, risk, supervisor, dry-run, and cleanup readiness.

## Summary

Production live bots with real funds remain not approved. Default env behavior remains dry-run/off/kill-switched:

- `POLY_BOTS_ENABLED=false`
- `POLY_BOTS_LIVE_TRADING=false`
- `POLY_BOTS_GLOBAL_KILL_SWITCH=true`
- `POLY_BOTS_MODE=dryRun`
- `SYSTEM_LIQUIDITY_DRY_RUN=true`
- `LIVE_SYSTEM_LIQUIDITY_ENABLED=false`

## Inventory

| Bot or tool | File path | Purpose | Current status | Useful | Duplicated | Safe | Can submit orders | Dry-run/live behavior | Kill switch behavior | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tightMarketMaker` | `src/strategies/liquidity/tightMarketMaker.ts` | Quotes both sides near fair value for system liquidity. | Active strategy module. | yes | no | yes when global safety gate is respected | only through `BotRunner` placement gate | live placement requires enabled/live/internal flags and no dry-run flag | blocked by `POLY_BOTS_GLOBAL_KILL_SWITCH=true` through `canPlaceLiveInternalOrders` | keep |
| `inventoryAwareMaker` | `src/strategies/liquidity/inventoryAwareMaker.ts` | Quotes while leaning around current inventory. | Active strategy module. | yes | no | yes when global safety gate is respected | only through `BotRunner` placement gate | live placement requires enabled/live/internal flags and no dry-run flag | blocked by global kill switch through shared placement gate | keep |
| `dynamicMarketMaker` | `src/strategies/liquidity/dynamicMarketMaker.ts` | Main richer market-maker with ladders, inventory pressure, and mint replenishment planning. | Active strategy module. | yes | no | yes when risk caps and global safety gate are respected | can submit place/mint actions through runner; guarded by safety/risk checks | live placement requires enabled/live/internal flags and no dry-run flag | blocked by global kill switch and risk manager emergency states | keep and improve through focused tests |
| `referenceArbitrageRebalancer` | `src/strategies/referenceArbitrageRebalancer.ts` | Compares local quotes to reference fair value and plans rebalancing. | Active strategy module. | yes | no | yes only behind dry-run/live gates and rollout allowlists | can submit/cancel through runner when dry-run false and live gate allows | default config is dry-run; live requires explicit allowed markets/max live markets | blocked by global safety and runner placement block | keep |
| `liquiditySeeder` | `src/strategies/liquiditySeeder.ts` | Seeds basic liquidity as a setup/dry-run tool. | Tooling strategy. | yes | no | safe when dry-run and caps are used | may prepare seed actions through scripts | use as dry-run/internal setup only | hard-stop by not running scripts and by global live flags | keep |
| `runtimeSupervisor` | `src/referenceMarket/runtimeSupervisor.ts` | Supervises reference-mapped markets, readiness, lifecycle, quote preview, and live quote management. | Active supervisor logic. | yes | no | safe by default because dry-run is default and live requires explicit confirmation | can manage/cancel/place only when live flags, runtime, lifecycle, and confirmation pass | quote preview in dry-run; live management only with `confirmLive` and live flags | skips/cancels on stale, blocked, emergency, missing runtime, or disabled states | keep |
| `botSupervisorAgent` | `src/agents/botSupervisorAgent.ts` | Review-only agent that inspects deterministic bot health and recommends pauses. | Review-only. | yes | no | yes | no direct order placement | always returns dry-run/review-only recommendations | direct trading and forced resume are blocked actions | keep |
| `riskReviewAgent` | `src/agents/riskReviewAgent.ts` | Blocks unsafe plans and reports approval requirements. | Review-only. | yes | no | yes | no | dry-run/review mode only | blocks withdrawal approval and unsafe trading plans | keep |
| `marketDiscoveryAgent` | `src/agents/marketDiscoveryAgent.ts` | Reviews candidate reference markets for draft import. | Review/dry-run import planning. | yes | no | yes when not used for unauthorized scraping | no order submission | dry-run discovery/recommendation | not a trading bot | keep |
| `referenceAwareLiquidityDryRun` | `scripts/referenceAwareLiquidityDryRun.ts` | Authenticated app/bot dry-run for reference-aware liquidity. | Useful but session-cookie blocked locally. | yes | no | yes if cookie is local and not printed | reports `noOrdersPlaced` in dry-run | forces `SYSTEM_LIQUIDITY_DRY_RUN=true` | does not enable production live bots | keep; rerun with local admin session only |
| `referenceCacheDryRun` | `scripts/referenceCacheDryRun.ts` | Reads reference quotes from cache for dry-run quality evidence. | Useful. | yes | no | yes | no | dry-run only | not a placement path | keep |
| `slow_down_sim_bots.cjs` | `scripts/slow_down_sim_bots.cjs` | Local generated-bot config helper for slowing simulation loops. | Local helper. | limited | duplicate survived as canonical CJS copy | safe if used on local generated config | no | modifies local `generated.bots.json` only | not a live trading path | keep as local helper |
| `slow_down_sim_bots.js` | `scripts/slow_down_sim_bots.js` | Duplicate of the CJS helper. | Deleted in this phase. | no | yes | no: CommonJS `require` in a `type: module` package can fail when run as `.js` | no | local helper only | not a live trading path | delete |

## Deletion Evidence

Deleted:

```text
scripts/slow_down_sim_bots.js
```

Reason:

- It was byte-for-byte equivalent in behavior to `scripts/slow_down_sim_bots.cjs`.
- The package declares `"type": "module"`, so the `.js` file's CommonJS `require` shape is the unsafe duplicate.
- `rg slow_down_sim_bots` found no package script or source import depending on the `.js` file.

Required validation:

- `npm run typecheck`
- `npm run bots:safety`
- `npm run test:world-cup-market-making-guardrails`
- `npm run test:reference-liquidity`
- `npm run test:production-risk-controls`
- dependency/import search after deletion


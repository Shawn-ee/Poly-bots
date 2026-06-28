# Bot Inventory and Polymarket MM Plan

Timestamp: 2026-06-28T00:00:00-05:00
Branch: `agent/polymarket-mm-phase0-audit`
Worktree: `C:\Users\hecto\projects\agent-workspaces\poly-bot-polymarket-mm`

## Phase 0 Branch State

- `origin/dev` is `1e0ede5` (`Merge pull request #3 from Shawn-ee/agent/final-bot-env-hygiene`).
- `origin/main` is `8f2b92a` (`feat: risk model fix, all 6 services enabled, arb observer, exposure-based limits`).
- Current package scripts already include reference import, reference liquidity, live event liquidity, arb observer, bot safety, reset/control, and World Cup guardrail tests.
- Current dev checkout in the original repo has pre-existing local edits outside this worktree; this audit branch is isolated in a clean worktree.

## Bot / Script Inventory

| Name | Path | Command | Purpose | Active | Old Market Model Dependency | Event -> Market -> Outcome Compatible | Recommendation | Dependency References | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Main orchestrator | `src/index.ts`, `src/runner/orchestrator.ts` | `npm run bot`, `npm run dev`, `npm start` | Loads bot config and runs configured deterministic bots through canonical Poly API | Yes | No direct DB/model dependency | Yes, via API market/outcome IDs | Keep | `package.json`, `README.md` | Primary external bot runtime |
| BotRunner | `src/runner/botRunner.ts` | via orchestrator | Executes strategy actions, API calls, cancel/place loops | Yes | API response shape dependent | Mostly yes | Modify as needed | `src/runner/orchestrator.ts` | Should remain central deterministic executor |
| Simulation orchestrator | `src/runner/simOrchestrator.ts` | `npm run sim:all` | Local simulation run across seed/health/resolve flows | Dev only | Uses configured market IDs | Compatible if config has outcome IDs | Keep but mark dev-only | `package.json`, `README.md` | Useful for soak but not final reference MM |
| Sim market seeder | `src/runner/simMarketSeeder.ts` | `npm run sim:seed` | Creates/funds simulation markets | Dev only | Possible old assumptions | Needs review before reference use | Modify/deprecate | `package.json` | Not part of Polymarket-reference MM |
| Sim closer/resolver/health | `src/runner/simMarketCloser.ts`, `simMarketResolver.ts`, `simHealthChecker.ts` | `sim:close`, `sim:resolve`, `sim:health` | Dev lifecycle helpers | Dev only | Possible old assumptions | Needs review | Keep dev-only | `package.json` | Do not delete until sim docs/tests updated |
| Dynamic market maker | `src/strategies/dynamicMarketMaker.ts`, `src/strategies/liquidity/dynamicMarketMaker.ts` | strategy in `bots.json` | General local system MM | Potentially active | API quote/order shape | Yes if outcome IDs configured | Keep/modularize | README strategy list, tests | Useful base for local order placement |
| Tight market maker | `src/strategies/tightMarketMaker.ts`, `src/strategies/liquidity/tightMarketMaker.ts` | strategy in `bots.json` | Symmetric local quotes near fair price | Potentially active | API quote/order shape | Yes | Keep | README strategy list | Useful but not reference-specific |
| Inventory-aware maker | `src/strategies/inventoryAwareMaker.ts`, `src/strategies/liquidity/inventoryAwareMaker.ts` | strategy in `bots.json` | Quotes with inventory skew | Potentially active | API quote/order shape | Yes | Keep | README strategy list | Useful risk primitive |
| Noise trader | `src/strategies/noiseTrader.ts`, `src/strategies/userSimulation/noiseTrader.ts` | strategy in `bots.json` | Dev-only simulated user activity | Dev only | API quote/order shape | Yes | Keep dev-only; never use for final product liquidity | README strategy list | Final rules forbid fake users/volume |
| Reference arbitrage rebalancer | `src/strategies/referenceArbitrageRebalancer.ts` | `npm run arb:observer`, strategy tests | Observes/local reacts to reference mispricing | Dry-run/reference active | Uses reference plan models | Yes | Modify toward risk/stale bot or deprecate for pure MM | `package.json`, tests, README | Useful for risk logic, not core quote placement |
| Polymarket Gamma client | `src/referenceMarket/polymarketGammaClient.ts` | used by imports/discovery | Public Gamma discovery/parser | Active | No | Yes | Keep | import scripts/tests | Core Phase 1/2 dependency |
| Polymarket CLOB client | `src/referenceMarket/polymarketClobClient.ts` | used by tests/imports | Public CLOB quote reads | Active | No | Yes | Keep | tests/import scripts | Core Phase 3 dependency |
| Reference price updater | `src/referenceMarket/referencePriceUpdater.ts` | library | Polls mapped markets and updates in-memory cache | Active library | Mapping file based | Yes | Keep/extend to API snapshot sync | tests/import scripts | Core Phase 3 dependency |
| Reference quote plan | `src/referenceMarket/referenceQuotePlan.ts` | `reference:cache-dry-run`, liquidity dry-run | Builds two-tick worse quote plan | Active | Mapping file based | Yes | Keep until Poly pure engine exists | tests/reference liquidity | Phase 4 bridge |
| Live reference market maker | `src/referenceMarket/liveMarketMaker.ts` | `npm run liquidity:live-market`, `liquidity:live-event`, `liquidity:runtime` | Evaluates live readiness and desired local orders | Local/staging only | Admin reference API response shape | Yes | Keep/guard | package scripts, tests, README | Phase 5/6 foundation |
| Runtime supervisor/file | `src/referenceMarket/runtimeSupervisor.ts`, `runtimeFile.ts` | `npm run liquidity:runtime` | Supervises reference liquidity loop | Local/staging only | Admin API response shape | Yes | Keep | package scripts | Needed for local/staging loop |
| Import World Cup markets | `scripts/importPolymarketWorldCup.ts` | `npm run import:polymarket-worldcup` | Dry-run or explicitly create local reference markets | Active | Admin import API shape | Yes | Keep | package scripts, docs | Phase 1/2 foundation |
| Import single Polymarket market | `scripts/importPolymarketMarket.ts` | `npm run import:polymarket-market` | Imports one market | Active | Admin import API shape | Yes | Keep | package scripts | Useful operator tool |
| Market discovery | `scripts/marketDiscovery.ts`, `src/agents/marketDiscoveryAgent.ts` | direct or `agent:market-discovery` | Safe review-only discovery | Active dry-run | No | Yes | Keep | docs, package scripts indirectly | Discovery bot foundation |
| Reference cache dry-run | `scripts/referenceCacheDryRun.ts` | `npm run reference:cache-dry-run` | Builds reference cache/plan without local orders | Active | Mapping file based | Yes | Keep | package scripts | Phase 3/4 validation |
| Reference-aware liquidity dry-run | `scripts/referenceAwareLiquidityDryRun.ts` | `npm run liquidity:reference-dry-run` | Dry-run quote/liquidity planning | Active | Admin/reference API shape | Yes | Keep | package scripts, tests | Phase 5 foundation |
| Seed/init/prepare reference liquidity | `scripts/initReferenceLiquidityMarket.ts`, `seedReferenceLiquidityMarketBot.ts`, `prepareReferenceLiquidityEvent.ts`, `enableReferenceEventMm.ts`, `enableReferenceEventTrading.ts`, `checkReferenceLiquidityEventReadiness.ts` | `liquidity:*`, `markets:enable-event-trading` | Operator setup for local reference markets/bots | Local/staging only | Admin API shape | Yes | Keep with strict guards | package scripts, README | Needed for safe Phase 6 |
| Stop/reset/control bots | `scripts/stopAllBots.ts`, `botsReset.ts`, `botControl.ts` | `bots:stop-all`, `bots:reset`, `bots:control` | Operational safety controls | Active | Bot config/API IDs | Yes | Keep | package scripts, README | Required kill/reset path |
| Bot safety check | `scripts/checkBotSafety.ts`, `src/config/botSafety.ts` | `npm run bots:safety` | Env and runtime safety checks | Active | No | Yes | Keep/extend | package scripts, tests | Guardrails for local/staging live orders |
| Slow down sim bots | `scripts/slow_down_sim_bots.cjs` | no package script in dev | Helper to slow simulation bots | Unknown | Runtime process assumptions | Not relevant | Do not delete until dependency audit complete | unreferenced by package scripts; original repo had deleted `.js` variant | Need repo-wide docs/systemd/orchestrator scan before removal |
| Agent runner/supervisor | `src/runner/agentRunner.ts`, `scripts/agentSupervisorLoop.ts`, `src/agents/*` | `agents:*`, `agent:*` | Review-only agent recommendations | Active dry-run/review | No | Yes | Keep as review layer | package scripts, docs | Agents must not place orders directly |

## Dependency Reference Checks

- Package script references are listed in `package.json`.
- Runtime docs reference bot commands in `README.md`, `docs/bot-architecture.md`, `docs/polymarket-import-engine.md`, and `docs/agent-safety-policy.md`.
- No obsolete bot deletion is approved by this audit. Before removal, run `rg` across `package.json`, `README.md`, `docs`, `scripts`, `src`, service files, orchestrator files, tests, and deployment/systemd files.

## Polymarket API Investigation

- Discovery uses public Gamma reads from `https://gamma-api.polymarket.com/markets` with `search`, active/closed/archived filters, ordering, slug lookup, and event metadata when present.
- Event import uses `https://gamma-api.polymarket.com/events?slug=...` for grouped World Cup winner events.
- Outcome/token mapping uses `outcomes`, `clobTokenIds`, `outcomePrices`, `conditionId`, `id`, and `slug`.
- Reference price reads use public CLOB endpoints:
  - `/book?token_id=...`
  - `/price?token_id=...&side=BUY`
  - `/price?token_id=...&side=SELL`
  - `/midpoint?token_id=...`
- Public reads require no Polymarket private keys. This repo must not place orders on Polymarket.
- Closed/resolved handling rejects inactive/closed/archived markets in discovery and marks missing books stale/unavailable in sync.
- Polling should stay conservative, per-market errors should be isolated, and repeated failures should pause local quoting.

Official/public references:
- `https://docs.polymarket.com/`
- `https://docs.polymarket.com/developers/CLOB/introduction`
- `https://gamma-api.polymarket.com`

## Final Desired Bot List

1. Polymarket Discovery Bot: keep `marketDiscovery` and `importPolymarketWorldCup` paths; unify naming later.
2. Polymarket Reference Price Sync Bot: keep `ReferencePriceUpdater`, `referenceCacheDryRun`, and Poly snapshot APIs; add script aliases `reference:sync:once` and `reference:sync:loop`.
3. Reference Market Maker Bot: keep `liveMarketMaker` and runtime supervisor; route final quote calculation through Poly pure quote engine when available.
4. Risk/Stale Quote Bot: extend `botSafety`, `evaluateLiveReadiness`, and reset/control scripts.
5. Resolution Proposal Bot: use existing review-only agent pattern; no automatic settlement.
6. Ops Reporter Bot: formalize current reports and runtime files into `polymarket-mm:status`.

## Data Flow

Polymarket Discovery -> Import Candidates -> Internal Event/Market/Outcome -> Mapping Verification -> Reference Price Sync -> Quote Engine -> Bot Order Intent -> Real Bot Orders -> Risk Monitor -> Admin/Ops Dashboard

## Cleanup Plan

- Keep: deterministic strategy runtime, reference-market clients, import scripts, safety/reset/control scripts, live readiness logic.
- Modify: reference quote planning to consume a pure quote engine; add required script aliases; persist dry-run intents or write explicit audit reports; strengthen stale/risk cancellation.
- Merge: duplicate strategy shims can stay until tests prove all imports use category paths.
- Delete later only after proof: any old simulation-only scripts that are unreferenced by package scripts, docs, systemd/orchestrator files, imports, and tests.
- Tests required before deletion: `npm run build`, relevant `tsx scripts/test*.ts`, package script dry-runs, and `rg` dependency scans.

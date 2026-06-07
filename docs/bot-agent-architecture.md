# Bot and Agent Architecture

Poly-bot is split into deterministic executors and reasoning agents.

## Separation

Bots are deterministic executors. They quote, cancel, rebalance, and seed liquidity through explicit strategy code and existing API risk checks.

Agents are reasoning supervisors and workflow coordinators. They review, plan, recommend, classify risk, and produce reports. Agents do not bypass the trading engine.

## Hybrid Model Roles

The Planner Agent uses OpenAI/GPT through Codex CLI. It owns goal decomposition, risk review, approval decisions, and final decisions.

Worker Agents consume DeepSeek tokens through direct DeepSeek Chat Completions API calls from `agent-orchestrator`. Worker roles include code search, log summary, small patch drafts, test generation, research summaries, and report generation.

Worker Agents must not directly deploy, restart production services, run production database writes, move funds, withdraw, modify balances/ledger/orders, resolve markets, or enable live trading. Any high-risk worker output requires Planner Agent or human review before use.

Codex CLI `0.137.0` only accepts `wire_api = "responses"` for custom providers. DeepSeek exposes chat completions but not a Responses endpoint, so worker execution must not depend on DeepSeek Codex profiles in this version.

## Deterministic Bot Workflows

- `tightMarketMaker`
- `inventoryAwareMaker`
- `dynamicMarketMaker`
- `referenceArbitrageRebalancer`
- dry-run `liquiditySeeder`

These workflows keep auditable rules for order placement, inventory, notional limits, stale data checks, and quote cleanup.

## Agent Workflows

- `marketDiscoveryAgent`: reviews NBA and FIFA World Cup reference markets and recommends draft imports.
- `botSupervisorAgent`: reviews deterministic bot health and recommends pause/resume/config changes.
- `riskReviewAgent`: blocks unsafe plans and records required approvals.
- `marketCreationAgent`: converts approved reference candidates into draft-only proposals.
- `resolutionReviewAgent`: reviews evidence and recommends outcomes without settling.

## Safety Model

All agents default to `dryRun` or `reviewOnly`. The default policy blocks:

- live order placement
- fund movement
- withdrawal approval
- production deploys
- production service restarts
- production balances, ledger, or order writes
- active market creation
- market resolution execution
- auto-trading from agent decisions

Market discovery and market creation remain draft-only. Imported markets keep:

- `desiredStatus=draft`
- `listed=false`
- `tradable=false`
- `mmEnabled=false`
- `importStatus=pending_review`
- `referenceOnly=true`

## Approval Gates

Admin approval is required before listing, trading, market-maker enablement, or resolution. Operator review is required before bot pause/resume actions are applied. Agents may recommend these actions, but the orchestrator does not execute them automatically.

## Folder Structure

```text
src/agents
src/tools
src/runner
src/strategies
```

Agents use typed actions and policy gates. Tools wrap existing API clients and reference-market code. Strategies remain deterministic.

## Running Dry-Runs

```bash
npx tsx src/runner/agentRunner.ts --agent marketDiscovery --mode dryRun
npx tsx src/runner/agentRunner.ts --agent botSupervisor --mode reviewOnly
npx tsx src/runner/agentRunner.ts --agent riskReview --mode dryRun
npx tsx src/runner/agentRunner.ts --agent marketCreation --mode dryRun
npx tsx src/runner/agentRunner.ts --agent resolutionReview --mode reviewOnly
```

Network discovery is disabled by default in the agent runner. Add `--allow-network-discovery true` only for an explicit dry-run discovery review.

## Roadmap

1. Add persisted agent run reports.
2. Feed bot logs into `botSupervisorAgent`.
3. Add admin review UI for agent recommendations.
4. Wire approved draft imports into the existing reference snapshot refresh flow.
5. Keep all live execution deterministic and gated by existing API risk controls.

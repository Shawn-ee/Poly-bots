# Agent Safety Policy

## Prohibited By Default

- Live trading from agents
- Fund movement
- Withdrawal approval
- Deposit monitor starts
- Active market creation
- Real market resolution or settlement
- Production deploys or service restarts
- `prisma migrate deploy`
- Production balances, ledger, or order writes
- Secret printing

## Approval Required

- Draft market import
- Bot pause or resume recommendation
- Market activation
- Market-maker enablement
- Resolution recommendation review

## Allowed Dry-Run Actions

- Discover reference markets
- Score and reject candidates
- Recommend draft imports
- Review bot health
- Review order intents
- Review resolution evidence
- Generate reports
- Search code and summarize logs
- Draft small patches for Planner Agent review
- Generate tests for human or Planner Agent review

## Model Routing

- Planner Agent: OpenAI/GPT provider for decomposition, risk review, approval, and final decision.
- Reviewer roles: OpenAI/GPT provider for security and high-risk review.
- Worker Agents: direct DeepSeek Chat Completions API calls from `agent-orchestrator` for code search, log summaries, small patch drafts, test generation, research, and reports.
- Worker output that touches deploys, services, production DB writes, balances, ledger, orders, withdrawals, live trading, or market resolution is treated as high risk and must be reviewed by the Planner Agent or a human.

## Market Import Restrictions

Market discovery is limited to NBA and FIFA World Cup candidates. Generic soccer markets are rejected unless clearly FIFA World Cup related. Imports are draft-only and capped by `MAX_IMPORTED_MARKETS=300` by default.

## Trading Restrictions

Agents cannot directly place live orders. Order tools can prepare and validate order intents, estimate risk, and produce dry-run plans. Live order placement remains deterministic bot behavior and must go through existing API checks.

## Resolution Restrictions

Resolution agents may recommend an outcome when evidence is clear, but they cannot resolve markets or move settlement funds. Admin approval and deterministic settlement code are required.

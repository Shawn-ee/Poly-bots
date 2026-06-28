# Agent Rules

These rules apply to every Codex or AI-agent session working in this repository.

## Branch Safety

- Never push directly to `main`.
- Never force push.
- Work only inside the assigned branch.
- Use `agent/<task-name>` branches for feature and fix work.
- Push only the current branch.
- Open pull requests into `dev`, not `main`.
- If conflicts happen, stop and report them.

## Change Scope

- Keep pull requests small and focused.
- Prefer changing 3-10 files per task.
- Do not mix unrelated refactors with feature or fix work.
- Do not change production configuration unless the task explicitly requires it.

## Secrets And Environment

- Never commit `.env` files or secrets.
- Do not print secrets into logs, test snapshots, docs, or PR descriptions.
- Use `.env.example` or documentation for new required variables.
- If a secret may have been committed, stop and report it immediately.

## Validation

- Run `scripts/agent/pre-pr-check.sh` before pushing.
- Commit only intentional files.
- Review `git diff --stat` and `git status --short` before every commit.

## High-Risk Areas

Use extra caution and add focused tests when touching:

- orderbook
- balances
- trades
- positions
- ledger
- settlement
- wallet
- deposits
- withdrawals
- market-making risk controls
- reference arbitrage
- bot credentials
- live trading automation

If schema or API contract changes are needed, explain the migration or rollout impact in the PR.

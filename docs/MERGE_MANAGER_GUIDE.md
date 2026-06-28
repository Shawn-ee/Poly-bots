# Merge Manager Guide

The merge manager is responsible for integrating agent pull requests safely.

## Responsibilities

- Fetch all branches.
- Review each agent PR before merging.
- Check files changed and confirm the scope matches the task.
- Check for accidental secrets.
- Run tests and build checks.
- Check database or API contract conflicts.
- Check live trading and bot risk-control changes carefully.
- Merge safe PRs into `dev`.
- Stop on conflicts.
- Never merge failing changes.
- Never push directly to `main` without final verification.
- After `dev` is stable, merge `dev` into `main` manually or through a protected PR.

## Review Flow

```sh
git fetch --all --prune
git switch dev
git pull --ff-only origin dev
```

For each PR:

```sh
git diff --stat dev...agent/name
git diff --name-only dev...agent/name
```

Review high-risk files carefully, especially market-making logic, risk controls, arbitrage rebalancing, bot credentials, live trading scripts, balances, positions, and order placement.

## Secret Check

Run:

```sh
scripts/agent/pre-pr-check.sh
```

Also inspect new config, docs, fixtures, logs, and bot credential files for keys or tokens.

## Contract And Migration Conflicts

Before merging, check for:

- API request or response shape changes
- shared type changes
- config variable changes
- changes that require a coordinated Poly repository deployment
- destructive migration or data backfill assumptions

Stop and ask for a rollout plan if the impact is unclear.

## Promotion To Main

Promote only after `dev` is stable:

```sh
git switch dev
git pull --ff-only origin dev
scripts/agent/pre-pr-check.sh
```

Then open a protected PR from `dev` to `main`, or follow the approved manual release process. Never promote unverified changes.

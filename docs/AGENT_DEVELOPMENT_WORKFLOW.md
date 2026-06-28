# Agent Development Workflow

This repository uses a branch-per-task workflow for safe parallel AI-agent development.

## Branch Model

- `main` is the stable production branch.
- `dev` is the integration branch.
- `agent/*` branches are isolated task branches.
- Every feature or fix starts from `dev`.
- Every agent branch opens a pull request into `dev`.
- `dev` is tested before anything is merged into `main`.
- No agent pushes directly to `main`.

## Creating A New Agent Branch

From a clean checkout:

```sh
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c agent/my-task-name
```

Use a short, descriptive branch name such as `agent/reference-arb-rebalancer`.

## Using Git Worktree

Worktrees let multiple Codex sessions work in parallel without sharing one working directory.

Recommended parent directory:

```text
~/projects/agent-workspaces/
```

Create a worktree from `dev`:

```sh
scripts/agent/create-agent-worktree.sh agent/my-task-name ~/projects/agent-workspaces/poly-bot-agent-my-task
```

Each worktree should have exactly one assigned branch. Do not run two Codex sessions in the same worktree.

## Running Codex In One Branch Only

Before starting Codex, enter the assigned worktree:

```sh
cd ~/projects/agent-workspaces/poly-bot-agent-my-task
git branch --show-current
```

Confirm the branch starts with `agent/`. Run:

```sh
scripts/agent/check-agent-branch.sh
```

Stop if the script reports `main` or an unexpected branch.

## Safe Commits

Before committing:

```sh
git status --short
git diff --stat
scripts/agent/pre-pr-check.sh
```

Commit only intentional files:

```sh
git add <files>
git commit -m "feat: describe focused change"
```

## Safe Pushes

Push only the current branch:

```sh
git push -u origin HEAD
```

Never use `--force` or `--force-with-lease`.

## Opening Pull Requests Into Dev

With GitHub CLI:

```sh
gh pr create --base dev --head agent/my-task-name --title "Short title" --body "Summary, tests, and risk notes."
```

Without GitHub CLI, open GitHub in the browser, compare `agent/my-task-name` into `dev`, and create the pull request manually. Do not target `main`.

## Merging Dev Into Main

Only the merge manager should promote `dev` into `main`.

Recommended path:

```sh
git fetch origin
git switch dev
git pull --ff-only origin dev
scripts/agent/pre-pr-check.sh
```

After final verification, open a protected PR from `dev` into `main`, or perform the approved manual merge process. Do not bypass failing checks.

## Conflict Avoidance

- Keep PRs small.
- Pull from `dev` before starting work.
- Avoid editing broad shared files unless required.
- Coordinate changes to API contracts, shared types, config loading, bot runner behavior, and live trading services.
- If conflicts appear, stop and report the files and branches involved.

## Database Migrations

This repository should not introduce database migrations unless the main Poly app contract explicitly requires it. If schema or API shape changes are needed, coordinate with the Poly repository PR and document rollout order.

## Environment Variables And Secrets

- Do not commit `.env` files.
- Add new variable names to `.env.example` or documentation only.
- Never include live keys, tokens, passwords, private keys, mnemonics, bot credentials, or webhook secrets.
- If a secret is found, stop and report it before pushing.

## Repository Checks

This repository currently defines `typecheck` and `build` npm scripts. It does not define generic `lint` or `test` npm scripts. `scripts/agent/pre-pr-check.sh` runs only scripts that exist in `package.json`.

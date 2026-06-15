#!/usr/bin/env bash
set -euo pipefail

workspace_root="${1:-$HOME/projects/agent-workspaces}"

if [ "$(git branch --show-current)" = "main" ]; then
  echo "ERROR: Refusing setup while current checkout is on main. Switch to dev first."
  exit 1
fi

if ! git show-ref --verify --quiet refs/heads/dev; then
  echo "ERROR: local dev branch is required."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree is not clean. Commit or stash changes before setup."
  git status --short
  exit 1
fi

mkdir -p "$workspace_root"

add_worktree_if_missing() {
  local branch="$1"
  local path="$2"
  local base="$3"

  if [ -e "$path" ]; then
    echo "Skipping existing path: $path"
    return
  fi

  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    git worktree add "$path" "$branch"
  else
    git worktree add -b "$branch" "$path" "$base"
  fi
}

add_worktree_if_missing main "$workspace_root/poly-bot-main" main
add_worktree_if_missing agent/reference-arb-rebalancer "$workspace_root/poly-bot-agent-reference-arb" dev
add_worktree_if_missing agent/soak-test-runner "$workspace_root/poly-bot-agent-soak-tests" dev
add_worktree_if_missing agent/risk-controls "$workspace_root/poly-bot-agent-risk-controls" dev

git worktree list

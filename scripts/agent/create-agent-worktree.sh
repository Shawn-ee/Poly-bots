#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 agent/<branch-name> <worktree-path>"
  exit 1
fi

branch="$1"
path="$2"
current_branch="$(git branch --show-current)"

if [ "$current_branch" = "main" ]; then
  echo "ERROR: Refusing to create agent worktree while current checkout is on main. Switch to dev first."
  exit 1
fi

if [[ "$branch" != agent/* ]]; then
  echo "ERROR: Agent branch must start with agent/."
  exit 1
fi

git fetch origin --prune

if git show-ref --verify --quiet "refs/remotes/origin/dev"; then
  git switch dev
  git pull --ff-only origin dev
elif git show-ref --verify --quiet "refs/heads/dev"; then
  git switch dev
else
  echo "ERROR: dev branch does not exist locally or remotely."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree is not clean. Commit or stash changes before creating a worktree."
  git status --short
  exit 1
fi

git worktree add -b "$branch" "$path" dev

echo "Created worktree:"
echo "  branch: $branch"
echo "  path:   $path"
echo "Run Codex from that path only for this task."

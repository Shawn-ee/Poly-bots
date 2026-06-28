#!/usr/bin/env bash
set -euo pipefail

branch="$(git branch --show-current)"

echo "Current branch: ${branch}"
echo "Changed files:"
git status --short

if [ "$branch" = "main" ]; then
  echo "ERROR: Refusing to run on main."
  exit 1
fi

if [ -z "$branch" ]; then
  echo "ERROR: Detached HEAD is not allowed for agent work."
  exit 1
fi

if [ "$branch" != "dev" ] && [[ "$branch" != agent/* ]]; then
  echo "WARNING: Expected dev or agent/* branch."
fi

echo "Reminder: open PRs into dev, not main."

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"

"${script_dir}/check-agent-branch.sh"

branch="$(git branch --show-current)"
if [ "$branch" = "main" ]; then
  echo "ERROR: Refusing pre-PR checks on main."
  exit 1
fi

echo "Secret scan:"
secret_regex='(AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----|ghp_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})'
if git grep -n -I -E "$secret_regex" -- . ':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock'; then
  echo "ERROR: Potential secret found. Review before pushing."
  exit 1
fi
echo "No obvious secrets found."

run_if_present() {
  local name="$1"
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Skipping npm run ${name}: node or npm is not available on PATH."
    return
  fi

  if node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts['${name}'] ? 0 : 1)"; then
    echo "Running npm run ${name}"
    npm run "$name"
  else
    echo "Skipping npm run ${name}: script not defined."
  fi
}

run_if_present typecheck
run_if_present lint
run_if_present test
run_if_present test:jest
run_if_present build

echo "Pre-PR checks complete."
echo "Push with: git push -u origin HEAD"
echo "Open PR into dev, not main."

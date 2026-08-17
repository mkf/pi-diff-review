#!/usr/bin/env bash
# Idempotent local / Cloud Agent bootstrap matching CONTRIBUTING.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.local/bin:${PATH}"

HOOKS_ONLY=0
if [ "${1:-}" = "--hooks-only" ]; then
  HOOKS_ONLY=1
fi

install_pre_commit_hooks() {
  if ! command -v pre-commit >/dev/null 2>&1; then
    echo "pre-commit is not on PATH; run this script without --hooks-only first" >&2
    return 1
  fi

  local saved_hooks_path=""
  if saved_hooks_path="$(git config --local --get core.hooksPath)"; then
    # Cursor Cloud sets core.hooksPath to a dispatcher that still runs
    # .git/hooks. Temporarily restore the default path so pre-commit can
    # install, then put the Cursor path back.
    git config --local --unset-all core.hooksPath
    pre-commit install
    git config --local core.hooksPath "$saved_hooks_path"
  else
    pre-commit install
  fi
}

if [ "$HOOKS_ONLY" -eq 0 ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required" >&2
    exit 1
  fi

  npm ci
  python3 -m pip install --user --upgrade pre-commit
fi

install_pre_commit_hooks
echo "pre-commit $(pre-commit --version) installed in ${ROOT}"

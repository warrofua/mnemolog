#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_CHECKS=0
SKIP_WORKER=0
SKIP_PAGES=0

for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=1 ;;
    --skip-worker) SKIP_WORKER=1 ;;
    --skip-pages) SKIP_PAGES=1 ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: $0 [--skip-checks] [--skip-worker] [--skip-pages]"
      exit 1
      ;;
  esac
done

echo "==> Repo: $ROOT_DIR"
cd "$ROOT_DIR"

echo "==> Git snapshot"
git branch --show-current
git status --short

if [[ "$SKIP_CHECKS" -eq 0 ]]; then
  echo "==> Running worker TypeScript checks"
  (
    cd worker
    npx tsc --noEmit
  )
else
  echo "==> Skipping TypeScript checks"
fi

if [[ "$SKIP_WORKER" -eq 0 ]]; then
  echo "==> Deploying Worker (mnemolog-api)"
  (
    cd worker
    npx wrangler deploy
  )
else
  echo "==> Skipping Worker deploy"
fi

if [[ "$SKIP_PAGES" -eq 0 ]]; then
  echo "==> Deploying Pages project (mnemolog)"
  (
    cd frontend
    npx wrangler pages deploy . --project-name mnemolog
  )
else
  echo "==> Skipping Pages deploy"
fi

echo "==> Smoke checks"
curl -sS https://mnemolog.com/api/health >/dev/null && echo "ok: /api/health"
curl -sS https://mnemolog.com/api/agents/status >/dev/null && echo "ok: /api/agents/status"
curl -sS https://mnemolog.com/api/agents/capabilities >/dev/null && echo "ok: /api/agents/capabilities"
curl -sS https://mnemolog.com/.well-known/agent.json >/dev/null && echo "ok: /.well-known/agent.json"
curl -sS https://mnemolog.com/agents/progress.md >/dev/null && echo "ok: /agents/progress.md"

echo "==> Deploy complete"

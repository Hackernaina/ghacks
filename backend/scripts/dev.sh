#!/usr/bin/env bash
# Local stack: Postgres + stub PSP A (:4001, also acts as the bank) + stub PSP B (:4002) + backend (:3000).
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
"${COMPOSE[@]}" -f ../docker-compose.yml up -d --wait postgres

set -a
[ -f .env ] && . ./.env
set +a
export BANK_URL="${BANK_URL:-http://localhost:4001}"

pnpm --filter @reconcile/shared build
pnpm exec tsx src/db/migrate.ts

BACKEND_URL="http://localhost:${PORT:-3000}"
trap 'kill 0' EXIT
PSP_ID=psp_a PORT=4001 WEBHOOK_SECRET="${WEBHOOK_SECRET_PSP_A:-dev-secret-psp-a}" CALLBACK_URL="$BACKEND_URL" \
  pnpm --filter @reconcile/stub-psp dev &
PSP_ID=psp_b PORT=4002 WEBHOOK_SECRET="${WEBHOOK_SECRET_PSP_B:-dev-secret-psp-b}" CALLBACK_URL="$BACKEND_URL" \
  pnpm --filter @reconcile/stub-psp dev &
pnpm exec tsx watch src/main.ts &
wait

#!/usr/bin/env bash
# Local stack: Postgres + Person A's mocks (PSP A :4001, PSP B :4002, bank :4003) + backend (:3000).
# STUB=1 uses the backend's stub PSPs instead (stub PSP A also serves /statements as the bank).
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
"${COMPOSE[@]}" -f ../docker-compose.yml up -d --wait postgres

set -a
[ -f .env ] && . ./.env
set +a

BACKEND_URL="http://localhost:${PORT:-3000}"
SECRET_A="${WEBHOOK_SECRET_PSP_A:-dev-secret-psp-a}"
SECRET_B="${WEBHOOK_SECRET_PSP_B:-dev-secret-psp-b}"

pnpm --filter @reconcile/shared build
pnpm exec tsx src/db/migrate.ts

trap 'kill 0' EXIT
if [ "${STUB:-0}" = "1" ]; then
  export BANK_URL="http://localhost:4001"
  PSP_ID=psp_a PORT=4001 WEBHOOK_SECRET="$SECRET_A" CALLBACK_URL="$BACKEND_URL" pnpm --filter @reconcile/stub-psp dev &
  PSP_ID=psp_b PORT=4002 WEBHOOK_SECRET="$SECRET_B" CALLBACK_URL="$BACKEND_URL" pnpm --filter @reconcile/stub-psp dev &
else
  export BANK_URL="${BANK_URL:-http://localhost:4003}"
  PORT=4003 pnpm --filter @reconcile/mock-bank dev &
  PSP_ID=psp_a PORT=4001 WEBHOOK_SECRET="$SECRET_A" BACKEND_URL="$BACKEND_URL" pnpm --filter @reconcile/mock-psp dev &
  PSP_ID=psp_b PORT=4002 WEBHOOK_SECRET="$SECRET_B" BACKEND_URL="$BACKEND_URL" pnpm --filter @reconcile/mock-psp dev &
fi
pnpm exec tsx watch src/main.ts &
wait

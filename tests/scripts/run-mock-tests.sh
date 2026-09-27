#!/usr/bin/env bash
# Builds and starts the three mocks on :4001/:4002/:4003, runs tests/vitest against them, then stops them.
# Webhooks go nowhere (BACKEND_URL points at a closed port) so no backend is needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

pnpm --filter @reconcile/shared build
pnpm --filter @reconcile/mock-psp --filter @reconcile/mock-bank build

trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
PORT=4003 node mocks/bank/dist/index.js &
PSP_ID=psp_a PORT=4001 BACKEND_URL=http://127.0.0.1:9 BANK_URL=http://localhost:4003 node mocks/psp/dist/index.js &
PSP_ID=psp_b PORT=4002 BACKEND_URL=http://127.0.0.1:9 BANK_URL=http://localhost:4003 node mocks/psp/dist/index.js &

for _ in $(seq 1 30); do
  curl -sf localhost:4001/healthz >/dev/null && curl -sf localhost:4002/healthz >/dev/null && curl -sf localhost:4003/healthz >/dev/null && break
  sleep 0.5
done

cd tests/vitest
status=0
../../mocks/psp/node_modules/.bin/vitest run --fileParallelism=false || status=$?
exit "$status"

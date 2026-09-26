#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Happy Path Tests — curl
# Usage: ./happy-path.sh [PSP_URL] [BANK_URL]
# Defaults: PSP=http://localhost:4001  BANK=http://localhost:4003
# ─────────────────────────────────────────────────────────────────────────────

PSP="${1:-http://localhost:4001}"
BANK="${2:-http://localhost:4003}"
PASS=0; FAIL=0

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

pass() { echo -e "${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "${RED}✗${NC} $1"; ((FAIL++)); }
header() { echo -e "\n${BOLD}$1${NC}"; }

ORDER_ID="ord_$(date +%s)_$$"
KEY="${ORDER_ID}:1"

# ─── Mock PSP ────────────────────────────────────────────────────────────────
header "Mock PSP — Happy Path"

# 1. Create payment
RESP=$(curl -sf -X POST "$PSP/v1/payments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d "{\"orderId\":\"$ORDER_ID\",\"amount\":1000,\"currency\":\"INR\",\"merchantPaymentId\":\"pay_$ORDER_ID\",\"customerId\":\"cust_1\"}")

if echo "$RESP" | grep -q "pspRef"; then
  pass "POST /v1/payments returns pspRef"
  PSP_REF=$(echo "$RESP" | grep -o '"pspRef":"[^"]*"' | cut -d'"' -f4)
else
  fail "POST /v1/payments — no pspRef in response: $RESP"
fi

# 2. Get payment by key
RESP2=$(curl -sf "$PSP/v1/payments?idempotency_key=$KEY")
if echo "$RESP2" | grep -q "$KEY"; then
  pass "GET /v1/payments?idempotency_key=K returns the payment"
else
  fail "GET /v1/payments?idempotency_key=K — key not found in response: $RESP2"
fi

# 3. Idempotency — same key, same pspRef
RESP3=$(curl -sf -X POST "$PSP/v1/payments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d "{\"orderId\":\"$ORDER_ID\",\"amount\":1000,\"currency\":\"INR\",\"merchantPaymentId\":\"pay_$ORDER_ID\",\"customerId\":\"cust_1\"}")
PSP_REF2=$(echo "$RESP3" | grep -o '"pspRef":"[^"]*"' | cut -d'"' -f4)

if [ "$PSP_REF" = "$PSP_REF2" ] && [ -n "$PSP_REF" ]; then
  pass "Idempotency: same key returns same pspRef"
else
  fail "Idempotency: pspRef differs — first=$PSP_REF second=$PSP_REF2"
fi

# 4. 404 for unknown key
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PSP/v1/payments?idempotency_key=NONEXISTENT_XYZ:1")
if [ "$STATUS" = "404" ]; then
  pass "GET unknown idempotency key returns 404"
else
  fail "GET unknown idempotency key returned $STATUS (expected 404)"
fi

# 5. Settlement CSV
SINCE=$(date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)
CSV=$(curl -sf "$PSP/v1/settlements?since=$SINCE")
if echo "$CSV" | head -1 | grep -qi "psp_ref\|amount\|status"; then
  pass "GET /v1/settlements returns CSV with expected headers"
else
  fail "GET /v1/settlements — unexpected CSV header: $(echo "$CSV" | head -1)"
fi

# ─── Mock Bank ───────────────────────────────────────────────────────────────
header "Mock Bank — Happy Path"

BANK_RESP=$(curl -sf -X POST "$BANK/debit" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":500,\"currency\":\"INR\",\"psp_ref\":\"pa_ref_$$\",\"ref\":\"pa_ref_$$\"}")

if echo "$BANK_RESP" | grep -q "bankRef"; then
  pass "POST /debit returns bankRef"
else
  fail "POST /debit — no bankRef in response: $BANK_RESP"
fi

SINCE=$(date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)
STMT=$(curl -sf "$BANK/statements?since=$SINCE")
if echo "$STMT" | head -1 | grep -qi "psp_ref\|amount"; then
  pass "GET /statements returns CSV with expected headers"
else
  fail "GET /statements — unexpected header: $(echo "$STMT" | head -1)"
fi

# 400 for missing fields
BAD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BANK/debit" \
  -H "Content-Type: application/json" \
  -d '{"amount":100}')
if [ "$BAD_STATUS" = "400" ]; then
  pass "POST /debit with missing fields returns 400"
else
  fail "POST /debit missing fields returned $BAD_STATUS (expected 400)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────"
echo -e "Results: ${GREEN}$PASS passed${NC}  ${RED}$FAIL failed${NC}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

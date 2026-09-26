#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Fault Scenario Scripts — 6 one-click reproductions
# Usage: ./scenarios.sh [scenario] [PSP_URL] [PSP_B_URL] [BANK_URL]
#
# Scenarios:
#   1  lost-response       — PSP drops response, payment enters UNKNOWN
#   2  duplicate-webhook   — webhook fires twice, dedup must catch it
#   3  late-webhook         — webhook delayed 15s, state catches up late
#   4  out-of-order        — webhooks arrive in wrong order
#   5  failover-double     — PSP A fails, PSP B fires, duplicate charge
#   6  settlement-mismatch — settlement CSV omits a row, recon flags it
#   all                    — run all scenarios in sequence
#
# Example: ./scenarios.sh 1
#          ./scenarios.sh all http://localhost:4001 http://localhost:4002
# ─────────────────────────────────────────────────────────────────────────────

SCENARIO="${1:-all}"
PSP="${2:-http://localhost:4001}"
PSP_B="${3:-http://localhost:4002}"
BANK="${4:-http://localhost:4003}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

key() { echo "ord_$(date +%s)_$RANDOM:1"; }
sep() { echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
info() { echo -e "${CYAN}ℹ${NC}  $1"; }
ok()   { echo -e "${GREEN}✓${NC}  $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
err()  { echo -e "${RED}✗${NC}  $1"; }

reset_faults() {
  curl -sf -X POST "$1/admin/faults" \
    -H "Content-Type: application/json" \
    -d '{"dropPercent":0,"webhookDelayMs":0,"duplicatePercent":0,"reorderWebhooks":false,"settlementMismatch":false,"bypassIdempotency":false}' \
    > /dev/null
}

set_fault() {
  local url="$1"; shift
  curl -sf -X POST "$url/admin/faults" \
    -H "Content-Type: application/json" \
    -d "$1" > /dev/null
}

pay() {
  local url="$1" key="$2" amount="${3:-1000}"
  local order_id="${key%%:*}"
  curl -sf -X POST "$url/v1/payments" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $key" \
    -d "{\"orderId\":\"$order_id\",\"amount\":$amount,\"currency\":\"INR\",\"merchantPaymentId\":\"pay_$order_id\",\"customerId\":\"cust_1\"}"
}

# ─────────────────────────────────────────────────────────────────────────────
scenario_1() {
  sep
  echo -e "${BOLD}SCENARIO 1: Lost Response → UNKNOWN State${NC}"
  info "PSP drops 100% of responses. Payment is written but client never hears back."
  info "Resolver must poll GET /v1/payments?idempotency_key=K to recover state."
  echo ""

  K=$(key)
  reset_faults "$PSP"
  set_fault "$PSP" '{"dropPercent":100}'
  info "Fault set: dropPercent=100 on $PSP"

  info "Firing payment with key=$K ..."
  RESP=$(pay "$PSP" "$K" 2>&1) && STATUS=200 || STATUS=ERR

  if [ "$STATUS" = "ERR" ] || [ -z "$RESP" ]; then
    ok "Payment POST failed as expected (simulates lost response)"
  else
    warn "Payment POST succeeded — drop may not be wired yet"
  fi

  reset_faults "$PSP"
  info "Faults cleared. Resolver can now poll:"
  echo -e "  ${CYAN}curl $PSP/v1/payments?idempotency_key=$K${NC}"

  POLL=$(curl -sf "$PSP/v1/payments?idempotency_key=$K")
  if [ -n "$POLL" ]; then
    ok "Resolver poll: payment found → $(echo "$POLL" | grep -o '"status":"[^"]*"')"
  else
    warn "Payment not found by poll (may not have been stored before drop)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
scenario_2() {
  sep
  echo -e "${BOLD}SCENARIO 2: Duplicate Webhook${NC}"
  info "PSP fires the same webhook twice. Ingestion must deduplicate on eventId."
  echo ""

  K=$(key)
  reset_faults "$PSP"
  set_fault "$PSP" '{"duplicatePercent":100}'
  info "Fault set: duplicatePercent=100"

  info "Firing payment with key=$K ..."
  RESP=$(pay "$PSP" "$K")
  if echo "$RESP" | grep -q "pspRef"; then
    ok "Payment created: $(echo "$RESP" | grep -o '"pspRef":"[^"]*"')"
    info "Webhook will fire TWICE. Check ingestion logs for dedup."
    info "Expected: evidence table has 1 row for this eventId, not 2."
  else
    err "Payment failed: $RESP"
  fi
  reset_faults "$PSP"
}

# ─────────────────────────────────────────────────────────────────────────────
scenario_3() {
  sep
  echo -e "${BOLD}SCENARIO 3: Late Webhook${NC}"
  info "Webhook delayed 15s. Payment shows UNKNOWN, then updates when webhook arrives."
  echo ""

  K=$(key)
  reset_faults "$PSP"
  set_fault "$PSP" '{"webhookDelayMs":15000}'
  info "Fault set: webhookDelayMs=15000"

  info "Firing payment with key=$K ..."
  RESP=$(pay "$PSP" "$K")
  if echo "$RESP" | grep -q "pspRef"; then
    ok "Payment created immediately (PSP responds fast, webhook fires late)"
    info "Watch the payment status — it should be UNKNOWN or PENDING for ~15s"
    info "Then webhook arrives and state transitions to SUCCEEDED/FAILED"
    echo -e "  Poll: ${CYAN}curl $PSP/v1/payments?idempotency_key=$K${NC}"
  else
    err "Payment failed: $RESP"
  fi
  reset_faults "$PSP"
}

# ─────────────────────────────────────────────────────────────────────────────
scenario_4() {
  sep
  echo -e "${BOLD}SCENARIO 4: Out-of-Order Webhooks${NC}"
  info "Webhooks arrive in wrong order (e.g. FAILED before PENDING)."
  info "Monotonic state machine must ignore backward transitions."
  echo ""

  K=$(key)
  reset_faults "$PSP"
  set_fault "$PSP" '{"reorderWebhooks":true}'
  info "Fault set: reorderWebhooks=true"

  info "Firing payment with key=$K ..."
  RESP=$(pay "$PSP" "$K")
  if echo "$RESP" | grep -q "pspRef"; then
    ok "Payment created: $(echo "$RESP" | grep -o '"pspRef":"[^"]*"')"
    info "Webhooks will arrive out of order. Final state must be monotonically correct."
    info "Check evidence timeline in ops dashboard — events may show out of sequence."
    info "But final payment state should reflect the HIGHEST precedence event."
  else
    err "Payment failed: $RESP"
  fi
  reset_faults "$PSP"
}

# ─────────────────────────────────────────────────────────────────────────────
scenario_5() {
  sep
  echo -e "${BOLD}SCENARIO 5: Failover Double Charge${NC}"
  info "PSP A drops. Client retries on PSP B with same idempotency key."
  info "Two PSPs each charge the bank. Duplicate detector must catch this."
  echo ""

  K=$(key)
  reset_faults "$PSP"
  set_fault "$PSP" '{"dropPercent":100}'
  info "Fault set: PSP A dropPercent=100"

  info "Attempt payment on PSP A (key=$K) — will fail ..."
  pay "$PSP" "$K" > /dev/null 2>&1 || true
  ok "PSP A failed as expected"

  reset_faults "$PSP"
  info "Client failover: retrying on PSP B with same key=$K"

  RESP_B=$(pay "$PSP_B" "$K" 2>/dev/null)
  if echo "$RESP_B" | grep -q "pspRef"; then
    PSP_B_REF=$(echo "$RESP_B" | grep -o '"pspRef":"[^"]*"' | cut -d'"' -f4)
    ok "PSP B created payment: pspRef=$PSP_B_REF"
    warn "DOUBLE CHARGE: Both PSPs may have charged the bank"
    info "Duplicate detector must fingerprint (user+order+amount+window) and flag this"
    info "Check review queue — a duplicate case should appear"
  else
    warn "PSP B not reachable or returned error: $RESP_B"
    info "Start PSP B with: PSP_ID=psp_b PORT=4002 pnpm --filter @reconcile/mock-psp start"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
scenario_6() {
  sep
  echo -e "${BOLD}SCENARIO 6: Settlement Mismatch${NC}"
  info "PSP settlement CSV omits or alters a row. Recon must flag the discrepancy."
  echo ""

  BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  K1=$(key); K2=$(key)
  reset_faults "$PSP"

  info "Creating two payments (both should appear in settlement) ..."
  R1=$(pay "$PSP" "$K1"); R2=$(pay "$PSP" "$K2")
  ok "Payment 1: $(echo "$R1" | grep -o '"pspRef":"[^"]*"')"
  ok "Payment 2: $(echo "$R2" | grep -o '"pspRef":"[^"]*"')"

  sleep 0.5
  NORMAL_CSV=$(curl -sf "$PSP/v1/settlements?since=$BEFORE")
  NORMAL_ROWS=$(echo "$NORMAL_CSV" | tail -n +2 | grep -c .)
  info "Normal settlement: $NORMAL_ROWS data rows"

  set_fault "$PSP" '{"settlementMismatch":true}'
  info "Fault set: settlementMismatch=true"

  MISMATCH_CSV=$(curl -sf "$PSP/v1/settlements?since=$BEFORE")
  MISMATCH_ROWS=$(echo "$MISMATCH_CSV" | tail -n +2 | grep -c .)
  info "Mismatch settlement: $MISMATCH_ROWS data rows"

  if [ "$NORMAL_ROWS" -ne "$MISMATCH_ROWS" ]; then
    ok "Settlement mismatch confirmed: $NORMAL_ROWS rows → $MISMATCH_ROWS rows"
    info "Recon engine should flag missing/altered rows and create review cases"
  else
    warn "Row counts match ($NORMAL_ROWS) — mismatch may alter amounts instead of dropping rows"
    info "Check if amounts differ between the two CSVs"
  fi
  reset_faults "$PSP"
}

# ─────────────────────────────────────────────────────────────────────────────
# Runner
# ─────────────────────────────────────────────────────────────────────────────

echo -e "${BOLD}Payment Reconciliation — Fault Scenarios${NC}"
echo "PSP A: $PSP  |  PSP B: $PSP_B  |  Bank: $BANK"

case "$SCENARIO" in
  1|lost*)        scenario_1 ;;
  2|dup*)         scenario_2 ;;
  3|late*)        scenario_3 ;;
  4|order*)       scenario_4 ;;
  5|failover*)    scenario_5 ;;
  6|settle*)      scenario_6 ;;
  all)
    scenario_1; scenario_2; scenario_3
    scenario_4; scenario_5; scenario_6
    ;;
  *)
    echo "Unknown scenario: $SCENARIO"
    echo "Usage: $0 [1-6|all] [PSP_URL] [PSP_B_URL] [BANK_URL]"
    exit 1
    ;;
esac

sep
echo -e "${GREEN}Done.${NC} Reset all faults: curl -X POST $PSP/admin/faults -d '{\"dropPercent\":0}'"

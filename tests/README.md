# Payment Reconciliation — Test & Verification Suite

Comprehensive test suite verifying core payment lifecycle, idempotency guarantees, asynchronous webhook ingestions, and real-world failure reconciliation against live mock services.

---

## Directory Structure

```
tests/
├── vitest/
│   ├── mock-psp.test.ts         # PSP API contracts, idempotency strictness, HMAC signature checks
│   ├── mock-bank.test.ts        # Bank debit and statement feed contracts
│   ├── fault-scenarios.test.ts  # End-to-end integration tests for 6 failure scenarios
│   ├── vitest.config.ts         # Vitest execution configuration
│   └── package.json             # Test runner dependencies & scripts
└── scripts/
    ├── happy-path.sh            # Smoke check for basic payment & settlement endpoints
    └── scenarios.sh             # Scripted execution of the 6 fault demo scenarios
```

---

## Prerequisites

Before running the integration tests, start the mock instances in separate terminals:

| Mock Service | Port | Start Command |
| :--- | :--- | :--- |
| **PSP A** | `4001` | `$env:PSP_ID="psp_a"; $env:PORT="4001"; node mocks/psp/dist/index.js` |
| **PSP B** | `4002` | `$env:PSP_ID="psp_b"; $env:PORT="4002"; node mocks/psp/dist/index.js` |
| **Bank**  | `4003` | `$env:PORT="4003"; node mocks/bank/dist/index.js` |

---

## Running Integration Tests (Vitest)

Navigate to `tests/vitest`:

```bash
cd tests/vitest
```

### Run All Test Suites
Runs PSP, Bank, and Scenario suites sequentially (avoiding concurrent fault state crosstalk):
```bash
corepack pnpm test
```
*Or directly via Vitest binary:*
```bash
../../mocks/psp/node_modules/.bin/vitest run --fileParallelism=false
```

### Run Individual Test Suites
```bash
# PSP contract & fault checks (Port 4001)
corepack pnpm test:psp

# Bank contract & statement checks (Port 4003)
corepack pnpm test:bank

# 6 Edge Case Scenarios (Port 4001 & 4002)
corepack pnpm test:scenarios
```

---

## Test Coverage Matrix

### 1. Mock PSP (`mock-psp.test.ts`)
* **Happy Path**: Verifies `POST /v1/payments` responds with `200 OK`, valid `pspRef` (`pa_...`), and `status: "SUCCEEDED"`.
* **State Polling**: Ensures `GET /v1/payments?idempotency_key=K` returns stored payment records and `404 NOT_FOUND` for invalid keys.
* **Idempotency Guarantees**: Confirms duplicate POSTs with the same idempotency key return the original payment response even if the payload amount differs.
* **HMAC Signatures**: Validates webhook payload authenticity using `X-Signature` with plain hexadecimal digest (`HMAC-SHA256`).
* **Settlement Feeds**: Verifies valid CSV output matching `SETTLEMENT_CSV_HEADER`.

### 2. Mock Bank (`mock-bank.test.ts`)
* **Direct Debit**: Validates `POST /debit` requiring `amount`, `currency`, and `psp_ref`.
* **Statement Feeds**: Validates `GET /statements?since=` returning sequential CSV records (`statement_id,line_no,psp_ref,amount,currency,type,credited_at`).
* **Timestamp Windowing**: Confirms statement filters correctly exclude entries prior to the query window.

### 3. Fault Scenarios (`fault-scenarios.test.ts`)

| Scenario | Injected Fault | Expected System Behavior |
| :--- | :--- | :--- |
| **1. Lost Response** | `dropPercent: 100` | Payment request times out / drops; system reconciles state via background polling (`GET /v1/payments`). |
| **2. Duplicate Webhook** | `duplicatePercent: 100` | Webhook dispatched multiple times; idempotency guarantees payment is recorded exactly once. |
| **3. Late Webhook** | `webhookDelayMs: 10000` | POST `/v1/payments` returns synchronously; delayed webhook is reconciled cleanly later. |
| **4. Out-of-Order Webhook** | `reorderWebhooks: true` | Webhooks delivered out of sequence do not regress terminal transaction states. |
| **5. Failover Double Charge**| PSP A dropped $\rightarrow$ PSP B | Same key sent to backup PSP generates distinct `pspRef`; duplicate payment detection flags the anomaly. |
| **6. Settlement Mismatch** | `settlementMismatch: true` | Settlement feed omits records; discrepancy detection identifies missing batch settlements. |

---

## Environment Configuration

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `PSP_URL` / `PSP_A_URL` | `http://localhost:4001` | URL for Primary PSP A |
| `PSP_B_URL` | `http://localhost:4002` | URL for Failover PSP B |
| `BANK_URL` | `http://localhost:4003` | URL for Mock Core Bank |
| `WEBHOOK_SECRET` | `dev-secret-psp-a` | Secret for HMAC signature generation and validation |

To run tests against remote deployments:
```bash
PSP_URL=https://psp-a.example.com BANK_URL=https://bank.example.com corepack pnpm test
```

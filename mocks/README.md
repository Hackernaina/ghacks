# Mock Services — PSPs & Bank

Mock payment infrastructure for simulating external financial entities, payment flows, asynchronous webhooks, settlement batches, and real-world network/operational faults.

---

## Overview

The mock suite contains two independent microservices built with **Fastify**:
1. **Mock PSP (`@reconcile/mock-psp`)**: Simulates dual Payment Service Providers (**PSP A** on `:4001` and **PSP B** on `:4002`). Supports idempotent payment creation, state polling, HMAC-signed webhook delivery, settlement batch feeds, and controllable fault injection.
2. **Mock Bank (`@reconcile/mock-bank`)**: Simulates core banking rail on `:4003`. Supports direct debit processing and settlement statement feeds (`GET /statements`).

```
                     ┌──────────────────┐
                     │ Merchant Backend │
                     └──────┬─────┬─────┘
                            │     │
            POST /v1/payments     POST /debit
            GET  /v1/settlements  GET  /statements
                            │     │
            ┌───────────────▼┐   ┌▼────────────────┐
            │ Mock PSP A / B │   │    Mock Bank    │
            │  (:4001/:4002) │   │     (:4003)     │
            └───────┬────────┘   └─────────────────┘
                    │ (async HMAC webhook)
                    ▼
          /webhooks/{psp_id}
```

---

## Service Specifications

### Default Ports & Identifiers

| Service | Port | Default Identifier | Default Webhook Secret |
| :--- | :--- | :--- | :--- |
| **Mock PSP A** | `4001` | `psp_a` | `dev-secret-psp-a` |
| **Mock PSP B** | `4002` | `psp_b` | `dev-secret-psp-b` |
| **Mock Bank**  | `4003` | `bank`  | N/A |

---

## 1. Mock PSP API (`:4001` / `:4002`)

### `POST /v1/payments`
Creates a payment attempt or returns an existing payment if the idempotency key matches.
* **Headers**: `Idempotency-Key: <orderId>:<attempt>` (e.g. `order-123:1`)
* **Request Body**:
  ```json
  {
    "orderId": "ord_1001",
    "amount": 50000,
    "currency": "INR",
    "merchantPaymentId": "pay_1001",
    "customerId": "cust_1001"
  }
  ```
* **Response `200 OK`**:
  ```json
  {
    "pspRef": "pa_a1b2c3d4",
    "idempotencyKey": "ord-123:1",
    "status": "SUCCEEDED",
    "amount": 50000,
    "currency": "INR",
    "createdAt": "2026-09-27T02:00:00.000Z"
  }
  ```
* **Asynchronous Webhook Trigger**: Upon successful creation, fires an HMAC-signed event to `$BACKEND_URL/webhooks/$PSP_ID`.

### `GET /v1/payments?idempotency_key=<key>`
Look up a payment's sync state by idempotency key.
* **Response**: Stored `PspPaymentResponse` or `404 { "error": "NOT_FOUND" }`.

### `GET /v1/settlements?since=<ISO_TIMESTAMP>`
Returns settled transaction lines in CSV format for reconciliation.
* **Headers**: `Content-Type: text/csv; charset=utf-8`
* **CSV Columns**:
  `batch_id,line_no,psp_ref,idempotency_key,order_id,amount,currency,status,settled_at`

### `POST /admin/faults`
Inject operational faults into the PSP mock runtime.
```json
{
  "dropPercent": 0,
  "webhookDelayMs": 0,
  "duplicatePercent": 0,
  "reorderWebhooks": false,
  "settlementMismatch": false,
  "bypassIdempotency": false
}
```

### `POST /admin/reset`
Clears in-memory idempotency records, settlement logs, and resets faults to default.

---

## 2. Webhook Dispatcher

When a payment is created, the PSP asynchronously dispatches a webhook to the backend ingestion endpoint:
* **Target URL**: `${BACKEND_URL:-http://localhost:3000}/webhooks/${PSP_ID}`
* **Headers**: `X-Signature: <hex(HMAC_SHA256(secret, rawBody))>`
* **Payload**:
  ```json
  {
    "eventId": "evt_9f8e7d6c",
    "type": "payment.succeeded",
    "createdAt": "2026-09-27T02:00:00.000Z",
    "data": {
      "pspRef": "pa_a1b2c3d4",
      "idempotencyKey": "ord-123:1",
      "orderId": "ord_1001",
      "amount": 50000,
      "currency": "INR",
      "status": "SUCCEEDED"
    }
  }
  ```
* **Delivery Guarantees**: Retries up to 3 times with exponential backoff on non-2xx responses.

---

## 3. Mock Bank API (`:4003`)

### `POST /debit`
Records a direct account debit corresponding to a settlement reference.
* **Request Body**:
  ```json
  {
    "amount": 50000,
    "currency": "INR",
    "psp_ref": "pa_a1b2c3d4"
  }
  ```
* **Response `200 OK`**:
  ```json
  {
    "bankRef": "bnk_12345678"
  }
  ```

### `GET /statements?since=<ISO_TIMESTAMP>`
Exports bank account statement records in CSV format.
* **Headers**: `Content-Type: text/csv; charset=utf-8`
* **CSV Columns**:
  `statement_id,line_no,psp_ref,amount,currency,type,credited_at`

---

## Fault Injection Reference

The mocks support programmatic fault injection via `POST /admin/faults` to test edge cases:

| Fault Flag | Type | Description |
| :--- | :--- | :--- |
| `dropPercent` | `number` (0–100) | Probabilistically returns `503 Service Unavailable` on payment creation to simulate network drop / timeout. |
| `webhookDelayMs` | `number` (ms) | Delays outgoing webhook dispatch to simulate late asynchronous confirmation. |
| `duplicatePercent` | `number` (0–100) | Probabilistically duplicates the outgoing webhook (same `eventId`) after 2 seconds. |
| `bypassIdempotency` | `boolean` | Purges idempotency keys to simulate PSP-side cache eviction, testing double-charge detection. |
| `settlementMismatch`| `boolean` | Drops ~30% of settlement records to simulate batch omission and trigger reconciliation discrepancies. |

---

## Running the Mocks

### Prerequisites
* Node.js 20+
* pnpm 9+

### Build
From project root:
```bash
corepack pnpm --filter @reconcile/mock-psp build
corepack pnpm --filter @reconcile/mock-bank build
```

### Start Services

**Mock PSP A (Port 4001):**
```powershell
$env:PSP_ID="psp_a"; $env:PORT="4001"; $env:WEBHOOK_SECRET_PSP_A="dev-secret-psp-a"; node mocks/psp/dist/index.js
```

**Mock PSP B (Port 4002):**
```powershell
$env:PSP_ID="psp_b"; $env:PORT="4002"; $env:WEBHOOK_SECRET_PSP_B="dev-secret-psp-b"; node mocks/psp/dist/index.js
```

**Mock Bank (Port 4003):**
```powershell
$env:PORT="4003"; node mocks/bank/dist/index.js
```

---

## Integration with the backend

These changes were made while wiring the mocks to the backend, `pnpm dev` and `docker-compose`.

| Change | Why |
| :--- | :--- |
| **`POST /v1/refunds`** (PSP) | It is part of the shared contract (§2). It is idempotent by `Idempotency-Key` (the backend sends `refund:<pspRef>`), returns `{ refundRef, pspRef, status, amount }`, and fires a `payment.refunded` webhook with `status: "REFUNDED"`. An unknown `pspRef` or an invalid amount returns `422`. |
| **Payout to the bank** (PSP) | Each settlement line is also posted to `${BANK_URL}/debit` (default `http://localhost:4003`; set `BANK_URL=` to disable), so it appears as a `CREDIT` on the bank statement feed. Before this, nothing ever called `/debit` in the payment flow, so the backend never saw bank evidence. |
| **Stable bank line numbers** (bank) | `line_no` is now assigned once when a debit is recorded. It used to be the row's index in the filtered response, so the same credit got a different number depending on `since`. The backend then dropped a new credit as a duplicate of an old one. |
| **Unique batch and statement IDs** (PSP and bank) | Batch IDs are `stl_<date>_<bootId>` and statement IDs are `stmt_<date>_<bootId>`, with a new `bootId` each time the process starts. In-memory counters restart at 1, but the backend's database doesn't, so a restarted mock re-issued an ID the backend had already stored. |

The fault flags above are unchanged, and the dashboard's fault panel uses them. `reorderWebhooks` is accepted but not implemented yet.

### Running with the backend

```bash
pnpm dev             # Postgres + these three mocks + backend (webhooks go to :3000)
pnpm test:mocks      # builds and starts the mocks, runs tests/vitest against them, stops them
COMPOSE_PARALLEL_LIMIT=1 docker-compose --profile stack up --build   # everything in containers
```

One image, `mocks/Dockerfile`, runs either service: set `SERVICE=psp` (with `PSP_ID`, `PORT`, `WEBHOOK_SECRET`, `BACKEND_URL`, `BANK_URL`) or `SERVICE=bank` (with `PORT`).

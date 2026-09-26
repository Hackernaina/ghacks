# Shared contracts

This is the single source of truth for everything that crosses a team
boundary. The TypeScript types and zod schemas in [`src/`](src/) are the
normative definitions; this document explains them. If the two ever disagree,
the code wins. Please fix the doc.

```ts
import { WebhookPayload, PaymentView, EVIDENCE_SOURCE_TRUST } from "@reconcile/shared";

const payload = WebhookPayload.parse(json); // runtime validation + static type
```

Add it to a workspace package with `"@reconcile/shared": "workspace:*"`, then
run `pnpm --filter @reconcile/shared build`.

**Conventions (all contracts)**

- **Money is always integer minor units (paise).** `150000` = ₹1,500.00. Never a float, never a string.
- Currency is a 3-letter ISO code (`"INR"`).
- Timestamps are ISO-8601 with an offset, e.g. `2026-09-27T10:02:14.000Z`.
- IDs are opaque strings. Our own IDs are UUIDs.

Contents: [Enums](#1-enums) · [PSP API](#2-psp-api) · [Webhooks](#3-webhooks) ·
[Settlement CSV](#4-settlement-csv) · [Bank CSV](#5-bank-statement-csv) ·
[Vendor API](#6-vendor-public-api) · [Admin API + timeline](#7-admin-api) ·
[DB schema](#8-database-schema) · [Open questions](#9-open-questions)

---

## 1. Enums

Defined in [`src/enums.ts`](src/enums.ts).

### `PaymentState`

| State | Meaning |
| --- | --- |
| `CREATED` | Row written, nothing sent to the PSP yet |
| `PENDING` | Request in flight to the PSP |
| `UNKNOWN` | We don't know: timeout, 5xx, network error, or PSP says `PROCESSING`/`NOT_FOUND`. **Not a failure.** |
| `SUCCEEDED` | Evidence says the customer was charged |
| `FAILED` | Evidence says the charge definitively did not happen |
| `SETTLED` | Succeeded and appears in a PSP settlement file |
| `REFUNDED` | Fully refunded |

`CREATED`, `PENDING` and `UNKNOWN` are the backend's own belief states. The
other four are always derived from evidence.

### `EvidenceSource` and trust

When sources disagree, the higher trust wins. Ties go to the latest `observedAt`.

| Source | Trust | Where it comes from |
| --- | --- | --- |
| `MANUAL` | 100 | An operator resolving a review case |
| `BANK_STATEMENT` | 95 | Bank statement CSV line |
| `SETTLEMENT` | 90 | PSP settlement CSV line |
| `STATUS_QUERY` | 70 | `GET /v1/payments?idempotency_key=` result |
| `WEBHOOK` | 60 | PSP webhook |
| `SYNC_RESPONSE` | 50 | The direct response to `POST /v1/payments` |

Exported as `EVIDENCE_SOURCE_TRUST`.

### Others

| Enum | Values |
| --- | --- |
| `ReportedStatus` (what a piece of evidence claims) | `SUCCEEDED` `FAILED` `PROCESSING` `NOT_FOUND` `SETTLED` `CREDITED` `REFUNDED` |
| `Confidence` | `HIGH` `MEDIUM` `LOW` |
| `CaseType` | `CONFLICT` `AMOUNT_MISMATCH` `UNRESOLVED` `SETTLED_BUT_FAILED` `SETTLEMENT_MISSING` `BANK_NOT_CREDITED` `DOUBLE_CHARGE` `SUSPECTED_DUPLICATE` `ORPHAN` |
| `CaseStatus` | `OPEN` `RESOLVED` |
| `CaseResolution` | `MARK_SUCCEEDED` `MARK_FAILED` `REFUND` `DISMISS` |
| `LedgerEntryType` | `CAPTURE` (+) `REFUND` (−) `REVERSAL` (−) |
| `PspId` | `psp_a` `psp_b` |

- **Success-class** statuses (`SUCCESS_CLASS_STATUSES`) are `SUCCEEDED`, `SETTLED` and `CREDITED`.
- **Terminal** statuses (`TERMINAL_STATUSES`) are the success-class ones plus `FAILED` and `REFUNDED`.
- `PROCESSING` and `NOT_FOUND` are never terminal.

---

## 2. PSP API

**Implemented by:** Person A's mocks (PSP A on `:4001`, PSP B on `:4002`) and
the backend's stub PSP. **Called by:** the backend. Both PSPs have the same API.
Schemas are in [`src/psp-api.ts`](src/psp-api.ts).

### `POST /v1/payments` — create a charge

Header `Idempotency-Key: <orderId>:<attempt>` (required).

```json
{ "amount": 150000, "currency": "INR", "orderId": "…uuid…",
  "merchantPaymentId": "…payment uuid…", "customerId": "cust_1" }
```

| Response | Body | Meaning |
| --- | --- | --- |
| `200` | `PspPaymentResponse` (below) | Accepted. `status` may be `SUCCEEDED`, `FAILED` or `PROCESSING` |
| `422` | `{ "error": "…", "message": "…" }` | Definitive validation rejection. The backend records it as `FAILED` |
| `5xx` / timeout / dropped connection | — | The backend treats it as `UNKNOWN` and polls. It never re-POSTs on its own |

```json
{ "pspRef": "pa_7f3c…", "idempotencyKey": "…:1", "status": "SUCCEEDED",
  "amount": 150000, "currency": "INR", "createdAt": "2026-09-27T10:02:13.000Z" }
```

**Idempotency rule:** the same key must return the same response and must not
create a new transaction. The `bypassIdempotency` fault deliberately breaks this.

### `GET /v1/payments?idempotency_key=K` — status query

- `200` returns the same `PspPaymentResponse` shape.
- `404` returns `{ "error": "NOT_FOUND" }`. The backend never treats `NOT_FOUND` as `FAILED`.

### `POST /v1/refunds`

Header `Idempotency-Key: refund:<pspRef>`. Body `{ "pspRef": "…", "amount": 150000 }`.
Response: `{ "refundRef", "pspRef", "status", "amount" }`.

### `GET /v1/settlements?since=<ISO>` — settlement file

Returns CSV. See [§4](#4-settlement-csv).

---

## 3. Webhooks

**Sent by:** the PSP mocks. **Received at:** `POST {BACKEND}/webhooks/psp_a` or `/webhooks/psp_b`.

**Signature:** header `X-Signature: hex(HMAC_SHA256(secret, rawBody))`. It is
computed over the **exact raw bytes** sent, so don't re-serialise the JSON
after signing. Secrets come from `WEBHOOK_SECRET_PSP_A` / `WEBHOOK_SECRET_PSP_B`.
The dev defaults are `dev-secret-psp-a` / `dev-secret-psp-b`.

```json
{
  "eventId": "evt_91b2…",
  "type": "payment.succeeded",
  "createdAt": "2026-09-27T10:02:40.000Z",
  "data": {
    "pspRef": "pa_7f3c…", "idempotencyKey": "…:1", "orderId": "…uuid…",
    "amount": 150000, "currency": "INR", "status": "SUCCEEDED"
  }
}
```

| `type` | `data.status` |
| --- | --- |
| `payment.succeeded` | `SUCCEEDED` |
| `payment.failed` | `FAILED` |
| `payment.refunded` | `REFUNDED` |

**Delivery semantics:**

- Delivery is at-least-once. Webhooks may be delayed, duplicated or reordered.
- **`eventId` is the dedup key.** A redelivery must reuse the same `eventId`. A new `eventId` means a new event.
- `createdAt` is when the event happened at the PSP, not when it was sent. Reordering must keep the true `createdAt`.

**Backend responses:**

| Code | When |
| --- | --- |
| `200` | Stored, **including duplicates** |
| `401` | Bad signature |
| `400` | Invalid payload |
| `5xx` | Database write failed. Retry |

---

## 4. Settlement CSV

`GET /v1/settlements?since=<ISO>` on each PSP returns lines with `settled_at >= since`.
Schema: `SettlementLine`.

```csv
batch_id,line_no,psp_ref,idempotency_key,order_id,amount,currency,status,settled_at
stl_20260927_01,1,pa_7f3c…,…:1,…uuid…,150000,INR,SETTLED,2026-09-27T10:30:00.000Z
```

- **`(batch_id, line_no)` identifies a line uniquely and must never change.** The backend deliberately re-reads overlapping windows.
- `status` is always `SETTLED`. `amount` is in paise.
- The `settlementAmountDelta` fault skews `amount` to test mismatch detection.

## 5. Bank statement CSV

`GET /statements?since=<ISO>` on the bank mock (`:4003`) returns lines with
`credited_at >= since`. Schema: `BankStatementLine`.

```csv
statement_id,line_no,psp_ref,amount,currency,type,credited_at
stmt_20260927,1,pa_7f3c…,150000,INR,CREDIT,2026-09-27T11:00:00.000Z
```

`(statement_id, line_no)` is the stable dedup key. `type` is always `CREDIT`.

---

## 6. Vendor public API

**Implemented by:** the backend (`:3000`). **Used by:** the checkout UI. Schemas
are in [`src/vendor-api.ts`](src/vendor-api.ts).

| Method + path | Body | Returns |
| --- | --- | --- |
| `POST /orders` | `{ customerId, amount, currency }` | `OrderView` |
| `GET /orders/:orderId` | — | `{ order: OrderView, payments: PaymentView[] }` |
| `POST /orders/:orderId/pay` | `{ psp?: "psp_a" \| "psp_b" }` | `PaymentView`. A double click returns the existing active payment |
| `GET /payments/:id` | — | `PaymentView` |
| `GET /payments/:id/stream` | — | SSE. Event `payment` carries a `PaymentView` on every change. Heartbeat every 15s |

```ts
PaymentView = {
  id, orderId, attempt,            // attempt starts at 1; a retry after FAILED is attempt 2
  psp: "psp_a" | "psp_b",
  pspRef: string | null,           // null until the PSP tells us
  amount, currency,
  state: PaymentState,
  confidence: Confidence | null,
  reason: string | null,           // one human-readable sentence, e.g.
                                   // "SUCCEEDED (HIGH): status query 10:02:14 and webhook 10:02:40 agree; sync response was lost (timeout)."
  updatedAt
}
OrderView = { id, customerId, amount, currency, createdAt }
```

`POST /orders/:orderId/pay` returns straight away, often with state `PENDING`
or `UNKNOWN`. Subscribe to the stream to follow it.

---

## 7. Admin API

**Implemented by:** the backend. **Used by:** the admin dashboard.

| Method + path | Returns |
| --- | --- |
| `GET /admin/payments?state=&limit=50&cursor=` | `{ items: PaymentView[], nextCursor: string \| null }`. `limit` is at most 200 |
| `GET /admin/payments/:id` | `PaymentDetailView`, which includes the **timeline** (below) |
| `GET /admin/review?status=OPEN\|RESOLVED` | `ReviewCaseView[]` |
| `POST /admin/review/:id/resolve` | Body `{ resolution: CaseResolution, note? }` |
| `GET /admin/invariants` | `{ ok, checks: [{ name, ok, details: unknown[] }] }` |
| `GET /admin/stats` | `{ byState, openCasesByType, totalEvidence, duplicatesSuppressed }` |
| `GET /healthz` / `GET /readyz` | `{ ok }` (`readyz` returns 503 if the DB is unreachable or migrations are pending) |

### The timeline — `GET /admin/payments/:id`

```ts
PaymentDetailView = {
  payment:  PaymentView,
  evidence: EvidenceView[],     // ← the timeline, sorted ascending by observedAt
  ledger:   LedgerEntryView[],
  cases:    ReviewCaseView[],
}

EvidenceView = {
  id,
  source: EvidenceSource,       // who said it
  trust: number,                // 50–100, see §1
  reportedStatus: ReportedStatus,
  pspRef: string | null,
  amount: number | null,        // paise; compare to payment.amount to spot mismatches
  observedAt: string,           // when it happened (webhook createdAt, settled_at, first poll with this answer…)
  receivedAt: string,           // when we stored it; receivedAt ≫ observedAt means it arrived late
  duplicateCount: number,       // extra deliveries suppressed; show "delivered N+1×, counted once"
  raw: unknown,                 // original payload or CSV line, for a "show raw" toggle
}

LedgerEntryView = { id, paymentId, orderId, pspRef, entryType, amount /* signed */, createdAt }

ReviewCaseView = {
  id, caseType, paymentId | null, orderId | null,   // ORPHAN cases have no payment
  status: "OPEN" | "RESOLVED",
  summary, suggestedAction | null,
  resolution | null, note | null,
  createdAt, resolvedAt | null,
}
```

How to render the timeline:

- Show one row per evidence item, in array order.
- Show the source badge and trust.
- Mark rows whose status class disagrees with `payment.state` (success vs failed). That is where conflicts come from.
- Flag late arrivals, where `receivedAt` is well after `observedAt`.
- Show `duplicateCount` when it is above 0.
- Put `payment.reason` at the top as the verdict.
- Ledger rows and cases go alongside.
- Identical repeated status polls collapse into one row with a raised `duplicateCount`. A changed answer gets a new row.

What each review case type means, for the dashboard:

| Case | Meaning | Typical action |
| --- | --- | --- |
| `CONFLICT` | Trusted sources disagree on success vs failure | Check the evidence, then mark succeeded or failed |
| `AMOUNT_MISMATCH` | Some evidence has a different amount | Investigate |
| `UNRESOLVED` | Deadline passed with no terminal evidence | Mark succeeded or failed |
| `SETTLED_BUT_FAILED` | Money settled for a payment we thought failed | Fulfil the order or refund |
| `SETTLEMENT_MISSING` | Succeeded but never settled within the window | Chase the PSP |
| `BANK_NOT_CREDITED` | Settled but the bank never credited it | Chase the bank |
| `DOUBLE_CHARGE` | Two real charges for one order | Refund the later one |
| `SUSPECTED_DUPLICATE` | Same customer and amount on another order within 2 min | Review only |
| `ORPHAN` | Evidence that matches no payment | Investigate |

After `POST /admin/review/:id/resolve`, the backend records `MANUAL` evidence
(trust 100) and re-derives the payment. The new state arrives over SSE a
moment later, not in the response.

---

## 8. Database schema

**Owned by:** the backend. **Postgres 16.** Only the backend reads and writes
it; mocks and frontend go through the HTTP APIs above. It's documented here so
everyone understands what the admin views are built from. The source of truth
is [`backend/migrations/`](../backend/migrations/).

**`orders`** — `id uuid pk`, `customer_id`, `amount bigint`, `currency`, `created_at`.

**`payments`** — one row per attempt.

- `id uuid pk`, `order_id → orders`, `attempt int`, `psp`
- `idem_key text UNIQUE` (`${orderId}:${attempt}`)
- `psp_ref null`, `amount bigint`, `currency`
- `state`, `confidence null`, `reason null`
- Polling bookkeeping: `next_check_at`, `deadline_at`, `not_found_since`, `poll_count`
- `version` (optimistic lock), `created_at`, `updated_at`
- Partial unique index: **one active (non-FAILED) payment per order**.

**`evidence`** — append-only. Only `duplicate_count` and `payment_id` are ever updated.

- `id uuid pk`, `source`, `source_event_id`, `payment_id null → payments`
- `psp`, `psp_ref`, `idem_key`, `order_id`
- `reported_status`, `amount bigint null`, `currency null`
- `observed_at`, `received_at`, `duplicate_count int`, `raw jsonb`
- **`UNIQUE (source, source_event_id)`** is the dedup key:

| Source | `source_event_id` |
| --- | --- |
| `WEBHOOK` | payload `eventId` |
| `SYNC_RESPONSE` | `sync:${idemKey}:${requestSeq}` |
| `STATUS_QUERY` | `poll:${idemKey}:${sha256(status+pspRef+amount)}` |
| `SETTLEMENT` | `${batch_id}:${line_no}` |
| `BANK_STATEMENT` | `${statement_id}:${line_no}` |
| `MANUAL` | `manual:${caseId}` |

**`ledger_entries`**

- `id`, `payment_id`, `order_id`, `psp_ref`, `entry_type`, `amount` (signed bigint), `created_at`
- **`UNIQUE (psp_ref, entry_type)`**, so a charge can never be captured twice.

**`review_cases`**

- `id`, `payment_id null`, `order_id null`, `case_type`, `status`, `summary`, `suggested_action`
- `evidence_snapshot jsonb`, `resolution`, `note`, `dedupe_key`, `created_at`, `resolved_at`
- Partial unique `(dedupe_key) WHERE status = 'OPEN'`. `dedupe_key` is `${caseType}:${paymentId}`, or `ORPHAN:${pspRef}` for orphans.

**`ingest_cursors`** — `name pk`, `cursor`, `updated_at`. One row per CSV poller.

---

## 9. Open questions

Settle these in the hour-0 sync. Update this section when they're decided.

1. **Refund status values.** `PspRefundResponse.status` currently reuses `SUCCEEDED | FAILED | PROCESSING`. Is that enough for the mock?
2. **Timeline extras.** Should `EvidenceView` also expose `sourceEventId` and `currency`? It would help debugging in the dashboard. This is an additive change.
3. **Mock admin endpoints.** The fault flag names are listed in [`mocks/README.md`](../mocks/README.md). Should their shapes live in `/shared` so the dashboard can toggle faults?

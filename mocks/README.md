# Mocks — PSP A, PSP B, bank (Person A)

These mock services exist so the backend can be tested against realistic
failures. **The contracts you implement are in
[`shared/README.md`](../shared/README.md) §2–§5.** Import the zod schemas from
`@reconcile/shared` so your payloads can't drift from the contract.

## What to build

| Service | Port | Endpoints |
| --- | --- | --- |
| PSP A | 4001 | `POST /v1/payments`, `GET /v1/payments?idempotency_key=`, `POST /v1/refunds`, `GET /v1/settlements?since=` |
| PSP B | 4002 | Same as PSP A. It can be the same code with a different config: `pspId=psp_b`, refs prefixed `pb_` |
| Bank | 4003 | `GET /statements?since=` |

The PSPs also **send** signed webhooks to the backend:

```
POST {CALLBACK_URL}/webhooks/psp_a          # or /webhooks/psp_b
X-Signature: hex(HMAC_SHA256(secret, rawBody))
```

- Default `CALLBACK_URL` is `http://localhost:3000`.
- Secrets are `dev-secret-psp-a` and `dev-secret-psp-b`. Keep them overridable by env.

## Behaviour that must be right

- **Idempotency.** The same `Idempotency-Key` returns the same response and creates no new `pspRef`, unless `bypassIdempotency` is on.
- **`eventId` is stable across redeliveries.** Duplicates reuse it. A genuinely new event gets a new one.
- **`createdAt` is the real event time.** It must be preserved when events are delayed or reordered.
- **CSV line identity is stable.** `(batch_id, line_no)` and `(statement_id, line_no)` must not change between requests. The backend re-reads overlapping windows and relies on this.
- **The settlement → bank flow is realistic.** Every settled `psp_ref` eventually shows up as a bank `CREDIT`, unless a fault says otherwise.
- **Money is integer paise.**

## Fault injection

Toggle faults at runtime with `POST /admin/faults` (JSON, partial updates).
Use these names. The backend's stub PSP uses the same ones, so tests and demo
scripts work against both.

| Flag | Effect | Scenario it tests |
| --- | --- | --- |
| `dropResponse: boolean` | Process the payment, then hang or close without responding | Lost sync response → backend polls and recovers |
| `webhookDuplicates: number` | Send each webhook N times with the same `eventId` | Dedup (ledger stays at 1 capture) |
| `webhookDelayMs: number` | Delay webhook delivery | Late webhooks |
| `webhookReorder: boolean` | Send `payment.failed` then `payment.succeeded`, with correct `createdAt`s | Out-of-order delivery |
| `bypassIdempotency: boolean` | A repeated key creates a new `pspRef` | Double charge detection |
| `notFoundForMs: number` | Status query returns 404 for this long after creation | NOT_FOUND grace period |
| `settlementAmountDelta: number` | Add this many paise to settlement amounts | Amount mismatch |

Ideas beyond the minimum, if you have time:

- `failRate` / `status5xxRate`
- `settlementSkip` (for SETTLEMENT_MISSING)
- `bankSkip` (for BANK_NOT_CREDITED)
- `settleFailedPayment` (for SETTLED_BUT_FAILED)
- a `POST /admin/reset` endpoint

If you add flags, tell Person C so the dashboard can expose them.

## Stack and setup

Use Node 20, TypeScript, Fastify and zod, the same stack as the backend.
In-memory state is fine.

1. Add `"mocks"` (or `"mocks/*"` if you make one package per service) to
   [`pnpm-workspace.yaml`](../pnpm-workspace.yaml).
2. Add `"@reconcile/shared": "workspace:*"` to your `package.json`.

```bash
pnpm install
pnpm --filter @reconcile/shared build
```

Until your mocks are ready, the backend develops against its own minimal stub
in `backend/dev/stub-psp`. Yours replaces it for the demo, so match the
contract exactly.

## Checking your mock against the backend

1. Run the backend (see the [root README](../README.md)) with `PSP_A_URL=http://localhost:4001`.
2. `POST /orders`, then `POST /orders/:id/pay`.
3. Open `GET /admin/payments/:id`. You should see your `SYNC_RESPONSE` and `WEBHOOK` evidence in the timeline.
4. A `401` from `/webhooks/psp_a` means the signature is wrong. Sign the exact bytes you send.

# Vendor backend

Works out the most likely final state of every payment from whatever evidence
has arrived: sync responses, webhooks, status polls, settlement files, bank
statements and operator decisions. Contracts are in
[`shared/README.md`](../shared/README.md). The non-negotiable rules are in
[`CLAUDE.md`](CLAUDE.md).

## Run

```bash
pnpm install
pnpm dev          # Postgres + mock PSP A :4001 + mock PSP B :4002 + mock bank :4003 + backend :3000
```

`pnpm dev` does four things:

- starts Postgres
- builds `/shared` and applies migrations
- runs Person A's three mocks, with webhooks pointed at this backend
- runs the backend in watch mode, with `ROLE=all` so the API and the worker share one process

It reads `backend/.env` if present, and every variable has a working default.

`STUB=1 pnpm dev` runs the backend's own stub PSPs instead (`dev/stub-psp`).
Stub PSP A also serves `/statements`, so in that mode it acts as the bank and
`BANK_URL` points at it. The stubs also back `pnpm test:int`, because their faults
are deterministic (for example, `dropResponse` processes the charge and then drops
the connection). Person A's `dropPercent` is random and fails before processing.

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm migrate` | Apply pending migrations (`migrations/NNN_name.sql`, tracked in `schema_migrations`) |
| `pnpm seed` | Insert a few demo orders |
| `pnpm dev:api` | Backend only, in watch mode, against whatever PSPs the env points at |
| `pnpm --filter @reconcile/stub-psp dev` | One stub PSP. Set it up with `PSP_ID`, `PORT`, `WEBHOOK_SECRET`, `CALLBACK_URL` and `FAULTS` (JSON) |

## Test

```bash
pnpm test         # resolver scenario tests + fast-check property tests (no DB, no network)
pnpm test:int     # end-to-end: real Postgres + real API + worker + stub PSP
```

`test:int` uses `TEST_DATABASE_URL`, which defaults to
`postgres://reconcile:reconcile@localhost:5433/reconcile_test`. It creates the
database if it is missing, migrates it, and truncates it between tests. It never
touches the dev database.

### Scenarios covered

**Resolver unit tests** ([`test/resolver.test.ts`](test/resolver.test.ts)):

| Scenario | Expected outcome |
| --- | --- |
| Happy path | SUCCEEDED HIGH, one CAPTURE |
| Lost sync response, status query SUCCEEDED | SUCCEEDED |
| Webhook delivered 50× | One CAPTURE; the reason says so |
| Late FAILED webhook after a SUCCEEDED status query | SUCCEEDED + CONFLICT |
| Out-of-order webhooks | Same result as in order |
| NOT_FOUND within the grace period | Still UNKNOWN |
| NOT_FOUND after the grace period | RESEND_SAME_KEY |
| Deadline passed with no terminal evidence | UNRESOLVED case |
| Settlement while FAILED | SETTLED_BUT_FAILED |
| Settlement amount mismatch | AMOUNT_MISMATCH, LOW, no CAPTURE |
| Idempotency bypassed | Two CAPTUREs + DOUBLE_CHARGE |
| Failover to PSP B | DOUBLE_CHARGE on the later attempt |
| Manual MARK_FAILED | REVERSAL |
| No settlement within the window | SETTLEMENT_MISSING |
| No bank credit within the window | BANK_NOT_CREDITED |
| Full refund | REFUNDED |
| Refunding the duplicate charge | Clears DOUBLE_CHARGE |
| Same customer and amount on another order | SUSPECTED_DUPLICATE |

**Property tests** ([`test/resolver.property.test.ts`](test/resolver.property.test.ts)):

- The output is identical after shuffling the evidence or duplicating any rows.
- There is exactly one CAPTURE per distinct successful `pspRef`.
- A payment is never FAILED without a FAILED claim.
- A FAILED payment never has a positive ledger balance.

**Integration tests** ([`test/flows.int.test.ts`](test/flows.int.test.ts)):

- happy path
- double click on Pay
- 50 duplicate webhooks (1 evidence row, `duplicate_count` 49, 1 CAPTURE)
- lost response recovered by polling
- reordered webhooks
- bypassed idempotency → DOUBLE_CHARGE
- settlement CSV re-imported twice
- manual MARK_FAILED → REVERSAL
- webhook signature and validation checks
- the SSE stream

Every flow ends by asserting `/admin/invariants` is ok.

## How it works

```
POST /orders/:id/pay ──▶ payments row (CREATED, committed) ──▶ PSP POST ──▶ SYNC_RESPONSE evidence
POST /webhooks/:psp  ──▶ verify HMAC ──▶ WEBHOOK evidence ──┐
CSV pollers          ──▶ SETTLEMENT / BANK_STATEMENT evidence ┤ NOTIFY evidence_inserted
worker status polls  ──▶ STATUS_QUERY evidence ───────────────┤
admin resolve        ──▶ MANUAL evidence ─────────────────────┘
                                                              ▼
worker: lock payment ─▶ resolve(payment, evidence, …) ─▶ UPDATE state + ledger + cases ─▶ NOTIFY payment_updated ─▶ SSE
          (then, outside the transaction: status poll / same-key resend / auto-refund)
```

**Evidence is append-only.** Each source has a dedup key (see shared §8). A
repeat delivery only increments `duplicate_count`, which `/admin/stats` reports
as duplicates suppressed.

**`resolve()` is a pure function** ([`src/resolver/`](src/resolver/)). The same
evidence set in any order gives the same output. It has one file per rule group:

| File | What it decides |
| --- | --- |
| `claims.ts` | Normalizing evidence, trust ranking, picking the winner |
| `state.ts` | State |
| `checks.ts` | CONFLICT and AMOUNT_MISMATCH |
| `settlement.ts` | Settlement and bank windows |
| `polling.ts` | Backoff, NOT_FOUND grace, deadline |
| `confidence.ts` | Confidence |
| `duplicates.ts` | DOUBLE_CHARGE and SUSPECTED_DUPLICATE |
| `ledger.ts` | Desired postings |
| `reason.ts` | The one-sentence explanation |

**Only the worker writes derived state.** It runs `resolve()` inside a short
transaction and holds a row lock (`FOR UPDATE SKIP LOCKED`) plus a version
check. Ledger postings and cases are `ON CONFLICT DO NOTHING` inserts. Any HTTP
call happens after commit.

**NOTIFY is an optimization.** The sweep every `SWEEP_MS` is what makes the
system correct on its own. It picks up:

- due payments
- payments with evidence newer than their last resolution
- orphan evidence

Payments due before the next sweep also get an in-process timer.

**Uncertainty is never failure:**

- A timeout, 5xx or dropped connection makes the payment `UNKNOWN`, and the worker polls `GET /v1/payments?idempotency_key=`.
- `NOT_FOUND` starts a grace period. After it, the worker re-sends with the **same** key, once per grace period.
- At the deadline, the worker opens an `UNRESOLVED` case.

## Configuration

Every variable is listed with its default in [`.env.example`](.env.example).
`ROLE=api|worker|all` lets the backend deploy as one service or as two.

On hosted Postgres (Supabase / Neon), set `DATABASE_LISTEN_URL` to the
direct/session connection. LISTEN doesn't work through a transaction pooler.

## Docker

Build from the repo root:

```bash
docker build -f backend/Dockerfile -t reconcile-backend .
docker run -p 3000:3000 -e DATABASE_URL=postgres://… reconcile-backend
docker build -f backend/dev/stub-psp/Dockerfile -t reconcile-stub-psp .
```

The backend container applies migrations on start, then runs `ROLE` (default
`all`). The migration runner takes a Postgres advisory lock, so separate api and
worker containers can start together.

## Behaviour where the spec was silent

These are deliberate choices; change them in the named file if the team decides otherwise.

| Behaviour | Where |
| --- | --- |
| **No PSP chosen:** `POST /orders/:id/pay` without `psp` uses `psp_a`. | `api/orders.ts` |
| **A MANUAL decision doesn't open a CONFLICT case.** An operator's decision settles the conflict, so resolving one doesn't immediately re-open another. | `resolver/checks.ts` |
| **Resolved cases stay closed.** A case an operator resolved (including DISMISS) only re-opens if new evidence arrives after the resolution. | `ledger/persist.ts` |
| **REFUNDED needs every charge refunded.** A payment is REFUNDED only when *every* successful charge on it is fully refunded. With two charges and one refunded, it stays SUCCEEDED and the DOUBLE_CHARGE clears. | `resolver/state.ts`, `resolver/duplicates.ts` |
| **Partial refunds aren't amount mismatches.** Refund amounts are excluded from the AMOUNT_MISMATCH check. | `resolver/checks.ts` |
| **Unconfirmed refunds stay neutral.** A refund the PSP doesn't confirm is recorded as `PROCESSING` evidence, not as a claim about the charge. | `ingestion/outbound.ts` |
| **Orphan cases can only be dismissed.** They have no payment to mark succeeded, failed or refunded. | `api/admin.ts` |
| **Settlement keys include the PSP.** A SETTLEMENT line's dedup key is `${psp}:${batch_id}:${line_no}`, not `${batch_id}:${line_no}`, because each PSP names its own batches. With the unscoped key, PSP B's first line collided with PSP A's and was dropped as a duplicate. | `ingestion/pollers.ts` |
| **Duplicate count is derived.** "Duplicates suppressed" is `SUM(evidence.duplicate_count)`, which is exact across processes and restarts. | `api/admin-queries.ts` |
| **New payments get a check time.** A new payment's `next_check_at` is set at creation, so the sweep recovers it if the process dies before calling the PSP. | `api/orders.ts` |

**Known gap:** the schema allows one non-FAILED payment per order. Suppose attempt 1 is FAILED, attempt 2 succeeds, and later evidence shows attempt 1 succeeded after all. Moving attempt 1 out of FAILED would break that index. The worker's update then fails and is logged every sweep, and the payment stays FAILED. The DOUBLE_CHARGE case rolls back with that update, so it isn't recorded either. The resolver computes the case correctly; the index needs a team decision.

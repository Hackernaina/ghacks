# Demo script

Exact steps to demo the payment reconciliation system: a payment's state is
never set directly by a webhook or a timeout — it's derived from every piece
of evidence that arrived for it (a PSP response, a webhook, a status poll, a
settlement line, a bank credit), and that derivation survives lost responses,
duplicate/late/out-of-order webhooks, and PSP failover without ever double
counting a charge.

Every step below was run and timed in this session against the real stack
(Postgres + Person A's PSP/bank mocks + the backend + this frontend). Times
are approximate — a slow machine adds a few seconds, not minutes, except where
noted.

## 1. Start the stack (~10 seconds)

```bash
pnpm install                 # first time only
docker-compose up -d postgres
pnpm dev                     # Postgres + mock PSP A :4001 + mock PSP B :4002 + mock bank :4003 + backend :3000
```

In a second terminal:

```bash
pnpm dev:frontend            # http://localhost:5173
```

Wait for `pnpm dev`'s terminal to print `api listening` and `worker started`
(a few seconds). Then open two browser tabs:

- **Checkout:** http://localhost:5173/
- **Ops dashboard:** http://localhost:5173/#ops

### Reset to a clean slate before the demo

If this Postgres container has been used before (data persists in the `pgdata`
Docker volume across restarts), clear it so the dashboard starts empty:

```bash
psql postgres://reconcile:reconcile@localhost:5433/reconcile \
  -c "TRUNCATE ledger_entries, review_cases, evidence, payments, orders, ingest_cursors RESTART IDENTITY CASCADE"
```

Reload the Ops dashboard tab afterward. **Stats** should read all zeros,
**Invariants** should be all green, and the payments table should be empty.

---

## 2. Scenario: happy path (~1 second)

**Say:** "A normal payment — the sync response and the webhook both confirm
success, and they agree."

1. On the **Checkout** tab, leave the defaults (or set an amount) and click **Pay**.
2. The status pill flips from `Confirming…` to **SUCCEEDED** almost immediately.
3. Switch to the **Ops** tab, click the new row in the payments table.
4. Point at the **evidence timeline**: one `SYNC_RESPONSE` row and one `WEBHOOK`
   row, both `SUCCEEDED`. Confidence is **HIGH** — two independent sources agree.

---

## 3. Scenario: lost response, recovered automatically (~35-40 seconds)

**Say:** "The PSP actually processed the charge, but our HTTP response never
arrived. We don't guess — we ask the PSP directly, and if that's slow, we
retry with the *same* idempotency key so we never double-charge."

1. On **Ops**, in the **Fault injection** panel: target `psp_a`, set **drop %**
   to `100`, click **Apply**.
2. On **Checkout**, pick PSP `psp_a` explicitly and click **Pay**.
3. The payment comes back **UNKNOWN** immediately — call out that this is *not*
   FAILED. A timeout or a dropped connection is never treated as a failure.
4. Back on **Ops**, fault panel: set **drop %** back to `0`, click **Apply**.
   (Leave the payment as UNKNOWN state on screen while you talk — this is the
   moment to explain the resolver never marks it FAILED just because the PSP
   is unreachable.)
5. Wait about 30–40 seconds (the backend polls the PSP by idempotency key, and
   after a `NOT_FOUND` grace period it resends the *same* key rather than
   creating a new charge). The payment flips to **SUCCEEDED**.
6. Open its detail: the timeline shows a `STATUS_QUERY` row (several identical
   `NOT_FOUND` polls collapsed into one row with a duplicate count) followed by
   the real `WEBHOOK`/`SYNC_RESPONSE` evidence from the eventual charge. The
   reason line reads: *"no sync response recorded (lost or timed out)"*.

---

## 4. Scenario: duplicate webhook, counted once (~3 seconds)

**Say:** "The PSP is required to deliver at-least-once, so it may send the
same event several times. We store it once and never post two captures."

1. **Ops** → fault panel: target `psp_b`, **duplicate webhook %** = `100`, **Apply**.
2. **Checkout** → pick `psp_b`, click **Pay**. It settles to SUCCEEDED in a couple seconds.
3. Open the detail view: the `WEBHOOK` row shows `dup=1` (delivered twice, same
   `eventId`, counted once) and there is exactly **one** `CAPTURE` in the ledger.
4. Reset the fault: **duplicate webhook %** = `0`, **Apply**.

---

## 5. Scenario: double charge detected, then refunded (~5 seconds + one click)

**Say:** "If the PSP's own idempotency cache is ever evicted and it genuinely
processes two charges for one payment, we don't hide that — we record both
real charges and open a case for a human to refund the extra one."

This fault needs a second POST with the *same* idempotency key while the mock
has forgotten it, which only the PSP mock itself can be told to accept — the
checkout app has no "resend" button, since resending is exactly what the
backend refuses to do on its own. Trigger the second charge directly:

1. **Ops** → fault panel: target `psp_a`, check **bypass idempotency**, **Apply**.
2. **Checkout** → pay a new order on `psp_a`, note the **order id** from the
   payment detail line under the status pill.
3. In a terminal, replay the same idempotency key straight at the mock
   (this simulates the PSP accepting it as a brand-new charge):
   ```bash
   ORDER_ID=<paste the order id>
   curl -s -X POST http://localhost:4001/v1/payments \
     -H 'content-type: application/json' \
     -H "idempotency-key: ${ORDER_ID}:1" \
     -d "{\"amount\":150000,\"currency\":\"INR\",\"orderId\":\"$ORDER_ID\",\"merchantPaymentId\":\"x\",\"customerId\":\"demo\"}"
   ```
4. **Ops** → fault panel: uncheck **bypass idempotency**, **Apply**.
5. Refresh the payments table, open the payment: **two** `CAPTURE` entries in
   the ledger, and an open **DOUBLE_CHARGE** case in the review queue naming
   the later charge to refund.
6. In the **review queue**, click **Refund** on that case. Reopen the payment
   detail: a `REFUND` entry now nets the extra capture back out, and the case
   moves to resolved.

---

## 6. Settlement and bank credit (~20-30 seconds, no action needed)

**Say:** "Every charge eventually shows up in the PSP's settlement file and
then the bank's statement. We poll both and cross-check them against the
ledger."

1. Leave any successful payment from the earlier scenarios open on **Ops**.
2. Wait about 30 seconds (the CSV pollers run every `CSV_POLL_MS`, 30s by default).
3. Refresh the detail view: a `SETTLEMENT` row and then a `BANK_STATEMENT` row
   appear, and the payment's state moves from SUCCEEDED to **SETTLED**.

---

## 7. Close on invariants and stats (~5 seconds)

**Say:** "None of this is just 'trust the resolver' — here's the system
checking its own books after everything above."

1. **Ops** → **Invariants** panel: every check is green (no `pspRef` captured
   twice, every settlement has a matching capture, no order over-captured
   without an open case, no FAILED payment holding a positive balance).
2. **Stats** panel: point at **duplicates suppressed** — it now reflects every
   duplicate webhook and status poll from the scenarios above, e.g. `1` from
   scenario 4's duplicate webhook. This is the number that proves at-least-once
   delivery never became at-least-once *charging*.

---

## What's out of scope for this demo

Say this up front rather than let it come up as a surprise question:

- **Reordered webhooks** and **settlement amount mismatch** are real resolver
  behaviors with passing tests (`backend/test/resolver.test.ts`), but Person
  A's mocks don't yet have a deterministic way to trigger them on demand (the
  mock's `settlementMismatch` fault randomly *drops* ~30% of rows rather than
  altering an amount, and `reorderWebhooks` isn't implemented in the mock
  yet). The backend's own stub PSP does implement both exactly:
  ```bash
  STUB=1 pnpm dev   # then use webhookReorder / settlementAmountDelta via
                    # POST http://localhost:4001/admin/faults
  ```
  Use this in front of a technical audience who wants to see those two cases
  live; for a general demo, cite the passing test names instead.
- **Failover to a backup PSP** (marking an unresponsive attempt as failed and
  paying again on PSP B) is implemented and tested at the resolver level, but
  triggering it live means either waiting for `PAYMENT_DEADLINE_MS` (10
  minutes by default) or lowering it for the demo:
  ```bash
  PAYMENT_DEADLINE_MS=20000 pnpm dev
  ```
  With that override, an attempt with `drop %` left at 100 opens an
  **UNRESOLVED** case after ~20s; resolve it **MARK_FAILED**, then pay the
  same order again and pick `psp_b` in Checkout — the new attempt succeeds
  and, if the first charge secretly did go through, a **DOUBLE_CHARGE** case
  appears naming both attempts.
- One-click scenario buttons (as opposed to the manual fault-panel steps
  above) aren't built yet — see `frontend/README.md`.

## If something looks wrong mid-demo

- `/admin/invariants` red → open the failing check's `details`; it names the
  exact row. This is expected to stay green throughout the scripted steps above.
- A payment stuck on PENDING/UNKNOWN longer than expected → check the
  `pnpm dev` terminal for worker errors, and confirm the fault panel's last
  **Apply** actually landed (`GET http://localhost:4001/admin/faults`).
- To fully restart: stop both terminals (Ctrl+C), then repeat step 1's reset
  and start commands.

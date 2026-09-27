# Backend rules (non-negotiable)

Payment state is derived, never mutated by event handlers. Every input is stored
as append-only **evidence**; a pure function `resolve(payment, evidence[], now, config)`
decides state, confidence, reason, ledger postings, review cases and next check time.
Only the worker persists the output of `resolve()`. No webhook handler or API handler
ever sets `payments.state` directly — the only exception is the API setting
`CREATED` → `PENDING` → `UNKNOWN` around the outbound call, which are "our belief"
states, not outcomes.

1. Never mark a payment `FAILED` because of a timeout, 5xx, or connection error.
   That is `UNKNOWN`.
2. Never automatically re-POST a payment. Query status by idempotency key instead.
3. Never hold a DB transaction open across an HTTP call.
4. Webhook handlers only verify, store evidence, `NOTIFY`, and return 200 (also
   for duplicates). No business logic.
5. All money is integer minor units (paise). No floats.
6. Deduplicate messages, never money: two distinct successful `pspRef`s are two
   real charges → both are recorded and a `DOUBLE_CHARGE` case is opened.
7. `resolve()` must stay pure (no I/O, no `Date.now()`; `now` is a parameter).
8. Every ledger/review insert is `ON CONFLICT DO NOTHING` against a unique
   constraint.

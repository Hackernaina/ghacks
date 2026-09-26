# Frontend — checkout, admin dashboard, deployment (Person C)

**The APIs you consume are in [`shared/README.md`](../shared/README.md) §6
(vendor/checkout) and §7 (admin + timeline).** Import the types and zod
schemas from `@reconcile/shared`. `PaymentView.parse(json)` catches contract
drift early.

The backend runs on `http://localhost:3000`. Set the backend's `CORS_ORIGIN`
to your dev origin, e.g. `http://localhost:5173`.

## Checkout UI

1. Create an order with `POST /orders { customerId, amount, currency }`. The amount is in **paise**, so display it ÷ 100.
2. Pay with `POST /orders/:id/pay { psp? }`. The response usually comes back `PENDING` or `UNKNOWN`. That's normal.
3. Follow the payment with `new EventSource("/payments/:id/stream")` and listen for the `payment` event. On error, fall back to polling `GET /payments/:id`.
4. Show `state`, `confidence` and `reason`. Treat `UNKNOWN` as "confirming with the bank…", **not** as a failure.
5. Double-clicking Pay is safe. The backend returns the existing active payment.
6. Retry is only valid after `FAILED`. It creates `attempt + 1`, and you can pick the other PSP to demo failover.

## Admin dashboard

| Screen | Endpoint | Notes |
| --- | --- | --- |
| Payments list | `GET /admin/payments?state=&limit=&cursor=` | Filter by state. Paginate with `nextCursor` |
| Payment detail / **timeline** | `GET /admin/payments/:id` | The centrepiece. Rendering guide is in shared §7 |
| Review queue | `GET /admin/review?status=OPEN` | Group or filter by `caseType`. Show `summary` and `suggestedAction` |
| Resolve case | `POST /admin/review/:id/resolve { resolution, note }` | `MARK_SUCCEEDED`, `MARK_FAILED`, `REFUND` or `DISMISS`. The resulting state arrives over SSE |
| Health | `GET /admin/invariants` | A green/red check list. `details` holds the offending rows |
| Stats | `GET /admin/stats` | Counts by state, open cases by type, total evidence, **duplicates suppressed** (a good demo number) |

A demo control panel that toggles the mock faults (`POST /admin/faults` on the
PSP mocks) makes the scenarios easy to show live. See
[`mocks/README.md`](../mocks/README.md) for the flag names.

## Demo scenarios worth a button each

- Happy path
- Lost response (`dropResponse`)
- 50 duplicate webhooks
- Reordered webhooks
- Bypassed idempotency → DOUBLE_CHARGE
- Failover to PSP B
- Settlement amount mismatch

After each one, open the timeline and show the invariants going green.

## Deployment

The backend will ship a Dockerfile and `.env.example` (phase 7). You'll need:

- A Postgres 16 database. Local: `docker-compose up -d postgres`, port 5433. Hosted: Supabase or Neon.
  - On hosted Postgres, the backend needs **two URLs**. `DATABASE_URL` can be the pooled one. `DATABASE_LISTEN_URL` must be the direct/session connection, because LISTEN/NOTIFY doesn't work through a transaction pooler.
- The backend, reachable by the PSP mocks for webhooks at `/webhooks/:psp`.
- The mocks, reachable by the backend at `PSP_A_URL`, `PSP_B_URL` and `BANK_URL`.
- `CORS_ORIGIN` on the backend, set to the deployed frontend origin.

The full env var list is in [`backend/.env.example`](../backend/.env.example).

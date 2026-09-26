# Frontend — checkout, admin dashboard, deployment (Person C)

**The APIs you consume are in [`shared/README.md`](../shared/README.md) §6
(vendor/checkout) and §7 (admin + timeline).** Import the types and zod
schemas from `@reconcile/shared`. `PaymentView.parse(json)` catches contract
drift early.

The backend runs on `http://localhost:3000`. Set the backend's `CORS_ORIGIN`
to your dev origin, e.g. `http://localhost:5173`.

## Scaffold already in place

A working Vite + React scaffold is checked in (`src/App.tsx`, `Checkout.tsx`,
`Ops.tsx`, `api.ts`). It compiles and builds today, but it's calling backend
routes that don't exist until the backend reaches Phase 3+ (`/orders`,
`/payments`, `/admin/*`) — so until then, requests will 404. Treat it as a
head start, not a finished dashboard.

```bash
pnpm install
pnpm --filter @reconcile/shared build
pnpm --filter @reconcile/frontend dev     # http://localhost:5173, #ops for the dashboard
```

The dev server proxies `/orders`, `/payments`, `/admin`, `/webhooks`,
`/healthz`, `/readyz` to the backend (`BACKEND_URL`, default `:3000`), and
`/mock-a`, `/mock-b`, `/mock-bank` to Person A's mocks (`PSP_A_URL`,
`PSP_B_URL`, `BANK_URL`, defaults `:4001`/`:4002`/`:4003`) — see
`vite.config.ts` and `.env.example`. `api.ts` is typed against
`@reconcile/shared`, so a contract change surfaces as a type error here, not a
silent runtime mismatch.

What's there and what's left:

- **Checkout** (`Checkout.tsx`): create order → pay → subscribe to `/payments/:id/stream`, retry after `FAILED`. Works once the backend implements those routes.
- **Ops dashboard** (`Ops.tsx`): stats, invariants, review queue with resolve actions, payments table with a state filter, and a payment-detail panel with the evidence timeline, ledger and cases. This is the piece to iterate on most — the timeline rendering is intentionally minimal (see shared §7 for the fuller rendering guide: badges, "delivered N× counted once", late-arrival flags).
- **Fault injection panel** (bottom of Ops): posts directly to the mocks' `/admin/faults` (proxied via `/mock-a` / `/mock-b`). Only useful once Person A's mocks exist and implement that endpoint.
- Not built yet: demo scenario buttons (Section "Demo scenarios" below still needs real UI), deployment config for the frontend itself (see Deployment below).

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

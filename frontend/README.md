# Frontend — checkout, admin dashboard, deployment (Person C)

**The APIs you consume are in [`shared/README.md`](../shared/README.md) §6
(vendor/checkout) and §7 (admin + timeline).** Import the types and zod
schemas from `@reconcile/shared`. `PaymentView.parse(json)` catches contract
drift early.

The backend runs on `http://localhost:3000`. Set the backend's `CORS_ORIGIN`
to your dev origin, e.g. `http://localhost:5173`.

## Running it

A Vite + React app is checked in (`src/App.tsx`, `Checkout.tsx`, `Ops.tsx`,
`api.ts`). It talks to the real backend: every route it calls exists, and the
admin API endpoints are implemented in `backend/src/api/admin.ts`.

```bash
pnpm install
pnpm dev                                  # backend + Person A's mocks + Postgres (see backend/README.md)
pnpm dev:frontend                         # http://localhost:5173, #ops for the dashboard
```

The dev server proxies `/orders`, `/payments`, `/admin`, `/webhooks`,
`/healthz`, `/readyz` to the backend (`BACKEND_URL`, default `:3000`), and
`/mock-a`, `/mock-b`, `/mock-bank` to Person A's mocks (`PSP_A_URL`,
`PSP_B_URL`, `BANK_URL`, defaults `:4001`/`:4002`/`:4003`) — see
`vite.config.ts` and `.env.example`. `api.ts` is typed against
`@reconcile/shared`, so a contract change surfaces as a type error here, not a
silent runtime mismatch.

What's there and what's left:

- **Checkout** (`Checkout.tsx`) is built:
  - creates an order, pays it, and follows the stream at `/payments/:id/stream`
  - offers a retry after `FAILED`
- **Ops dashboard** (`Ops.tsx`) is built:
  - stats and invariants panels
  - the review queue, with resolve actions and each case's suggested action
  - the payments table, with a state filter
  - a detail panel showing the evidence timeline, ledger and cases

  The timeline is the piece to iterate on most. Its rendering is minimal; see shared §7 for the fuller guide (badges, "delivered N× counted once", late-arrival flags).
- **Fault injection panel** (bottom of Ops) posts Person A's flags to `/admin/faults` on PSP A or B (`dropPercent`, `duplicatePercent`, `webhookDelayMs`, `bypassIdempotency`, `settlementMismatch`). It also has a reset button (`/admin/reset`).
- **Not built yet:**
  - one-click demo scenario buttons. These depend on Person A's scenario scripts.
  - payments-list pagination in the UI. The API returns `nextCursor`.

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

What exists:

- **CI.** `.github/workflows/ci.yml` runs on every push. It builds, typechecks and runs all tests, including the integration suite against a Postgres service, and it builds both Docker images.
- **Backend image.** `backend/Dockerfile` applies migrations on start, and `/readyz` returns 200 once it's up. The full env list is in [`backend/.env.example`](../backend/.env.example).
- **Frontend.** This is a static build: `pnpm --filter @reconcile/frontend build` produces `frontend/dist`. Set these first:
  - `VITE_API_URL` to the deployed backend URL. Leave it empty if the frontend is served from the same origin as the backend.
  - `VITE_MOCK_*_URL` for the fault panel.

What's still to choose (a team decision, not built):

- **Hosting.** You need somewhere to run the backend container(s), Postgres 16 and a static host for `frontend/dist`. Once that's picked, the deploy is one extra CI job.
- **Postgres.**
  - Local: `docker-compose up -d postgres` (port 5433).
  - Hosted (Supabase or Neon): the backend needs **two URLs**. `DATABASE_URL` can be the pooled one. `DATABASE_LISTEN_URL` must be the direct/session connection, because LISTEN/NOTIFY doesn't work through a transaction pooler.
- **Wiring:**
  - The PSP mocks must reach the backend's `/webhooks/:psp`.
  - The backend must reach the mocks at `PSP_A_URL`, `PSP_B_URL` and `BANK_URL`.
  - The backend's `CORS_ORIGIN` must be the deployed frontend origin.

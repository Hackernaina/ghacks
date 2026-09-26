# ghacks — Payment Reconciliation

Works out the most likely final state of a payment when the merchant backend,
the PSP (payment service provider), webhooks and the bank disagree. It has to
survive lost responses, webhooks that arrive late, twice or out of order,
retries, and switching to a backup PSP. **A payment must never be counted twice
because an event arrived more than once.**

## Who builds what

| Folder | Owner | What it is |
| --- | --- | --- |
| [`/shared`](shared/README.md) | everyone (agreed in hour 0–1) | Contract types + zod schemas. **Single source of truth.** |
| [`/mocks`](mocks/README.md) | Person A | Mock PSP A, PSP B and bank, with fault injection |
| [`/backend`](backend/README.md) | Person B | Vendor backend: ingestion, resolver, worker, ledger, admin API |
| [`/frontend`](frontend/README.md) | Person C | Checkout UI, admin dashboard, deployment |

**Start with [`shared/README.md`](shared/README.md).** It covers every API,
payload, CSV format, enum and DB table.

## How it fits together

```
 frontend ──HTTP/SSE──▶ backend ──POST /v1/payments──▶ mock PSP A / B
                          ▲  ▲     GET  /v1/payments?idempotency_key=
                          │  │     GET  /v1/settlements (CSV)
                          │  └──── webhooks (HMAC-signed) ◀── mock PSP
                          │
                          └─────── GET /statements (CSV) ◀── mock bank
                     Postgres 16
```

The backend never sets a payment's outcome directly. Every input (a sync
response, webhook, status poll, settlement line, bank line or manual decision)
is saved as an append-only **evidence** row. A pure function then derives the
state, confidence and reason from all the evidence for that payment. That is
why the admin dashboard can show a full **timeline** explaining every state.

## Prerequisites

- Node 20+ and pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- Docker (for Postgres)

## Quick start

```bash
pnpm install
pnpm dev             # Postgres :5433 + migrations + stub PSP A :4001 + stub PSP B :4002 + backend :3000
pnpm dev:frontend    # in a second terminal: checkout at http://localhost:5173, dashboard at /#ops

pnpm test            # resolver unit + property tests
pnpm test:int        # end-to-end tests against real Postgres + stub PSP
```

Every setting has a working default. Copy `backend/.env.example` to
`backend/.env` only to override something. Until Person A's mocks exist, the
backend's stub PSPs stand in for them and support the same fault flags.

## Status

| Area | State |
| --- | --- |
| `/shared` contracts | Done |
| Backend: pay flow, webhooks, CSV pollers, resolver, worker, ledger, review cases | Done, with unit, property and integration tests. See [`backend/README.md`](backend/README.md) |
| Admin API (§3.5) + SSE | Done (in the backend) |
| Frontend checkout + ops dashboard | Working against the real API; timeline rendering and demo buttons still to polish |
| CI + Docker images | Done (`.github/workflows/ci.yml`, `backend/Dockerfile`, `backend/dev/stub-psp/Dockerfile`) |
| Person A's mocks + scenario scripts | Not started. See [`mocks/README.md`](mocks/README.md) |
| Hosting / deploy target, video | Not chosen yet |

> Postgres is exposed on host port **5433**, not 5432, so it doesn't clash with
> any local Postgres you already run. Connection string:
> `postgres://reconcile:reconcile@localhost:5433/reconcile`.

### Default ports

| Service | Port | Env var the backend reads |
| --- | --- | --- |
| Backend (vendor) | 3000 | `PORT` |
| Mock PSP A | 4001 | `PSP_A_URL` |
| Mock PSP B | 4002 | `PSP_B_URL` |
| Mock bank | 4003 | `BANK_URL` |
| Postgres | 5433 | `DATABASE_URL` |
| Frontend (dev) | 5173 | `CORS_ORIGIN` on the backend |

### Hosted Postgres (Supabase / Neon)

The backend uses `LISTEN/NOTIFY`, which needs a **direct/session** connection,
not a transaction pooler. Set `DATABASE_URL` to the pooled URL and
`DATABASE_LISTEN_URL` to the direct URL. The backend also runs a periodic sweep,
so it stays correct even if a notification is lost.

## Changing a contract

`/shared` is frozen once the team agrees on it. To change it:

1. Say so in the team chat first. Two other people are building against it.
2. Edit `shared/src/*.ts` **and** `shared/README.md` in the same PR.
3. Run `pnpm --filter @reconcile/shared build` and tell the others to pull.

## Branches

Don't commit to `main` directly. Work on a branch and open a PR.

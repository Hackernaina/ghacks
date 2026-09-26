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
| [`/backend`](backend/CLAUDE.md) | Person B | Vendor backend: ingestion, resolver, worker, ledger, admin API |
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
pnpm --filter @reconcile/shared build     # other packages import the built contracts

docker-compose up -d postgres             # Postgres 16 on localhost:5433
cp backend/.env.example backend/.env
set -a; source backend/.env; set +a
pnpm migrate                              # creates all tables
pnpm seed                                 # optional: a few demo orders
pnpm dev                                  # backend on :3000
curl localhost:3000/readyz                # {"ok":true}
```

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
| Frontend (dev) | 5173 suggested | `CORS_ORIGIN` on the backend |

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

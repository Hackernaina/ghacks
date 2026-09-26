# Payment Recon — Test Suite

Two formats. Same coverage. Drop into your monorepo at `/tests`.

## Structure

```
tests/
├── vitest/
│   ├── mock-psp.test.ts       # PSP happy path + idempotency + fault injection
│   ├── mock-bank.test.ts      # Bank happy path
│   ├── fault-scenarios.test.ts # All 6 demo scenarios as assertions
│   ├── vitest.config.ts
│   └── package.json
└── scripts/
    ├── happy-path.sh          # curl-based happy path checks
    └── scenarios.sh           # 6 one-click fault scenario runners
```

## Setup

```bash
# Install test deps
cd tests/vitest && npm install

# Make scripts executable
chmod +x tests/scripts/*.sh
```

## Running

### Vitest (TypeScript)

```bash
# All tests
cd tests/vitest && npm test

# One suite at a time
npm run test:psp
npm run test:bank
npm run test:scenarios

# Happy path only (fast pre-demo check)
npm run test:happy
```

### Shell scripts

```bash
# Happy path (quick smoke test)
./tests/scripts/happy-path.sh

# Custom URLs
./tests/scripts/happy-path.sh http://my-psp.render.com http://my-bank.render.com

# Run one fault scenario
./tests/scripts/scenarios.sh 1          # lost response
./tests/scripts/scenarios.sh 2          # duplicate webhook
./tests/scripts/scenarios.sh 3          # late webhook
./tests/scripts/scenarios.sh 4          # out-of-order
./tests/scripts/scenarios.sh 5          # failover double charge
./tests/scripts/scenarios.sh 6          # settlement mismatch

# Run all scenarios (this IS your demo script)
./tests/scripts/scenarios.sh all
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PSP_URL` / `PSP_A_URL` | `http://localhost:4001` | Mock PSP A |
| `PSP_B_URL` | `http://localhost:4002` | Mock PSP B (failover) |
| `BANK_URL` | `http://localhost:4003` | Mock Bank |
| `WEBHOOK_SECRET` | `dev-secret-psp-a` | Shared HMAC secret (plain hex X-Signature) |

```bash
PSP_URL=https://psp-a.render.com npm test
```

## What each test covers

| Test | Covers |
|---|---|
| POST /v1/payments | Basic payment creation |
| GET /v1/payments?idempotency_key=K | State query by key |
| Idempotency same key → same pspRef | Core idempotency guarantee |
| Idempotency different amount → original response | Idempotency strictness |
| dropPercent=100 | Lost response / UNKNOWN state |
| duplicatePercent=100 | Webhook dedup |
| bypassIdempotency=true | Double charge via same PSP |
| webhookDelayMs | Late webhook delivery |
| reorderWebhooks | Out-of-order state machine |
| settlementMismatch | Recon discrepancy detection |
| HMAC signing | Webhook authenticity |
| POST /debit | Bank debit |
| GET /statements?since= | Bank statement feed |

## Notes

- Tests reset faults in `beforeEach`/`afterEach` — safe to run repeatedly
- Scenario 5 (failover) requires PSP B to be running on `PSP_B_URL`
- Shell scripts work on Mac and Linux; Windows users should use WSL or the Vitest suite
- Timeout is set to 15s to accommodate fault injection delays

import type { AddressInfo } from "node:net";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { PaymentStreamHub } from "../../src/api/sse.js";
import { type Config, loadConfig } from "../../src/config/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { PAYMENT_UPDATED, PgListener } from "../../src/db/notify.js";
import { createPspClient } from "../../src/psp-client/client.js";
import { startWorker, type Worker } from "../../src/worker/index.js";
import { buildStubPsp, type StubPsp } from "../../dev/stub-psp/src/server.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://reconcile:reconcile@localhost:5433/reconcile_test";

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
  } finally {
    await client.end();
  }
}

export interface Harness {
  config: Config;
  pool: pg.Pool;
  stub: StubPsp;
  app: FastifyInstance;
  worker: Worker;
  baseUrl: string;
  stubUrl: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  await ensureDatabase(TEST_DATABASE_URL);
  await runMigrations(TEST_DATABASE_URL);

  const stub = buildStubPsp({ pspId: "psp_a", webhookSecret: "test-secret-a", callbackUrl: "http://127.0.0.1:1" });
  await stub.app.listen({ port: 0, host: "127.0.0.1" });
  const stubUrl = `http://127.0.0.1:${(stub.app.server.address() as AddressInfo).port}`;

  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    PSP_A_URL: stubUrl,
    PSP_B_URL: stubUrl,
    BANK_URL: stubUrl,
    WEBHOOK_SECRET_PSP_A: "test-secret-a",
    WEBHOOK_SECRET_PSP_B: "test-secret-b",
    PSP_TIMEOUT_MS: "1000",
    POLL_BASE_MS: "100",
    POLL_MAX_MS: "400",
    NOT_FOUND_GRACE_MS: "600",
    SWEEP_MS: "300",
    CSV_POLL_MS: "600000",
  });
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const psp = createPspClient(config);

  const listener = new PgListener(TEST_DATABASE_URL, [PAYMENT_UPDATED]);
  await listener.start();
  const app = await buildServer({ config, pool, psp, hub: new PaymentStreamHub(pool, listener) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  stub.options.callbackUrl = baseUrl;

  const worker = await startWorker({ config, pool, psp }, { pollFeeds: false });

  return {
    config,
    pool,
    stub,
    app,
    worker,
    baseUrl,
    stubUrl,
    async reset() {
      await stub.webhooksDelivered();
      await worker.idle();
      await pool.query(
        "TRUNCATE ledger_entries, review_cases, evidence, payments, orders, ingest_cursors RESTART IDENTITY CASCADE",
      );
      await stub.app.inject({ method: "POST", url: "/admin/reset" });
    },
    async close() {
      await stub.webhooksDelivered();
      await worker.stop();
      await app.close();
      await listener.stop();
      await stub.app.close();
      await pool.end();
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ""}`);
}

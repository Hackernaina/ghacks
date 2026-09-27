import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addDebit,
  getDebits,
  debitLog,
  getFaultConfig,
  setFaultConfig,
  clearStore,
  type BankFaultConfig,
} from "./store.js";

// ---------------------------------------------------------------------------
// CSV header (matches what mock-bank.test.ts checks)
// ---------------------------------------------------------------------------
export const BANK_STATEMENT_CSV_HEADER =
  "statement_id,line_no,psp_ref,amount,currency,type,credited_at";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/** Accept both `psp_ref` (preferred) and `ref` (legacy alias) so tests pass. */
const DebitRequest = z.object({
  amount: z.number().int().positive(),
  currency: z.string().min(1),
  // test sends both psp_ref and ref — accept either
  psp_ref: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BankServerOptions {
  port?: number;
}

export function buildBankServer(options?: BankServerOptions): FastifyInstance {
  const port = options?.port ?? (Number(process.env.PORT) || 4003);

  const app = Fastify({ logger: false });

  // ── Health check ──────────────────────────────────────────────────────────
  app.get("/healthz", async () => ({ ok: true, service: "mock-bank", port }));

  // ── POST /debit ───────────────────────────────────────────────────────────
  app.post("/debit", async (req, reply) => {
    const parsed = DebitRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: parsed.error.message,
      });
    }

    const { amount, currency } = parsed.data;
    // Resolve psp_ref from either field; require at least one
    const psp_ref = parsed.data.psp_ref ?? parsed.data.ref;
    if (!psp_ref) {
      return reply.code(400).send({
        error: "MISSING_REF",
        message: "Either psp_ref or ref field is required",
      });
    }

    const bankRef = `bnk_${randomUUID().slice(0, 8)}`;
    const credited_at = new Date().toISOString();

    addDebit({ bankRef, psp_ref, amount, currency, credited_at });

    return reply.code(200).send({ bankRef });
  });

  // ── GET /statements?since=ISO_TIMESTAMP ───────────────────────────────────
  app.get("/statements", async (req, reply) => {
    const query = req.query as { since?: string };
    const entries = getDebits(query.since);

    const rows = [BANK_STATEMENT_CSV_HEADER];
    for (const entry of entries) {
      rows.push(
        `${entry.statement_id},${entry.line_no},${entry.psp_ref},${entry.amount},${entry.currency},CREDIT,${entry.credited_at}`
      );
    }

    reply.header("content-type", "text/csv; charset=utf-8");
    return reply.code(200).send(rows.join("\n") + "\n");
  });

  // ── POST /admin/faults ────────────────────────────────────────────────────
  app.post("/admin/faults", async (req, reply) => {
    const faults = req.body as Partial<BankFaultConfig>;
    setFaultConfig(faults ?? {});
    return reply.code(200).send({ ok: true, faults: getFaultConfig() });
  });

  // ── GET /admin/faults ─────────────────────────────────────────────────────
  app.get("/admin/faults", async () => ({
    ok: true,
    faults: getFaultConfig(),
  }));

  // ── POST /admin/reset ─────────────────────────────────────────────────────
  app.post("/admin/reset", async () => {
    clearStore();
    return { ok: true };
  });

  return app;
}

// ---------------------------------------------------------------------------
// start() — called when run directly
// ---------------------------------------------------------------------------

export async function start(options?: BankServerOptions): Promise<FastifyInstance> {
  const port = options?.port ?? (Number(process.env.PORT) || 4003);
  const server = buildBankServer(options);
  try {
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Mock Bank running on port ${port}`);
    return server;
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Direct-run guard
// ---------------------------------------------------------------------------

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js") ||
    (import.meta.url.startsWith("file:") &&
      path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))));

if (isDirectRun) {
  start().catch((err) => {
    console.error("Failed to start bank mock server:", err);
    process.exit(1);
  });
}
